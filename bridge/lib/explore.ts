/**
 * lib/explore.ts — 页面自动探索
 *
 * 通过 browser-bridge 打开页面，注入网络拦截脚本，
 * 自动滚动触发懒加载，分析 XHR/fetch 请求，推断可用 API。
 *
 * 用法：
 *   tw explore --url https://example.com/ --site example --name read-page
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BridgePage, checkBridge, closeTab, openTab } from "./bridge";

// ─── 类型 ────────────────────────────────────────────────────────────

export interface NetworkEntry {
  method: string;
  url: string;
  status: number | null;
  contentType: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseBody: unknown;
}

export interface AnalyzedEndpoint {
  pattern: string;
  method: string;
  url: string;
  status: number | null;
  score: number;
  queryParams: string[];
  itemPath: string | null;
  itemCount: number;
  detectedFields: Record<string, string>;
  authIndicators: string[];
  requestHeaders: Record<string, string>;
  requestBody: string | null;
}

export interface InferredCapability {
  name: string;
  description: string;
  endpoint: string;
  method: string;
  itemPath: string | null;
  recommendedColumns: string[];
  recommendedArgs: Array<{
    name: string;
    type: string;
    required: boolean;
    default?: unknown;
  }>;
  confidence: number;
  requestBody: string | null;
}

export interface ExploreResult {
  site: string;
  name: string;
  url: string;
  title: string;
  endpointCount: number;
  apiCount: number;
  capabilities: InferredCapability[];
  endpoints: AnalyzedEndpoint[];
  outDir: string;
}

// ─── 注入脚本：拦截 XHR + fetch ──────────────────────────────────────

/**
 * 注入到页面的拦截器，记录所有 XHR/fetch 请求到 window.__bridge_requests__
 */
const INTERCEPTOR_SCRIPT = `
(function() {
  if (window.__bridge_intercepted__) return 'already';
  window.__bridge_intercepted__ = true;
  window.__bridge_requests__ = window.__bridge_requests__ || [];

  function record(entry) {
    window.__bridge_requests__.push(entry);
    if (window.__bridge_requests__.length > 300) window.__bridge_requests__.shift();
  }

  // 拦截 fetch
  const _fetch = window.fetch;
  window.fetch = async function(input, init) {
    const method = (init?.method || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const requestBody = init?.body != null ? String(init.body).slice(0, 2000) : null;
    const requestHeaders = {};
    if (init?.headers) {
      try {
        const h = new Headers(init.headers);
        h.forEach((v, k) => { requestHeaders[k] = v; });
      } catch {}
    }
    let resp;
    try {
      resp = await _fetch.apply(this, arguments);
    } catch (e) {
      record({ method, url, status: null, contentType: '', requestHeaders, requestBody, responseBody: null });
      throw e;
    }
    const clone = resp.clone();
    const ct = resp.headers.get('content-type') || '';
    let responseBody = null;
    if (ct.includes('json')) {
      try { responseBody = await clone.json(); } catch {}
    }
    record({ method, url, status: resp.status, contentType: ct, requestHeaders, requestBody, responseBody });
    return resp;
  };

  // 拦截 XMLHttpRequest
  const _XHROpen = XMLHttpRequest.prototype.open;
  const _XHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__bm__ = method.toUpperCase();
    this.__bu__ = url;
    this.__bh__ = {};
    return _XHROpen.apply(this, arguments);
  };
  const _setRH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
    if (this.__bh__) this.__bh__[k.toLowerCase()] = v;
    return _setRH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    this.addEventListener('load', function() {
      const ct = this.getResponseHeader('content-type') || '';
      let responseBody = null;
      if (ct.includes('json')) {
        try { responseBody = JSON.parse(this.responseText); } catch {}
      }
      record({
        method: this.__bm__ || 'GET',
        url: this.__bu__ || '',
        status: this.status,
        contentType: ct,
        requestHeaders: this.__bh__ || {},
        requestBody: body != null ? String(body).slice(0, 2000) : null,
        responseBody,
      });
    });
    return _XHRSend.apply(this, arguments);
  };

  return 'injected';
})()
`;

/** 从页面收集已捕获的请求 */
const COLLECT_SCRIPT = `
(function() {
  const reqs = window.__bridge_requests__ || [];
  return JSON.parse(JSON.stringify(reqs));
})()
`;

/** 触发页面自动滚动以加载懒加载内容 */
const SCROLL_SCRIPT = `
(async function() {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 3; i++) {
    window.scrollBy(0, 800);
    await delay(600);
  }
  window.scrollTo(0, 0);
  return 'scrolled';
})()
`;

// ─── 分析工具 ────────────────────────────────────────────────────────

const VOLATILE_PARAMS = new Set([
  "_t",
  "_",
  "ts",
  "timestamp",
  "nonce",
  "sign",
  "signature",
  "requestId",
  "request_id",
  "traceId",
  "trace_id",
  "rnd",
  "random",
  "t",
  "v",
  "callback",
  "jsonpCallback",
]);

const SEARCH_PARAMS = new Set([
  "q",
  "query",
  "keyword",
  "search",
  "kw",
  "wd",
  "word",
  "key",
]);
const PAGINATION_PARAMS = new Set([
  "page",
  "pageNum",
  "pageNo",
  "p",
  "pn",
  "current",
  "pageIndex",
]);
const LIMIT_PARAMS = new Set([
  "limit",
  "size",
  "pageSize",
  "count",
  "num",
  "per_page",
  "perPage",
  "rows",
]);

const FIELD_ROLES: Record<string, string[]> = {
  title: [
    "title",
    "name",
    "subject",
    "headline",
    "label",
    "text",
    "content",
    "menuName",
    "operationName",
  ],
  url: ["url", "link", "href", "path", "shortUrl", "urlInfo"],
  author: [
    "author",
    "user",
    "username",
    "operator",
    "creator",
    "owner",
    "creatorName",
  ],
  id: ["id", "menuId", "operationCode", "code", "key", "itemId", "bizId"],
  status: ["status", "state", "enabled", "active", "enable"],
  time: [
    "time",
    "date",
    "createTime",
    "updateTime",
    "gmtCreate",
    "gmtModified",
    "createdAt",
    "updatedAt",
  ],
};

function urlToPattern(url: string): string {
  try {
    const p = new URL(url);
    const pathNorm = p.pathname
      .replace(/\/\d+/g, "/{id}")
      .replace(/\/[0-9a-fA-F]{32,}/g, "/{hex}");
    const params: string[] = [];
    p.searchParams.forEach((_v, k) => {
      if (!VOLATILE_PARAMS.has(k)) params.push(k);
    });
    // 对于 ?method=Xxx.yyy 这类 RPC 风格，保留 method 值
    const methodParam = p.searchParams.get("method");
    if (methodParam) {
      return `${p.host}${pathNorm}?method=${methodParam}`;
    }
    return `${p.host}${pathNorm}${params.length ? "?" + params.sort().join("&") : ""}`;
  } catch {
    return url;
  }
}

function findArrayPath(
  obj: unknown,
  depth = 0,
): { path: string; items: unknown[] } | null {
  if (depth > 5 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    if (
      obj.length >= 2 &&
      obj.some((i) => i && typeof i === "object" && !Array.isArray(i))
    ) {
      return { path: "", items: obj };
    }
    return null;
  }
  let best: { path: string; items: unknown[] } | null = null;
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const found = findArrayPath(val, depth + 1);
    if (found) {
      const fullPath = found.path ? `${key}.${found.path}` : key;
      const candidate = { path: fullPath, items: found.items };
      if (!best || candidate.items.length > best.items.length) best = candidate;
    }
  }
  return best;
}

function flattenFields(
  obj: unknown,
  prefix: string,
  maxDepth: number,
): string[] {
  if (maxDepth <= 0 || !obj || typeof obj !== "object") return [];
  const names: string[] = [];
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${key}` : key;
    names.push(full);
    if (val && typeof val === "object" && !Array.isArray(val)) {
      names.push(...flattenFields(val, full, maxDepth - 1));
    }
  }
  return names;
}

function detectFieldRoles(sampleFields: string[]): Record<string, string> {
  const detected: Record<string, string> = {};
  for (const [role, aliases] of Object.entries(FIELD_ROLES)) {
    let exactMatch = "";
    let fuzzyMatch = "";
    for (const f of sampleFields) {
      const leaf = f.split(".").pop()?.toLowerCase() ?? "";
      if (aliases.some((a) => a.toLowerCase() === leaf)) {
        exactMatch = f;
        break;
      }
      if (
        !fuzzyMatch &&
        aliases.some((a) => leaf.includes(a.toLowerCase()))
      ) {
        fuzzyMatch = f;
      }
    }
    if (exactMatch) detected[role] = exactMatch;
    else if (fuzzyMatch) detected[role] = fuzzyMatch;
  }
  return detected;
}

function detectAuthFromHeaders(headers: Record<string, string>): string[] {
  const indicators: string[] = [];
  const keys = Object.keys(headers).map((k) => k.toLowerCase());
  if (keys.includes("authorization")) indicators.push("bearer");
  if (keys.some((k) => k.startsWith("x-csrf") || k.startsWith("x-xsrf")))
    indicators.push("csrf");
  if (keys.some((k) => ["invocation-protocol", "x-sn-protocol"].includes(k)))
    indicators.push("sn-protocol");
  if (
    keys.some((k) =>
      ["napos-communication-protocol", "napos-version"].includes(k),
    )
  )
    indicators.push("napos");
  if (keys.some((k) => k.startsWith("x-s") && k !== "x-sn-protocol"))
    indicators.push("signature");
  return indicators;
}

function scoreEndpoint(ep: {
  contentType: string;
  itemCount: number;
  detectedFieldCount: number;
  hasSearchParam: boolean;
  hasPaginationParam: boolean;
  status: number | null;
  pattern: string;
}): number {
  let s = 0;
  if (ep.contentType.includes("json")) s += 10;
  if (ep.itemCount > 0) {
    s += 5;
    s += Math.min(ep.itemCount, 10);
  }
  s += ep.detectedFieldCount * 2;
  if (ep.hasSearchParam) s += 3;
  if (ep.hasPaginationParam) s += 2;
  if (ep.status === 200) s += 2;
  // 降分：空数组响应
  if (ep.itemCount === 0 && ep.contentType.includes("json")) s -= 3;
  return s;
}

function inferCapabilityName(url: string, name?: string): string {
  if (name) return name;
  // 内网 RPC 风格：method=Xxx.yyy → 取方法名最后一段
  try {
    const u = new URL(url);
    const method = u.searchParams.get("method");
    if (method) {
      const parts = method.split(".");
      const last = parts[parts.length - 1] ?? "";
      return (
        last
          .replace(/^(get|query|find|fetch|list)/i, "")
          .replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
          .replace(/^-/, "") || "query"
      );
    }
    // REST 风格：取有意义的路径段
    const segs = u.pathname
      .split("/")
      .filter(
        (s) =>
          s && !s.match(/^\d+$/) && !s.match(/^v\d+$/) && !s.match(/^api$/i),
      );
    return (
      segs[segs.length - 1]?.replace(/[^a-z0-9]/gi, "-").toLowerCase() ??
      "query"
    );
  } catch {
    return "query";
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────

export async function exploreUrl(opts: {
  url: string;
  site: string;
  name?: string;
  waitMs?: number;
  outDir?: string;
}): Promise<ExploreResult> {
  const { url, site, name, waitMs = 3000 } = opts;

  await checkBridge();
  const pageId = await openTab(url);
  const page = new BridgePage(pageId);

  let rawEntries: NetworkEntry[] = [];
  let title = "";

  try {
    // 1. 注入拦截器
    await page.runJs(INTERCEPTOR_SCRIPT);

    // 2. 等待页面初始请求完成
    await sleep(waitMs);

    // 3. 自动滚动触发懒加载
    await page.runJs(SCROLL_SCRIPT);
    await sleep(1500);

    // 4. 收集请求
    rawEntries = await page.runJs<NetworkEntry[]>(COLLECT_SCRIPT);

    // 5. 读取页面标题
    const meta = await page.inspect();
    title = meta.title;
  } finally {
    await closeTab(pageId);
  }

  // 6. 分析请求
  const { endpoints, capabilities } = analyzeEntries(rawEntries, {
    site,
    name,
    url,
  });

  // 7. 写产物到磁盘
  const outDir = opts.outDir ?? join(".bridge", "explore", site);
  await mkdir(outDir, { recursive: true });

  const result: ExploreResult = {
    site,
    name: name ?? site,
    url,
    title,
    endpointCount: rawEntries.length,
    apiCount: endpoints.length,
    capabilities,
    endpoints,
    outDir,
  };

  await Promise.all([
    writeFile(
      join(outDir, "manifest.json"),
      JSON.stringify(
        {
          site,
          url,
          title,
          exploredAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    ),
    writeFile(
      join(outDir, "endpoints.json"),
      JSON.stringify(endpoints, null, 2),
    ),
    writeFile(
      join(outDir, "capabilities.json"),
      JSON.stringify(capabilities, null, 2),
    ),
  ]);

  return result;
}

export function analyzeEntries(
  entries: NetworkEntry[],
  opts: { site: string; name?: string; url: string },
): { endpoints: AnalyzedEndpoint[]; capabilities: InferredCapability[] } {
  const seen = new Map<string, AnalyzedEndpoint>();

  for (const entry of entries) {
    if (!entry.url) continue;

    // 跳过静态资源
    const ct = (entry.contentType ?? "").toLowerCase();
    if (
      ct.includes("image/") ||
      ct.includes("font/") ||
      ct.includes("css") ||
      ct.includes("javascript") ||
      ct.includes("html") ||
      ct.includes("wasm")
    )
      continue;

    // 跳过失败请求
    if (entry.status && entry.status >= 400) continue;

    const pattern = urlToPattern(entry.url);
    const key = `${entry.method}:${pattern}`;
    if (seen.has(key)) continue;

    // 分析查询参数
    const qParams: string[] = [];
    let hasSearch = false,
      hasPagination = false,
      hasLimit = false;
    try {
      const u = new URL(entry.url);
      u.searchParams.forEach((_v, k) => {
        if (!VOLATILE_PARAMS.has(k)) qParams.push(k);
      });
      hasSearch = qParams.some((p) => SEARCH_PARAMS.has(p));
      hasPagination = qParams.some((p) => PAGINATION_PARAMS.has(p));
      hasLimit = qParams.some((p) => LIMIT_PARAMS.has(p));
    } catch {}

    // 分析响应体
    let itemPath: string | null = null;
    let itemCount = 0;
    let detectedFields: Record<string, string> = {};

    if (entry.responseBody) {
      const found = findArrayPath(entry.responseBody);
      if (found) {
        itemPath = found.path || null;
        itemCount = found.items.length;
        const sample = found.items[0];
        if (sample && typeof sample === "object") {
          const fields = flattenFields(sample, "", 2);
          detectedFields = detectFieldRoles(fields);
        }
      }
    }

    const authIndicators = detectAuthFromHeaders(entry.requestHeaders ?? {});

    const score = scoreEndpoint({
      contentType: ct,
      itemCount,
      detectedFieldCount: Object.keys(detectedFields).length,
      hasSearchParam: hasSearch,
      hasPaginationParam: hasPagination,
      status: entry.status,
      pattern,
    });

    seen.set(key, {
      pattern,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      score,
      queryParams: qParams,
      itemPath,
      itemCount,
      detectedFields,
      authIndicators,
      requestHeaders: entry.requestHeaders ?? {},
      requestBody: entry.requestBody,
    });
  }

  const endpoints = [...seen.values()]
    .filter((ep) => ep.score >= 5)
    .sort((a, b) => b.score - a.score);

  // 推断 capabilities（取前 6 个端点）
  const usedNames = new Set<string>();
  const capabilities: InferredCapability[] = [];

  for (const ep of endpoints.slice(0, 6)) {
    let capName = inferCapabilityName(ep.url, opts.name);
    if (usedNames.has(capName)) {
      capName = `${capName}-${usedNames.size}`;
    }
    usedNames.add(capName);

    // 推荐列
    const cols: string[] = [];
    for (const role of ["title", "id", "url", "author", "status", "time"]) {
      if (ep.detectedFields[role]) cols.push(role);
    }

    // 推荐参数
    const args: InferredCapability["recommendedArgs"] = [];
    if (ep.queryParams.some((p) => SEARCH_PARAMS.has(p))) {
      args.push({ name: "keyword", type: "string", required: false });
    }
    args.push({ name: "limit", type: "int", required: false, default: 20 });

    capabilities.push({
      name: capName,
      description: `${opts.site} ${capName}（自动探索）`,
      endpoint: ep.pattern,
      method: ep.method,
      itemPath: ep.itemPath,
      recommendedColumns: cols.length ? cols : ["title", "id"],
      recommendedArgs: args,
      confidence: Math.min(ep.score / 25, 1.0),
      requestBody: ep.requestBody,
    });
  }

  return { endpoints, capabilities };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 格式化输出 ──────────────────────────────────────────────────────

export function renderExploreResult(result: ExploreResult): string {
  const lines = [
    `探索完成：${result.site}`,
    `URL：${result.url}`,
    `标题：${result.title || "（无）"}`,
    `请求总数：${result.endpointCount}，API 端点：${result.apiCount}`,
    `推断能力：${result.capabilities.length} 个`,
  ];

  for (const cap of result.capabilities) {
    lines.push(
      `  • ${cap.name}（置信度 ${(cap.confidence * 100).toFixed(0)}%）`,
    );
    lines.push(`    端点：${cap.endpoint}`);
    if (cap.recommendedColumns.length) {
      lines.push(`    推荐列：${cap.recommendedColumns.join(", ")}`);
    }
  }

  lines.push(`\n产物已写入：${result.outDir}`);
  lines.push(`下一步：tw synthesize --site ${result.site}`);

  return lines.join("\n");
}
