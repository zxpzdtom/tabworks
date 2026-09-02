// @ts-nocheck
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

const TEST_CONFIG = globalThis.__TABWORKS_TEST_CONFIG__ || {};
const BRIDGE_WS_URL = "ws://127.0.0.1:9527/ext";
const WS_RECONNECT_BASE_DELAY = TEST_CONFIG.reconnectBaseDelay ?? 2000;
const WS_RECONNECT_MAX_DELAY = TEST_CONFIG.reconnectMaxDelay ?? 60000;
const WS_HEARTBEAT_INTERVAL = TEST_CONFIG.heartbeatInterval ?? 20000;
const WINDOW_IDLE_TIMEOUT = TEST_CONFIG.windowIdleTimeout ?? 30000; // 30s 无命令后自动关闭自动化窗口
const DEFAULT_COMMAND_TIMEOUT = TEST_CONFIG.commandTimeout ?? 30000;
const DEFAULT_NAVIGATION_TIMEOUT = TEST_CONFIG.navigationTimeout ?? 25000;
const DEBUGGER_OPERATION_TIMEOUT = TEST_CONFIG.debuggerTimeout ?? 10000;
const TAB_OPERATION_TIMEOUT = TEST_CONFIG.tabTimeout ?? 10000;
const MAX_COMMAND_TIMEOUT = 120000;
const BLANK_PAGE = "data:text/html,<html></html>";
const KEEPALIVE_ALARM = "keepalive";
const AUTOMATION_SESSIONS_KEY = "automationSessions";

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

  let socket;
  try {
    socket = new WebSocket(BRIDGE_WS_URL);
    ws = socket;
  } catch {
    scheduleReconnect();
    return;
  }

  let heartbeatTimer = null;

  const clearHeartbeat = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  socket.onopen = () => {
    if (ws !== socket) {
      socket.close();
      return;
    }
    console.log(`[tabworks] 已连接到 bridge: ${BRIDGE_WS_URL}`);
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket.send(
      JSON.stringify({
        type: "hello",
        version: chrome.runtime.getManifest().version,
      }),
    );
    heartbeatTimer = setInterval(() => {
      if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(
          JSON.stringify({ type: "heartbeat", timestamp: Date.now() }),
        );
      } catch {
        /* onclose/onerror 会负责重连 */
      }
    }, WS_HEARTBEAT_INTERVAL);
    updateBadge();
    broadcastStatus();
  };

  socket.onmessage = async (event) => {
    if (ws !== socket) return;
    try {
      const command = JSON.parse(event.data);
      const result = await handleCommand(command, socket);
      // 命令属于接收它的 socket。连接换代后绝不能把旧结果发给新 socket。
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(result));
      }
    } catch (err) {
      console.error("[tabworks] 消息处理异常:", err);
    }
  };

  socket.onclose = () => {
    clearHeartbeat();
    if (ws !== socket) return;
    console.log("[tabworks] 已断开 bridge 连接");
    ws = null;
    cdpDetachAll().catch((err) =>
      console.warn("[tabworks] 释放 debugger 失败:", err),
    );
    scheduleReconnect();
    updateBadge();
    broadcastStatus();
  };

  socket.onerror = () => {
    socket.close();
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

// ─── 有界异步操作 ────────────────────────────────────────────────────

function clampTimeout(value, fallback, maximum = MAX_COMMAND_TIMEOUT) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(numeric), maximum));
}

function commandError(code, context, cause, startedAt = Date.now()) {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const action = context?.action || "unknown";
  const phase = context?.phase || "unknown";
  const tabId = Number.isInteger(context?.tabId) ? context.tabId : "unknown";
  const detail = cause instanceof Error ? cause.message : String(cause || code);
  const error = new Error(
    `${code} action=${action} phase=${phase} tabId=${tabId} elapsedMs=${elapsedMs}: ${detail}`,
  );
  error.code = code;
  error.action = action;
  error.phase = phase;
  error.tabId = Number.isInteger(context?.tabId) ? context.tabId : null;
  error.elapsedMs = elapsedMs;
  error.cause = cause;
  return error;
}

async function withTimeout(operation, timeoutMs, context) {
  const startedAt = Date.now();
  const boundedTimeout = clampTimeout(timeoutMs, DEFAULT_COMMAND_TIMEOUT);
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              commandError(
                "COMMAND_TIMEOUT",
                context,
                `超过 ${boundedTimeout}ms`,
                startedAt,
              ),
            ),
          boundedTimeout,
        );
      }),
    ]);
  } catch (err) {
    if (err?.code) throw err;
    throw commandError("COMMAND_FAILED", context, err, startedAt);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 自动化窗口隔离 ──────────────────────────────────────────────────

const automationSessions = new Map();
const activeCommandsByWorkspace = new Map();
const automationWindowPromises = new Map();
const workspaceTabQueues = new Map();
const recordingTabs = new Map(); // Map<tabId, { sessionId, startedAt, events }>
const LAST_UI_RECORDING_KEY = "lastUiRecording";

function getWorkspaceKey(workspace) {
  return workspace?.trim() || "default";
}

function persistAutomationSessions() {
  const value = [...automationSessions.entries()].map(
    ([workspace, session]) => ({
      workspace,
      windowId: session.windowId,
      idleDeadlineAt: session.idleDeadlineAt,
    }),
  );
  return chrome.storage.session
    .set({ [AUTOMATION_SESSIONS_KEY]: value })
    .catch((err) =>
      console.warn("[tabworks] 保存自动化 session 失败:", err),
    );
}

function clearWindowIdleTimer(session) {
  if (session?.idleTimer) clearTimeout(session.idleTimer);
  if (session) session.idleTimer = null;
}

function resetWindowIdleTimer(workspace, delayMs = WINDOW_IDLE_TIMEOUT) {
  const session = automationSessions.get(workspace);
  if (!session) return;
  clearWindowIdleTimer(session);
  if (session.activeCommandCount > 0) {
    session.idleDeadlineAt = null;
    void persistAutomationSessions();
    broadcastSessions();
    return;
  }
  const boundedDelay = Math.max(0, delayMs);
  session.idleDeadlineAt = Date.now() + boundedDelay;
  session.idleTimer = setTimeout(async () => {
    const current = automationSessions.get(workspace);
    if (!current || current.activeCommandCount > 0) return;
    try {
      await withTimeout(
        () => chrome.windows.remove(current.windowId),
        TAB_OPERATION_TIMEOUT,
        { action: "idle-close", phase: "windows.remove" },
      );
      console.log(
        `[tabworks] 自动化窗口 ${current.windowId} (${workspace}) 已关闭（空闲超时）`,
      );
    } catch {
      /* 已关闭 */
    }
    automationSessions.delete(workspace);
    await persistAutomationSessions();
    broadcastSessions();
  }, boundedDelay);
  void persistAutomationSessions();
  broadcastSessions();
}

function beginWorkspaceCommand(workspace) {
  const count = (activeCommandsByWorkspace.get(workspace) || 0) + 1;
  activeCommandsByWorkspace.set(workspace, count);
  const session = automationSessions.get(workspace);
  if (session) {
    session.activeCommandCount = count;
    session.idleDeadlineAt = null;
    clearWindowIdleTimer(session);
    void persistAutomationSessions();
  }
}

function endWorkspaceCommand(workspace) {
  const count = Math.max(
    0,
    (activeCommandsByWorkspace.get(workspace) || 1) - 1,
  );
  if (count === 0) activeCommandsByWorkspace.delete(workspace);
  else activeCommandsByWorkspace.set(workspace, count);
  const session = automationSessions.get(workspace);
  if (!session) return;
  session.activeCommandCount = count;
  if (count === 0) resetWindowIdleTimer(workspace);
}

async function getAutomationWindow(
  workspace,
  { focused = false, initialUrl = BLANK_PAGE } = {},
) {
  const existing = automationSessions.get(workspace);
  if (existing) {
    try {
      await withTimeout(
        () => chrome.windows.get(existing.windowId),
        TAB_OPERATION_TIMEOUT,
        { action: "window", phase: "windows.get" },
      );
      if (focused)
        await withTimeout(
          () => chrome.windows.update(existing.windowId, { focused: true }),
          TAB_OPERATION_TIMEOUT,
          { action: "window", phase: "windows.update" },
        );
      return existing.windowId;
    } catch {
      automationSessions.delete(workspace);
      await persistAutomationSessions();
    }
  }

  const pendingWindow = automationWindowPromises.get(workspace);
  if (pendingWindow) {
    const windowId = await pendingWindow;
    if (focused) {
      await withTimeout(
        () => chrome.windows.update(windowId, { focused: true }),
        TAB_OPERATION_TIMEOUT,
        { action: "window", phase: "windows.update:coalesced" },
      );
    }
    return windowId;
  }

  const createWindow = (async () => {
    const win = await withTimeout(
      () =>
        chrome.windows.create({
          url: initialUrl,
          focused,
          width: 1280,
          height: 900,
          type: "normal",
          state: "normal",
        }),
      TAB_OPERATION_TIMEOUT,
      { action: "window", phase: "windows.create" },
    );
    let bootstrapTabId = win.tabs?.[0]?.id ?? null;
    if (!Number.isInteger(bootstrapTabId)) {
      try {
        const createdTabs = await withTimeout(
          () => chrome.tabs.query({ windowId: win.id }),
          TAB_OPERATION_TIMEOUT,
          { action: "window", phase: "tabs.query:bootstrap" },
        );
        bootstrapTabId = createdTabs[0]?.id ?? null;
      } catch {
        /* Window.tabs 在正常权限下会直接提供首 tab；查询仅为兼容兜底。 */
      }
    }
    const session = {
      windowId: win.id,
      bootstrapTabId,
      idleTimer: null,
      idleDeadlineAt: null,
      activeCommandCount: activeCommandsByWorkspace.get(workspace) || 0,
    };
    automationSessions.set(workspace, session);
    await persistAutomationSessions();
    console.log(
      `[tabworks] 创建自动化窗口 ${session.windowId} (${workspace}, focused=${focused})`,
    );
    if (session.activeCommandCount === 0) resetWindowIdleTimer(workspace);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return session.windowId;
  })();
  automationWindowPromises.set(workspace, createWindow);
  try {
    return await createWindow;
  } finally {
    if (automationWindowPromises.get(workspace) === createWindow) {
      automationWindowPromises.delete(workspace);
    }
  }
}

function withWorkspaceTabQueue(workspace, operation) {
  const previous = workspaceTabQueues.get(workspace) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  workspaceTabQueues.set(workspace, current);
  return current.finally(() => {
    if (workspaceTabQueues.get(workspace) === current) {
      workspaceTabQueues.delete(workspace);
    }
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [workspace, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(`[tabworks] 自动化窗口已关闭 (${workspace})`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
      void persistAutomationSessions();
      broadcastSessions();
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  recordingTabs.delete(tabId);
});

// ─── CDP 工具函数 ────────────────────────────────────────────────────

const attachedTabs = new Set();
const tabCommandQueues = new Map();
const tabOperationQueues = new Map();

function withTabQueue(tabId, operation) {
  const previous = tabCommandQueues.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  tabCommandQueues.set(tabId, current);
  return current.finally(() => {
    if (tabCommandQueues.get(tabId) === current) tabCommandQueues.delete(tabId);
  });
}

function withTabOperationQueue(tabId, operation, context = {}) {
  const previous = tabOperationQueues.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    if (context.deadlineAt && Date.now() >= context.deadlineAt) {
      throw commandError(
        "COMMAND_TIMEOUT",
        {
          action: context.action,
          phase: "tab-queue",
          tabId,
        },
        "命令在排队期间已超时，已取消且不会迟到执行",
        context.startedAt,
      );
    }
    return operation();
  });
  tabOperationQueues.set(tabId, current);
  return current.finally(() => {
    if (tabOperationQueues.get(tabId) === current) {
      tabOperationQueues.delete(tabId);
    }
  });
}

function tabOperationContext(cmd) {
  return {
    action: cmd?.action,
    startedAt: cmd?.__startedAt,
    deadlineAt: cmd?.__deadlineAt,
  };
}

function runUiTabOperation(tabId, action, operation) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + DEFAULT_COMMAND_TIMEOUT;
  return withTimeout(
    () =>
      withTabOperationQueue(tabId, operation, {
        action,
        startedAt,
        deadlineAt,
      }),
    DEFAULT_COMMAND_TIMEOUT,
    { action, phase: "ui-command", tabId },
  );
}

function sendCdpCommand(tabId, method, params, action) {
  return withTimeout(
    () => chrome.debugger.sendCommand({ tabId }, method, params),
    DEBUGGER_OPERATION_TIMEOUT,
    { action, phase: `sendCommand:${method}`, tabId },
  );
}

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

async function ensureAttachedUnlocked(tabId, action) {
  try {
    const tab = await withTimeout(
      () => chrome.tabs.get(tabId),
      TAB_OPERATION_TIMEOUT,
      { action, phase: "tabs.get", tabId },
    );
    if (!isDebuggableUrl(tab.url)) {
      attachedTabs.delete(tabId);
      throw new Error(`无法调试 tab ${tabId}：URL 为 ${tab.url ?? "unknown"}`);
    }
  } catch (e) {
    if (e?.code) throw e;
    if (e instanceof Error && e.message.startsWith("无法调试")) throw e;
    attachedTabs.delete(tabId);
    throw new Error(`Tab ${tabId} 不存在`);
  }

  if (attachedTabs.has(tabId)) return;

  const targets = await withTimeout(
    () => chrome.debugger.getTargets(),
    DEBUGGER_OPERATION_TIMEOUT,
    { action, phase: "getTargets", tabId },
  );
  if (
    targets.some(
      (target) => target.tabId === tabId && target.attached === true,
    )
  ) {
    throw commandError(
      "DEBUGGER_BUSY",
      { action, phase: "getTargets", tabId },
      "已有 debugger（例如 DevTools）占用；未执行 attach/detach",
    );
  }

  try {
    await withTimeout(
      () => chrome.debugger.attach({ tabId }, "1.3"),
      DEBUGGER_OPERATION_TIMEOUT,
      { action, phase: "attach", tabId },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/another debugger is already attached/i.test(msg)) {
      throw commandError(
        "DEBUGGER_BUSY",
        { action, phase: "attach", tabId },
        "已有 debugger（例如 DevTools）占用；未执行 detach",
      );
    }
    throw e;
  }
  attachedTabs.add(tabId);
  try {
    await sendCdpCommand(tabId, "Runtime.enable", undefined, action);
  } catch (err) {
    try {
      await cdpDetachUnlocked(tabId, action);
    } catch {
      /* 保留 Runtime.enable 的原始错误 */
    }
    throw err;
  }
}

async function cdpEvaluate(tabId, expression) {
  return withCdpAttachment(tabId, "exec", async () => {
    const result = await sendCdpCommand(
      tabId,
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      "exec",
    );
    if (result.exceptionDetails) {
      const errMsg =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Eval 错误";
      throw new Error(errMsg);
    }
    return result.result?.value;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cdpMouseClick(tabId, x, y) {
  return withCdpAttachment(tabId, "mouse", async () => {
    const point = { x: Number(x), y: Number(y) };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error("鼠标坐标无效");
    }
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      pointerType: "mouse",
    }, "mouse");
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    }, "mouse");
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    }, "mouse");
    return { clicked: true, ...point };
  });
}

async function cdpMousePress(tabId, x, y, durationMs = 700) {
  return withCdpAttachment(tabId, "mouse", async () => {
    const point = { x: Number(x), y: Number(y) };
    const holdMs = Math.max(100, Math.min(Number(durationMs) || 700, 5000));
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error("鼠标坐标无效");
    }
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
    }, "mouse");
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    }, "mouse");
    await sleep(holdMs);
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    }, "mouse");
    return { pressed: true, durationMs: holdMs, ...point };
  });
}

async function cdpMouseDrag(tabId, fromX, fromY, toX, toY, durationMs = 450) {
  return withCdpAttachment(tabId, "mouse", async () => {
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
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x,
      y: start.y,
      button: "none",
    }, "mouse");
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: start.x,
      y: start.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    }, "mouse");

    const steps = Math.max(4, Math.min(40, Math.round(dragMs / 24)));
    for (let i = 1; i <= steps; i += 1) {
      await sleep(dragMs / steps);
      await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: start.x + ((end.x - start.x) * i) / steps,
        y: start.y + ((end.y - start.y) * i) / steps,
        button: "left",
        buttons: 1,
      }, "mouse");
    }

    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: end.x,
      y: end.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    }, "mouse");
    return {
      dragged: true,
      fromX: start.x,
      fromY: start.y,
      toX: end.x,
      toY: end.y,
      durationMs: dragMs,
    };
  });
}

const KEY_DEFINITIONS = {
  Space: { key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
};

async function cdpKeyPress(tabId, key) {
  return withCdpAttachment(tabId, "key", async () => {
    const definition =
      KEY_DEFINITIONS[key] ||
      (String(key || "").length === 1
        ? {
            key: String(key),
            code: `Key${String(key).toUpperCase()}`,
            text: String(key),
            windowsVirtualKeyCode: String(key).toUpperCase().charCodeAt(0),
          }
        : null);
    if (!definition) throw new Error(`不支持的按键: ${key}`);
    const base = {
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
    };
    await sendCdpCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      text: definition.text,
    }, "key");
    await sendCdpCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      ...base,
    }, "key");
    return { pressed: true, key };
  });
}

async function cdpDetachUnlocked(tabId, action = "cleanup") {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  await withTimeout(
    () => chrome.debugger.detach({ tabId }),
    DEBUGGER_OPERATION_TIMEOUT,
    { action, phase: "detach", tabId },
  );
}

async function cdpDetach(tabId, action = "cleanup") {
  return withTabQueue(tabId, () => cdpDetachUnlocked(tabId, action));
}

async function cdpDetachAll() {
  await Promise.all([...attachedTabs].map((tabId) => cdpDetach(tabId)));
}

async function withCdpAttachment(tabId, action, operation) {
  return withTabQueue(tabId, async () => {
    await ensureAttachedUnlocked(tabId, action);
    let operationError = null;
    try {
      return await operation();
    } catch (err) {
      operationError = err;
      throw err;
    } finally {
      try {
        await cdpDetachUnlocked(tabId, action);
      } catch (detachError) {
        if (!operationError) throw detachError;
        console.warn(
          `[tabworks] debugger 清理失败（保留原始命令错误）: ${detachError instanceof Error ? detachError.message : String(detachError)}`,
        );
      }
    }
  });
}

async function cdpScreenshot(tabId, options = {}) {
  return withCdpAttachment(tabId, "screenshot", async () => {
    const format = options.format ?? "png";

    if (options.fullPage) {
      const metrics = await sendCdpCommand(
        tabId,
        "Page.getLayoutMetrics",
        undefined,
        "screenshot",
      );
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) {
        await sendCdpCommand(
          tabId,
          "Emulation.setDeviceMetricsOverride",
          {
            mobile: false,
            width: Math.ceil(size.width),
            height: Math.ceil(size.height),
            deviceScaleFactor: 1,
          },
          "screenshot",
        );
      }
    }

    try {
      const params = { format };
      if (format === "jpeg" && options.quality !== undefined) {
        params.quality = Math.max(0, Math.min(100, options.quality));
      }
      const result = await sendCdpCommand(
        tabId,
        "Page.captureScreenshot",
        params,
        "screenshot",
      );
      return result.data;
    } finally {
      if (options.fullPage) {
        await sendCdpCommand(
          tabId,
          "Emulation.clearDeviceMetricsOverride",
          undefined,
          "screenshot",
        )
          .catch(() => {});
      }
    }
  });
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
      await cdpDetach(tabId).catch((err) =>
        console.warn("[tabworks] URL 变化后释放 debugger 失败:", err),
      );
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

function normalizeFrameUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function normalizeFrameName(name) {
  return String(name || "").split("?")[0];
}

function frameContextFromEvent(event) {
  return event?.frameContext || null;
}

function recordedFrameKey(event) {
  const context = frameContextFromEvent(event);
  if (context?.isTop) return "top";
  if (context?.frameSelector) return `selector:${context.frameSelector}`;
  if (context?.frameName) return `name:${normalizeFrameName(context.frameName)}`;
  if (Number.isInteger(context?.frameIndex)) return `index:${context.frameIndex}`;
  const frameId = Number.isInteger(event.frameId) ? event.frameId : 0;
  return `id:${frameId}`;
}

function sameRecordingFrame(a, b) {
  const left = recordedFrameKey(a);
  const right = recordedFrameKey(b);
  if (left === right) return true;
  return (
    (left === "top" && right === "id:0") ||
    (left === "id:0" && right === "top")
  );
}

function recordingEventTime(event) {
  const time = Date.parse(event?.at || "");
  return Number.isFinite(time) ? time : null;
}

function orderedRecordingEvents(events = []) {
  return events
    .map((event, index) => ({ event, index, time: recordingEventTime(event) }))
    .sort((a, b) => {
      if (a.time !== null && b.time !== null && a.time !== b.time) {
        return a.time - b.time;
      }
      if (a.time !== null && b.time === null) return -1;
      if (a.time === null && b.time !== null) return 1;
      return a.index - b.index;
    })
    .map((item) => item.event);
}

function isContentReplayEvent(event) {
  return [
    "click",
    "input",
    "scroll",
    "submit",
    "long-press",
    "drag",
    "double-click",
    "context-menu",
    "key",
  ].includes(event?.kind);
}

function replayDelayMs(previousEvent, event, options = {}) {
  const previousAt = recordingEventTime(previousEvent);
  const currentAt = recordingEventTime(event);
  if (previousAt === null || currentAt === null) return 0;
  const delta = currentAt - previousAt;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  const speed = Math.max(0.1, Number(options.speed || 1));
  const maxDelayMs = Math.max(0, Number(options.maxDelayMs ?? 2000));
  return Math.min(delta / speed, maxDelayMs);
}

function selectorForRecordingEvent(event) {
  const selectors = event?.element?.selectors || [];
  return (
    selectors.find((item) => item.unique)?.selector ||
    event?.element?.preferredSelector ||
    event?.sortable?.rowElement?.preferredSelector ||
    event?.sortable?.rowElement?.selectors?.find((item) => item.unique)
      ?.selector ||
    ""
  );
}

function closeNumber(a, b, tolerance = 6) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= tolerance;
}

function sameSortableMove(a, b) {
  if (!a?.sortable || !b?.sortable) return false;
  if (
    a.sortable.sourceLabel ||
    b.sortable.sourceLabel ||
    a.sortable.rowElement ||
    b.sortable.rowElement
  ) {
    const sameSourceLabel =
      String(a.sortable.sourceLabel || "") ===
      String(b.sortable.sourceLabel || "");
    const sameRowSelector =
      selectorForRecordingEvent(a) &&
      selectorForRecordingEvent(a) === selectorForRecordingEvent(b);
    if (sameSourceLabel || sameRowSelector) return true;
  }
  return (
    String(a.sortable.sourceLabel || "") ===
      String(b.sortable.sourceLabel || "") &&
    Number(a.sortable.fromIndex) === Number(b.sortable.fromIndex) &&
    Number(a.sortable.toIndex) === Number(b.sortable.toIndex) &&
    Number(a.sortable.moveDelta) === Number(b.sortable.moveDelta)
  );
}

function sameDragGeometry(a, b) {
  return (
    closeNumber(a?.startX, b?.startX) &&
    closeNumber(a?.startY, b?.startY) &&
    closeNumber(a?.endX, b?.endX) &&
    closeNumber(a?.endY, b?.endY)
  );
}

function isDuplicateDragEvent(previous, next) {
  if (previous?.kind !== "drag" || next?.kind !== "drag") return false;
  const previousAt = recordingEventTime(previous);
  const nextAt = recordingEventTime(next);
  if (
    previousAt !== null &&
    nextAt !== null &&
    Math.abs(nextAt - previousAt) > 900
  ) {
    return false;
  }
  if (!sameRecordingFrame(previous, next)) return false;
  return sameSortableMove(previous, next) || sameDragGeometry(previous, next);
}

function sameClickGeometry(a, b) {
  return closeNumber(a?.x, b?.x, 12) && closeNumber(a?.y, b?.y, 12);
}

function isDuplicateClickEvent(previous, next) {
  if (previous?.kind !== "click" || next?.kind !== "click") return false;
  const previousAt = recordingEventTime(previous);
  const nextAt = recordingEventTime(next);
  if (
    previousAt !== null &&
    nextAt !== null &&
    Math.abs(nextAt - previousAt) > 350
  ) {
    return false;
  }
  if (!sameRecordingFrame(previous, next)) return false;
  return sameClickGeometry(previous, next);
}

function shouldSkipDuplicateRecordingEvent(recording, event) {
  const recentEvents = (recording?.events || []).slice(-8);
  return recentEvents.some(
    (previous) =>
      isDuplicateDragEvent(previous, event) ||
      isDuplicateClickEvent(previous, event),
  );
}

function dedupeDragEvents(events = []) {
  const normalized = [];
  for (const event of events) {
    if (
      normalized
        .slice(-8)
        .some(
          (previous) =>
            isDuplicateDragEvent(previous, event) ||
            isDuplicateClickEvent(previous, event),
        )
    ) {
      continue;
    }
    normalized.push(event);
  }
  return normalized;
}

async function resolveTabId(tabId, workspace) {
  if (tabId !== undefined) {
    const startedAt = Date.now();
    let tab;
    try {
      tab = await withTimeout(
        () => chrome.tabs.get(tabId),
        TAB_OPERATION_TIMEOUT,
        { action: "resolve-tab", phase: "tabs.get", tabId },
      );
    } catch (err) {
      throw commandError(
        err?.code === "COMMAND_TIMEOUT" ? "COMMAND_TIMEOUT" : "TAB_NOT_FOUND",
        { action: "resolve-tab", phase: "tabs.get", tabId },
        err,
        startedAt,
      );
    }
    const session = automationSessions.get(workspace);
    if (!session || tab.windowId !== session.windowId) {
      throw commandError(
        "TAB_OUTSIDE_AUTOMATION",
        { action: "resolve-tab", phase: "validate-window", tabId },
        `Tab ${tabId} 不属于 workspace=${workspace} 的自动化窗口`,
        startedAt,
      );
    }
    if (!isDebuggableUrl(tab.url)) {
      throw commandError(
        "TAB_NOT_DEBUGGABLE",
        { action: "resolve-tab", phase: "validate-url", tabId },
        `URL 不可调试: ${tab.url}`,
        startedAt,
      );
    }
    return tabId;
  }

  const windowId = await getAutomationWindow(workspace);
  const tabs = await withTimeout(
    () => chrome.tabs.query({ windowId }),
    TAB_OPERATION_TIMEOUT,
    { action: "resolve-tab", phase: "tabs.query" },
  );

  const debuggableTab = tabs.find((t) => t.id && isDebuggableUrl(t.url));
  if (debuggableTab?.id) return debuggableTab.id;

  const reuseTab = tabs.find((t) => t.id);
  if (reuseTab?.id) {
    await withTimeout(
      () => chrome.tabs.update(reuseTab.id, { url: BLANK_PAGE }),
      TAB_OPERATION_TIMEOUT,
      { action: "resolve-tab", phase: "tabs.update", tabId: reuseTab.id },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const updated = await withTimeout(
        () => chrome.tabs.get(reuseTab.id),
        TAB_OPERATION_TIMEOUT,
        { action: "resolve-tab", phase: "tabs.get:updated", tabId: reuseTab.id },
      );
      if (isDebuggableUrl(updated.url)) return reuseTab.id;
    } catch {
      /* 标签页在导航中关闭 */
    }
  }

  const newTab = await withTimeout(
    () =>
      chrome.tabs.create({
        windowId,
        url: BLANK_PAGE,
        active: true,
      }),
    TAB_OPERATION_TIMEOUT,
    { action: "resolve-tab", phase: "tabs.create" },
  );
  if (!newTab.id) throw new Error("创建标签页失败");
  return newTab.id;
}

async function listAutomationWebTabs(workspace) {
  const session = automationSessions.get(workspace);
  if (!session) return [];
  try {
    const tabs = await withTimeout(
      () => chrome.tabs.query({ windowId: session.windowId }),
      TAB_OPERATION_TIMEOUT,
      { action: "tabs", phase: "tabs.query" },
    );
    return tabs.filter((t) => isDebuggableUrl(t.url));
  } catch {
    automationSessions.delete(workspace);
    await persistAutomationSessions();
    return [];
  }
}

async function resolveRecordingTabId(tabId) {
  if (tabId !== undefined && tabId !== null) return tabId;
  const tabs = await withTimeout(
    () => chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    TAB_OPERATION_TIMEOUT,
    { action: "recording", phase: "tabs.query" },
  );
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

async function sendMessageToTabFrame(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch (err) {
    throw new Error(
      "无法连接页面录制脚本，请刷新目标页面或重新加载扩展后再试：" +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

async function getTabFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return (frames || [])
      .filter((frame) => Number.isInteger(frame.frameId))
      .map((frame) => ({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url,
      }));
  } catch {
    return [{ frameId: 0, parentFrameId: -1, url: "" }];
  }
}

async function injectRecorderIntoFrames(tabId, targetFrameId) {
  if (!Number.isInteger(targetFrameId)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["recorder-main.js"],
        world: "MAIN",
      });
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["recorder-content.js"],
      });
      return;
    } catch {
      /* allFrames 在部分受限页面会失败，继续按 frameId 逐个注入 */
    }
  }
  const frameIds =
    Number.isInteger(targetFrameId)
      ? [targetFrameId]
      : (await getTabFrames(tabId)).map((frame) => frame.frameId);
  for (const frameId of frameIds) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ["recorder-main.js"],
        world: "MAIN",
      });
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ["recorder-content.js"],
      });
    } catch {
      /* 某些受限 frame 不能注入，后续 sendMessage 会按 frame 汇报失败 */
    }
  }
}

async function refreshTabBeforeReplay(tabId, url, timeoutMs = 12000) {
  const targetUrl = url && isDebuggableUrl(url) ? url : null;
  const waitMs = Math.max(1000, Math.min(Number(timeoutMs) || 12000, 60000));
  await new Promise((resolve, reject) => {
    let done = false;
    let timer = null;

    const finish = (error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };

    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") finish();
    };

    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => finish(new Error("等待页面刷新超时")), waitMs);

    const navigation = targetUrl
      ? withTimeout(
          () => chrome.tabs.update(tabId, { url: targetUrl, active: true }),
          TAB_OPERATION_TIMEOUT,
          { action: "recording", phase: "tabs.update", tabId },
        )
      : withTimeout(
          () => chrome.tabs.reload(tabId),
          TAB_OPERATION_TIMEOUT,
          { action: "recording", phase: "tabs.reload", tabId },
        );
    navigation.catch((err) =>
      finish(err instanceof Error ? err : new Error(String(err))),
    );
  });
  await sleep(500);
}

async function sendMessageToAllFrames(tabId, message) {
  const frames = await getTabFrames(tabId);
  const results = [];
  for (const frame of frames) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message, {
        frameId: frame.frameId,
      });
      results.push({ ...frame, ok: true, response });
    } catch (err) {
      results.push({
        ...frame,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const connected = results.filter((item) => item.ok);
  if (!connected.length) {
    const firstError = results.find((item) => item.error)?.error || "没有 frame 响应";
    throw new Error(
      "无法连接页面录制脚本，请刷新目标页面或重新加载扩展后再试：" +
        firstError,
    );
  }
  return {
    frames: results,
    primary:
      connected.find((item) => item.frameId === 0)?.response ||
      connected[0]?.response ||
      null,
  };
}

async function collectFrameContexts(tabId) {
  const response = await sendMessageToAllFrames(tabId, {
    type: "tabworks-frame-context",
  });
  return response.frames.map((frame) => ({
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId,
    url: frame.response?.url || frame.url,
    ok: frame.ok,
    error: frame.error,
    frameContext: frame.response?.frameContext || null,
  }));
}

async function startRecordingInFrames(tabId, sessionId, attempts = 6) {
  let latest = null;
  for (let i = 0; i < attempts; i += 1) {
    await injectRecorderIntoFrames(tabId);
    latest = await sendMessageToAllFrames(tabId, {
      type: "tabworks-recording-start",
      sessionId,
    });
    const frames = await getTabFrames(tabId);
    const expectedFrameCount = frames.length;
    const connectedFrameCount = latest.frames.filter((frame) => frame.ok).length;
    if (connectedFrameCount >= expectedFrameCount) break;
    await sleep(300);
  }
  return latest;
}

function chooseReplayFrameId(frameEvents, frameContexts) {
  const sample =
    frameEvents.find((event) => frameContextFromEvent(event)) ||
    frameEvents.find((event) => Number.isInteger(event.frameId)) ||
    frameEvents[0] ||
    {};
  const recordedFrameId = Number.isInteger(sample.frameId) ? sample.frameId : 0;
  const recordedContext = frameContextFromEvent(sample);

  if (recordedContext?.isTop || (!recordedContext && recordedFrameId === 0)) {
    return 0;
  }

  const recordedUrl = normalizeFrameUrl(
    recordedContext?.url || sample.frameUrl || sample.url,
  );
  const candidates = frameContexts.filter((frame) => {
    if (!frame.ok) return false;
    if (!recordedUrl) return true;
    return normalizeFrameUrl(frame.url || frame.frameContext?.url) === recordedUrl;
  });
  const scopedCandidates = candidates.length ? candidates : frameContexts;

  if (recordedContext?.frameSelector) {
    const matched = scopedCandidates.find(
      (frame) => frame.frameContext?.frameSelector === recordedContext.frameSelector,
    );
    if (matched) return matched.frameId;
  }

  const recordedName = normalizeFrameName(recordedContext?.frameName);
  if (recordedName) {
    const matched = scopedCandidates.find(
      (frame) => normalizeFrameName(frame.frameContext?.frameName) === recordedName,
    );
    if (matched) return matched.frameId;
  }

  if (Number.isInteger(recordedContext?.frameIndex)) {
    const matched = scopedCandidates.find(
      (frame) => frame.frameContext?.frameIndex === recordedContext.frameIndex,
    );
    if (matched) return matched.frameId;
  }

  const sameId = frameContexts.find((frame) => frame.frameId === recordedFrameId);
  if (sameId) return sameId.frameId;
  if (candidates.length === 1) return candidates[0].frameId;
  return scopedCandidates[0]?.frameId ?? recordedFrameId;
}

function hasReplayFrameMatch(frameEvents, frameContexts) {
  const sample =
    frameEvents.find((event) => frameContextFromEvent(event)) ||
    frameEvents.find((event) => Number.isInteger(event.frameId)) ||
    frameEvents[0] ||
    {};
  const recordedFrameId = Number.isInteger(sample.frameId) ? sample.frameId : 0;
  const recordedContext = frameContextFromEvent(sample);

  if (recordedContext?.isTop || (!recordedContext && recordedFrameId === 0)) {
    return frameContexts.some((frame) => frame.ok && frame.frameId === 0);
  }

  const recordedUrl = normalizeFrameUrl(
    recordedContext?.url || sample.frameUrl || sample.url,
  );
  const candidates = frameContexts.filter((frame) => {
    if (!frame.ok) return false;
    if (!recordedUrl) return true;
    return normalizeFrameUrl(frame.url || frame.frameContext?.url) === recordedUrl;
  });
  if (!candidates.length) return false;

  if (recordedContext?.frameSelector) {
    return candidates.some(
      (frame) => frame.frameContext?.frameSelector === recordedContext.frameSelector,
    );
  }
  const recordedName = normalizeFrameName(recordedContext?.frameName);
  if (recordedName) {
    return candidates.some(
      (frame) => normalizeFrameName(frame.frameContext?.frameName) === recordedName,
    );
  }
  if (Number.isInteger(recordedContext?.frameIndex)) {
    return candidates.some(
      (frame) => frame.frameContext?.frameIndex === recordedContext.frameIndex,
    );
  }
  if (recordedFrameId !== 0) {
    return candidates.some((frame) => frame.frameId === recordedFrameId);
  }
  return candidates.length === 1;
}

function requiredReplayFrameGroups(grouped) {
  return [...grouped.values()].filter((frameEvents) =>
    frameEvents.some((event) => {
      const context = frameContextFromEvent(event);
      return (
        event.inFrame ||
        context?.isTop === false ||
        (Number.isInteger(event.frameId) && event.frameId !== 0)
      );
    }),
  );
}

async function waitForReplayFrames(tabId, grouped, timeoutMs = 15000) {
  const requiredGroups = requiredReplayFrameGroups(grouped);
  const waitMs = Math.max(1000, Math.min(Number(timeoutMs) || 15000, 60000));
  const startedAt = Date.now();
  let lastContexts = [];

  while (Date.now() - startedAt < waitMs) {
    await injectRecorderIntoFrames(tabId);
    try {
      lastContexts = await collectFrameContexts(tabId);
      const allReady = requiredGroups.every((frameEvents) =>
        hasReplayFrameMatch(frameEvents, lastContexts),
      );
      if (allReady) return lastContexts;
    } catch {
      /* frame 正在加载或还没有 content script，稍后重试 */
    }
    await sleep(350);
  }

  if (!requiredGroups.length && lastContexts.length) return lastContexts;
  throw new Error(
    `等待 iframe 接入超时：需要 ${requiredGroups.length} 个 iframe 分组，当前已连接 ${
      lastContexts.filter((frame) => frame.ok && frame.frameId !== 0).length
    } 个`,
  );
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

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

async function getLastUiRecording() {
  const result = await storageGet([LAST_UI_RECORDING_KEY]);
  return result[LAST_UI_RECORDING_KEY] || null;
}

async function clearLastUiRecording() {
  await storageRemove(LAST_UI_RECORDING_KEY);
  return { cleared: true };
}

function recordingStatus(item) {
  if (!item) return null;
  return {
    sessionId: item.sessionId,
    tabId: item.tabId,
    url: item.url,
    startUrl: item.startUrl,
    title: item.title,
    startTitle: item.startTitle,
    startedAt: item.startedAt,
    eventCount: item.events?.length || 0,
    frameCount: item.frames?.filter((frame) => frame.ok).length || 0,
  };
}

function upsertRecordingFrame(item, frame) {
  if (!item || !Number.isInteger(frame?.frameId)) return;
  if (!Array.isArray(item.frames)) item.frames = [];
  const existingIndex = item.frames.findIndex(
    (entry) => entry.frameId === frame.frameId,
  );
  if (existingIndex >= 0) {
    item.frames[existingIndex] = { ...item.frames[existingIndex], ...frame };
  } else {
    item.frames.push(frame);
  }
}

async function startUiRecording(
  tabId,
  sessionId = createRecordingSessionId(),
  eventSocket = null,
) {
  const targetTabId = await resolveRecordingTabId(tabId);
  const tab = await withTimeout(
    () => chrome.tabs.get(targetTabId),
    TAB_OPERATION_TIMEOUT,
    { action: "recording", phase: "tabs.get", tabId: targetTabId },
  );
  if (!isDebuggableUrl(tab.url)) {
    throw new Error(`无法录制当前 URL：${tab.url}`);
  }
  const item = {
    sessionId,
    tabId: targetTabId,
    startUrl: tab.url,
    startTitle: tab.title,
    url: tab.url,
    title: tab.title,
    startedAt: new Date().toISOString(),
    events: [],
    // 录制事件只能回到启动该录制的 WebSocket，不能因重连被转发到新连接。
    eventSocket,
  };
  recordingTabs.set(targetTabId, item);
  let response;
  try {
    response = await startRecordingInFrames(targetTabId, sessionId);
  } catch (err) {
    recordingTabs.delete(targetTabId);
    throw err;
  }
  item.frames = response.frames;
  item.url = response.primary?.url ?? item.url;
  item.title = response.primary?.title ?? item.title;
  return recordingStatus(item);
}

function findActiveRecordingTabId(sessionId, tabId) {
  const matched = [...recordingTabs.entries()].find(
    ([entryTabId, item]) =>
      item.sessionId === sessionId ||
      (tabId !== undefined && Number(entryTabId) === Number(tabId)),
  );
  return matched?.[0] ?? null;
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
  item.stopping = true;
  let response;
  try {
    response = await sendMessageToAllFrames(targetTabId, {
      type: "tabworks-recording-stop",
      sessionId: item.sessionId,
    });
  } catch (err) {
    item.stopping = false;
    throw err;
  }
  // MAIN world 的采集器使用 AbortController 注册事件；停止后立即中止，
  // 下一次开始录制会重新动态注入并创建新的 controller。
  await chrome.scripting
    .executeScript({
      target: { tabId: targetTabId, allFrames: true },
      world: "MAIN",
      func: () => {
        globalThis.__tabworksRecorderMainBridgeState?.controller?.abort?.();
      },
    })
    .catch(() => {});
  item.events.push({
    seq: item.events.length + 1,
    at: new Date().toISOString(),
    url: response.primary?.url ?? item.url,
    title: response.primary?.title ?? item.title,
    kind: "stop",
    frameId: 0,
  });
  recordingTabs.delete(targetTabId);
  const events = dedupeDragEvents(orderedRecordingEvents(item.events));
  const {
    eventSocket: _eventSocket,
    stopping: _stopping,
    ...persistableItem
  } = item;
  const saved = {
    ...persistableItem,
    events,
    url: response.primary?.url ?? item.url,
    title: response.primary?.title ?? item.title,
    frames: response.frames,
    stoppedAt: new Date().toISOString(),
    eventCount: events.length,
  };
  await storageSet({ [LAST_UI_RECORDING_KEY]: saved });
  return saved;
}

async function replayUiRecording({ sessionId, tabId, events, options } = {}) {
  const last = await getLastUiRecording();
  const saved =
    last && (!sessionId || last.sessionId === sessionId) ? last : null;
  const source =
    events || (saved ? saved.events : null);
  if (!source) throw new Error("没有可回放的录制");
  const orderedSource = orderedRecordingEvents(source);
  const replayEvents = dedupeDragEvents(
    orderedSource.filter(isContentReplayEvent),
  );
  if (!replayEvents.length) throw new Error("录制中没有可回放的 UI 步骤");
  const targetTabId = await resolveRecordingTabId(tabId);
  if (options?.reloadBeforeReplay !== false) {
    const firstEventUrl = orderedSource.find(
      (event) =>
        (event.frameId === undefined || event.frameId === 0) && event.url,
    )?.url;
    const replayStartUrl =
      saved?.startUrl ||
      options?.startUrl ||
      firstEventUrl ||
      saved?.url ||
      options?.url;
    await refreshTabBeforeReplay(
      targetTabId,
      replayStartUrl,
      options?.navigationTimeoutMs,
    );
    await injectRecorderIntoFrames(targetTabId);
  }
  const grouped = new Map();
  for (const event of replayEvents) {
    const key = recordedFrameKey(event);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  const currentFrames = await waitForReplayFrames(
    targetTabId,
    grouped,
    options?.frameReadyTimeoutMs,
  );

  const frameIdByKey = new Map();
  for (const [key, frameEvents] of grouped.entries()) {
    frameIdByKey.set(key, chooseReplayFrameId(frameEvents, currentFrames));
  }

  const replayChunks = [];
  let currentChunk = null;
  for (const event of replayEvents) {
    const key = recordedFrameKey(event);
    const frameId = frameIdByKey.get(key) ?? 0;
    if (!currentChunk || currentChunk.frameId !== frameId) {
      currentChunk = { frameId, events: [] };
      replayChunks.push(currentChunk);
    }
    currentChunk.events.push(event);
  }

  const results = [];
  let previousEvent = null;
  for (let chunkIndex = 0; chunkIndex < replayChunks.length; chunkIndex += 1) {
    const chunk = replayChunks[chunkIndex];
    const firstEvent = chunk.events[0];
    const delay = replayDelayMs(previousEvent, firstEvent, options);
    if (delay > 0) await sleep(delay);
    try {
      const response = await sendMessageToTabFrame(targetTabId, chunk.frameId, {
        type: "tabworks-recording-replay",
        events: chunk.events,
        options: {
          ...(options || {}),
          hideCursorOnComplete: chunkIndex === replayChunks.length - 1,
        },
      });
      results.push({
        frameId: chunk.frameId,
        eventCount: chunk.events.length,
        ...(response || {}),
      });
    } catch (err) {
      results.push({
        frameId: chunk.frameId,
        eventCount: chunk.events.length,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    previousEvent = chunk.events[chunk.events.length - 1] || previousEvent;
  }

  const played = results.reduce((sum, item) => sum + (item.played || 0), 0);
  const failures = results.flatMap((item) => item.failures || []);
  const ok = results.every((item) => item.ok !== false);
  try {
    await sendMessageToTabFrame(targetTabId, 0, {
      type: "tabworks-recording-toast",
      kind: ok && !failures.length ? "success" : "error",
      message:
        ok && !failures.length
          ? `TabWorks 回放完成，执行 ${played} 步`
          : `TabWorks 回放完成，${failures.length} 步未命中`,
    });
  } catch {
    /* 顶层页面可能不支持注入，忽略 Toast 失败 */
  }

  return {
    tabId: targetTabId,
    ok,
    played,
    skipped: results.reduce((sum, item) => sum + (item.skipped || 0), 0),
    failures,
    frames: results,
  };
}

// ─── 命令分发 ────────────────────────────────────────────────────────

async function handleCommand(cmd, commandSocket = null) {
  const workspace = getWorkspaceKey(cmd.workspace);
  if (cmd?.action === "health") {
    const version = chrome.runtime.getManifest().version;
    const timestamp = Date.now();
    return {
      id: cmd.id,
      ok: true,
      version,
      timestamp,
      data: {
        ok: true,
        version,
        timestamp,
      },
    };
  }

  beginWorkspaceCommand(workspace);
  const requestedTimeout =
    cmd?.action === "navigate"
      ? clampTimeout(cmd.timeoutMs, DEFAULT_NAVIGATION_TIMEOUT) + 5000
      : clampTimeout(cmd?.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT);
  cmd.__startedAt = Date.now();
  cmd.__deadlineAt = cmd.__startedAt + requestedTimeout;
  const operation = (async () => {
    switch (cmd.action) {
      case "exec":
        return await handleExec(cmd, workspace);
      case "mouse":
        return await handleMouse(cmd, workspace);
      case "key":
        return await handleKey(cmd, workspace);
      case "navigate":
        return await handleNavigate(cmd, workspace);
      case "tabs":
        return await handleTabs(cmd, workspace);
      case "cookies":
        return await handleCookies(cmd);
      case "screenshot":
        return await handleScreenshot(cmd, workspace);
      case "recording":
        return await handleRecording(cmd, commandSocket);
      case "close-window":
        return await handleCloseWindow(cmd, workspace);
      case "sessions":
        return await handleSessions(cmd);
      default:
        return { id: cmd.id, ok: false, error: `未知 action: ${cmd.action}` };
    }
  })().finally(() => endWorkspaceCommand(workspace));

  try {
    return await withTimeout(() => operation, requestedTimeout, {
      action: cmd?.action,
      phase: "command",
      tabId: cmd?.tabId,
    });
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
    const data = await withTabOperationQueue(
      tabId,
      () => cdpEvaluate(tabId, cmd.code),
      tabOperationContext(cmd),
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

async function handleMouse(cmd, workspace) {
  if (!["click", "press", "drag"].includes(cmd.op)) {
    return { id: cmd.id, ok: false, error: `未知 mouse op: ${cmd.op}` };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await withTabOperationQueue(
      tabId,
      () =>
        cmd.op === "click"
          ? cdpMouseClick(tabId, cmd.x, cmd.y)
          : cmd.op === "press"
            ? cdpMousePress(tabId, cmd.x, cmd.y, cmd.durationMs)
            : cdpMouseDrag(
                tabId,
                cmd.fromX,
                cmd.fromY,
                cmd.toX,
                cmd.toY,
                cmd.durationMs,
              ),
      tabOperationContext(cmd),
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

async function handleKey(cmd, workspace) {
  if (!cmd.key) return { id: cmd.id, ok: false, error: "缺少 key 字段" };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await withTabOperationQueue(
      tabId,
      () => cdpKeyPress(tabId, cmd.key),
      tabOperationContext(cmd),
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

  const waitUntil = cmd.waitUntil ?? "complete";
  if (!["none", "url", "complete"].includes(waitUntil)) {
    return {
      id: cmd.id,
      ok: false,
      error: `不支持的 waitUntil: ${waitUntil}`,
    };
  }
  const timeoutMs = clampTimeout(cmd.timeoutMs, DEFAULT_NAVIGATION_TIMEOUT);
  const tabId = await resolveTabId(cmd.tabId, workspace);
  return withTabOperationQueue(
    tabId,
    () => navigateTab(cmd, tabId, waitUntil, timeoutMs),
    tabOperationContext(cmd),
  );
}

async function navigateTab(cmd, tabId, waitUntil, timeoutMs) {
  const beforeTab = await withTimeout(
    () => chrome.tabs.get(tabId),
    TAB_OPERATION_TIMEOUT,
    { action: "navigate", phase: "tabs.get:before", tabId },
  );
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;

  if (
    isTargetUrl(beforeTab.url, targetUrl) &&
    (waitUntil !== "complete" || beforeTab.status === "complete")
  ) {
    return {
      id: cmd.id,
      ok: true,
      data: {
        title: beforeTab.title,
        url: beforeTab.url,
        tabId,
        status: beforeTab.status,
        timedOut: false,
      },
    };
  }

  let timedOut = false;
  let finishNavigation;
  const navigationWait = new Promise((resolve) => {
    let settled = false;
    let checkTimer = null;
    let timeoutTimer = null;

    const finish = (didTimeOut = false) => {
      if (settled) return;
      settled = true;
      timedOut = didTimeOut;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };
    finishNavigation = finish;

    const isNavigationDone = (url) =>
      isTargetUrl(url, targetUrl) ||
      normalizeUrlForComparison(url) !== beforeNormalized;

    const listener = (id, info, tab) => {
      if (id !== tabId) return;
      const currentUrl = tab.url ?? info.url;
      if (waitUntil === "url" && isNavigationDone(currentUrl)) finish();
      if (
        waitUntil === "complete" &&
        info.status === "complete" &&
        isNavigationDone(currentUrl)
      ) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await withTimeout(
          () => chrome.tabs.get(tabId),
          TAB_OPERATION_TIMEOUT,
          { action: "navigate", phase: "tabs.get:check", tabId },
        );
        if (
          isNavigationDone(currentTab.url) &&
          (waitUntil === "url" || currentTab.status === "complete")
        ) {
          finish();
        }
      } catch {
        /* tab 已关闭 */
      }
    }, 100);

    timeoutTimer = setTimeout(() => {
      console.warn(`[tabworks] 导航到 ${targetUrl} 超时（${timeoutMs}ms）`);
      finish(true);
    }, timeoutMs);
  });

  try {
    await withTabQueue(tabId, async () => {
      await cdpDetachUnlocked(tabId, "navigate");
      await withTimeout(
        () => chrome.tabs.update(tabId, { url: targetUrl }),
        TAB_OPERATION_TIMEOUT,
        { action: "navigate", phase: "tabs.update", tabId },
      );
    });
  } catch (err) {
    finishNavigation?.();
    throw err;
  }

  if (waitUntil === "none") finishNavigation?.();
  await navigationWait;

  const tab = await withTimeout(
    () => chrome.tabs.get(tabId),
    TAB_OPERATION_TIMEOUT,
    { action: "navigate", phase: "tabs.get:after", tabId },
  );
  return {
    id: cmd.id,
    ok: true,
    data: {
      title: tab.title,
      url: tab.url,
      tabId,
      status: tab.status,
      timedOut,
    },
  };
}

async function createAutomationTab(cmd, workspace, foreground) {
  return withWorkspaceTabQueue(workspace, async () => {
    if (cmd.__deadlineAt && Date.now() >= cmd.__deadlineAt) {
      throw commandError(
        "COMMAND_TIMEOUT",
        { action: "tabs", phase: "workspace-tab-queue" },
        "open 在排队期间已超时，已取消且不会迟到创建 tab",
        cmd.__startedAt,
      );
    }

    const targetUrl = cmd.url ?? BLANK_PAGE;
    const windowId = await getAutomationWindow(workspace, {
      focused: foreground,
      initialUrl: targetUrl,
    });
    const session = automationSessions.get(workspace);
    let bootstrapTabId = session?.bootstrapTabId;

    if (!Number.isInteger(bootstrapTabId)) {
      const existingTabs = await withTimeout(
        () => chrome.tabs.query({ windowId }),
        TAB_OPERATION_TIMEOUT,
        { action: "tabs", phase: "tabs.query:bootstrap" },
      );
      bootstrapTabId = existingTabs.find(
        (tab) => tab.id && tab.url === BLANK_PAGE,
      )?.id;
    }

    if (Number.isInteger(bootstrapTabId)) {
      // 在 workspace 队列内先领取，避免并发 open 复用同一个首 tab。
      if (session) session.bootstrapTabId = null;
      try {
        const bootstrapTab = await withTimeout(
          () => chrome.tabs.get(bootstrapTabId),
          TAB_OPERATION_TIMEOUT,
          { action: "tabs", phase: "tabs.get:bootstrap", tabId: bootstrapTabId },
        );
        const currentUrl = bootstrapTab.pendingUrl || bootstrapTab.url;
        const changes = {};
        if (!isTargetUrl(currentUrl, targetUrl)) changes.url = targetUrl;
        if (foreground) changes.active = true;
        const tab = Object.keys(changes).length
          ? await withTimeout(
              () => chrome.tabs.update(bootstrapTabId, changes),
              TAB_OPERATION_TIMEOUT,
              {
                action: "tabs",
                phase: "tabs.update:bootstrap",
                tabId: bootstrapTabId,
              },
            )
          : bootstrapTab;
        return { ...tab, url: tab.pendingUrl || tab.url || targetUrl };
      } catch (err) {
        // update 超时后底层操作可能仍会完成；此时不能再创建第二个 tab。
        throw err;
      }
    }

    return withTimeout(
      () =>
        chrome.tabs.create({
          windowId,
          url: targetUrl,
          active: foreground,
        }),
      TAB_OPERATION_TIMEOUT,
      { action: "tabs", phase: "tabs.create" },
    );
  });
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
          status: t.status,
          windowId: t.windowId,
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
      const tab = await createAutomationTab(cmd, workspace, foreground);
      return {
        id: cmd.id,
        ok: true,
        data: { tabId: tab.id, url: tab.pendingUrl || tab.url || cmd.url },
      };
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
        await closeTabForCommand(cmd, target.id);
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      const tabId = await resolveTabId(cmd.tabId, workspace);
      await closeTabForCommand(cmd, tabId);
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
          tab = await withTimeout(
            () => chrome.tabs.get(cmd.tabId),
            TAB_OPERATION_TIMEOUT,
            { action: "tabs", phase: "tabs.get", tabId: cmd.tabId },
          );
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
        await withTabOperationQueue(
          cmd.tabId,
          () =>
            withTimeout(
              () => chrome.tabs.update(cmd.tabId, { active: true }),
              TAB_OPERATION_TIMEOUT,
              { action: "tabs", phase: "tabs.update", tabId: cmd.tabId },
            ),
          tabOperationContext(cmd),
        );
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
      await withTabOperationQueue(
        target.id,
        () =>
          withTimeout(
            () => chrome.tabs.update(target.id, { active: true }),
            TAB_OPERATION_TIMEOUT,
            { action: "tabs", phase: "tabs.update", tabId: target.id },
          ),
        tabOperationContext(cmd),
      );
      return { id: cmd.id, ok: true, data: { selected: target.id } };
    }
    default:
      return { id: cmd.id, ok: false, error: `未知 tabs op: ${cmd.op}` };
  }
}

async function closeTabForCommand(cmd, tabId) {
  return withTabOperationQueue(
    tabId,
    () =>
      withTabQueue(tabId, async () => {
        await cdpDetachUnlocked(tabId, "tabs");
        await withTimeout(
          () => chrome.tabs.remove(tabId),
          TAB_OPERATION_TIMEOUT,
          { action: "tabs", phase: "tabs.remove", tabId },
        );
      }),
    tabOperationContext(cmd),
  );
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
  const cookies = await withTimeout(
    () => chrome.cookies.getAll(details),
    TAB_OPERATION_TIMEOUT,
    { action: "cookies", phase: "cookies.getAll" },
  );
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
    const data = await withTabOperationQueue(
      tabId,
      () =>
        cdpScreenshot(tabId, {
          format: cmd.format,
          quality: cmd.quality,
          fullPage: cmd.fullPage,
        }),
      tabOperationContext(cmd),
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

async function handleRecording(cmd, commandSocket = null) {
  const op = cmd.op;
  if (op === "start") {
    const tabId = await resolveRecordingTabId(cmd.tabId);
    const data = await withTabOperationQueue(
      tabId,
      () => startUiRecording(tabId, cmd.sessionId, commandSocket),
      tabOperationContext(cmd),
    );
    return {
      id: cmd.id,
      ok: true,
      data,
    };
  }

  if (op === "stop") {
    const tabId = findActiveRecordingTabId(cmd.sessionId, cmd.tabId);
    if (!Number.isInteger(tabId)) throw new Error("未找到正在录制的标签页");
    const data = await withTabOperationQueue(
      tabId,
      () => stopUiRecording(cmd.sessionId, tabId),
      tabOperationContext(cmd),
    );
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
    const tabId = await resolveRecordingTabId(cmd.tabId);
    const response = await withTabOperationQueue(
      tabId,
      () =>
        replayUiRecording({
          tabId,
          events: cmd.events,
          options: cmd.options,
        }),
      tabOperationContext(cmd),
    );
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
  const otherActiveCommands = Math.max(
    0,
    (activeCommandsByWorkspace.get(workspace) || 1) - 1,
  );
  if (otherActiveCommands > 0) {
    return {
      id: cmd.id,
      ok: false,
      error: `WORKSPACE_BUSY action=close-window phase=active-commands tabId=unknown elapsedMs=0: workspace=${workspace} 仍有 ${otherActiveCommands} 条命令执行中`,
    };
  }
  const session = automationSessions.get(workspace);
  if (session) {
    try {
      await withTimeout(
        () => chrome.windows.remove(session.windowId),
        TAB_OPERATION_TIMEOUT,
        { action: "close-window", phase: "windows.remove" },
      );
    } catch {
      /* 已关闭 */
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    automationSessions.delete(workspace);
    await persistAutomationSessions();
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
        await withTimeout(
          () => chrome.tabs.query({ windowId: session.windowId }),
          TAB_OPERATION_TIMEOUT,
          { action: "sessions", phase: "tabs.query" },
        )
      ).filter((t) => isDebuggableUrl(t.url)).length,
      activeCommandCount: session.activeCommandCount || 0,
      idleMsRemaining:
        session.idleDeadlineAt === null
          ? null
          : Math.max(0, session.idleDeadlineAt - now),
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
        await withTimeout(
          () => chrome.tabs.query({ windowId: session.windowId }),
          TAB_OPERATION_TIMEOUT,
          { action: "sessions", phase: "tabs.query" },
        )
      ).filter((t) => isDebuggableUrl(t.url)).length,
      activeCommandCount: session.activeCommandCount || 0,
      idleMsRemaining:
        session.idleDeadlineAt === null
          ? null
          : Math.max(0, session.idleDeadlineAt - now),
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

function handleRecordingEvent(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return false;
  const recording = recordingTabs.get(tabId);
  if (
    !recording ||
    recording.stopping ||
    recording.sessionId !== message.sessionId
  )
    return false;
  const event = {
    ...message.event,
    frameId: sender.frameId ?? 0,
    frameUrl: sender.url || message.event?.url,
  };
  if (shouldSkipDuplicateRecordingEvent(recording, event)) return false;
  recording.events.push(event);
  upsertRecordingFrame(recording, {
    frameId: sender.frameId ?? 0,
    url: sender.url || message.event?.url,
    ok: true,
    response: {
      url: sender.url || message.event?.url,
      title: message.event?.title,
      frameContext: message.event?.frameContext,
    },
  });
  if ((sender.frameId ?? 0) === 0) {
    if (message.event?.url) recording.url = message.event.url;
    if (message.event?.title) recording.title = message.event.title;
  }

  const eventSocket = recording.eventSocket;
  if (eventSocket?.readyState === WebSocket.OPEN) {
    try {
      eventSocket.send(
        JSON.stringify({
          type: "recording-event",
          sessionId: recording.sessionId,
          tabId,
          event,
        }),
      );
    } catch {
      /* 连接关闭后由 stop 返回本地录制结果；事件绝不改发到新 socket */
    }
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "tabworks-ui-recording-start") {
    resolveRecordingTabId(message.tabId)
      .then((tabId) =>
        runUiTabOperation(tabId, "recording-start", () =>
          startUiRecording(tabId),
        ),
      )
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
    const tabId = findActiveRecordingTabId(message.sessionId, message.tabId);
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "未找到正在录制的标签页" });
      return true;
    }
    runUiTabOperation(tabId, "recording-stop", () =>
      stopUiRecording(message.sessionId, tabId),
    )
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

  if (message?.type === "tabworks-ui-recording-clear") {
    clearLastUiRecording()
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

  if (message?.type === "tabworks-recording-trusted-click") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "无法定位当前标签页" });
      return true;
    }
    runUiTabOperation(tabId, "mouse", () =>
      cdpMouseClick(tabId, message.x, message.y),
    )
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

  if (message?.type === "tabworks-ui-recording-replay") {
    resolveRecordingTabId(message.tabId)
      .then((tabId) =>
        runUiTabOperation(tabId, "recording-replay", () =>
          replayUiRecording({ ...message, tabId }),
        ),
      )
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

  if (message?.type === "tabworks-recording-sync") {
    const tabId = sender.tab?.id;
    const recording = tabId ? recordingTabs.get(tabId) : null;
    sendResponse({
      ok: true,
      recording: Boolean(recording),
      sessionId: recording?.sessionId,
    });
    return true;
  }

  if (message?.type !== "tabworks-recording-event") return false;
  return handleRecordingEvent(message, sender);
});

async function attachRecordingToFrame(tabId, frameId, url) {
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId)) return;
  const recording = recordingTabs.get(tabId);
  if (!recording || recording.stopping || !isDebuggableUrl(url)) return;
  try {
    await injectRecorderIntoFrames(tabId, frameId);
    const response = await chrome.tabs.sendMessage(
      tabId,
      {
        type: "tabworks-recording-start",
        sessionId: recording.sessionId,
      },
      { frameId },
    );
    upsertRecordingFrame(recording, {
      frameId,
      url: response?.url || url,
      ok: true,
      response,
    });
  } catch {
    /* frame 可能还没注入 content script，content script 初始化时还会主动 sync */
  }
}

chrome.webNavigation.onCommitted.addListener((details) => {
  attachRecordingToFrame(details.tabId, details.frameId, details.url);
});

chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
  attachRecordingToFrame(details.tabId, details.frameId, details.url);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  attachRecordingToFrame(details.tabId, details.frameId, details.url);
});

// ─── 生命周期 ────────────────────────────────────────────────────────

let initializePromise = null;

async function ensureKeepaliveAlarm() {
  const alarm = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (!alarm || alarm.periodInMinutes !== 0.5) {
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  }
}

async function restoreAutomationSessions() {
  const stored = await chrome.storage.session.get(AUTOMATION_SESSIONS_KEY);
  const sessions = Array.isArray(stored?.[AUTOMATION_SESSIONS_KEY])
    ? stored[AUTOMATION_SESSIONS_KEY]
    : [];
  for (const item of sessions) {
    if (
      !item ||
      typeof item.workspace !== "string" ||
      !Number.isInteger(item.windowId)
    ) {
      continue;
    }
    try {
      await withTimeout(
        () => chrome.windows.get(item.windowId),
        TAB_OPERATION_TIMEOUT,
        { action: "restore", phase: "windows.get" },
      );
      const session = {
        windowId: item.windowId,
        idleTimer: null,
        idleDeadlineAt: Number.isFinite(item.idleDeadlineAt)
          ? item.idleDeadlineAt
          : Date.now() + WINDOW_IDLE_TIMEOUT,
        activeCommandCount: 0,
      };
      automationSessions.set(item.workspace, session);
      resetWindowIdleTimer(
        item.workspace,
        Math.max(0, session.idleDeadlineAt - Date.now()),
      );
    } catch {
      /* 窗口在 worker 停止期间已被关闭 */
    }
  }
  await persistAutomationSessions();
}

function initialize() {
  if (initializePromise) return initializePromise;
  registerCdpListeners();
  initializePromise = (async () => {
    await ensureKeepaliveAlarm();
    await restoreAutomationSessions();
    connect();
    updateBadge();
    console.log("[tabworks] TabWorks Bridge 扩展已初始化");
  })().catch((err) => {
    initializePromise = null;
    console.error("[tabworks] 初始化失败:", err);
    throw err;
  });
  return initializePromise;
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});
chrome.runtime.onStartup.addListener(() => void initialize());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) connect();
});

// MV3 worker 每次被唤醒都会重新执行模块；alarm 只负责断线时的兜底唤醒。
void initialize();

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

// 仅导出可独立验证的边界；MV3 service worker 仍以模块方式加载。
export const __testing = {
  withTimeout,
  withTabQueue,
  withTabOperationQueue,
  cdpEvaluate,
  handleCommand,
  handleNavigate,
  connect,
  initialize,
  restoreAutomationSessions,
  getAutomationWindow,
  automationSessions,
  recordingTabs,
  handleRecordingEvent,
  getCurrentSocket: () => ws,
};
