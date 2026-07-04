#!/usr/bin/env node
/**
 * TabWorks Bridge — 本地桥接服务
 *
 * 架构：
 *
 *   AI Agent
 *     → HTTP (port 9527)         /run-js、/open、/navigate 等
 *     → browser-bridge.mjs       本文件，统一提供 viewer / 日志 API / bridge / WebSocket
 *     → WebSocket /ext           Chrome 扩展主动连入
 *     → chrome.debugger API      无横幅、无确认弹窗
 *     → 用户已登录的 Chrome 标签页
 *
 * 安全机制：
 *   1. HTTP 仅监听 127.0.0.1，不对外网暴露
 *   2. WebSocket /ext 端点通过 origin 校验只接受 chrome-extension:// 连接
 *   3. HTTP 接口要求自定义 Header: X-TabWorks-Bridge: 1，防止简单请求绕过
 *   4. 不设置 CORS 响应头，浏览器页面脚本无法读取响应
 */

import http from "node:http";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { extname, join, relative } from "node:path";
import { WebSocketServer } from "ws";

const HOST = "127.0.0.1";
const PORT = parseInt(process.env.TABWORKS_PORT || "9527", 10);
const IDLE_TIMEOUT = Math.max(
  0,
  parseInt(process.env.TABWORKS_IDLE_TIMEOUT_MS || "0", 10) || 0,
);
const STARTED_AT = Date.now();
const PROJECT_DIR = join(import.meta.dirname, "..", "..");
const LOGS_DIR = join(PROJECT_DIR, "logs");
const SCREENSHOTS_DIR = join(LOGS_DIR, "screenshots");
const UI_RECORDINGS_DIR = join(PROJECT_DIR, ".bridge", "ui-record");
const VIEWER_DIST_DIR = join(PROJECT_DIR, "viewer", "dist");
const INDEX_HTML = join(VIEWER_DIST_DIR, "index.html");
const BRIDGE_ROUTES = new Set([
  "/logs",
  "/pages",
  "/open",
  "/goto",
  "/close",
  "/inspect",
  "/run-js",
  "/tap",
  "/press",
  "/drag",
  "/key",
  "/input",
  "/move",
  "/capture",
  "/request",
  "/cookies",
  "/sessions",
  "/recording/start",
  "/recording/stop",
  "/recording/status",
  "/recording/replay",
  "/shutdown",
]);
const VIEWER_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const STATIC_CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

// ─── 扩展连接状态 ────────────────────────────────────────────────────

let extensionWs = null; // Chrome 扩展的 WebSocket 连接
let extensionVersion = null; // 扩展上报的版本号
const pending = new Map(); // 等待扩展回复的请求 Map<id, {resolve, reject, timer}>
let nextId = 0;
const logBuffer = []; // 扩展转发的 console 日志（最多 200 条）
const MAX_LOG_BUFFER = 200;
const uiRecordings = new Map();

function isExtensionConnected() {
  return extensionWs !== null && extensionWs.readyState === 1; // WebSocket.OPEN = 1
}

// ─── 向扩展发送命令 ──────────────────────────────────────────────────

function sendToExtension(command) {
  return new Promise((resolve, reject) => {
    if (!isExtensionConnected()) {
      return reject(
        new Error(
          "扩展未连接。请安装 tabworks Chrome 扩展并确保 bridge 正在运行。\n" +
            "安装方法：打开 chrome://extensions → 开启开发者模式 → 加载已解压扩展 → 选择 extension/ 目录",
        ),
      );
    }

    const id = `cmd_${++nextId}_${Date.now()}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`命令超时（30s）：${command.action}`));
    }, 30000);

    pending.set(id, { resolve, reject, timer });
    extensionWs.send(JSON.stringify({ ...command, id }));
  });
}

// ─── HTTP 请求工具 ───────────────────────────────────────────────────

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

async function parseJson(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

function respond(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // 不设置 CORS 头，防止浏览器页面读取响应
  res.end(JSON.stringify(payload));
}

function respondWithHeaders(res, statusCode, payload, headers = {}) {
  res.statusCode = statusCode;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function respondText(res, statusCode, text, headers = {}) {
  res.statusCode = statusCode;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.end(text);
}

function requireField(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${fieldName} 字段不能为空`);
  }
}

function requireFiniteNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${fieldName} 字段必须是数字`);
  return number;
}

async function elementPoint(tabId, selector, workspace, options = {}) {
  requireField(selector, "selector");
  const offsetX =
    options.offsetX === undefined || options.offsetX === null
      ? null
      : requireFiniteNumber(options.offsetX, "offsetX");
  const offsetY =
    options.offsetY === undefined || options.offsetY === null
      ? null
      : requireFiniteNumber(options.offsetY, "offsetY");
  const result = await sendToExtension({
    action: "exec",
    tabId,
    code: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'not found' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const offsetX = ${JSON.stringify(offsetX)};
      const offsetY = ${JSON.stringify(offsetY)};
      return {
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 200),
        x: rect.x + (offsetX == null ? rect.width / 2 : offsetX),
        y: rect.y + (offsetY == null ? rect.height / 2 : offsetY),
        width: rect.width,
        height: rect.height
      };
    })()`,
    workspace,
  });
  if (!result || result.error) throw new Error("元素未找到");
  return result;
}

async function elementCenter(tabId, selector, workspace) {
  return elementPoint(tabId, selector, workspace);
}

function isSubPath(baseDir, targetPath) {
  const rel = relative(baseDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
}

function isTrustedOrigin(origin) {
  if (!origin) return true;
  return (
    origin.startsWith("chrome-extension://") ||
    origin === `http://${HOST}:${PORT}` ||
    origin === `http://localhost:${PORT}`
  );
}

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function createRecordingSessionId() {
  return `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getRecordingStatus() {
  return [...uiRecordings.values()].map((recording) => ({
    sessionId: recording.sessionId,
    tabId: recording.tabId,
    url: recording.url,
    title: recording.title,
    startedAt: recording.startedAt,
    eventCount: recording.events.length,
    outDir: recording.outDir,
  }));
}

function appendRecordingEvent(sessionId, tabId, event) {
  const recording = uiRecordings.get(sessionId);
  if (!recording) return false;
  recording.tabId = tabId ?? recording.tabId;
  recording.events.push(event);
  recording.updatedAt = new Date().toISOString();
  if (event?.url) recording.url = event.url;
  if (event?.title) recording.title = event.title;
  return true;
}

async function finishRecording(sessionId, finalMeta = {}) {
  const recording = uiRecordings.get(sessionId);
  if (!recording) return null;
  recording.stoppedAt = new Date().toISOString();
  if (finalMeta.url) recording.url = finalMeta.url;
  if (finalMeta.title) recording.title = finalMeta.title;
  await mkdir(recording.outDir, { recursive: true });
  await writeFile(
    join(recording.outDir, "session.json"),
    JSON.stringify(recording, null, 2),
  );
  uiRecordings.delete(sessionId);
  return recording;
}

async function readRecordingSession(sessionId) {
  requireField(sessionId, "sessionId");
  const sessionFile = join(UI_RECORDINGS_DIR, String(sessionId), "session.json");
  if (!isSubPath(UI_RECORDINGS_DIR, sessionFile)) {
    throw new Error("非法录制 sessionId");
  }
  const raw = await readFile(sessionFile, "utf-8");
  return JSON.parse(raw);
}

function aggregateLogs(entries) {
  const byPid = new Map();
  for (const entry of entries) {
    if (!byPid.has(entry.pid)) byPid.set(entry.pid, []);
    byPid.get(entry.pid).push(entry);
  }

  const result = [];

  for (const [pid, rows] of byPid.entries()) {
    const start = rows.find((row) => row.msg === "start" && row.site && row.routine);
    if (!start) continue;

    const finish = rows.find((row) => row.msg === "finish");
    const errorEntry = rows.find((row) => row.msg === "error");
    const checkStart = rows.find((row) => row.msg === "check →");
    const checkEnd = rows.find((row) => row.msg === "check ✓");
    const navStart = rows.find((row) => row.msg === "nav →");
    const navEnd = rows.find((row) => row.msg === "nav ✓");
    const runStart = rows.find((row) => row.msg === "run →");
    const runEnd = rows.find((row) => row.msg === "run ✓");
    const tabClose = rows.find((row) => row.msg === "tab ×");
    const usedFetchEnd = new Set();
    const usedFetchErr = new Set();
    let seq = 0;
    const steps = [];

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
        url: navStart.url ?? "",
        durationMs: navEnd?.durationMs ?? 0,
      });
    }

    if (runStart) {
      steps.push({
        kind: "run",
        seq: ++seq,
        time: runStart.time,
        description: runStart.description ?? "",
        durationMs: runEnd?.durationMs ?? 0,
      });
    }

    for (const row of rows) {
      if (row.msg === "fetch →") {
        const fetchEndIndex = rows.findIndex(
          (entry, index) =>
            !usedFetchEnd.has(index) &&
            entry.msg === "fetch ←" &&
            entry.url === row.url &&
            entry.requestId === row.requestId,
        );
        const fetchErrIndex = rows.findIndex(
          (entry, index) =>
            !usedFetchErr.has(index) &&
            entry.msg === "fetch ✗" &&
            entry.url === row.url &&
            entry.requestId === row.requestId,
        );

        if (fetchEndIndex >= 0) usedFetchEnd.add(fetchEndIndex);
        if (fetchErrIndex >= 0) usedFetchErr.add(fetchErrIndex);

        const fetchEnd = fetchEndIndex >= 0 ? rows[fetchEndIndex] : undefined;
        const fetchErr = fetchErrIndex >= 0 ? rows[fetchErrIndex] : undefined;

        steps.push({
          kind: "fetch",
          seq: ++seq,
          time: row.time,
          url: row.url ?? "",
          method: row.method ?? "GET",
          requestId: row.requestId,
          headers: row.headers,
          body: row.body,
          durationMs: fetchEnd?.durationMs ?? fetchErr?.durationMs ?? 0,
          error: fetchErr?.err?.message,
        });
        continue;
      }

      if (row.msg === "run-js" && row.code) {
        steps.push({
          kind: "js",
          seq: ++seq,
          time: row.time,
          code: row.code,
        });
        continue;
      }

      if (row.msg === "tap →" && row.selector) {
        const tapEnd = rows.find(
          (entry) =>
            entry.msg === "tap ✓" &&
            entry.selector === row.selector &&
            entry.time >= row.time,
        );
        steps.push({
          kind: "tap",
          seq: ++seq,
          time: row.time,
          selector: row.selector,
          mode: row.mode ?? "dom",
          tag: tapEnd?.tag,
          text: tapEnd?.text,
          durationMs: tapEnd
            ? new Date(tapEnd.time).getTime() - new Date(row.time).getTime()
            : 0,
        });
        continue;
      }

      if (row.msg === "input →" && row.selector) {
        const inputEnd = rows.find(
          (entry) =>
            entry.msg === "input ✓" &&
            entry.selector === row.selector &&
            entry.time >= row.time,
        );
        steps.push({
          kind: "input",
          seq: ++seq,
          time: row.time,
          selector: row.selector,
          text: row.text ?? "",
          durationMs: inputEnd
            ? new Date(inputEnd.time).getTime() - new Date(row.time).getTime()
            : 0,
        });
        continue;
      }

      if (row.msg === "scroll" && row.direction) {
        steps.push({
          kind: "scroll",
          seq: ++seq,
          time: row.time,
          direction: row.direction,
          distance: row.distance ?? 0,
        });
        continue;
      }

      if (row.msg === "sleep") {
        steps.push({
          kind: "sleep",
          seq: ++seq,
          time: row.time,
          durationMs: row.durationMs ?? 0,
        });
        continue;
      }

      if (row.msg === "screenshot →") {
        const screenshotEnd = rows.find(
          (entry) => entry.msg === "screenshot ✓" && entry.time >= row.time,
        );
        steps.push({
          kind: "screenshot",
          seq: ++seq,
          time: row.time,
          format: row.format ?? "png",
          fullPage: row.fullPage ?? false,
          filePath: screenshotEnd?.filePath ?? "",
          bytes: screenshotEnd?.bytes ?? 0,
          durationMs: screenshotEnd
            ? new Date(screenshotEnd.time).getTime() - new Date(row.time).getTime()
            : 0,
        });
      }
    }

    if (errorEntry?.err) {
      steps.push({
        kind: "error",
        seq: ++seq,
        time: errorEntry.time,
        message: errorEntry.err.message ?? String(errorEntry.err),
        stack: errorEntry.err.stack,
      });
    }

    if (tabClose) {
      steps.push({
        kind: "tab",
        seq: ++seq,
        time: tabClose.time,
        url: tabClose.url ?? "",
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
      error: errorEntry?.err?.message,
      steps,
    });
  }

  return result.sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );
}

async function readLogs(date) {
  try {
    const file = join(LOGS_DIR, `${date}.jsonl`);
    const text = await readFile(file, "utf8");
    const entries = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return aggregateLogs(entries);
  } catch {
    return [];
  }
}

async function listFiles() {
  try {
    const files = await readdir(LOGS_DIR);
    return files
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => file.replace(".jsonl", ""))
      .sort();
  } catch {
    return [];
  }
}

async function serveViewerAsset(pathname, res, headOnly = false) {
  const wantsIndex = pathname === "/" || !extname(pathname);
  const targetPath = wantsIndex
    ? INDEX_HTML
    : join(VIEWER_DIST_DIR, pathname.replace(/^\/+/, ""));

  if (!isSubPath(VIEWER_DIST_DIR, targetPath)) {
    respondText(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(targetPath);
    const contentType =
      STATIC_CONTENT_TYPES[extname(targetPath)] || "application/octet-stream";
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    if (headOnly) {
      res.end();
      return;
    }
    res.end(body);
  } catch {
    respondText(res, 404, "Not Found");
  }
}

async function handleViewerApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [name, value] of Object.entries(VIEWER_CORS_HEADERS)) {
      res.setHeader(name, value);
    }
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    const date = url.searchParams.get("date") ?? todayDate();
    const logs = await readLogs(date);
    respondWithHeaders(res, 200, { logs }, VIEWER_CORS_HEADERS);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    const files = await listFiles();
    respondWithHeaders(res, 200, { files }, VIEWER_CORS_HEADERS);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/screenshot") {
    const filePath = url.searchParams.get("path") ?? "";
    if (!filePath) {
      respondText(res, 400, "Missing screenshot path", VIEWER_CORS_HEADERS);
      return;
    }

    if (!isSubPath(SCREENSHOTS_DIR, filePath)) {
      respondText(res, 403, "Forbidden", VIEWER_CORS_HEADERS);
      return;
    }

    try {
      const body = await readFile(filePath);
      const ext = extname(filePath) || ".png";
      res.statusCode = 200;
      for (const [name, value] of Object.entries(VIEWER_CORS_HEADERS)) {
        res.setHeader(name, value);
      }
      res.setHeader(
        "Content-Type",
        STATIC_CONTENT_TYPES[ext] || "application/octet-stream",
      );
      res.end(body);
      return;
    } catch {
      respondText(res, 404, "Not Found", VIEWER_CORS_HEADERS);
      return;
    }
  }

  respondText(res, 404, "Not Found", VIEWER_CORS_HEADERS);
}

async function pruneOldLogs(keep = 30) {
  try {
    const files = (await readdir(LOGS_DIR))
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
    const toDelete = files.slice(0, Math.max(0, files.length - keep));
    await Promise.all(toDelete.map((file) => unlink(join(LOGS_DIR, file))));
    if (toDelete.length) {
      console.error(`[tabworks] 已清理 ${toDelete.length} 个旧日志文件`);
    }
  } catch {
    /* 忽略日志目录不存在等情况 */
  }
}

async function pruneOldScreenshots(keepDays = 30) {
  try {
    const files = await readdir(SCREENSHOTS_DIR);
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const toDelete = files.filter((file) => {
      const match = file.match(/_(\d{13,})\./);
      if (!match) return false;
      return Number(match[1]) < cutoff;
    });
    await Promise.all(
      toDelete.map((file) => unlink(join(SCREENSHOTS_DIR, file))),
    );
    if (toDelete.length) {
      console.error(`[tabworks] 已清理 ${toDelete.length} 张旧截图`);
    }
  } catch {
    /* 忽略截图目录不存在等情况 */
  }
}

// ─── HTTP 路由 ───────────────────────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  resetIdleTimer();

  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const origin = req.headers["origin"] || "";

    if (req.method === "GET" && url.pathname === "/status") {
      return respondWithHeaders(
        res,
        200,
        {
          ok: true,
          host: HOST,
          port: PORT,
          pid: process.pid,
          startedAt: new Date(STARTED_AT).toISOString(),
          uptimeMs: Date.now() - STARTED_AT,
          extensionConnected: isExtensionConnected(),
          extensionVersion,
          pendingCommands: pending.size,
        },
        VIEWER_CORS_HEADERS,
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return handleViewerApi(req, res, url);
    }

    if (
      (req.method === "GET" || req.method === "HEAD") &&
      !BRIDGE_ROUTES.has(url.pathname)
    ) {
      return serveViewerAsset(url.pathname, res, req.method === "HEAD");
    }

    // 安全检查：拒绝来自非扩展 / 非统一入口页面的跨域请求
    if (!isTrustedOrigin(origin)) {
      return respond(res, 403, { error: "跨域请求被拒绝" });
    }

    // 其余接口要求自定义 Header，防止 simple request 绕过
    if (!req.headers["x-tabworks-bridge"] && !req.headers["x-tabworks"]) {
      return respond(res, 403, { error: "缺少 X-TabWorks-Bridge 请求头" });
    }

    // POST /shutdown — 优雅关闭 bridge（供重启时调用）
    if (req.method === "POST" && url.pathname === "/shutdown") {
      respond(res, 200, { ok: true });
      setTimeout(() => {
        httpServer.close();
        process.exit(0);
      }, 100);
      return;
    }

    // GET /logs — 查看扩展转发的 console 日志
    if (req.method === "GET" && url.pathname === "/logs") {
      return respond(res, 200, { logs: logBuffer });
    }

    // DELETE /logs — 清空日志
    if (req.method === "DELETE" && url.pathname === "/logs") {
      logBuffer.length = 0;
      return respond(res, 200, { ok: true });
    }

    // GET /pages — 列出自动化窗口中的标签页
    if (req.method === "GET" && url.pathname === "/pages") {
      const result = await sendToExtension({ action: "tabs", op: "list" });
      return respond(res, 200, result);
    }

    // POST /open — 在自动化窗口中新建标签页
    // 参数：url（必填）、foreground（可选，true = 前台展示，默认由扩展 popup 的全局开关决定）
    if (req.method === "POST" && url.pathname === "/open") {
      const body = await parseJson(req);
      const result = await sendToExtension({
        action: "tabs",
        op: "new",
        url: body.url,
        foreground: body.foreground, // undefined = 由扩展侧全局开关决定，true/false = 强制覆盖
      });
      // 返回格式兼容旧版 pageId 字段
      return respond(res, 200, {
        pageId: result.tabId,
        tabId: result.tabId,
        url: result.url,
      });
    }

    // POST /goto — 在指定标签页中导航
    if (req.method === "POST" && url.pathname === "/goto") {
      const body = await parseJson(req);
      requireField(body.pageId ?? body.tabId, "pageId");
      requireField(body.url, "url");
      const result = await sendToExtension({
        action: "navigate",
        tabId: body.pageId ?? body.tabId,
        url: body.url,
        workspace: body.workspace,
      });
      return respond(res, 200, result);
    }

    // POST /close — 关闭指定标签页
    if (req.method === "POST" && url.pathname === "/close") {
      const body = await parseJson(req);
      requireField(body.pageId ?? body.tabId, "pageId");
      const result = await sendToExtension({
        action: "tabs",
        op: "close",
        tabId: body.pageId ?? body.tabId,
        workspace: body.workspace,
      });
      return respond(res, 200, result);
    }

    // POST /inspect — 读取页面基本信息（title、url、文本摘要、链接）
    if (req.method === "POST" && url.pathname === "/inspect") {
      const body = await parseJson(req);
      requireField(body.pageId ?? body.tabId, "pageId");
      const script = `(() => {
        const text = (document.body?.innerText || '').trim().slice(0, 1200);
        const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 20).map(a => ({
          text: (a.textContent || '').trim().slice(0, 120),
          href: a.href,
        }));
        return { title: document.title, url: location.href, readyState: document.readyState, text, links };
      })()`;
      const result = await sendToExtension({
        action: "exec",
        tabId: body.pageId ?? body.tabId,
        code: script,
        workspace: body.workspace,
      });
      return respond(res, 200, result);
    }

    // POST /run-js — 在页面上下文执行任意 JS（核心接口）
    if (req.method === "POST" && url.pathname === "/run-js") {
      const body = await parseJson(req);
      requireField(body.pageId ?? body.tabId, "pageId");
      requireField(body.script, "script");
      const result = await sendToExtension({
        action: "exec",
        tabId: body.pageId ?? body.tabId,
        code: body.script,
        workspace: body.workspace,
      });
      return respond(res, 200, { value: result });
    }

    // POST /tap — 点击元素
    if (req.method === "POST" && url.pathname === "/tap") {
      const body = await parseJson(req);
      requireField(body.pageId ?? body.tabId, "pageId");
      requireField(body.selector, "selector");
      const mode = body.mode === "mouse" ? "mouse" : "dom";
      const selector = JSON.stringify(body.selector);

      // 先获取元素位置信息
      const elementMeta = await sendToExtension({
        action: "exec",
        tabId: body.pageId ?? body.tabId,
        code: `(() => {
          const el = document.querySelector(${selector});
          if (!el) return { error: 'not found' };
          el.scrollIntoView({ block: 'center' });
          const rect = el.getBoundingClientRect();
          return { tag: el.tagName, text: (el.textContent || '').trim().slice(0, 200), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`,
        workspace: body.workspace,
      });

      if (!elementMeta || elementMeta.error) {
        return respond(res, 400, elementMeta || { error: "元素未找到" });
      }

      if (mode === "dom") {
        await sendToExtension({
          action: "exec",
          tabId: body.pageId ?? body.tabId,
          code: `(() => { const el = document.querySelector(${selector}); el && el.click(); return true; })()`,
          workspace: body.workspace,
        });
      } else {
        await sendToExtension({
          action: "mouse",
          tabId: body.pageId ?? body.tabId,
          op: "click",
          x: elementMeta.x,
          y: elementMeta.y,
          workspace: body.workspace,
        });
      }

      return respond(res, 200, { ok: true, mode, ...elementMeta });
    }

    // POST /press — 长按元素
    if (req.method === "POST" && url.pathname === "/press") {
      const body = await parseJson(req);
      const tabId = body.pageId ?? body.tabId;
      requireField(tabId, "pageId");
      const point = body.selector
        ? await elementPoint(tabId, body.selector, body.workspace, {
            offsetX: body.offsetX,
            offsetY: body.offsetY,
          })
        : {
            x: requireFiniteNumber(body.x, "x"),
            y: requireFiniteNumber(body.y, "y"),
          };
      const result = await sendToExtension({
        action: "mouse",
        tabId,
        op: "press",
        x: point.x,
        y: point.y,
        durationMs: body.durationMs,
        workspace: body.workspace,
      });
      return respond(res, 200, { ok: true, ...point, result });
    }

    // POST /drag — 拖拽元素或坐标
    if (req.method === "POST" && url.pathname === "/drag") {
      const body = await parseJson(req);
      const tabId = body.pageId ?? body.tabId;
      requireField(tabId, "pageId");
      const start = body.selector || body.fromSelector
        ? await elementPoint(tabId, body.selector || body.fromSelector, body.workspace, {
            offsetX: body.offsetX ?? body.fromOffsetX,
            offsetY: body.offsetY ?? body.fromOffsetY,
          })
        : {
            x: requireFiniteNumber(body.fromX ?? body.x, "fromX"),
            y: requireFiniteNumber(body.fromY ?? body.y, "fromY"),
          };
      const end = body.toSelector
        ? await elementCenter(tabId, body.toSelector, body.workspace)
        : body.toX !== undefined || body.toY !== undefined
          ? {
              x: requireFiniteNumber(body.toX, "toX"),
              y: requireFiniteNumber(body.toY, "toY"),
            }
          : {
              x: start.x + requireFiniteNumber(body.deltaX, "deltaX"),
              y: start.y + requireFiniteNumber(body.deltaY, "deltaY"),
            };
      const result = await sendToExtension({
        action: "mouse",
        tabId,
        op: "drag",
        fromX: start.x,
        fromY: start.y,
        toX: end.x,
        toY: end.y,
        durationMs: body.durationMs,
        workspace: body.workspace,
      });
      return respond(res, 200, { ok: true, start, end, result });
    }

    // POST /key — 发送可信键盘事件
    if (req.method === "POST" && url.pathname === "/key") {
      const body = await parseJson(req);
      const tabId = body.pageId ?? body.tabId;
      requireField(tabId, "pageId");
      requireField(body.key, "key");
      const result = await sendToExtension({
        action: "key",
        tabId,
        key: body.key,
        workspace: body.workspace,
      });
      return respond(res, 200, { ok: true, result });
    }

    // POST /input — 向输入框写入文字
    if (req.method === "POST" && url.pathname === "/input") {
      const body = await parseJson(req);
      requireField(body.pageId ?? body.tabId, "pageId");
      requireField(body.selector, "selector");
      if (typeof body.text !== "string")
        throw new Error("text 字段必须为字符串");
      const result = await sendToExtension({
        action: "exec",
        tabId: body.pageId ?? body.tabId,
        code: `(() => {
          const el = document.querySelector(${JSON.stringify(body.selector)});
          if (!el) return { error: 'not found' };
          el.scrollIntoView({ block: 'center' });
          if (typeof el.focus === 'function') el.focus();

          const value = ${JSON.stringify(body.text)};
          const dispatchInput = (target, data) => {
            try {
              target.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'insertText',
                data,
              }));
            } catch {
              target.dispatchEvent(new Event('input', { bubbles: true }));
            }
          };
          const dispatchChange = (target) => {
            target.dispatchEvent(new Event('change', { bubbles: true }));
          };
          const setNativeValue = (target, nextValue) => {
            const proto =
              target instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : target instanceof HTMLInputElement
                  ? HTMLInputElement.prototype
                  : target instanceof HTMLSelectElement
                    ? HTMLSelectElement.prototype
                    : null;
            const descriptor = proto
              ? Object.getOwnPropertyDescriptor(proto, 'value')
              : null;
            const ownDescriptor = Object.getOwnPropertyDescriptor(target, 'value');
            const setter = descriptor?.set || ownDescriptor?.set;
            if (setter) setter.call(target, nextValue);
            else target.value = nextValue;
          };

          if (el instanceof HTMLInputElement) {
            if (['checkbox', 'radio', 'file'].includes(el.type)) {
              return { error: 'unsupported input type', tag: el.tagName, type: el.type };
            }
            setNativeValue(el, value);
            dispatchInput(el, value);
            dispatchChange(el);
            return { ok: true, tag: el.tagName, type: el.type || 'text', value: el.value };
          }

          if (el instanceof HTMLTextAreaElement) {
            setNativeValue(el, value);
            dispatchInput(el, value);
            dispatchChange(el);
            return { ok: true, tag: el.tagName, type: 'textarea', value: el.value };
          }

          if (el instanceof HTMLSelectElement) {
            setNativeValue(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            dispatchChange(el);
            return { ok: true, tag: el.tagName, type: el.multiple ? 'select-multiple' : 'select-one', value: el.value };
          }

          if (el.isContentEditable) {
            el.textContent = value;
            dispatchInput(el, value);
            return { ok: true, tag: el.tagName, type: 'contenteditable', text: el.textContent };
          }

          if ('value' in el) {
            el.value = value;
            dispatchInput(el, value);
            dispatchChange(el);
            return { ok: true, tag: el.tagName, type: 'custom-value', value: el.value };
          }

          return { error: 'unsupported element', tag: el.tagName };
        })()`,
        workspace: body.workspace,
      });
      return respond(res, result?.error ? 400 : 200, result);
    }

    // POST /move — 滚动页面
    if (req.method === "POST" && url.pathname === "/move") {
      const body = await parseJson(req);
      requireField(body.pageId ?? body.tabId, "pageId");
      const direction = body.direction || "down";
      const distance = Math.abs(parseInt(String(body.distance || 3000), 10));
      let script = `window.scrollBy(0, ${distance}); 'down'`;
      if (direction === "up") script = `window.scrollBy(0, -${distance}); 'up'`;
      if (direction === "top") script = `window.scrollTo(0, 0); 'top'`;
      if (direction === "bottom")
        script = `window.scrollTo(0, document.body.scrollHeight); 'bottom'`;
      const moved = await sendToExtension({
        action: "exec",
        tabId: body.pageId ?? body.tabId,
        code: script,
        workspace: body.workspace,
      });
      await new Promise((r) => setTimeout(r, 800));
      return respond(res, 200, { direction: moved || direction });
    }

    // POST /capture — 截图（返回 base64 或保存文件）
    if (req.method === "POST" && url.pathname === "/capture") {
      const body = await parseJson(req);
      requireField(body.pageId ?? body.tabId, "pageId");
      const data = await sendToExtension({
        action: "screenshot",
        tabId: body.pageId ?? body.tabId,
        format: body.format === "jpeg" ? "jpeg" : "png",
        quality: body.quality,
        fullPage: body.fullPage,
        workspace: body.workspace,
      });
      if (body.file) {
        const { writeFileSync } = await import("node:fs");
        const image = Buffer.from(data, "base64");
        writeFileSync(body.file, image);
        return respond(res, 200, { saved: body.file });
      }
      const format = body.format === "jpeg" ? "jpeg" : "png";
      const image = Buffer.from(data, "base64");
      res.statusCode = 200;
      res.setHeader("Content-Type", `image/${format}`);
      return res.end(image);
    }

    // POST /request — 在页面上下文发起 fetch（自动携带 cookie）
    if (req.method === "POST" && url.pathname === "/request") {
      const body = await parseJson(req);
      requireField(body.pageId ?? body.tabId, "pageId");
      requireField(body.url, "url");
      const sameOriginOnly = body.sameOriginOnly !== false;
      const method = String(body.method || "GET").toUpperCase();
      const result = await sendToExtension({
        action: "exec",
        tabId: body.pageId ?? body.tabId,
        code: `(() => {
          const input = ${JSON.stringify(body)};
          const url = new URL(input.url, location.href);
          const method = String(input.method || 'GET').toUpperCase();
          if (${sameOriginOnly} && url.origin !== location.origin) {
            return { error: 'cross-origin blocked', pageOrigin: location.origin, targetOrigin: url.origin };
          }
          return fetch(url.toString(), {
            method,
            headers: input.headers || {},
            body: input.body == null ? undefined : input.body,
            credentials: 'include',
          }).then(async resp => {
            const text = await resp.text();
            let json = null;
            try { json = JSON.parse(text); } catch {}
            return { ok: resp.ok, status: resp.status, url: resp.url, headers: Array.from(resp.headers.entries()), text, json };
          });
        })()`,
        workspace: body.workspace,
      });
      return respond(res, result?.error ? 400 : 200, result);
    }

    // POST /cookies — 读取指定域名的 cookie
    if (req.method === "POST" && url.pathname === "/cookies") {
      const body = await parseJson(req);
      if (!body.domain && !body.url) throw new Error("需要提供 domain 或 url");
      const result = await sendToExtension({
        action: "cookies",
        domain: body.domain,
        url: body.url,
      });
      return respond(res, 200, result);
    }

    // POST /sessions — 查看当前自动化会话状态
    if (req.method === "POST" && url.pathname === "/sessions") {
      const result = await sendToExtension({ action: "sessions" });
      return respond(res, 200, result);
    }

    // POST /recording/start — 开始录制当前或指定标签页的 UI 操作
    if (req.method === "POST" && url.pathname === "/recording/start") {
      const body = await parseJson(req);
      const sessionId = body.sessionId || createRecordingSessionId();
      const outDir = join(UI_RECORDINGS_DIR, sessionId);
      uiRecordings.set(sessionId, {
        sessionId,
        tabId: body.pageId ?? body.tabId ?? null,
        url: body.url ?? "",
        title: "",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        outDir,
        events: [],
      });

      try {
        const result = await sendToExtension({
          action: "recording",
          op: "start",
          sessionId,
          tabId: body.pageId ?? body.tabId,
        });
        const recording = uiRecordings.get(sessionId);
        if (recording) {
          recording.tabId = result.tabId ?? recording.tabId;
          recording.url = result.url ?? recording.url;
          recording.title = result.title ?? recording.title;
        }
        return respond(res, 200, {
          ok: true,
          sessionId,
          tabId: result.tabId,
          url: result.url,
          title: result.title,
          outDir,
        });
      } catch (err) {
        uiRecordings.delete(sessionId);
        throw err;
      }
    }

    // POST /recording/stop — 停止录制并写入 .bridge/ui-record/<sessionId>/session.json
    if (req.method === "POST" && url.pathname === "/recording/stop") {
      const body = await parseJson(req);
      requireField(body.sessionId, "sessionId");
      const result = await sendToExtension({
        action: "recording",
        op: "stop",
        sessionId: body.sessionId,
        tabId: body.pageId ?? body.tabId,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const recording = await finishRecording(body.sessionId, result);
      if (!recording) return respond(res, 404, { error: "录制会话不存在" });
      return respond(res, 200, {
        ok: true,
        sessionId: body.sessionId,
        eventCount: recording.events.length,
        outDir: recording.outDir,
        url: recording.url,
        title: recording.title,
      });
    }

    // POST /recording/replay — 在当前或指定标签页回放已保存的 UI 录制
    if (req.method === "POST" && url.pathname === "/recording/replay") {
      const body = await parseJson(req);
      if (!body.sessionId && !Array.isArray(body.events)) {
        throw new Error("需要 sessionId 或 events");
      }
      const recording = body.sessionId
        ? await readRecordingSession(body.sessionId)
        : {
            sessionId: "inline",
            title: body.title || "",
            url: body.url || "",
            events: body.events || [],
          };
      const result = await sendToExtension({
        action: "recording",
        op: "replay",
        tabId: body.pageId ?? body.tabId,
        events: recording.events || [],
        options: {
          speed: body.speed,
          maxDelayMs: body.maxDelayMs,
        },
      });
      return respond(res, 200, {
        ok: true,
        sessionId: recording.sessionId,
        sourceTitle: recording.title,
        sourceUrl: recording.url,
        ...result,
      });
    }

    // POST /recording/status — 查看当前进行中的 UI 录制
    if (req.method === "POST" && url.pathname === "/recording/status") {
      return respond(res, 200, { recordings: getRecordingStatus() });
    }

    return respond(res, 404, { error: "未知路由" });
  } catch (err) {
    return respond(res, 500, { error: err.message || String(err) });
  }
});

// ─── WebSocket 服务（供扩展连入）────────────────────────────────────

const wss = new WebSocketServer({
  server: httpServer,
  path: "/ext",
  verifyClient: ({ req }) => {
    // 只允许来自 chrome-extension:// origin 的 WebSocket 连接
    const origin = req.headers["origin"] || "";
    return origin.startsWith("chrome-extension://");
  },
});

wss.on("connection", (ws) => {
  console.error("[tabworks] 扩展已连接");
  extensionWs = ws;
  extensionVersion = null;

  // 心跳：定期发送 ping 保活，但不再因空闲主动断开。
  let lastPongAt = Date.now();
  const heartbeat = setInterval(() => {
    if (!ws || ws.readyState !== 1) {
      clearInterval(heartbeat);
      return;
    }
    if (Date.now() - lastPongAt > 5 * 60 * 1000) {
      console.error("[tabworks] 扩展心跳长时间未响应，保持等待重连");
    }
    ws.ping();
  }, 30000);

  ws.on("pong", () => {
    lastPongAt = Date.now();
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // 版本握手
    if (msg.type === "hello") {
      extensionVersion = typeof msg.version === "string" ? msg.version : null;
      console.error(`[tabworks] 扩展版本: ${extensionVersion ?? "未知"}`);
      return;
    }

    // console 日志转发
    if (msg.type === "log") {
      const prefix =
        { info: "[ext]", warn: "[ext:warn]", error: "[ext:error]" }[
          msg.level
        ] || "[ext]";
      console.error(`${prefix} ${msg.msg}`);
      logBuffer.push({ level: msg.level, msg: msg.msg, ts: msg.ts });
      if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
      return;
    }

    // UI 录制事件转发
    if (msg.type === "recording-event") {
      appendRecordingEvent(msg.sessionId, msg.tabId, msg.event);
      return;
    }

    // 命令结果：从 pending 中找到对应的 Promise 并 resolve
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.ok) {
        resolve(msg.data);
      } else {
        reject(new Error(msg.error || "扩展返回错误"));
      }
    }
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    if (extensionWs === ws) {
      extensionWs = null;
      extensionVersion = null;
      console.error("[tabworks] 扩展已断开");
    }
    // 拒绝所有等待中的请求
    for (const [id, { reject, timer }] of pending.entries()) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error("扩展连接已断开"));
    }
  });

  ws.on("error", (err) => {
    console.error("[tabworks] 扩展 WebSocket 错误:", err.message);
  });
});

// ─── 空闲自动退出 ────────────────────────────────────────────────────

let idleTimer = null;

function resetIdleTimer() {
  if (IDLE_TIMEOUT <= 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.error(`[tabworks] 空闲超时（${IDLE_TIMEOUT}ms），自动退出`);
    process.exit(0);
  }, IDLE_TIMEOUT);
}

// ─── 启动 ────────────────────────────────────────────────────────────

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

async function shutdownExisting() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: "/shutdown",
        method: "POST",
        timeout: 2000,
        headers: {
          "X-TabWorks-Bridge": "1",
          "Content-Type": "application/json",
        },
      },
      () => resolve(true),
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitPortFree(maxMs = 3000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await portIsFree(PORT)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function boot() {
  const free = await portIsFree(PORT);
  if (!free) {
    // 检查是否是同一个 bridge 已在运行，尝试优雅关闭后重启
    try {
      const alive = await new Promise((resolve) => {
        http
          .get(
            `http://${HOST}:${PORT}/status`,
            { timeout: 1500, headers: {} },
            (res) => {
              let body = "";
              res.on("data", (c) => (body += c));
              res.on("end", () => resolve(body.includes('"ok":true')));
            },
          )
          .on("error", () => resolve(false));
      });
      if (alive) {
        console.error(`[tabworks] 检测到旧 bridge 进程，正在关闭...`);
        await shutdownExisting();
        const freed = await waitPortFree(3000);
        if (!freed) {
          console.error(`[tabworks] 关闭旧进程超时，端口 ${PORT} 仍被占用`);
          process.exit(1);
        }
        console.error(`[tabworks] 旧进程已关闭，重新启动...`);
        // 继续往下走，正常启动
      } else {
        console.error(`[tabworks] 端口 ${PORT} 已被其他进程占用`);
        process.exit(1);
      }
    } catch {
      console.error(`[tabworks] 端口 ${PORT} 已被占用`);
      process.exit(1);
    }
  }

  httpServer.listen(PORT, HOST, () => {
    console.error(`[tabworks] 统一服务已启动 http://${HOST}:${PORT}`);
    console.error("[tabworks] viewer / 日志 API / bridge / WebSocket 已统一到单端口");
    console.error("[tabworks] 等待 Chrome 扩展连接...");
    console.error("[tabworks] 提示：若扩展未安装，请参考 extension/README.md");
    if (IDLE_TIMEOUT <= 0) {
      console.error("[tabworks] 已关闭空闲自动退出，bridge 将常驻运行");
    }
    resetIdleTimer();
  });
}

process.on("SIGTERM", () => {
  httpServer.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  httpServer.close();
  process.exit(0);
});
process.on("uncaughtException", (err) =>
  console.error("[tabworks] 未捕获异常:", err.message),
);
process.on("unhandledRejection", (err) =>
  console.error("[tabworks] 未处理 rejection:", err?.message || err),
);

await pruneOldLogs();
await pruneOldScreenshots();

boot();
