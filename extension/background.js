/**
 * TabWorks Bridge — Service Worker (background script)
 *
 * 通过统一入口端口连接本地 bridge 服务（localhost:9527/ext），
 * 接收命令后调用 Chrome Debugger API 执行 CDP 操作，返回结果。
 *
 * 支持的操作：
 * - exec：在页面上下文执行任意 JS
 * - navigate：页面导航（含重定向检测和超时兜底）
 * - tabs：标签页管理（list / new / close / select）
 * - cookies：按域名或 URL 读取 cookie
 * - screenshot：页面截图（可视区或全页）
 * - recording：启动 / 停止 UI 操作录制
 * - close-window：关闭自动化专用窗口
 * - sessions：查看当前自动化会话状态
 *
 * 所有操作在后台专用窗口中执行，不影响用户正在浏览的标签页。
 */

// ─── 常量 ────────────────────────────────────────────────────────────

const BRIDGE_WS_URL = "ws://127.0.0.1:9527/ext";
const WS_RECONNECT_BASE_DELAY = 2000;
const WS_RECONNECT_MAX_DELAY = 60000;
const WINDOW_IDLE_TIMEOUT = 30000; // 30s 无命令后自动关闭自动化窗口
const BLANK_PAGE = "data:text/html,<html></html>";

// ─── 日志环形缓冲 ─────────────────────────────────────────────────────
// 保留最近 200 条，供转发到 bridge 的日志服务（viewer）使用。

const LOG_MAX = 200;
const logBuffer = []; // { ts, level, msg }

function appendLog(level, msg) {
  const entry = { ts: Date.now(), level, msg };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
}

// ─── 日志转发 ────────────────────────────────────────────────────────
// 将 console.log/warn/error 同步转发到 bridge 和日志缓冲

let ws = null;

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function forwardLog(level, args) {
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  appendLog(level, msg);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "log", level, msg, ts: Date.now() }));
  } catch {
    /* 不递归 */
  }
}

console.log = (...args) => {
  _origLog(...args);
  forwardLog("info", args);
};
console.warn = (...args) => {
  _origWarn(...args);
  forwardLog("warn", args);
};
console.error = (...args) => {
  _origError(...args);
  forwardLog("error", args);
};

// ─── WebSocket 连接管理 ──────────────────────────────────────────────

let reconnectTimer = null;
let reconnectAttempts = 0;

function connect() {
  if (
    ws?.readyState === WebSocket.OPEN ||
    ws?.readyState === WebSocket.CONNECTING
  )
    return;

  try {
    ws = new WebSocket(BRIDGE_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log(`[tabworks] 已连接到 bridge: ${BRIDGE_WS_URL}`);
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.send(
      JSON.stringify({
        type: "hello",
        version: chrome.runtime.getManifest().version,
      }),
    );
    updateBadge();
    broadcastStatus();
  };

  ws.onmessage = async (event) => {
    try {
      const command = JSON.parse(event.data);
      const result = await handleCommand(command);
      ws?.send(JSON.stringify(result));
    } catch (err) {
      console.error("[tabworks] 消息处理异常:", err);
    }
  };

  ws.onclose = () => {
    console.log("[tabworks] 已断开 bridge 连接");
    ws = null;
    scheduleReconnect();
    updateBadge();
    broadcastStatus();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(
    WS_RECONNECT_BASE_DELAY * 2 ** (reconnectAttempts - 1),
    WS_RECONNECT_MAX_DELAY,
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// ─── Badge ───────────────────────────────────────────────────────────
// 图标右下角小徽标：绿色"ON" = 已连接，无徽标 = 未连接

function updateBadge() {
  const connected = ws?.readyState === WebSocket.OPEN;
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  if (connected) chrome.action.setBadgeBackgroundColor({ color: "#34c759" });
}

// ─── 自动化窗口隔离 ──────────────────────────────────────────────────

const automationSessions = new Map();
const recordingTabs = new Map(); // Map<tabId, { sessionId, startedAt, events }>
const LAST_UI_RECORDING_KEY = "lastUiRecording";

function getWorkspaceKey(workspace) {
  return workspace?.trim() || "default";
}

function resetWindowIdleTimer(workspace) {
  const session = automationSessions.get(workspace);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleDeadlineAt = Date.now() + WINDOW_IDLE_TIMEOUT;
  session.idleTimer = setTimeout(async () => {
    const current = automationSessions.get(workspace);
    if (!current) return;
    try {
      await chrome.windows.remove(current.windowId);
      console.log(
        `[tabworks] 自动化窗口 ${current.windowId} (${workspace}) 已关闭（空闲超时）`,
      );
    } catch {
      /* 已关闭 */
    }
    automationSessions.delete(workspace);
    broadcastSessions();
  }, WINDOW_IDLE_TIMEOUT);
  broadcastSessions();
}

async function getAutomationWindow(workspace, { focused = false } = {}) {
  const existing = automationSessions.get(workspace);
  if (existing) {
    try {
      await chrome.windows.get(existing.windowId);
      if (focused)
        await chrome.windows.update(existing.windowId, { focused: true });
      return existing.windowId;
    } catch {
      automationSessions.delete(workspace);
    }
  }

  const win = await chrome.windows.create({
    url: BLANK_PAGE,
    focused,
    width: 1280,
    height: 900,
    type: "normal",
    state: "normal",
  });
  const session = {
    windowId: win.id,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
  };
  automationSessions.set(workspace, session);
  console.log(
    `[tabworks] 创建自动化窗口 ${session.windowId} (${workspace}, focused=${focused})`,
  );
  resetWindowIdleTimer(workspace);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return session.windowId;
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [workspace, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(`[tabworks] 自动化窗口已关闭 (${workspace})`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
      broadcastSessions();
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  recordingTabs.delete(tabId);
});

// ─── CDP 工具函数 ────────────────────────────────────────────────────

const attachedTabs = new Set();

function isDebuggableUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url === BLANK_PAGE
  );
}

function isSafeNavigationUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

async function ensureAttached(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl(tab.url)) {
      attachedTabs.delete(tabId);
      throw new Error(`无法调试 tab ${tabId}：URL 为 ${tab.url ?? "unknown"}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("无法调试")) throw e;
    attachedTabs.delete(tabId);
    throw new Error(`Tab ${tabId} 不存在`);
  }

  if (attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true,
      });
      return;
    } catch {
      attachedTabs.delete(tabId);
    }
  }

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Another debugger is already attached")) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        /* 忽略 */
      }
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch {
        throw new Error(`attach 失败: ${msg}`);
      }
    } else {
      throw new Error(`attach 失败: ${msg}`);
    }
  }
  attachedTabs.add(tabId);

  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  } catch {
    /* 部分页面不需要显式 enable */
  }
}

async function cdpEvaluate(tabId, expression) {
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
  );
  if (result.exceptionDetails) {
    const errMsg =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "Eval 错误";
    throw new Error(errMsg);
  }
  return result.result?.value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cdpMouseClick(tabId, x, y) {
  await ensureAttached(tabId);
  const point = { x: Number(x), y: Number(y) };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("鼠标坐标无效");
  }
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  return { clicked: true, ...point };
}

async function cdpMousePress(tabId, x, y, durationMs = 700) {
  await ensureAttached(tabId);
  const point = { x: Number(x), y: Number(y) };
  const holdMs = Math.max(100, Math.min(Number(durationMs) || 700, 5000));
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("鼠标坐标无效");
  }
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(holdMs);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return { pressed: true, durationMs: holdMs, ...point };
}

async function cdpMouseDrag(tabId, fromX, fromY, toX, toY, durationMs = 450) {
  await ensureAttached(tabId);
  const start = { x: Number(fromX), y: Number(fromY) };
  const end = { x: Number(toX), y: Number(toY) };
  const dragMs = Math.max(80, Math.min(Number(durationMs) || 450, 8000));
  if (
    !Number.isFinite(start.x) ||
    !Number.isFinite(start.y) ||
    !Number.isFinite(end.x) ||
    !Number.isFinite(end.y)
  ) {
    throw new Error("拖拽坐标无效");
  }
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: start.x,
    y: start.y,
    button: "none",
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });

  const steps = Math.max(4, Math.min(40, Math.round(dragMs / 24)));
  for (let i = 1; i <= steps; i += 1) {
    await sleep(dragMs / steps);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + ((end.x - start.x) * i) / steps,
      y: start.y + ((end.y - start.y) * i) / steps,
      button: "left",
      buttons: 1,
    });
  }

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return { dragged: true, fromX: start.x, fromY: start.y, toX: end.x, toY: end.y, durationMs: dragMs };
}

async function cdpDetach(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* 忽略 */
  }
}

async function cdpScreenshot(tabId, options = {}) {
  await ensureAttached(tabId);
  const format = options.format ?? "png";

  if (options.fullPage) {
    const metrics = await chrome.debugger.sendCommand(
      { tabId },
      "Page.getLayoutMetrics",
    );
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size) {
      await chrome.debugger.sendCommand(
        { tabId },
        "Emulation.setDeviceMetricsOverride",
        {
          mobile: false,
          width: Math.ceil(size.width),
          height: Math.ceil(size.height),
          deviceScaleFactor: 1,
        },
      );
    }
  }

  try {
    const params = { format };
    if (format === "jpeg" && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }
    const result = await chrome.debugger.sendCommand(
      { tabId },
      "Page.captureScreenshot",
      params,
    );
    return result.data;
  } finally {
    if (options.fullPage) {
      await chrome.debugger
        .sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride")
        .catch(() => {});
    }
  }
}

function registerCdpListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabs.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) attachedTabs.delete(source.tabId);
  });
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await cdpDetach(tabId);
    }
  });
}

// ─── Tab 解析 ────────────────────────────────────────────────────────

function normalizeUrlForComparison(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function isTargetUrl(currentUrl, targetUrl) {
  return (
    normalizeUrlForComparison(currentUrl) ===
    normalizeUrlForComparison(targetUrl)
  );
}

async function resolveTabId(tabId, workspace) {
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const session = automationSessions.get(workspace);
      if (
        isDebuggableUrl(tab.url) &&
        session &&
        tab.windowId === session.windowId
      ) {
        return tabId;
      }
      if (session && tab.windowId !== session.windowId) {
        console.warn(`[tabworks] Tab ${tabId} 不属于自动化窗口，重新解析`);
      } else if (!isDebuggableUrl(tab.url)) {
        console.warn(
          `[tabworks] Tab ${tabId} URL 不可调试 (${tab.url})，重新解析`,
        );
      }
    } catch {
      console.warn(`[tabworks] Tab ${tabId} 已不存在，重新解析`);
    }
  }

  const windowId = await getAutomationWindow(workspace);
  const tabs = await chrome.tabs.query({ windowId });

  const debuggableTab = tabs.find((t) => t.id && isDebuggableUrl(t.url));
  if (debuggableTab?.id) return debuggableTab.id;

  const reuseTab = tabs.find((t) => t.id);
  if (reuseTab?.id) {
    await chrome.tabs.update(reuseTab.id, { url: BLANK_PAGE });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const updated = await chrome.tabs.get(reuseTab.id);
      if (isDebuggableUrl(updated.url)) return reuseTab.id;
    } catch {
      /* 标签页在导航中关闭 */
    }
  }

  const newTab = await chrome.tabs.create({
    windowId,
    url: BLANK_PAGE,
    active: true,
  });
  if (!newTab.id) throw new Error("创建标签页失败");
  return newTab.id;
}

async function listAutomationWebTabs(workspace) {
  const session = automationSessions.get(workspace);
  if (!session) return [];
  try {
    const tabs = await chrome.tabs.query({ windowId: session.windowId });
    return tabs.filter((t) => isDebuggableUrl(t.url));
  } catch {
    automationSessions.delete(workspace);
    return [];
  }
}

async function resolveRecordingTabId(tabId) {
  if (tabId !== undefined && tabId !== null) return tabId;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs.find((item) => item.id && isDebuggableUrl(item.url));
  if (!tab?.id) throw new Error("未找到可录制的当前网页标签页");
  return tab.id;
}

async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    throw new Error(
      "无法连接页面录制脚本，请刷新目标页面或重新加载扩展后再试：" +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

function createRecordingSessionId() {
  return `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

async function getLastUiRecording() {
  const result = await storageGet([LAST_UI_RECORDING_KEY]);
  return result[LAST_UI_RECORDING_KEY] || null;
}

function recordingStatus(item) {
  if (!item) return null;
  return {
    sessionId: item.sessionId,
    tabId: item.tabId,
    url: item.url,
    title: item.title,
    startedAt: item.startedAt,
    eventCount: item.events?.length || 0,
  };
}

async function startUiRecording(tabId, sessionId = createRecordingSessionId()) {
  const targetTabId = await resolveRecordingTabId(tabId);
  const tab = await chrome.tabs.get(targetTabId);
  if (!isDebuggableUrl(tab.url)) {
    throw new Error(`无法录制当前 URL：${tab.url}`);
  }
  const item = {
    sessionId,
    tabId: targetTabId,
    url: tab.url,
    title: tab.title,
    startedAt: new Date().toISOString(),
    events: [],
  };
  recordingTabs.set(targetTabId, item);
  let response;
  try {
    response = await sendMessageToTab(targetTabId, {
      type: "tabworks-recording-start",
      sessionId,
    });
  } catch (err) {
    recordingTabs.delete(targetTabId);
    throw err;
  }
  item.url = response?.url ?? item.url;
  item.title = response?.title ?? item.title;
  return recordingStatus(item);
}

async function stopUiRecording(sessionId, tabId) {
  const entries = [...recordingTabs.entries()];
  const matched = entries.find(
    ([entryTabId, item]) =>
      item.sessionId === sessionId ||
      (tabId !== undefined && Number(entryTabId) === Number(tabId)),
  );
  if (!matched) throw new Error("未找到正在录制的标签页");

  const [targetTabId, item] = matched;
  const response = await sendMessageToTab(targetTabId, {
    type: "tabworks-recording-stop",
    sessionId: item.sessionId,
  });
  item.events.push({
    seq: item.events.length + 1,
    at: new Date().toISOString(),
    url: response?.url ?? item.url,
    title: response?.title ?? item.title,
    kind: "stop",
  });
  recordingTabs.delete(targetTabId);
  const saved = {
    ...item,
    url: response?.url ?? item.url,
    title: response?.title ?? item.title,
    stoppedAt: new Date().toISOString(),
    eventCount: item.events.length,
  };
  await storageSet({ [LAST_UI_RECORDING_KEY]: saved });
  return saved;
}

async function replayUiRecording({ sessionId, tabId, events, options } = {}) {
  const last = await getLastUiRecording();
  const source =
    events ||
    (last && (!sessionId || last.sessionId === sessionId) ? last.events : null);
  if (!source) throw new Error("没有可回放的录制");
  const targetTabId = await resolveRecordingTabId(tabId);
  const response = await sendMessageToTab(targetTabId, {
    type: "tabworks-recording-replay",
    events: source,
    options: options || {},
  });
  return { tabId: targetTabId, ...(response || {}) };
}

// ─── 命令分发 ────────────────────────────────────────────────────────

async function handleCommand(cmd) {
  const workspace = getWorkspaceKey(cmd.workspace);
  resetWindowIdleTimer(workspace);
  try {
    switch (cmd.action) {
      case "exec":
        return await handleExec(cmd, workspace);
      case "mouse":
        return await handleMouse(cmd, workspace);
      case "navigate":
        return await handleNavigate(cmd, workspace);
      case "tabs":
        return await handleTabs(cmd, workspace);
      case "cookies":
        return await handleCookies(cmd);
      case "screenshot":
        return await handleScreenshot(cmd, workspace);
      case "recording":
        return await handleRecording(cmd);
      case "close-window":
        return await handleCloseWindow(cmd, workspace);
      case "sessions":
        return await handleSessions(cmd);
      default:
        return { id: cmd.id, ok: false, error: `未知 action: ${cmd.action}` };
    }
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Action 实现 ─────────────────────────────────────────────────────

async function handleExec(cmd, workspace) {
  if (!cmd.code) return { id: cmd.id, ok: false, error: "缺少 code 字段" };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await cdpEvaluate(tabId, cmd.code);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleMouse(cmd, workspace) {
  if (!["click", "press", "drag"].includes(cmd.op)) {
    return { id: cmd.id, ok: false, error: `未知 mouse op: ${cmd.op}` };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data =
      cmd.op === "click"
        ? await cdpMouseClick(tabId, cmd.x, cmd.y)
        : cmd.op === "press"
          ? await cdpMousePress(tabId, cmd.x, cmd.y, cmd.durationMs)
          : await cdpMouseDrag(
              tabId,
              cmd.fromX,
              cmd.fromY,
              cmd.toX,
              cmd.toY,
              cmd.durationMs,
            );
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleNavigate(cmd, workspace) {
  if (!cmd.url) return { id: cmd.id, ok: false, error: "缺少 url 字段" };
  if (!isSafeNavigationUrl(cmd.url)) {
    return {
      id: cmd.id,
      ok: false,
      error: "不安全的 URL scheme，仅允许 http:// 和 https://",
    };
  }

  const tabId = await resolveTabId(cmd.tabId, workspace);
  const beforeTab = await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;

  if (
    beforeTab.status === "complete" &&
    isTargetUrl(beforeTab.url, targetUrl)
  ) {
    return {
      id: cmd.id,
      ok: true,
      data: {
        title: beforeTab.title,
        url: beforeTab.url,
        tabId,
        timedOut: false,
      },
    };
  }

  await cdpDetach(tabId);
  await chrome.tabs.update(tabId, { url: targetUrl });

  let timedOut = false;
  await new Promise((resolve) => {
    let settled = false;
    let checkTimer = null;
    let timeoutTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };

    const isNavigationDone = (url) =>
      isTargetUrl(url, targetUrl) ||
      normalizeUrlForComparison(url) !== beforeNormalized;

    const listener = (id, info, tab) => {
      if (id !== tabId) return;
      if (info.status === "complete" && isNavigationDone(tab.url ?? info.url))
        finish();
    };
    chrome.tabs.onUpdated.addListener(listener);

    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (
          currentTab.status === "complete" &&
          isNavigationDone(currentTab.url)
        )
          finish();
      } catch {
        /* tab 已关闭 */
      }
    }, 100);

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[tabworks] 导航到 ${targetUrl} 超时（15s）`);
      finish();
    }, 15000);
  });

  const tab = await chrome.tabs.get(tabId);
  return {
    id: cmd.id,
    ok: true,
    data: { title: tab.title, url: tab.url, tabId, timedOut },
  };
}

async function handleTabs(cmd, workspace) {
  switch (cmd.op) {
    case "list": {
      const tabs = await listAutomationWebTabs(workspace);
      return {
        id: cmd.id,
        ok: true,
        data: tabs.map((t, i) => ({
          index: i,
          tabId: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
        })),
      };
    }
    case "new": {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return { id: cmd.id, ok: false, error: "不安全的 URL scheme" };
      }
      const foreground =
        cmd.foreground !== undefined
          ? cmd.foreground === true
          : globalForeground;
      const windowId = await getAutomationWindow(workspace, {
        focused: foreground,
      });
      const tab = await chrome.tabs.create({
        windowId,
        url: cmd.url ?? BLANK_PAGE,
        active: foreground,
      });
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case "close": {
      const { globalKeepTab: storedKeepTab } =
        await chrome.storage.local.get("globalKeepTab");
      if (storedKeepTab === true) {
        globalKeepTab = true;
        return { id: cmd.id, ok: true, data: { kept: true } };
      }
      if (cmd.index !== undefined) {
        const tabs = await listAutomationWebTabs(workspace);
        const target = tabs[cmd.index];
        if (!target?.id)
          return {
            id: cmd.id,
            ok: false,
            error: `Tab index ${cmd.index} 不存在`,
          };
        await chrome.tabs.remove(target.id);
        await cdpDetach(target.id);
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      const tabId = await resolveTabId(cmd.tabId, workspace);
      await chrome.tabs.remove(tabId);
      await cdpDetach(tabId);
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case "select": {
      if (cmd.index === undefined && cmd.tabId === undefined) {
        return { id: cmd.id, ok: false, error: "需要 index 或 tabId" };
      }
      if (cmd.tabId !== undefined) {
        const session = automationSessions.get(workspace);
        let tab;
        try {
          tab = await chrome.tabs.get(cmd.tabId);
        } catch {
          return { id: cmd.id, ok: false, error: `Tab ${cmd.tabId} 不存在` };
        }
        if (!session || tab.windowId !== session.windowId) {
          return {
            id: cmd.id,
            ok: false,
            error: `Tab ${cmd.tabId} 不属于自动化窗口`,
          };
        }
        await chrome.tabs.update(cmd.tabId, { active: true });
        return { id: cmd.id, ok: true, data: { selected: cmd.tabId } };
      }
      const tabs = await listAutomationWebTabs(workspace);
      const target = tabs[cmd.index];
      if (!target?.id)
        return {
          id: cmd.id,
          ok: false,
          error: `Tab index ${cmd.index} 不存在`,
        };
      await chrome.tabs.update(target.id, { active: true });
      return { id: cmd.id, ok: true, data: { selected: target.id } };
    }
    default:
      return { id: cmd.id, ok: false, error: `未知 tabs op: ${cmd.op}` };
  }
}

async function handleCookies(cmd) {
  if (!cmd.domain && !cmd.url) {
    return {
      id: cmd.id,
      ok: false,
      error: "需要提供 domain 或 url，避免导出全部 cookie",
    };
  }
  const details = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;
  const cookies = await chrome.cookies.getAll(details);
  return {
    id: cmd.id,
    ok: true,
    data: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate,
    })),
  };
}

async function handleScreenshot(cmd, workspace) {
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await cdpScreenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
    });
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleRecording(cmd) {
  const op = cmd.op;
  if (op === "start") {
    const data = await startUiRecording(cmd.tabId, cmd.sessionId);
    return {
      id: cmd.id,
      ok: true,
      data,
    };
  }

  if (op === "stop") {
    const data = await stopUiRecording(cmd.sessionId, cmd.tabId);
    return {
      id: cmd.id,
      ok: true,
      data,
    };
  }

  if (op === "status") {
    return {
      id: cmd.id,
      ok: true,
      data: [...recordingTabs.entries()].map(([tabId, item]) => ({
        tabId,
        sessionId: item.sessionId,
        startedAt: item.startedAt,
        eventCount: item.events?.length || 0,
      })),
    };
  }

  if (op === "replay") {
    const response = await replayUiRecording({
      tabId: cmd.tabId,
      events: cmd.events,
      options: cmd.options,
    });
    return {
      id: cmd.id,
      ok: response?.ok !== false,
      data: response,
      error: response?.ok === false ? response.error || "回放失败" : undefined,
    };
  }

  return { id: cmd.id, ok: false, error: `未知 recording op: ${op}` };
}

async function handleCloseWindow(cmd, workspace) {
  const session = automationSessions.get(workspace);
  if (session) {
    try {
      await chrome.windows.remove(session.windowId);
    } catch {
      /* 已关闭 */
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    automationSessions.delete(workspace);
    broadcastSessions();
  }
  return { id: cmd.id, ok: true, data: { closed: true } };
}

async function handleSessions(cmd) {
  const now = Date.now();
  const data = await Promise.all(
    [...automationSessions.entries()].map(async ([workspace, session]) => ({
      workspace,
      windowId: session.windowId,
      tabCount: (
        await chrome.tabs.query({ windowId: session.windowId })
      ).filter((t) => isDebuggableUrl(t.url)).length,
      idleMsRemaining: Math.max(0, session.idleDeadlineAt - now),
    })),
  );
  return { id: cmd.id, ok: true, data };
}

// ─── 全局开关 ────────────────────────────────────────────────────────

let globalForeground = false;
let globalKeepTab = false;

chrome.storage.local.get(["globalForeground", "globalKeepTab"], (result) => {
  if (result.globalForeground === true) globalForeground = true;
  if (result.globalKeepTab === true) globalKeepTab = true;
});

function setGlobalForeground(value) {
  globalForeground = value;
  chrome.storage.local.set({ globalForeground: value });
  broadcastStatus();
}

function setGlobalKeepTab(value) {
  globalKeepTab = value;
  chrome.storage.local.set({ globalKeepTab: value });
  broadcastStatus();
}

// ─── Popup 长连接（Port）────────────────────────────────────────────
// popup 通过 chrome.runtime.connect({ name: 'popup' }) 建立长连接。
// background 在状态变化时主动推送 status / session / log 三类消息。

const popupPorts = new Set();

function buildStatusMsg() {
  return {
    type: "status",
    connected: ws?.readyState === WebSocket.OPEN,
    reconnecting: reconnectTimer !== null,
    foreground: globalForeground,
    keepTab: globalKeepTab,
  };
}

function broadcastStatus() {
  const msg = buildStatusMsg();
  for (const port of popupPorts) {
    try {
      port.postMessage(msg);
    } catch {
      /* popup 已关闭 */
    }
  }
}

async function buildSessionsMsg() {
  const now = Date.now();
  const sessions = await Promise.all(
    [...automationSessions.entries()].map(async ([workspace, session]) => ({
      workspace,
      windowId: session.windowId,
      tabCount: (
        await chrome.tabs.query({ windowId: session.windowId })
      ).filter((t) => isDebuggableUrl(t.url)).length,
      idleMsRemaining: Math.max(0, session.idleDeadlineAt - now),
    })),
  );
  return { type: "sessions", sessions };
}

function broadcastSessions() {
  buildSessionsMsg().then((msg) => {
    for (const port of popupPorts) {
      try {
        port.postMessage(msg);
      } catch {
        /* popup 已关闭 */
      }
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupPorts.add(port);

  // popup 打开时主动触发一次连接（connect() 内部有幂等保护）
  // 同时重置重连计数，确保即使超出 eager 上限也能恢复
  if (
    !ws ||
    ws.readyState === WebSocket.CLOSED ||
    ws.readyState === WebSocket.CLOSING
  ) {
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  }

  // 立即推送当前状态
  port.postMessage(buildStatusMsg());
  // 推送当前 session 列表
  buildSessionsMsg().then((msg) => {
    try {
      port.postMessage(msg);
    } catch {
      /* 已关闭 */
    }
  });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type === "setForeground") setGlobalForeground(msg.value === true);
    if (msg?.type === "setKeepTab") setGlobalKeepTab(msg.value === true);
    if (msg?.type === "openAutomationWindow") {
      try {
        await getAutomationWindow("default", { focused: true });
      } catch (err) {
        console.error("[tabworks] 打开自动化窗口失败:", err);
      }
    }
    if (msg?.type === "getSessions") {
      const sessionsMsg = await buildSessionsMsg();
      try {
        port.postMessage(sessionsMsg);
      } catch {
        /* 已关闭 */
      }
    }
  });

  port.onDisconnect.addListener(() => popupPorts.delete(port));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "tabworks-ui-recording-start") {
    startUiRecording(message.tabId)
      .then((data) => ({ ok: true, ...data }))
      .then(sendResponse)
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (message?.type === "tabworks-ui-recording-stop") {
    stopUiRecording(message.sessionId, message.tabId)
      .then((data) => ({ ok: true, ...data }))
      .then(sendResponse)
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (message?.type === "tabworks-ui-recording-status") {
    const active = [...recordingTabs.values()][0] || null;
    getLastUiRecording()
      .then((lastRecording) => ({
        ok: true,
        recording: active ? recordingStatus(active) : null,
        lastRecording,
      }))
      .then(sendResponse)
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (message?.type === "tabworks-ui-recording-replay") {
    replayUiRecording(message)
      .then((data) => ({ ok: data?.ok !== false, ...data }))
      .then(sendResponse)
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (message?.type !== "tabworks-recording-event") return false;
  const tabId = sender.tab?.id;
  if (!tabId) return false;
  const recording = recordingTabs.get(tabId);
  if (!recording || recording.sessionId !== message.sessionId) return false;
  recording.events.push(message.event);
  if (message.event?.url) recording.url = message.event.url;
  if (message.event?.title) recording.title = message.event.title;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "recording-event",
        sessionId: recording.sessionId,
        tabId,
        event: message.event,
      }),
    );
  }
  return false;
});

// ─── 生命周期 ────────────────────────────────────────────────────────

let initialized = false;

function initialize() {
  if (initialized) return;
  initialized = true;
  chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
  registerCdpListeners();
  connect();
  updateBadge();
  console.log("[tabworks] TabWorks Bridge 扩展已初始化");
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});
chrome.runtime.onStartup.addListener(() => initialize());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") connect();
});

// 兼容旧版一次性消息查询
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getStatus") {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN,
      reconnecting: reconnectTimer !== null,
      foreground: globalForeground,
    });
  }
  return false;
});
