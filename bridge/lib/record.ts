/**
 * lib/record.ts — 交互式录制模式
 *
 * 打开目标页面，注入全量拦截器（记录所有 JSON 请求），
 * 用户在浏览器中正常操作，每 2s 轮询收集捕获的请求，
 * 按 Enter 停止录制后分析请求、推断能力，写入产物目录。
 *
 * 与 explore 的区别：
 *   - explore：自动模式（注入→等待→滚动→收集→分析）
 *   - record：交互模式（注入→用户操作→轮询→按 Enter 停止→分析）
 *
 * 产物目录：.bridge/record/<site>/
 *   - captured.json    — 原始捕获数据
 *   - endpoints.json   — 分析后的端点列表
 *   - capabilities.json — 推断的能力列表
 */

import { mkdir, writeFile } from "node:fs/promises";
import * as readline from "node:readline";
import { join } from "node:path";
import {
  BridgePage,
  checkBridge,
  closeTab,
  openTab,
} from "./bridge";
import {
  type AnalyzedEndpoint,
  type InferredCapability,
  type NetworkEntry,
  analyzeEntries,
} from "./explore";

// ─── 类型 ────────────────────────────────────────────────────────────

export interface RecordResult {
  site: string;
  url: string;
  title: string;
  totalCaptured: number;
  endpointCount: number;
  capabilityCount: number;
  capabilities: InferredCapability[];
  endpoints: AnalyzedEndpoint[];
  outDir: string;
}

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "com.hk",
  "com.tw",
  "co.jp",
  "co.kr",
  "co.uk",
]);

function sanitizeSiteName(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "site";
}

function isIpHost(host: string): boolean {
  if (host === "localhost") return false;
  if (host.includes(":")) return true;
  return host.split(".").every((part) => /^\d+$/.test(part));
}

export function inferRecordSite(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (!host) return "site";
    if (host === "localhost" || isIpHost(host)) return sanitizeSiteName(host);

    const labels = host.split(".").filter(Boolean);
    if (labels.length === 0) return "site";
    if (labels.length === 1) return sanitizeSiteName(labels[0]);

    const suffix = labels.slice(-2).join(".");
    const publicSuffixParts = MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? 2 : 1;
    const registrableIndex = Math.max(0, labels.length - publicSuffixParts - 1);
    return sanitizeSiteName(labels[registrableIndex] ?? labels[0]);
  } catch {
    return "site";
  }
}

// ─── 全量拦截器（record 用，比 explore 的更完整）────────────────────

/**
 * record 专用拦截器 — 捕获请求体 + 响应体 + Content-Type
 * 与 explore 的 INTERCEPTOR_SCRIPT 相比，额外记录 requestContentType 和完整的 requestBody
 */
const RECORD_INTERCEPTOR_SCRIPT = `
(function() {
  if (window.__bridge_record_patched__) return 'already';
  window.__bridge_record_patched__ = true;
  window.__bridge_requests__ = window.__bridge_requests__ || [];

  function record(entry) {
    window.__bridge_requests__.push(entry);
    if (window.__bridge_requests__.length > 500) window.__bridge_requests__.shift();
  }

  function tryParseJson(contentType, raw) {
    try {
      var ct = String(contentType || '').toLowerCase();
      if (!ct.includes('json')) return null;
      if (typeof raw !== 'string' || !raw.trim()) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  // 拦截 fetch
  var _fetch = window.fetch;
  window.fetch = async function(input, init) {
    var url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    var method = (init?.method || 'GET').toUpperCase();
    var requestContentType = null;
    if (init?.headers) {
      try {
        var h = new Headers(init.headers);
        requestContentType = h.get('content-type');
      } catch {}
    }
    var requestBodyText = typeof init?.body === 'string' ? init.body : null;
    var requestBody = tryParseJson(requestContentType, requestBodyText);

    var resp;
    try {
      resp = await _fetch.apply(this, arguments);
    } catch (e) {
      record({ method: method, url: url, status: null, contentType: '',
               requestHeaders: {}, requestBody: requestBody ? JSON.stringify(requestBody) : null,
               responseBody: null });
      throw e;
    }
    var clone = resp.clone();
    var ct = resp.headers.get('content-type') || '';
    var responseBody = null;
    if (ct.includes('json')) {
      try { responseBody = await clone.json(); } catch {}
    }
    record({
      method: method, url: url, status: resp.status, contentType: ct,
      requestHeaders: {},
      requestBody: requestBody ? JSON.stringify(requestBody) : (requestBodyText || null),
      responseBody: responseBody
    });
    return resp;
  };

  // 拦截 XMLHttpRequest
  var _XHROpen = XMLHttpRequest.prototype.open;
  var _XHRSend = XMLHttpRequest.prototype.send;
  var _setRH = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__bm__ = method.toUpperCase();
    this.__bu__ = url;
    this.__bh__ = {};
    this.__rec_ct__ = null;
    return _XHROpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
    if (this.__bh__) this.__bh__[k.toLowerCase()] = v;
    if (String(k).toLowerCase() === 'content-type') {
      this.__rec_ct__ = String(v);
    }
    return _setRH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    var requestBody = tryParseJson(this.__rec_ct__, typeof body === 'string' ? body : null);
    this.addEventListener('load', function() {
      var ct = this.getResponseHeader('content-type') || '';
      var responseBody = null;
      if (ct.includes('json')) {
        try { responseBody = JSON.parse(this.responseText); } catch {}
      }
      record({
        method: this.__bm__ || 'GET',
        url: this.__bu__ || '',
        status: this.status,
        contentType: ct,
        requestHeaders: this.__bh__ || {},
        requestBody: requestBody ? JSON.stringify(requestBody) : (body != null ? String(body).slice(0, 2000) : null),
        responseBody: responseBody
      });
    });
    return _XHRSend.apply(this, arguments);
  };

  return 'injected';
})()
`;

/** 从页面收集已捕获的请求并清空缓冲 */
const DRAIN_SCRIPT = `
(function() {
  var data = window.__bridge_requests__ || [];
  window.__bridge_requests__ = [];
  return JSON.parse(JSON.stringify(data));
})()
`;

// ─── 主流程 ──────────────────────────────────────────────────────────

export async function recordUrl(opts: {
  url: string;
  site?: string;
  name?: string;
  pollMs?: number;
  timeoutMs?: number;
  outDir?: string;
}): Promise<RecordResult> {
  const { url, name, pollMs = 2000, timeoutMs = 120_000 } = opts;
  const site = opts.site ?? inferRecordSite(url);

  await checkBridge();
  const pageId = await openTab(url, { foreground: true });
  const page = new BridgePage(pageId);

  const allEntries: NetworkEntry[] = [];
  let title = "";

  try {
    // 1. 等待页面加载
    await page.waitForLoad();

    // 2. 注入 record 专用拦截器
    await page.runJs(RECORD_INTERCEPTOR_SCRIPT);

    // 3. 读取页面标题
    const meta = await page.inspect();
    title = meta.title;

    console.log("");
    console.log("  tw record");
    console.log(`  站点：${site}  URL：${url}`);
    console.log(`  超时：${timeoutMs / 1000}s  轮询：${pollMs}ms`);
    console.log("");
    console.log("  已在前台打开录制页面。");
    console.log("  正在录制。请在浏览器中正常操作页面。");
    console.log(`  按 Enter 停止录制，或等待 ${timeoutMs / 1000}s 自动停止。`);
    console.log("");

    // 4. 轮询 + 等待 Enter
    let stopped = false;
    const { promise: enterPromise, cleanup } = waitForEnter();

    enterPromise.then(() => {
      stopped = true;
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        stopped = true;
        resolve();
      }, timeoutMs);
    });

    // 轮询收集
    const pollInterval = setInterval(async () => {
      if (stopped) return;
      try {
        const batch = await page.runJs<NetworkEntry[]>(DRAIN_SCRIPT);
        if (Array.isArray(batch) && batch.length > 0) {
          allEntries.push(...batch);
          process.stderr.write(
            `  +${batch.length} 已捕获 — 总计：${allEntries.length}\n`,
          );
        }
      } catch {
        // 页面可能正在导航，继续轮询
      }
    }, pollMs);

    // 等待 Enter 或超时
    await Promise.race([enterPromise, timeoutPromise]);
    cleanup();
    clearInterval(pollInterval);

    // 5. 最终一次 drain
    try {
      const last = await page.runJs<NetworkEntry[]>(DRAIN_SCRIPT);
      if (Array.isArray(last) && last.length > 0) {
        allEntries.push(...last);
      }
    } catch {}

    process.stderr.write(
      `\n  录制停止。共捕获 ${allEntries.length} 个请求，正在分析…\n`,
    );
  } finally {
    await closeTab(pageId);
  }

  // 6. 分析（复用 explore 的分析逻辑）
  const { endpoints, capabilities } = analyzeEntries(allEntries, {
    site,
    name,
    url,
  });

  // 7. 写产物到磁盘
  const outDir = opts.outDir ?? join(".bridge", "record", site);
  await mkdir(outDir, { recursive: true });

  const result: RecordResult = {
    site,
    url,
    title,
    totalCaptured: allEntries.length,
    endpointCount: endpoints.length,
    capabilityCount: capabilities.length,
    capabilities,
    endpoints,
    outDir,
  };

  await Promise.all([
    writeFile(
      join(outDir, "captured.json"),
      JSON.stringify(
        {
          site,
          url,
          title,
          capturedAt: new Date().toISOString(),
          totalRequests: allEntries.length,
          requests: allEntries,
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

// ─── 等待 Enter ──────────────────────────────────────────────────────

function waitForEnter(): {
  promise: Promise<void>;
  cleanup: () => void;
} {
  let rl: readline.Interface | null = null;
  const promise = new Promise<void>((resolve) => {
    rl = readline.createInterface({ input: process.stdin });
    rl.once("line", () => {
      rl?.close();
      rl = null;
      process.stdin.pause();
      resolve();
    });
    rl.once("SIGINT", () => {
      rl?.close();
      rl = null;
      process.stdin.pause();
      resolve();
    });
  });
  return {
    promise,
    cleanup: () => {
      rl?.close();
      rl = null;
      process.stdin.pause();
    },
  };
}

// ─── 格式化输出 ──────────────────────────────────────────────────────

export function renderRecordResult(result: RecordResult): string {
  const lines = [
    "",
    `录制完成：${result.site}`,
    `URL：${result.url}`,
    `标题：${result.title || "（无）"}`,
    `捕获请求：${result.totalCaptured} 个`,
    `API 端点：${result.endpointCount} 个`,
    `推断能力：${result.capabilityCount} 个`,
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

  if (result.capabilityCount === 0) {
    lines.push("");
    lines.push("  未发现有效 API 能力。");
    lines.push(
      "  提示：请确保在录制期间触发了 JSON API 调用（如打开列表、搜索、滚动页面）。",
    );
  }

  lines.push("");
  lines.push(`产物已写入：${result.outDir}`);
  if (result.capabilityCount > 0) {
    lines.push(
      `下一步：tw synthesize --site ${result.site} --capability <name>`,
    );
  }

  return lines.join("\n");
}
