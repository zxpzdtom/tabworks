import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { listResolvedRoutines } from "./discovery";
import { bridgeHost, ensureTabworksHome } from "./paths";
import { daemonStatusSnapshot } from "./service";

export async function doctorReport(): Promise<Record<string, unknown>> {
  const paths = await ensureTabworksHome();
  let homeWritable = true;
  let homeError = "";
  try { await access(paths.home, constants.R_OK | constants.W_OK); }
  catch (error) { homeWritable = false; homeError = error instanceof Error ? error.message : String(error); }

  let routineCount = 0;
  let routineError = "";
  try { routineCount = (await listResolvedRoutines()).length; }
  catch (error) { routineError = error instanceof Error ? error.message : String(error); }

  const daemon = await daemonStatusSnapshot();
  const bridge = daemon.bridge as Record<string, unknown> | null;
  let viewer = false;
  if (bridge?.ok) {
    try { viewer = (await fetch(`${bridgeHost()}/`, { method: "HEAD", signal: AbortSignal.timeout(1500) })).ok; }
    catch { viewer = false; }
  }

  const nodeCheck = spawnSync("node", ["--version"], { encoding: "utf8" });
  const nodeVersion = nodeCheck.status === 0 ? nodeCheck.stdout.trim().replace(/^v/, "") : null;
  return {
    ok: homeWritable && !routineError && Boolean(bridge?.ok),
    runtime: { bun: Bun.version, node: nodeVersion, nodeAvailable: Boolean(nodeVersion) },
    home: { path: paths.home, configFile: paths.configFile, writable: homeWritable, error: homeError || null },
    routines: { count: routineCount, error: routineError || null },
    daemon: { running: daemon.running, pid: daemon.pid, stateFile: daemon.stateFile, logFile: daemon.logFile },
    bridge: {
      running: Boolean(bridge?.ok),
      host: bridgeHost(),
      socketConnected: Boolean(bridge?.socketConnected),
      extensionConnected: Boolean(bridge?.extensionConnected),
      extensionVersion: bridge?.extensionVersion ?? null,
      lastExtensionResponseAt: bridge?.lastExtensionResponseAt ?? null,
      pendingCommands: bridge?.pendingCommands ?? 0,
    },
    viewer: { running: viewer, url: bridgeHost() },
  };
}

export function formatDoctor(report: Record<string, unknown>): string {
  const runtime = report.runtime as Record<string, unknown>;
  const home = report.home as Record<string, unknown>;
  const routines = report.routines as Record<string, unknown>;
  const daemon = report.daemon as Record<string, unknown>;
  const bridge = report.bridge as Record<string, unknown>;
  const viewer = report.viewer as Record<string, unknown>;
  return [
    `Bun: ${runtime.bun}`,
    `Node: ${runtime.node}`,
    `用户目录: ${home.writable ? "可用" : "不可用"} (${home.path})`,
    `Routine: ${routines.count}${routines.error ? `，错误：${routines.error}` : ""}`,
    `Daemon: ${daemon.running ? `运行中 (pid ${daemon.pid})` : "未运行"}`,
    `Bridge: ${bridge.running ? "运行中" : "未运行"} (${bridge.host})`,
    `扩展: ${bridge.extensionConnected ? `已连接 v${bridge.extensionVersion ?? "unknown"}` : bridge.socketConnected ? "socket 已连接但未健康响应" : "未连接"}`,
    `Viewer: ${viewer.running ? "可访问" : "不可访问"} (${viewer.url})`,
  ].join("\n");
}

export async function extensionStatusReport(): Promise<Record<string, unknown>> {
  const report = await doctorReport();
  return { bridge: report.bridge, daemon: report.daemon };
}
