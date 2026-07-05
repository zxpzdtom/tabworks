/**
 * viewer/server.ts — 日志 API 服务
 *
 * 提供 JSON API，由 viewer/ 的 React 应用调用：
 *   GET /api/logs?date=YYYY-MM-DD → 返回指定日期聚合后的执行记录
 *   GET /api/files                → 返回所有可用日志文件日期列表
 *
 * 说明：
 *   默认统一走 `TABWORKS_PORT`（缺省 9527）。
 *   根目录 `make dev` 已改为统一服务入口，本文件仅保留给 viewer 单独开发时使用。
 */

import { readdir, readFile, unlink } from "node:fs/promises";
import { extname, join } from "node:path";

const PORT = Number(process.env.TABWORKS_PORT ?? "9527");
const LOGS_DIR = join(import.meta.dirname, "..", "logs");

// ─── 按 pid 聚合日志条目 ─────────────────────────────────────────────

interface RawEntry {
  level: number;
  time: string;
  pid: number;
  site?: string;
  routine?: string;
  msg: string;
  argv?: string[];
  durationMs?: number;
  rows?: number;
  result?: unknown;
  err?: { message?: string; stack?: string };
  url?: string;
  method?: string;
  requestId?: string;
  headers?: Record<string, string>;
  body?: unknown;
  // tap / input
  selector?: string;
  mode?: string;
  tag?: string;
  text?: string;
  // scroll
  direction?: string;
  distance?: number;
  // screenshot
  format?: string;
  fullPage?: boolean;
  bytes?: number;
  filePath?: string;
  [k: string]: unknown;
}

type Step =
  | { kind: "check"; seq: number; time: string; durationMs: number }
  | { kind: "nav"; seq: number; time: string; url: string; durationMs: number }
  | {
      kind: "run";
      seq: number;
      time: string;
      description: string;
      durationMs: number;
    }
  | {
      kind: "fetch";
      seq: number;
      time: string;
      url: string;
      method: string;
      requestId?: string;
      headers?: Record<string, string>;
      body?: unknown;
      durationMs: number;
      error?: string;
    }
  | { kind: "js"; seq: number; time: string; code: string }
  | { kind: "tab"; seq: number; time: string; url: string }
  | {
      kind: "tap";
      seq: number;
      time: string;
      selector: string;
      mode: string;
      tag?: string;
      text?: string;
      durationMs: number;
    }
  | {
      kind: "input";
      seq: number;
      time: string;
      selector: string;
      text: string;
      durationMs: number;
    }
  | {
      kind: "scroll";
      seq: number;
      time: string;
      direction: string;
      distance: number;
    }
  | { kind: "sleep"; seq: number; time: string; durationMs: number }
  | {
      kind: "screenshot";
      seq: number;
      time: string;
      format: string;
      fullPage: boolean;
      filePath: string;
      bytes: number;
      durationMs: number;
    }
  | {
      kind: "error";
      seq: number;
      time: string;
      message: string;
      stack?: string;
    };

interface Execution {
  pid: number;
  site: string;
  routine: string;
  startTime: string;
  argv: string[];
  status: "running" | "ok" | "error";
  durationMs: number;
  rows?: number;
  result?: unknown;
  error?: string;
  steps: Step[];
}

function aggregateLogs(entries: RawEntry[]): Execution[] {
  const byPid = new Map<number, RawEntry[]>();
  for (const e of entries) {
    if (!byPid.has(e.pid)) byPid.set(e.pid, []);
    byPid.get(e.pid)?.push(e);
  }

  const result: Execution[] = [];

  for (const [pid, rows] of byPid) {
    const start = rows.find((r) => r.msg === "start" && r.site && r.routine);
    if (!start) continue;

    const finish = rows.find((r) => r.msg === "finish");
    const errorEntry = rows.find((r) => r.msg === "error");

    // 配对各阶段的 → / ✓ 日志
    const checkStart = rows.find((r) => r.msg === "check →");
    const checkEnd = rows.find((r) => r.msg === "check ✓");
    const navStart = rows.find((r) => r.msg === "nav →");
    const navEnd = rows.find((r) => r.msg === "nav ✓");
    const runStart = rows.find((r) => r.msg === "run →");
    const runEnd = rows.find((r) => r.msg === "run ✓");
    const tabClose = rows.find((r) => r.msg === "tab ×");

    // 按时间顺序收集所有步骤（固定阶段按时间序手动插入）
    let seq = 0;
    const steps: Step[] = [];

    if (checkStart) {
      steps.push({
        kind: "check",
        seq: ++seq,
        time: checkStart.time,
        durationMs: checkEnd?.durationMs ?? 0,
      });
    }

    if (navStart) {
      steps.push({
        kind: "nav",
        seq: ++seq,
        time: navStart.time,
        url: (navStart.url as string) ?? "",
        durationMs: navEnd?.durationMs ?? 0,
      });
    }

    if (runStart) {
      steps.push({
        kind: "run",
        seq: ++seq,
        time: runStart.time,
        description: (runStart.description as string) ?? "",
        durationMs: runEnd?.durationMs ?? 0,
      });
    }

    // 用已消费索引集合，避免同 URL 多次请求时错误配对
    const usedFetchEnd = new Set<number>();
    const usedFetchErr = new Set<number>();

    for (const r of rows) {
      if (r.msg === "fetch →") {
        // 按 url + requestId 找第一个未被配对的 fetch ← / fetch ✗
        const feIdx = rows.findIndex(
          (e, i) =>
            !usedFetchEnd.has(i) &&
            e.msg === "fetch ←" &&
            e.url === r.url &&
            e.requestId === r.requestId,
        );
        const ferrIdx = rows.findIndex(
          (e, i) =>
            !usedFetchErr.has(i) &&
            e.msg === "fetch ✗" &&
            e.url === r.url &&
            e.requestId === r.requestId,
        );

        if (feIdx >= 0) usedFetchEnd.add(feIdx);
        if (ferrIdx >= 0) usedFetchErr.add(ferrIdx);
        const fe = feIdx >= 0 ? rows[feIdx] : undefined;
        const fetchErr = ferrIdx >= 0 ? rows[ferrIdx] : undefined;

        steps.push({
          kind: "fetch",
          seq: ++seq,
          time: r.time,
          url: r.url ?? "",
          method: r.method ?? "GET",
          requestId: r.requestId,
          headers: r.headers,
          body: r.body,
          durationMs: fe?.durationMs ?? fetchErr?.durationMs ?? 0,
          error: fetchErr?.err?.message,
        });
      } else if (r.msg === "run-js" && r.code) {
        steps.push({
          kind: "js",
          seq: ++seq,
          time: r.time,
          code: r.code as string,
        });
      } else if (r.msg === "tap →" && r.selector) {
        // 找对应的 tap ✓（selector 相同）
        const tapEnd = rows.find(
          (e) =>
            e.msg === "tap ✓" && e.selector === r.selector && e.time >= r.time,
        );
        steps.push({
          kind: "tap",
          seq: ++seq,
          time: r.time,
          selector: r.selector,
          mode: r.mode ?? "dom",
          tag: tapEnd?.tag as string | undefined,
          text: tapEnd?.text as string | undefined,
          durationMs: tapEnd
            ? new Date(tapEnd.time).getTime() - new Date(r.time).getTime()
            : 0,
        });
      } else if (r.msg === "input →" && r.selector) {
        const inputEnd = rows.find(
          (e) =>
            e.msg === "input ✓" &&
            e.selector === r.selector &&
            e.time >= r.time,
        );
        steps.push({
          kind: "input",
          seq: ++seq,
          time: r.time,
          selector: r.selector,
          text: r.text ?? "",
          durationMs: inputEnd
            ? new Date(inputEnd.time).getTime() - new Date(r.time).getTime()
            : 0,
        });
      } else if (r.msg === "scroll" && r.direction) {
        steps.push({
          kind: "scroll",
          seq: ++seq,
          time: r.time,
          direction: r.direction,
          distance: r.distance ?? 0,
        });
      } else if (r.msg === "sleep") {
        steps.push({
          kind: "sleep",
          seq: ++seq,
          time: r.time,
          durationMs: r.durationMs ?? 0,
        });
      } else if (r.msg === "screenshot →") {
        const ssEnd = rows.find(
          (e) => e.msg === "screenshot ✓" && e.time >= r.time,
        );
        steps.push({
          kind: "screenshot",
          seq: ++seq,
          time: r.time,
          format: (r.format as string) ?? "png",
          fullPage: (r.fullPage as boolean) ?? false,
          // screenshot ✓ 日志里记录了 filePath（图片已存入 logs/screenshots/）
          filePath: (ssEnd?.filePath as string) ?? "",
          bytes: ssEnd?.bytes ?? 0,
          durationMs: ssEnd
            ? new Date(ssEnd.time).getTime() - new Date(r.time).getTime()
            : 0,
        });
      }
    }

    // 执行级报错
    if (errorEntry?.err) {
      const e = errorEntry.err as { message?: string; stack?: string };
      steps.push({
        kind: "error",
        seq: ++seq,
        time: errorEntry.time,
        message: e.message ?? String(errorEntry.err),
        stack: e.stack,
      });
    }

    // 关闭标签页（finally 块，无论成功失败都会执行）
    if (tabClose) {
      steps.push({
        kind: "tab",
        seq: ++seq,
        time: tabClose.time,
        url: (tabClose.url as string) ?? "",
      });
    }

    result.push({
      pid,
      site: start.site ?? "",
      routine: start.routine ?? "",
      startTime: start.time,
      argv: start.argv ?? [],
      status: errorEntry ? "error" : finish ? "ok" : "running",
      durationMs: (finish ?? errorEntry)?.durationMs ?? 0,
      rows: finish?.rows,
      result: finish?.result,
      error: (errorEntry?.err as { message?: string })?.message,
      steps,
    });
  }

  return result.sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );
}

async function readLogs(date: string): Promise<Execution[]> {
  try {
    const file = join(LOGS_DIR, `${date}.jsonl`);
    const text = await readFile(file, "utf8");
    const entries = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as RawEntry;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as RawEntry[];
    return aggregateLogs(entries);
  } catch {
    return [];
  }
}

async function listFiles(): Promise<string[]> {
  try {
    const files = await readdir(LOGS_DIR);
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(".jsonl", ""))
      .sort();
  } catch {
    return [];
  }
}

function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── HTTP 服务 ───────────────────────────────────────────────────────

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (pathname === "/api/logs") {
      const date = new URL(req.url).searchParams.get("date") ?? todayDate();
      const logs = await readLogs(date);
      return Response.json({ logs }, { headers: corsHeaders });
    }

    if (pathname === "/api/files") {
      const files = await listFiles();
      return Response.json({ files }, { headers: corsHeaders });
    }

    // GET /api/screenshot?path=/absolute/path/to/file.png
    // 提供截图文件的访问接口（仅允许 logs/screenshots/ 目录下的文件）
    if (pathname === "/api/screenshot") {
      const filePath = new URL(req.url).searchParams.get("path") ?? "";
      const screenshotsDir = join(LOGS_DIR, "screenshots");
      // 安全检查：只允许访问 screenshots 目录内的文件
      if (!filePath.startsWith(screenshotsDir)) {
        return new Response("Forbidden", { status: 403, headers: corsHeaders });
      }
      try {
        const buf = await readFile(filePath);
        const ext = extname(filePath).slice(1) || "png";
        return new Response(buf, {
          headers: { ...corsHeaders, "content-type": `image/${ext}` },
        });
      } catch {
        return new Response("Not Found", { status: 404, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

// ─── 启动时清理旧日志，只保留最新 30 个文件 ──────────────────────────

async function pruneOldLogs(keep = 30) {
  try {
    const files = (await readdir(LOGS_DIR))
      .filter((f) => f.endsWith(".jsonl"))
      .sort(); // 文件名是 YYYY-MM-DD，字典序 = 时间序
    const toDelete = files.slice(0, Math.max(0, files.length - keep));
    await Promise.all(toDelete.map((f) => unlink(join(LOGS_DIR, f))));
    if (toDelete.length) {
      console.log(
        `已清理 ${toDelete.length} 个旧日志文件：${toDelete.join(", ")}`,
      );
    }
  } catch {
    // 目录不存在等情况静默忽略
  }
}

// ─── 启动时清理旧截图，保留最近 keepDays 天内的文件 ──────────────────

async function pruneOldScreenshots(keepDays = 30) {
  const screenshotsDir = join(LOGS_DIR, "screenshots");
  try {
    const files = await readdir(screenshotsDir);
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const toDelete: string[] = [];

    for (const f of files) {
      // 文件名格式：{tabId}_{timestamp}.{ext}，从 timestamp 判断年龄
      const match = f.match(/_(\d{13,})\./);
      if (match) {
        const ts = Number(match[1]);
        if (ts < cutoff) toDelete.push(f);
      }
    }

    await Promise.all(toDelete.map((f) => unlink(join(screenshotsDir, f))));
    if (toDelete.length) {
      console.log(`已清理 ${toDelete.length} 张旧截图（${keepDays} 天前）`);
    }
  } catch {
    // 目录不存在等情况静默忽略
  }
}

await pruneOldLogs();
await pruneOldScreenshots();

console.log(`日志 API 服务已启动：http://localhost:${PORT}`);
console.log(`统一入口已切换到 make dev；本文件仅用于单独调试日志 API`);
