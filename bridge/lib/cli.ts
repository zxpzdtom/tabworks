/**
 * lib/cli.ts — 复用型 CLI 能力
 *
 * 提供：
 * - routine 发现 / 列表 / 执行
 * - explore / synthesize / clean 子命令
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { exploreUrl, renderExploreResult } from "./explore";
import { recordUrl, renderRecordResult } from "./record";
import type { Routine } from "./routine";
import { renderSynthesizeResult, synthesize } from "./synthesize";

const SITES_DIR = join(import.meta.dir, "..", "sites");
const DEFAULT_BRIDGE_PORT = process.env.TABWORKS_PORT || "9527";
const BRIDGE_HOST =
  process.env.TABWORKS_BRIDGE_HOST ??
  `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;

export async function loadRoutine(
  site: string,
  name: string,
): Promise<Routine> {
  const filePath = join(SITES_DIR, site, `${name}.ts`);
  let mod: { default?: new () => Routine };
  try {
    mod = await import(filePath);
  } catch (e: unknown) {
    throw new Error(
      `找不到 ${site}/${name}：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!mod.default) throw new Error(`${site}/${name}.ts 没有 default export`);
  const routine = new mod.default();
  if (
    typeof routine.site !== "string" ||
    routine.site.length === 0 ||
    typeof routine.name !== "string" ||
    routine.name.length === 0 ||
    typeof routine.description !== "string" ||
    routine.description.length === 0 ||
    typeof routine.url !== "string" ||
    routine.url.length === 0
  ) {
    throw new Error(`${site}/${name}.ts 缺少必要的 routine 元数据`);
  }
  return routine;
}

export async function listRoutines(): Promise<Routine[]> {
  const routines: Routine[] = [];
  let siteDirs: string[];
  try {
    siteDirs = await readdir(SITES_DIR);
  } catch {
    return [];
  }

  for (const site of siteDirs.sort()) {
    if (site.startsWith("_")) continue;
    let files: string[];
    try {
      files = await readdir(join(SITES_DIR, site));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      if (
        !file.endsWith(".ts") ||
        file.startsWith("_") ||
        file.endsWith(".test.ts") ||
        file.endsWith(".integration.test.ts")
      ) {
        continue;
      }
      try {
        routines.push(await loadRoutine(site, file.replace(/\.ts$/, "")));
      } catch {
        /* 跳过加载失败的 routine */
      }
    }
  }

  return routines;
}

export function formatRoutineList(routines: Routine[]): string {
  if (!routines.length) {
    return "暂无可用 Routine";
  }

  const riskLabel: Record<string, string> = {
    readonly: "只读",
    low: "低风险",
    medium: "中风险",
    high: "高风险",
  };
  const siteW = Math.max(...routines.map((routine) => routine.site.length));
  const nameW = Math.max(...routines.map((routine) => routine.name.length));

  const lines = ["可用 Routine：", ""];
  let lastSite = "";

  for (const routine of routines) {
    if (routine.site !== lastSite) {
      if (lastSite) lines.push("");
      lastSite = routine.site;
    }
    lines.push(
      `  ${routine.site.padEnd(siteW)}  ${routine.name.padEnd(nameW)}  [${riskLabel[routine.risk] ?? routine.risk}]  ${routine.description}`,
    );
  }

  lines.push("", "用法：tw <site> <name> [--arg value ...]");
  return lines.join("\n");
}

export function parseArgv(argv: string[]): {
  flags: Record<string, string>;
  positionals: string[];
} {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }

  return { flags, positionals };
}

export function parseFlags(argv: string[]): Record<string, string> {
  return parseArgv(argv).flags;
}

async function callBridge<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BRIDGE_HOST}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TabWorks-Bridge": "1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export async function executeUiRecord(argv: string[]): Promise<string> {
  const { flags, positionals } = parseArgv(argv);
  const op = positionals[0];

  if (!op || !["start", "stop", "status"].includes(op)) {
    throw new Error(
      "用法：tw ui-record <start|stop|status> [sessionId] [--tab-id <id>]",
    );
  }

  if (op === "start") {
    const result = await callBridge<{
      sessionId: string;
      tabId?: number;
      url?: string;
      title?: string;
      outDir: string;
    }>("/recording/start", {
      tabId: flags["tab-id"] ? Number(flags["tab-id"]) : undefined,
    });
    return [
      "UI 录制已开始",
      `sessionId：${result.sessionId}`,
      `tabId：${result.tabId ?? "当前标签页"}`,
      `标题：${result.title || "（无）"}`,
      `URL：${result.url || "（未知）"}`,
      "",
      `停止：tw ui-record stop ${result.sessionId}`,
    ].join("\n");
  }

  if (op === "stop") {
    const sessionId = positionals[1] ?? flags.session;
    if (!sessionId) throw new Error("停止录制需要 sessionId");
    const result = await callBridge<{
      sessionId: string;
      eventCount: number;
      outDir: string;
      url?: string;
      title?: string;
    }>("/recording/stop", { sessionId });
    return [
      "UI 录制已停止",
      `sessionId：${result.sessionId}`,
      `事件数：${result.eventCount}`,
      `标题：${result.title || "（无）"}`,
      `URL：${result.url || "（未知）"}`,
      `产物：${result.outDir}/session.json`,
    ].join("\n");
  }

  const status = await callBridge<{
    recordings: Array<{
      sessionId: string;
      tabId?: number;
      url?: string;
      title?: string;
      startedAt: string;
      eventCount: number;
      outDir: string;
    }>;
  }>("/recording/status", {});

  if (!status.recordings.length) return "当前没有进行中的 UI 录制。";
  return status.recordings
    .map((item) =>
      [
        `${item.sessionId}  tab=${item.tabId ?? "?"}  events=${item.eventCount}`,
        `  标题：${item.title || "（无）"}`,
        `  URL：${item.url || "（未知）"}`,
        `  开始：${item.startedAt}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export async function executeExplore(argv: string[]): Promise<string> {
  const flags = parseFlags(argv);

  if (!flags.url || !flags.site) {
    throw new Error(
      "用法：tw explore --url <页面URL> --site <站点名> [--name <能力名>] [--wait <等待毫秒>]",
    );
  }

  const result = await exploreUrl({
    url: flags.url,
    site: flags.site,
    name: flags.name,
    waitMs: flags.wait ? parseInt(flags.wait, 10) : 3000,
  });

  return renderExploreResult(result);
}

export async function executeRecord(argv: string[]): Promise<string> {
  const { flags, positionals } = parseArgv(argv);
  const url = positionals[0] ?? flags.url;

  if (!url) {
    throw new Error(
      "用法：tw record <页面URL> [--site <站点名>] [--name <能力名>] [--timeout <秒数>]",
    );
  }

  const timeoutSeconds = flags.timeout ? parseInt(flags.timeout, 10) : 120;
  if (Number.isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("--timeout 必须为正整数");
  }

  const result = await recordUrl({
    url,
    site: flags.site,
    name: flags.name,
    timeoutMs: timeoutSeconds * 1000,
  });

  return renderRecordResult(result);
}

export async function executeSynthesize(argv: string[]): Promise<string> {
  const flags = parseFlags(argv);

  if (!flags.site) {
    throw new Error(
      "用法：tw synthesize --site <站点名> [--capability <能力名>]",
    );
  }

  const result = await synthesize({
    site: flags.site,
    capability: flags.capability,
  });

  return renderSynthesizeResult(result);
}

export async function executeClean(argv: string[]): Promise<string> {
  const flags = parseFlags(argv);
  const targetSite = flags.site ?? "";
  const days = flags.days ? parseInt(flags.days, 10) : 7;

  if (Number.isNaN(days) || days < 0) {
    throw new Error("--days 必须为非负整数");
  }

  const exploreDir = join(import.meta.dir, "..", "..", ".bridge", "explore");
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const lines: string[] = [];

  let siteDirs: string[];
  try {
    siteDirs = await readdir(exploreDir);
  } catch {
    return "没有找到 explore 产物目录（.bridge/explore/），无需清理。";
  }

  let removed = 0;
  let skipped = 0;

  for (const site of siteDirs) {
    if (targetSite && site !== targetSite) continue;

    const siteDir = join(exploreDir, site);
    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
      dirStat = await stat(siteDir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    const mtime = dirStat.mtimeMs;
    if (days === 0 || mtime < cutoff) {
      await rm(siteDir, { recursive: true, force: true });
      lines.push(`  已删除：.bridge/explore/${site}/`);
      removed++;
    } else {
      const daysOld = Math.floor((Date.now() - mtime) / (24 * 60 * 60 * 1000));
      lines.push(
        `  保留  ：.bridge/explore/${site}/（${daysOld} 天前，未超过 ${days} 天）`,
      );
      skipped++;
    }
  }

  if (removed === 0 && skipped === 0) {
    lines.push(
      targetSite
        ? `没有找到站点 "${targetSite}" 的 explore 产物。`
        : "没有找到任何 explore 产物。",
    );
  } else {
    lines.push("", `清理完成：删除 ${removed} 个，保留 ${skipped} 个。`);
  }

  return lines.join("\n");
}

export async function executeRoutine(
  site: string,
  name: string,
  argv: string[],
): Promise<void> {
  const routine = await loadRoutine(site, name);
  await routine.exec(argv);
}
