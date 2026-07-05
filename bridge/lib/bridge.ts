/**
 * lib/bridge.ts — Browser Bridge HTTP 客户端
 *
 * 封装与本地 browser-bridge 的通信。
 * 默认固定走统一入口（127.0.0.1:9527）。
 * 提供 Page 实现和 tab 生命周期管理。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Page } from "./types";

const DEFAULT_BRIDGE_PORT = process.env.TABWORKS_PORT || "9527";
const BRIDGE_HOST =
  process.env.TABWORKS_BRIDGE_HOST ??
  `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;

/** 截图保存目录：项目根下的 logs/screenshots/ */
const SCREENSHOTS_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "logs",
  "screenshots",
);

// ─── HTTP 工具 ───────────────────────────────────────────────────────

async function fetchBridgeStatus(host: string): Promise<{
  ok: boolean;
  extensionConnected: boolean;
}> {
  const res = await fetch(`${host}/status`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`Bridge 状态异常（HTTP ${res.status}）`);
  return (await res.json()) as {
    ok: boolean;
    extensionConnected: boolean;
  };
}

async function resolveBridgeHost(): Promise<string> {
  return BRIDGE_HOST;
}

async function callWithHost<T = unknown>(
  host: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${host}${path}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-TabWorks-Bridge": "1",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Bridge 返回非 JSON（${res.status}）：${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    const err = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(`Bridge 错误：${err}`);
  }

  return json as T;
}

async function call<T = unknown>(path: string, body?: unknown): Promise<T> {
  const host = await resolveBridgeHost();
  return callWithHost<T>(host, path, body);
}

// ─── 状态检查 ────────────────────────────────────────────────────────

export async function checkBridge(): Promise<void> {
  let status: { ok: boolean; extensionConnected: boolean };
  const bridgeHost = await resolveBridgeHost();
  try {
    status = await fetchBridgeStatus(bridgeHost);
  } catch {
    throw new Error(
      "Browser Bridge 未启动，请先运行：tw serve、make dev 或 make daemon",
    );
  }
  if (!status.ok) throw new Error("Browser Bridge 状态异常");
  if (!status.extensionConnected) {
    // 扩展未连接：轮询等待最多 30s（扩展安装后会自动连入 bridge）
    process.stderr.write(
      "Chrome 扩展未连接，等待扩展连入（最多 30s）...\n" +
        "如未安装，请从 Chrome Web Store 安装 TabWorks Bridge 扩展。\n",
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const s = await fetchBridgeStatus(bridgeHost);
        if (s.ok && s.extensionConnected) {
          process.stderr.write("Chrome 扩展已连接\n");
          return;
        }
      } catch {
        // bridge 可能短暂不可用，继续等待
      }
    }
    throw new Error(
      "Chrome 扩展未连接（等待超时），请从 Chrome Web Store 安装 TabWorks Bridge 扩展。",
    );
  }
}

// ─── Cookie 读取（扩展侧，绕过页面 CSP）────────────────────────────

/**
 * 通过扩展的 chrome.cookies API 读取指定域名下的 cookie 值。
 * 不受页面 CSP / HttpOnly 限制。
 */
export async function getCookie(domain: string, name: string): Promise<string> {
  const cookies = await call<Array<{ name: string; value: string }>>(
    "/cookies",
    { domain },
  );
  return cookies.find((c) => c.name === name)?.value ?? "";
}

// ─── Tab 生命周期 ────────────────────────────────────────────────────

export async function openTab(
  url: string,
  options: { foreground?: boolean } = {},
): Promise<number> {
  const res = await call<{ pageId: number }>("/open", {
    url,
    foreground: options.foreground,
  });
  return res.pageId;
}

export async function closeTab(pageId: number): Promise<void> {
  await call("/close", { pageId }).catch(() => {});
}

// ─── Page 实现 ───────────────────────────────────────────────────────

export class BridgePage implements Page {
  readonly pageId: number;
  /** 由 Routine 注入，用于记录业务代码直接调用 runJs 的日志 */
  _log?: Logger;

  constructor(pageId: number, log?: Logger) {
    this.pageId = pageId;
    this._log = log;
  }

  async runJs<T = unknown>(
    script: string,
    {
      retries = 3,
      delayMs = 1500,
      silent = false,
    }: { retries?: number; delayMs?: number; silent?: boolean } = {},
  ): Promise<T> {
    // 非静默模式（即业务代码直接调用，而非 pageFetch 内部）记录日志
    if (!silent && this._log) {
      this._log.debug({ code: script.trim() }, "run-js");
    }

    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await call<{ value: T; error?: string }>("/run-js", {
          pageId: this.pageId,
          script,
        });
        if (res.error) throw new Error(res.error);
        return res.value;
      } catch (err) {
        lastErr = err;
        const msg = String(err);
        // 只对 fetch 网络错误重试，业务错误（JS 执行报错）直接抛出
        const isRetryable =
          msg.includes("Failed to fetch") ||
          msg.includes("NetworkError") ||
          msg.includes("Failed to execute 'fetch'");
        if (!isRetryable || i === retries) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  async goto(url: string): Promise<void> {
    await call("/goto", { pageId: this.pageId, url });
  }

  async inspect(): Promise<{ title: string; url: string; readyState: string }> {
    // /inspect 直接返回扁平结构 { title, url, readyState, text, links }，无 .value 包装
    return call<{ title: string; url: string; readyState: string }>(
      "/inspect",
      { pageId: this.pageId },
    );
  }

  async tap(
    selector: string,
    { mode = "dom" }: { mode?: "dom" | "mouse" } = {},
  ): Promise<{ tag: string; text: string }> {
    if (this._log) this._log.debug({ selector, mode }, "tap →");
    const result = await call<{ tag: string; text: string; error?: string }>(
      "/tap",
      {
        pageId: this.pageId,
        selector,
        mode,
      },
    );
    if (result?.error) throw new Error(`tap 失败：${result.error}`);
    if (this._log)
      this._log.debug(
        { selector, mode, tag: result.tag, text: result.text },
        "tap ✓",
      );
    return result;
  }

  async input(selector: string, text: string): Promise<void> {
    if (this._log) this._log.debug({ selector, text }, "input →");
    const result = await call<{ ok?: boolean; error?: string }>("/input", {
      pageId: this.pageId,
      selector,
      text,
    });
    if (result?.error) throw new Error(`input 失败：${result.error}`);
    if (this._log) this._log.debug({ selector }, "input ✓");
  }

  async scroll(
    direction: "up" | "down" | "top" | "bottom",
    distance = 3000,
  ): Promise<void> {
    if (this._log) this._log.debug({ direction, distance }, "scroll");
    await call("/move", { pageId: this.pageId, direction, distance });
  }

  async sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("sleep 毫秒数必须是非负有限数");
    }
    const durationMs = Math.floor(ms);
    if (this._log) this._log.debug({ durationMs }, "sleep");
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  async screenshot({
    format = "png",
    fullPage = false,
  }: {
    format?: "png" | "jpeg";
    fullPage?: boolean;
  } = {}): Promise<string> {
    if (this._log) this._log.debug({ format, fullPage }, "screenshot →");

    // 确保截图目录存在
    await mkdir(SCREENSHOTS_DIR, { recursive: true });

    // 生成唯一文件名并让 bridge 直接写入磁盘
    const ts = Date.now();
    const fileName = `${this.pageId}_${ts}.${format}`;
    const filePath = join(SCREENSHOTS_DIR, fileName);

    // /capture 传入 file 参数时，bridge 把图片写到该路径并返回 { saved: filePath }
    const saved = await call<{ saved: string }>("/capture", {
      pageId: this.pageId,
      format,
      fullPage,
      file: filePath,
    });

    // 读取文件内容，构造 data URI 返回给调用方（API 兼容）
    const buf = await Bun.file(saved.saved).arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    const dataUri = `data:image/${format};base64,${base64}`;

    if (this._log) {
      this._log.debug(
        { format, fullPage, filePath: saved.saved, bytes: buf.byteLength },
        "screenshot ✓",
      );
    }
    return dataUri;
  }

  async waitForLoad(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let stableUrl: string | null = null;
    while (Date.now() < deadline) {
      try {
        // runJs 自带重试，这里关闭重试避免双重等待；silent 避免产生大量轮询日志
        const result = await this.runJs<string>(
          "document.readyState + '|' + location.href",
          { retries: 0, silent: true },
        );
        const [state, url] = result.split("|");
        if (state === "complete") {
          if (url === stableUrl) return; // URL 连续两次相同，认为稳定
          stableUrl = url;
        } else {
          stableUrl = null;
        }
      } catch {
        // 页面导航中，runJs 暂时不可用，继续轮询
        stableUrl = null;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`页面加载超时（${timeoutMs}ms）`);
  }
}
