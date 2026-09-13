import { spawn } from "node:child_process";
import http from "node:http";
import {
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bridgeHost, bridgePort, ensureTabworksHome, PROJECT_DIR, tabworksPaths } from "./paths";

const USER_PATHS = tabworksPaths();
const BRIDGE_ENTRY = USER_PATHS.bridgeEntry;
const DAEMON_META_FILE = USER_PATHS.daemonFile;
const DAEMON_LOG_FILE = USER_PATHS.daemonLogFile;

type BridgeStatusPayload = {
  ok?: boolean;
  host?: string;
  port?: number;
  pid?: number;
  startedAt?: string;
  uptimeMs?: number;
  extensionConnected?: boolean;
  extensionVersion?: string | null;
  pendingCommands?: number;
  socketConnected?: boolean;
  lastExtensionResponseAt?: string | null;
  lastExtensionResponseAgeMs?: number | null;
};

type DaemonMeta = {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  logFile: string;
  entry?: string;
};

export function classifyDaemonState(
  meta: DaemonMeta | null,
  bridgeOnline: boolean,
  processAlive: boolean,
  expectedEntry = BRIDGE_ENTRY,
): "healthy" | "absent" | "stale" | "recoverable" | "unsafe" {
  if (bridgeOnline) return "healthy";
  if (!meta) return "absent";
  if (!processAlive) return "stale";
  return meta.entry === expectedEntry ? "recoverable" : "unsafe";
}

function normalizedPort(port?: string): string {
  return bridgePort(port);
}

export function bridgeUrl(port?: string): string {
  return bridgeHost(port);
}

async function requestBridge(
  path: string,
  options: { method?: string; port?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${bridgeUrl(options.port)}${path}`, {
    method: options.method ?? "GET",
    headers:
      options.method && options.method !== "GET"
        ? { "X-TabWorks-Bridge": "1" }
        : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? Number(process.env.TABWORKS_BRIDGE_REQUEST_TIMEOUT_MS || 3000)),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

async function fetchBridgeStatus(
  port?: string,
  timeoutMs = 1500,
): Promise<BridgeStatusPayload | null> {
  try {
    const result = await requestBridge("/status", { port, timeoutMs });
    if (!result.ok) return null;
    return (result.data ?? null) as BridgeStatusPayload | null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureStateDir(): Promise<void> {
  await ensureTabworksHome();
}

async function readDaemonMeta(): Promise<DaemonMeta | null> {
  try {
    const value = JSON.parse(await readFile(DAEMON_META_FILE, "utf8")) as Partial<DaemonMeta>;
    if (!Number.isInteger(value.pid) || !value.host || !Number.isInteger(value.port)) return null;
    return value as DaemonMeta;
  } catch {
    return null;
  }
}

async function writeDaemonMeta(meta: DaemonMeta): Promise<void> {
  await ensureStateDir();
  await writeFile(DAEMON_META_FILE, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

async function clearDaemonMeta(): Promise<void> {
  await rm(DAEMON_META_FILE, { force: true }).catch(() => {});
}

function isProcessAlive(pid?: number): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForBridgeOnline(
  port?: string,
  maxMs = 5000,
): Promise<BridgeStatusPayload | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const status = await fetchBridgeStatus(port);
    if (status?.ok) return status;
    await sleep(200);
  }
  return null;
}

async function waitForBridgeOffline(port?: string, maxMs = 5000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const status = await fetchBridgeStatus(port, 500);
    if (!status?.ok) return true;
    await sleep(200);
  }
  return false;
}

async function waitForProcessExit(pid: number, maxMs = 3000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(200);
  }
  return !isProcessAlive(pid);
}

async function cleanupStaleDaemonMeta(port?: string): Promise<DaemonMeta | null> {
  const meta = await readDaemonMeta();
  if (!meta) return null;
  if (port && String(meta.port) !== normalizedPort(port)) return meta;
  if (isProcessAlive(meta.pid)) return meta;
  const status = await fetchBridgeStatus(port, 500);
  if (!status?.ok) {
    await clearDaemonMeta();
    return null;
  }
  return meta;
}

async function recoverUnhealthyDaemon(meta: DaemonMeta | null, port?: string): Promise<void> {
  const state = classifyDaemonState(meta, false, Boolean(meta && isProcessAlive(meta.pid)));
  if (state === "absent" || state === "stale") {
    await clearDaemonMeta();
    return;
  }
  if (state === "unsafe" || !meta) {
    throw new Error(`daemon: 状态文件指向仍存活的未知进程 ${meta?.pid ?? "unknown"}；已停止自动恢复，请人工检查`);
  }
  try {
    process.kill(meta.pid, "SIGTERM");
  } catch {
    await clearDaemonMeta();
    return;
  }
  if (!(await waitForProcessExit(meta.pid, 3000))) {
    throw new Error(`daemon: 异常进程 ${meta.pid} 无法安全停止`);
  }
  await clearDaemonMeta();
  await waitForBridgeOffline(port, 1500);
}

export async function showBridgeStatus(json = false, port?: string): Promise<void> {
  const status = await fetchBridgeStatus(port);

  if (!status?.ok) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            running: false,
            url: `${bridgeUrl(port)}/status`,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`bridge: not running (${bridgeUrl(port)})`);
    return;
  }

  const host =
    status.host && status.port
      ? `http://${status.host}:${status.port}`
      : bridgeUrl(port);

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(`bridge: running (${host})`);
  console.log(
    `extension: ${status.extensionConnected ? "connected" : "disconnected"}`,
  );
  console.log(`version: ${status.extensionVersion ?? "unknown"}`);
  console.log(`pending: ${status.pendingCommands ?? 0}`);
}

export async function stopBridgeService(port?: string): Promise<void> {
  try {
    const result = await requestBridge("/shutdown", {
      method: "POST",
      port,
    });
    if (!result.ok) {
      throw new Error(`HTTP ${result.status}`);
    }
    console.log("bridge: stopped");
  } catch {
    console.log("bridge: not running");
  }
}

export async function startBridgeService(port?: string): Promise<void> {
  if (port) process.env.TABWORKS_PORT = port;
  const href = `${pathToFileURL(BRIDGE_ENTRY).href}?t=${Date.now()}`;
  await import(href);
}

export async function startBridgeDaemon(port?: string, options: { quiet?: boolean } = {}): Promise<void> {
  const output = (...values: unknown[]) => { if (!options.quiet) console.log(...values); };
  await ensureTabworksHome();
  const running = await fetchBridgeStatus(port);
  if (running?.ok) {
    output(
      `daemon: running (${bridgeUrl(port)}${running.extensionConnected ? "，扩展已连接" : "，等待扩展连接"})`,
    );
    return;
  }

  const meta = await cleanupStaleDaemonMeta(port);
  if (meta && isProcessAlive(meta.pid)) {
    const ready = await waitForBridgeOnline(port, 4000);
    if (ready?.ok) {
      output(
        `daemon: running (${bridgeUrl(port)}${ready.extensionConnected ? "，扩展已连接" : "，等待扩展连接"})`,
      );
      return;
    }
    await recoverUnhealthyDaemon(meta, port);
  }

  await ensureStateDir();
  const logHandle = await open(DAEMON_LOG_FILE, "a");
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: PROJECT_DIR,
    detached: true,
    env: {
      ...process.env,
      ...(port ? { TABWORKS_PORT: port } : {}),
    },
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  child.unref();
  await logHandle.close();

  if (!child.pid) {
    throw new Error("daemon: 启动失败，未获取到子进程 PID");
  }

  await writeDaemonMeta({
    pid: child.pid,
    host: bridgeUrl(port),
    port: parseInt(normalizedPort(port), 10),
    startedAt: new Date().toISOString(),
    logFile: DAEMON_LOG_FILE,
    entry: BRIDGE_ENTRY,
  });

  const ready = await waitForBridgeOnline(port, 5000);
  if (!ready?.ok) {
    await clearDaemonMeta();
    throw new Error(`daemon: 启动失败，请查看日志 ${DAEMON_LOG_FILE}`);
  }

  output(`daemon: started (pid ${child.pid}) ${bridgeUrl(port)}`);
  output(`daemon: log ${DAEMON_LOG_FILE}`);
}

export async function stopBridgeDaemon(port?: string): Promise<void> {
  const status = await fetchBridgeStatus(port);
  if (status?.ok) {
    const stopped = await new Promise<boolean>((resolve) => {
      const target = new URL("/shutdown", bridgeUrl(port));
      const req = http.request(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: "POST",
          timeout: 3000,
          headers: {
            "Content-Type": "application/json",
            "X-TabWorks-Bridge": "1",
          },
        },
        (res) => resolve(res.statusCode === 200),
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });

    if (!stopped) {
      throw new Error("daemon: 关闭请求失败");
    }

    await waitForBridgeOffline(port, 5000);
    await clearDaemonMeta();
    console.log("daemon: stopped");
    return;
  }

  const meta = await cleanupStaleDaemonMeta(port);
  if (meta && isProcessAlive(meta.pid)) {
    try {
      process.kill(meta.pid, "SIGTERM");
    } catch {
      /* ignore */
    }

    if (!(await waitForProcessExit(meta.pid, 3000))) {
      throw new Error(`daemon: 进程 ${meta.pid} 未在预期时间内退出`);
    }

    await clearDaemonMeta();
    console.log(`daemon: stopped (pid ${meta.pid})`);
    return;
  }

  await clearDaemonMeta();
  console.log("daemon: not running");
}

export async function showBridgeDaemonStatus(
  json = false,
  port?: string,
): Promise<void> {
  const status = await fetchBridgeStatus(port);
  const meta = await cleanupStaleDaemonMeta(port);
  const host =
    status?.host && status?.port
      ? `http://${status.host}:${status.port}`
      : meta?.host ?? bridgeUrl(port);
  const payload = {
    running: Boolean(status?.ok),
    host,
    port: status?.port ?? meta?.port ?? parseInt(normalizedPort(port), 10),
    pid: status?.pid ?? meta?.pid ?? null,
    startedAt: status?.startedAt ?? meta?.startedAt ?? null,
    uptimeMs: status?.uptimeMs ?? null,
    extensionConnected: Boolean(status?.extensionConnected),
    extensionVersion: status?.extensionVersion ?? null,
    pendingCommands: status?.pendingCommands ?? 0,
    logFile: meta?.logFile ?? DAEMON_LOG_FILE,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!payload.running) {
    console.log(`daemon: stopped (${payload.host})`);
    console.log(`daemon: log ${payload.logFile}`);
    return;
  }

  console.log(`daemon: running (${payload.host})`);
  console.log(
    `daemon: pid ${payload.pid ?? "unknown"}，端口 ${payload.port}，扩展${payload.extensionConnected ? "已连接" : "未连接"}`,
  );
  if (payload.startedAt) {
    console.log(`daemon: startedAt ${payload.startedAt}`);
  }
  console.log(`daemon: log ${payload.logFile}`);
}

export async function daemonStatusSnapshot(port?: string): Promise<Record<string, unknown>> {
  const status = await fetchBridgeStatus(port);
  const meta = await cleanupStaleDaemonMeta(port);
  return {
    running: Boolean(status?.ok),
    pid: status?.pid ?? meta?.pid ?? null,
    port: status?.port ?? meta?.port ?? Number(normalizedPort(port)),
    stateFile: DAEMON_META_FILE,
    logFile: DAEMON_LOG_FILE,
    bridge: status,
  };
}
