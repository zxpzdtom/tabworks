/**
 * lib/types.ts — 公共类型定义
 */

// ─── 参数 ────────────────────────────────────────────────────────────

export type ArgType = "string" | "int" | "float" | "boolean";
export type ArgValue = string | number | boolean;

export interface ArgDef {
  name: string;
  type: ArgType;
  default?: ArgValue | (() => ArgValue | Promise<ArgValue>);
  help?: string;
  required?: boolean;
}

/** 解析后的参数 map */
export type Args = Record<string, ArgValue>;

// ─── 输出 ────────────────────────────────────────────────────────────

/** 一行数据，key 为列名 */
export type Row = Record<string, unknown>;

export type Format = "auto" | "table" | "list" | "json";

// ─── 风险等级 ────────────────────────────────────────────────────────

/**
 * readonly — 纯读取，无副作用，直接执行
 * low      — 轻微写操作（如切换偏好），直接执行
 * medium   — 有影响的写操作，展示详情后等用户确认
 * high     — 高风险操作（发布、删除等），必须输入 yes 才执行
 */
export type Risk = "readonly" | "low" | "medium" | "high";

export type NavReady = "load" | "url";
export type RoutineSourceKind = "user" | "plugin" | "builtin";

export interface RoutineSource {
  kind: RoutineSourceKind;
  label: string;
  path: string;
  packageName?: string;
}

// ─── 页面上下文 ──────────────────────────────────────────────────────

export interface Page {
  readonly pageId: number;
  runJs<T = unknown>(
    script: string,
    options?: { retries?: number; delayMs?: number; silent?: boolean },
  ): Promise<T>;
  goto(url: string, options?: { waitUntil?: "none" | "load"; timeoutMs?: number }): Promise<void>;
  inspect(): Promise<{ title: string; url: string; readyState: string }>;
  /** 等待页面加载完成（readyState === 'complete'），最多等 timeoutMs 毫秒 */
  waitForLoad(timeoutMs?: number): Promise<void>;
  waitForUrl(timeoutMs?: number): Promise<void>;
  /** 点击 CSS 选择器匹配的元素 */
  tap(
    selector: string,
    options?: { mode?: "dom" | "mouse" },
  ): Promise<{ tag: string; text: string }>;
  press(
    target: string | { x: number; y: number },
    options?: { durationMs?: number; offsetX?: number; offsetY?: number },
  ): Promise<Record<string, unknown>>;
  drag(
    from: string | { x: number; y: number },
    to: string | { x: number; y: number } | { deltaX: number; deltaY: number },
    options?: { durationMs?: number },
  ): Promise<Record<string, unknown>>;
  key(key: string): Promise<void>;
  /** 向输入框写入文字 */
  input(selector: string, text: string): Promise<void>;
  /** 滚动页面 */
  scroll(
    direction: "up" | "down" | "top" | "bottom",
    distance?: number,
  ): Promise<void>;
  /** 等待指定毫秒数，用于等待页面异步加载或动画完成 */
  sleep(ms: number): Promise<void>;
  /** 截图，返回 base64 数据 URI */
  screenshot(options?: {
    format?: "png" | "jpeg";
    fullPage?: boolean;
  }): Promise<string>;
  request<T = unknown>(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    sameOriginOnly?: boolean;
  }): Promise<{ ok: boolean; status: number; url: string; headers: Array<[string, string]>; text: string; json: T | null }>;
}

export interface RoutineSdk {
  pageFetch<T = unknown>(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    requestId?: string;
  }): Promise<T>;
  getCookie(domain: string, name: string): Promise<string>;
}

export interface ObjectRoutine {
  site: string;
  name: string;
  description: string;
  url: string;
  risk: Risk;
  args?: ArgDef[];
  columns?: string[];
  requiresBrowser?: boolean;
  navReady?: NavReady;
  navTimeoutMs?: number;
  navOptional?: boolean;
  run(page: Page | null, args: Args, sdk: RoutineSdk): Promise<Row[]> | Row[];
  describeAction?(args: Args): string;
  resolveRisk?(args: Args): Risk | Promise<Risk>;
  resolveUrl?(args: Args): string | Promise<string>;
}

export interface PluginManifest {
  site: string;
  title: string;
  description: string;
  version: string;
  pluginApiVersion: number;
  routines: string[];
}
