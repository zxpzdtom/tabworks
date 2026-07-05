/**
 * lib/types.ts — 公共类型定义
 */

// ─── 参数 ────────────────────────────────────────────────────────────

export type ArgType = "string" | "int" | "float" | "boolean";
export type ArgValue = string | number | boolean;

export interface ArgDef {
  name: string;
  type: ArgType;
  default?: ArgValue;
  help?: string;
  required?: boolean;
}

/** 解析后的参数 map */
export type Args = Record<string, ArgValue>;

// ─── 输出 ────────────────────────────────────────────────────────────

/** 一行数据，key 为列名 */
export type Row = Record<string, unknown>;

export type Format = "table" | "json";

// ─── 风险等级 ────────────────────────────────────────────────────────

/**
 * readonly — 纯读取，无副作用，直接执行
 * low      — 轻微写操作（如切换偏好），直接执行
 * medium   — 有影响的写操作，展示详情后等用户确认
 * high     — 高风险操作（发布、删除等），必须输入 yes 才执行
 */
export type Risk = "readonly" | "low" | "medium" | "high";

// ─── 页面上下文 ──────────────────────────────────────────────────────

export interface Page {
  readonly pageId: number;
  runJs<T = unknown>(
    script: string,
    options?: { retries?: number; delayMs?: number; silent?: boolean },
  ): Promise<T>;
  goto(url: string): Promise<void>;
  inspect(): Promise<{ title: string; url: string; readyState: string }>;
  /** 等待页面加载完成（readyState === 'complete'），最多等 timeoutMs 毫秒 */
  waitForLoad(timeoutMs?: number): Promise<void>;
  /** 点击 CSS 选择器匹配的元素 */
  tap(
    selector: string,
    options?: { mode?: "dom" | "mouse" },
  ): Promise<{ tag: string; text: string }>;
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
}
