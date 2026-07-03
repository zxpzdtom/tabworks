/**
 * lib/synthesize.ts — 从 explore 产物生成 Routine TypeScript 骨架
 *
 * 读取 .bridge/explore/<site>/ 或 .bridge/record/<site>/ 目录下的
 * capabilities.json + endpoints.json，
 * 生成可直接运行的 Routine 代码到 bridge/sites/<site>/<name>.ts。
 *
 * 生成策略：
 *   - 根据探索到的请求头判断协议类型
 *   - 优先使用站点现有的 _base.ts
 *   - 无已知基类则生成通用 fetch 代码
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalyzedEndpoint, InferredCapability } from "./explore";

// ─── 已知站点协议映射 ────────────────────────────────────────────────

interface SiteProfile {
  baseClass: string; // 继承的基类名
  baseImport: string; // import 路径（相对于 sites/<site>/）
  fetchHelper?: string; // 封装好的 fetch 方法名（如 xyFetch）
  fetchSignature?: string; // fetch helper 参数示意注释
}

const KNOWN_SITES: Record<string, SiteProfile> = {};

function getGenericBaseClassName(site: string): string {
  return `${site
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("")}Routine`;
}

const BROWSER_MANAGED_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "pragma",
  "referer",
  "user-agent",
]);

function sanitizeRecordedHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  if (!headers) return sanitized;

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!rawValue || BROWSER_MANAGED_HEADERS.has(name) || name.startsWith("sec-")) {
      continue;
    }

    if (name === "authorization") {
      sanitized[name] = rawValue.toLowerCase().startsWith("bearer ")
        ? "__TABWORKS_AUTHORIZATION_BEARER__"
        : "__TABWORKS_AUTHORIZATION_RAW__";
      continue;
    }

    if (/(token|secret|api[-_]?key|session)/i.test(name)) {
      sanitized[name] = "__TABWORKS_SECRET__";
      continue;
    }

    sanitized[name] = rawValue;
  }

  return sanitized;
}

// ─── 协议推断 ────────────────────────────────────────────────────────

function inferProtocol(
  endpoints: AnalyzedEndpoint[],
): "sn-protocol" | "napos" | "generic" {
  const allIndicators = new Set(endpoints.flatMap((ep) => ep.authIndicators));
  if (allIndicators.has("napos")) return "napos";
  if (allIndicators.has("sn-protocol")) return "sn-protocol";
  return "generic";
}

// ─── 代码生成 ────────────────────────────────────────────────────────

function buildFetchCode(
  cap: InferredCapability,
  endpoint: AnalyzedEndpoint,
  profile: SiteProfile | null,
): string {
  const urlStr = endpoint.url;
  const itemPath = cap.itemPath;

  // 生成数据访问链
  const pathChain = itemPath
    ? itemPath
        .split(".")
        .map((p) => `?.${p}`)
        .join("")
    : "?.data?.result";

  // 生成字段映射
  const fieldMappings = Object.entries(endpoint.detectedFields)
    .map(([role, field]) => `      ${role}: item?.${field},`)
    .join("\n");

  // 如果有已知的 fetch helper
  if (profile?.fetchHelper) {
    if (
      profile.fetchHelper === "xyFetch" ||
      profile.fetchHelper === "xyGrayFetch"
    ) {
      // 从 URL 提取 apiPath
      let apiPath = "";
      try {
        const u = new URL(urlStr);
        const method = u.searchParams.get("method") ?? "";
        apiPath = method
          ? `${u.pathname.replace(/^\//, "")}?method=${method}`
          : u.pathname.replace(/^\//, "");
      } catch {
        apiPath = "/* TODO: 填写 API 路径 */";
      }

      // 提取请求体参数
      let paramsCode = "{}";
      if (endpoint.requestBody) {
        try {
          const body = JSON.parse(endpoint.requestBody);
          const params = body.params ?? body;
          if (typeof params === "object" && params !== null) {
            const keys = Object.keys(params);
            if (keys.length > 0) {
              paramsCode = `{ ${keys.map((k) => `${k}: /* args.${k} ?? */ ${JSON.stringify(params[k])}`).join(", ")} }`;
            }
          }
        } catch {}
      }

      return `    const result = await this.${profile.fetchHelper}</* TODO: 定义返回类型 */>(
      page,
      ${JSON.stringify(apiPath)},
      ${paramsCode},
    );
    // TODO: 根据实际返回结构调整下方数据提取路径
    const items = (result as any)${pathChain} ?? (Array.isArray(result) ? result : []);
    return items.slice(0, Number(args.limit ?? 20)).map((item: any) => ({
${fieldMappings || "      // TODO: 按需提取字段"}
    }));`;
    }

    if (profile.fetchHelper === "cubeFetch") {
      // 从 URL 提取 service/method
      let service = "/* ServiceName */";
      let method = "/* methodName */";
      try {
        const u = new URL(urlStr);
        const m = u.searchParams.get("method") ?? "";
        const parts = m.split(".");
        if (parts.length >= 2) {
          service = JSON.stringify(parts[0]);
          method = JSON.stringify(parts[1]);
        }
      } catch {}

      return `    const result = await this.cubeFetch</* TODO: 定义返回类型 */>(
      page,
      ${service},
      ${method},
      { /* TODO: 填写参数 */ },
    );
    const items = (result as any)${pathChain} ?? (Array.isArray(result) ? result : []);
    return items.slice(0, Number(args.limit ?? 20)).map((item: any) => ({
${fieldMappings || "      // TODO: 按需提取字段"}
    }));`;
    }
  }

  // 通用 fetch 代码
  const method = endpoint.method ?? "GET";
  const recordedHeaders = JSON.stringify(
    sanitizeRecordedHeaders(endpoint.requestHeaders),
    null,
    6,
  );

  return `    const data = await this.genericJsonFetch<any>(page, {
      url: ${JSON.stringify(urlStr)},
      method: '${method}',
      recordedHeaders: ${recordedHeaders},
      requestBody: ${endpoint.requestBody ? JSON.stringify(endpoint.requestBody) : "null"},
    });
    // TODO: 根据实际返回结构调整下方数据提取路径
    const items = (data as any)${pathChain} ?? (Array.isArray(data) ? data : []);
    return items.slice(0, Number(args.limit ?? 20)).map((item: any) => ({
${fieldMappings || "      // TODO: 按需提取字段"}
    }));`;
}

function buildRoutineCode(opts: {
  site: string;
  cap: InferredCapability;
  endpoint: AnalyzedEndpoint;
  profile: SiteProfile;
}): string {
  const { site, cap, endpoint, profile } = opts;

  const className = cap.name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

  const baseClass = profile.baseClass;
  const importLine = `import { ${baseClass} } from '${profile.baseImport}';`;

  const argsCode = cap.recommendedArgs
    .map((arg) => {
      const parts: string[] = [
        `name: '${arg.name}'`,
        `type: '${arg.type}' as const`,
      ];
      if (arg.required) parts.push(`required: true`);
      if (arg.default !== undefined)
        parts.push(`default: ${JSON.stringify(arg.default)}`);
      const helpMap: Record<string, string> = {
        keyword: "搜索关键词",
        limit: "最多返回条数",
        page: "页码",
      };
      if (helpMap[arg.name]) parts.push(`help: '${helpMap[arg.name]}'`);
      return `    { ${parts.join(", ")} }`;
    })
    .join(",\n");

  const columnsCode = cap.recommendedColumns.map((c) => `'${c}'`).join(", ");

  const fetchCode = buildFetchCode(cap, endpoint, profile);

  // 生成简要的探索说明注释
  const exploredUrl =
    endpoint.url.length > 80 ? `${endpoint.url.slice(0, 80)}...` : endpoint.url;

  return `/**
 * sites/${site}/${cap.name}.ts — ${cap.description}
 *
 * 由 \`tw explore / record\` 自动生成（置信度 ${(cap.confidence * 100).toFixed(0)}%）
 * 探索端点：${exploredUrl}
 *
 * TODO：请检查并补全以下内容：
 *   1. 确认 API 路径和参数是否正确
 *   2. 补全返回类型接口定义
 *   3. 调整字段映射
 *   4. 设置合适的 risk 等级
 *
 * 用法：
 *   tw ${site} ${cap.name}
 */

${importLine}
import type { Page, Args, Row } from '../../lib/types';

// TODO: 根据实际 API 返回结构定义类型
// interface ${className}Item {
//   [key: string]: unknown;
// }

export default class ${className} extends ${baseClass} {
  readonly name = '${cap.name}';
  readonly description = '${cap.description}';
  readonly risk = 'readonly' as const;

  readonly args = [
${argsCode || "    // 暂无参数"}
  ];

  readonly columns = [${columnsCode}];

  async run(page: Page, args: Args): Promise<Row[]> {
${fetchCode}
  }
}
`;
}

// ─── 主函数 ──────────────────────────────────────────────────────────

export interface SynthesizeResult {
  site: string;
  generated: Array<{ name: string; path: string; confidence: number }>;
}

export async function synthesize(opts: {
  site: string;
  capability?: string; // 只生成指定 capability，不传则生成全部
  exploreDir?: string;
  sitesDir?: string;
}): Promise<SynthesizeResult> {
  const exploreDir = opts.exploreDir ?? join(".bridge", "explore", opts.site);
  const recordDir = join(".bridge", "record", opts.site);
  const sitesDir =
    opts.sitesDir ?? join(import.meta.dir, "..", "sites", opts.site);

  // 优先读取 explore 产物，缺失时回退到 record 产物
  let capabilities: InferredCapability[];
  let endpoints: AnalyzedEndpoint[];
  let sourceUrl = "";
  let recordedRequests: Array<{
    method?: string;
    url?: string;
    requestHeaders?: Record<string, string>;
  }> = [];
  try {
    capabilities = JSON.parse(
      await readFile(join(exploreDir, "capabilities.json"), "utf-8"),
    );
    endpoints = JSON.parse(
      await readFile(join(exploreDir, "endpoints.json"), "utf-8"),
    );
    try {
      const manifest = JSON.parse(
        await readFile(join(exploreDir, "manifest.json"), "utf-8"),
      ) as { url?: string };
      sourceUrl = manifest.url ?? "";
    } catch {
      sourceUrl = "";
    }
  } catch (_e: unknown) {
    try {
      capabilities = JSON.parse(
        await readFile(join(recordDir, "capabilities.json"), "utf-8"),
      );
      endpoints = JSON.parse(
        await readFile(join(recordDir, "endpoints.json"), "utf-8"),
      );
      try {
        const captured = JSON.parse(
          await readFile(join(recordDir, "captured.json"), "utf-8"),
        ) as {
          url?: string;
          requests?: Array<{
            method?: string;
            url?: string;
            requestHeaders?: Record<string, string>;
          }>;
        };
        sourceUrl = captured.url ?? "";
        recordedRequests = captured.requests ?? [];
      } catch {
        sourceUrl = "";
        recordedRequests = [];
      }
    } catch {
      throw new Error(
        `找不到 explore/record 产物（${exploreDir} 或 ${recordDir}），请先运行：\n` +
          `  tw explore --url <页面URL> --site ${opts.site}\n` +
          `或 tw record <页面URL> --site ${opts.site}`,
      );
    }
  }

  if (recordedRequests.length > 0) {
    endpoints = endpoints.map((endpoint) => {
      if (endpoint.requestHeaders && Object.keys(endpoint.requestHeaders).length) {
        return endpoint;
      }
      const matched = recordedRequests.find(
        (request) =>
          (request.method ?? "GET") === endpoint.method &&
          request.url === endpoint.url,
      );
      return {
        ...endpoint,
        requestHeaders: matched?.requestHeaders ?? endpoint.requestHeaders ?? {},
      };
    });
  }

  // 按需过滤
  if (opts.capability) {
    const availableCapabilities = capabilities.map((c) => c.name);
    capabilities = capabilities.filter((c) => c.name === opts.capability);
    if (!capabilities.length) {
      throw new Error(
        `未找到 capability "${opts.capability}"，可用：${availableCapabilities.join(", ")}`,
      );
    }
  }

  const profile =
    KNOWN_SITES[opts.site] ?? {
      baseClass: getGenericBaseClassName(opts.site),
      baseImport: "./_base",
    };
  const protocol = inferProtocol(endpoints);

  // 确保输出目录存在
  await mkdir(sitesDir, { recursive: true });

  // 检查是否需要生成 _base.ts
  const baseFile = join(sitesDir, "_base.ts");
  if (!(opts.site in KNOWN_SITES)) {
    try {
      await access(baseFile);
    } catch {
      await writeFile(baseFile, buildGenericBase(opts.site, protocol, sourceUrl));
    }
  }

  const generated: SynthesizeResult["generated"] = [];

  for (const cap of capabilities) {
    // 找到对应端点
    const endpoint =
      endpoints.find((ep) => ep.pattern === cap.endpoint) ??
      endpoints.sort((a, b) => b.score - a.score)[0];

    if (!endpoint) continue;

    const code = buildRoutineCode({ site: opts.site, cap, endpoint, profile });
    const filePath = join(sitesDir, `${cap.name}.ts`);
    await writeFile(filePath, code);
    generated.push({
      name: cap.name,
      path: filePath,
      confidence: cap.confidence,
    });
  }

  return { site: opts.site, generated };
}

function buildGenericBase(site: string, protocol: string, sourceUrl = ""): string {
  const className = getGenericBaseClassName(site);
  const baseUrl = sourceUrl || "https://TODO.example.com/";
  const urlComment = sourceUrl
    ? ""
    : " // TODO: 替换为真实 URL";

  return `/**
 * sites/${site}/_base.ts — ${site} 站点基类
 *
 * 由 \`tw synthesize\` 自动生成
 * 协议推断：${protocol}
 *
 * TODO：补充站点 URL 和协议细节
 */

import { Routine } from '../../lib/routine';
import type { Page } from '../../lib/types';

export abstract class ${className} extends Routine {
  readonly site = '${site}';
  readonly url = '${baseUrl}';${urlComment}

  protected async genericJsonFetch<T>(
    page: Page,
    options: {
      url: string;
      method?: string;
      recordedHeaders?: Record<string, string>;
      requestBody?: string | null;
    },
  ): Promise<T> {
    const { url, method = 'GET', recordedHeaders = {}, requestBody = null } = options;
    const script = \`
      (async () => {
        const targetUrl = \${JSON.stringify(url)};
        const method = \${JSON.stringify(method)};
        const recordedHeaders = \${JSON.stringify(recordedHeaders)};
        const requestBody = \${JSON.stringify(requestBody)};
        const CONTROLLED_HEADERS = new Set([
          'accept',
          'accept-encoding',
          'accept-language',
          'cache-control',
          'connection',
          'content-length',
          'cookie',
          'host',
          'origin',
          'pragma',
          'referer',
          'user-agent',
        ]);

        function collectStrings(target, value, depth = 0, seen = new WeakSet()) {
          if (depth > 4 || value == null) return;
          if (typeof value === 'string') {
            if (value.length > 0) target.push(value);
            try {
              const parsed = JSON.parse(value);
              collectStrings(target, parsed, depth + 1, seen);
            } catch {}
            return;
          }
          if (typeof value === 'number' || typeof value === 'boolean') {
            target.push(String(value));
            return;
          }
          if (typeof value !== 'object') return;
          if (seen.has(value)) return;
          seen.add(value);

          if (Array.isArray(value)) {
            for (const item of value.slice(0, 50)) {
              collectStrings(target, item, depth + 1, seen);
            }
            return;
          }

          for (const [key, nested] of Object.entries(value).slice(0, 100)) {
            target.push(String(key));
            collectStrings(target, nested, depth + 1, seen);
          }
        }

        function collectStorageSnapshot() {
          const values = [];
          for (const storage of [window.localStorage, window.sessionStorage]) {
            try {
              for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (!key) continue;
                values.push(key);
                collectStrings(values, storage.getItem(key));
              }
            } catch {}
          }

          const globals = [
            '__NEXT_DATA__',
            '__NUXT__',
            '__INITIAL_STATE__',
            '__APOLLO_STATE__',
            '__APP_DATA__',
          ];
          for (const key of globals) {
            try {
              if (key in window) {
                values.push(key);
                collectStrings(values, window[key]);
              }
            } catch {}
          }

          try { values.push(document.cookie); } catch {}
          try { values.push(location.href); } catch {}

          return values.join('\\\\n');
        }

        function readStorageValue(possibleKeys) {
          for (const storage of [window.localStorage, window.sessionStorage]) {
            try {
              for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (!key) continue;
                if (possibleKeys.some((candidate) => candidate.toLowerCase() === key.toLowerCase())) {
                  return storage.getItem(key) || '';
                }
              }
            } catch {}
          }
          return '';
        }

        function parseCookies() {
          return String(document.cookie || '')
            .split(/;\\s*/)
            .map((chunk) => {
              const index = chunk.indexOf('=');
              if (index === -1) return [chunk, ''];
              return [chunk.slice(0, index), decodeURIComponent(chunk.slice(index + 1))];
            });
        }

        function matchFirst(haystack, patterns) {
          for (const pattern of patterns) {
            const match = haystack.match(pattern);
            if (match?.[0]) return match[0];
          }
          return '';
        }

        function strictJwtRegex() {
          return /[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/;
        }

        function findAuthorizationToken(haystack) {
          const jwtPattern = strictJwtRegex();

          for (const [cookieName, cookieValue] of parseCookies()) {
            if (!/token|auth/i.test(cookieName)) continue;
            const matched = cookieValue.match(jwtPattern)?.[0];
            if (matched) return matched;
          }

          for (const storage of [window.localStorage, window.sessionStorage]) {
            try {
              for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (!key || !/token|auth/i.test(key)) continue;
                const value = storage.getItem(key) || '';
                const matched = value.match(jwtPattern)?.[0];
                if (matched) return matched;
              }
            } catch {}
          }

          return matchFirst(haystack, [strictJwtRegex()]);
        }

        function resolveDynamicHeader(name, sampleValue, haystack) {
          if (!sampleValue) return '';
          if (
            sampleValue === '__TABWORKS_AUTHORIZATION_RAW__' ||
            sampleValue === '__TABWORKS_AUTHORIZATION_BEARER__'
          ) {
            const token = findAuthorizationToken(haystack);
            if (!token) {
              throw new Error('未能从页面上下文解析 Authorization，请确认当前页面已登录。');
            }
            if (sampleValue === '__TABWORKS_AUTHORIZATION_BEARER__') {
              return token.startsWith('Bearer ') ? token : 'Bearer ' + token;
            }
            return token.startsWith('Bearer ') ? token.slice(7) : token;
          }

          if (sampleValue === '__TABWORKS_SECRET__') {
            const value = readStorageValue([name]) || matchFirst(haystack, [strictJwtRegex()]);
            if (!value) {
              throw new Error('未能从页面上下文解析 ' + name + '，请确认当前页面已登录。');
            }
            return value;
          }

          return sampleValue;
        }

        const haystack = collectStorageSnapshot();
        const headers = {};
        for (const [name, sampleValue] of Object.entries(recordedHeaders)) {
          const lowerName = name.toLowerCase();
          if (CONTROLLED_HEADERS.has(lowerName) || lowerName.startsWith('sec-')) {
            continue;
          }
          const resolved = resolveDynamicHeader(name, sampleValue, haystack);
          if (resolved) headers[name] = resolved;
        }

        if (requestBody != null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['content-type'] = 'application/json;charset=UTF-8';
        }

        const response = await fetch(targetUrl, {
          method,
          credentials: 'include',
          headers,
          ...(requestBody != null && method !== 'GET' ? { body: requestBody } : {}),
        });

        const text = await response.text();
        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }

        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)));
        }
        if (data && typeof data === 'object' && data.success === false) {
          throw new Error(typeof data.msg === 'string' ? data.msg : JSON.stringify(data));
        }

        return data;
      })()
    \`;

    return page.runJs<T>(script, { silent: true });
  }
}
`;
}

// ─── 格式化输出 ──────────────────────────────────────────────────────

export function renderSynthesizeResult(result: SynthesizeResult): string {
  const lines = [
    `代码生成完成：${result.site}`,
    `生成文件：${result.generated.length} 个`,
  ];
  for (const g of result.generated) {
    lines.push(
      `  • ${g.name}（置信度 ${(g.confidence * 100).toFixed(0)}%）→ ${g.path}`,
    );
  }
  if (result.generated.length) {
    lines.push(`\n下一步：检查并补全 TODO 注释，然后运行：`);
    for (const g of result.generated) {
      lines.push(`  tw ${result.site} ${g.name}`);
    }
  }
  return lines.join("\n");
}
