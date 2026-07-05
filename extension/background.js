// extension/src/background.ts
var BRIDGE_WS_URL = "ws://127.0.0.1:9527/ext";
var WS_RECONNECT_BASE_DELAY = 2000;
var WS_RECONNECT_MAX_DELAY = 60000;
var WINDOW_IDLE_TIMEOUT = 30000;
var BLANK_PAGE = "data:text/html,<html></html>";
var LOG_MAX = 200;
var logBuffer = [];
function appendLog(level, msg) {
  const entry = { ts: Date.now(), level, msg };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX)
    logBuffer.shift();
}
var ws = null;
var _origLog = console.log.bind(console);
var _origWarn = console.warn.bind(console);
var _origError = console.error.bind(console);
function forwardLog(level, args) {
  const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  appendLog(level, msg);
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return;
  try {
    ws.send(JSON.stringify({ type: "log", level, msg, ts: Date.now() }));
  } catch {}
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
var reconnectTimer = null;
var reconnectAttempts = 0;
function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING)
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
    ws?.send(JSON.stringify({
      type: "hello",
      version: chrome.runtime.getManifest().version
    }));
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
  if (reconnectTimer)
    return;
  reconnectAttempts++;
  const delay = Math.min(WS_RECONNECT_BASE_DELAY * 2 ** (reconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}
function updateBadge() {
  const connected = ws?.readyState === WebSocket.OPEN;
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  if (connected)
    chrome.action.setBadgeBackgroundColor({ color: "#34c759" });
}
var automationSessions = new Map;
var recordingTabs = new Map;
var LAST_UI_RECORDING_KEY = "lastUiRecording";
function getWorkspaceKey(workspace) {
  return workspace?.trim() || "default";
}
function resetWindowIdleTimer(workspace) {
  const session = automationSessions.get(workspace);
  if (!session)
    return;
  if (session.idleTimer)
    clearTimeout(session.idleTimer);
  session.idleDeadlineAt = Date.now() + WINDOW_IDLE_TIMEOUT;
  session.idleTimer = setTimeout(async () => {
    const current = automationSessions.get(workspace);
    if (!current)
      return;
    try {
      await chrome.windows.remove(current.windowId);
      console.log(`[tabworks] 自动化窗口 ${current.windowId} (${workspace}) 已关闭（空闲超时）`);
    } catch {}
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
    state: "normal"
  });
  const session = {
    windowId: win.id,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT
  };
  automationSessions.set(workspace, session);
  console.log(`[tabworks] 创建自动化窗口 ${session.windowId} (${workspace}, focused=${focused})`);
  resetWindowIdleTimer(workspace);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return session.windowId;
}
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [workspace, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(`[tabworks] 自动化窗口已关闭 (${workspace})`);
      if (session.idleTimer)
        clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
      broadcastSessions();
    }
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  recordingTabs.delete(tabId);
});
var attachedTabs = new Set;
function isDebuggableUrl(url) {
  if (!url)
    return true;
  return url.startsWith("http://") || url.startsWith("https://") || url === BLANK_PAGE;
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
    if (e instanceof Error && e.message.startsWith("无法调试"))
      throw e;
    attachedTabs.delete(tabId);
    throw new Error(`Tab ${tabId} 不存在`);
  }
  if (attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true
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
      } catch {}
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
  } catch {}
}
async function cdpEvaluate(tabId, expression) {
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Eval 错误";
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
    buttons: 0,
    pointerType: "mouse"
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse"
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse"
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
    button: "none"
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1
  });
  await sleep(holdMs);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
  return { pressed: true, durationMs: holdMs, ...point };
}
async function cdpMouseDrag(tabId, fromX, fromY, toX, toY, durationMs = 450) {
  await ensureAttached(tabId);
  const start = { x: Number(fromX), y: Number(fromY) };
  const end = { x: Number(toX), y: Number(toY) };
  const dragMs = Math.max(80, Math.min(Number(durationMs) || 450, 8000));
  if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y)) {
    throw new Error("拖拽坐标无效");
  }
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: start.x,
    y: start.y,
    button: "none"
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1
  });
  const steps = Math.max(4, Math.min(40, Math.round(dragMs / 24)));
  for (let i = 1;i <= steps; i += 1) {
    await sleep(dragMs / steps);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + (end.x - start.x) * i / steps,
      y: start.y + (end.y - start.y) * i / steps,
      button: "left",
      buttons: 1
    });
  }
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
  return { dragged: true, fromX: start.x, fromY: start.y, toX: end.x, toY: end.y, durationMs: dragMs };
}
var KEY_DEFINITIONS = {
  Space: { key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }
};
async function cdpKeyPress(tabId, key) {
  await ensureAttached(tabId);
  const definition = KEY_DEFINITIONS[key] || (String(key || "").length === 1 ? {
    key: String(key),
    code: `Key${String(key).toUpperCase()}`,
    text: String(key),
    windowsVirtualKeyCode: String(key).toUpperCase().charCodeAt(0)
  } : null);
  if (!definition)
    throw new Error(`不支持的按键: ${key}`);
  const base = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
    nativeVirtualKeyCode: definition.windowsVirtualKeyCode
  };
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    text: definition.text
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...base
  });
  return { pressed: true, key };
}
async function cdpDetach(tabId) {
  if (!attachedTabs.has(tabId))
    return;
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
}
async function cdpScreenshot(tabId, options = {}) {
  await ensureAttached(tabId);
  const format = options.format ?? "png";
  if (options.fullPage) {
    const metrics = await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        mobile: false,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        deviceScaleFactor: 1
      });
    }
  }
  try {
    const params = { format };
    if (format === "jpeg" && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }
    const result = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", params);
    return result.data;
  } finally {
    if (options.fullPage) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
  }
}
function registerCdpListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabs.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId)
      attachedTabs.delete(source.tabId);
  });
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await cdpDetach(tabId);
    }
  });
}
function normalizeUrlForComparison(url) {
  if (!url)
    return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.port === "443" || parsed.protocol === "http:" && parsed.port === "80") {
      parsed.port = "";
    }
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}
function isTargetUrl(currentUrl, targetUrl) {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}
function normalizeFrameUrl(url) {
  if (!url)
    return "";
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
  if (context?.isTop)
    return "top";
  if (context?.frameSelector)
    return `selector:${context.frameSelector}`;
  if (context?.frameName)
    return `name:${normalizeFrameName(context.frameName)}`;
  if (Number.isInteger(context?.frameIndex))
    return `index:${context.frameIndex}`;
  const frameId = Number.isInteger(event.frameId) ? event.frameId : 0;
  return `id:${frameId}`;
}
function sameRecordingFrame(a, b) {
  const left = recordedFrameKey(a);
  const right = recordedFrameKey(b);
  if (left === right)
    return true;
  return left === "top" && right === "id:0" || left === "id:0" && right === "top";
}
function recordingEventTime(event) {
  const time = Date.parse(event?.at || "");
  return Number.isFinite(time) ? time : null;
}
function orderedRecordingEvents(events = []) {
  return events.map((event, index) => ({ event, index, time: recordingEventTime(event) })).sort((a, b) => {
    if (a.time !== null && b.time !== null && a.time !== b.time) {
      return a.time - b.time;
    }
    if (a.time !== null && b.time === null)
      return -1;
    if (a.time === null && b.time !== null)
      return 1;
    return a.index - b.index;
  }).map((item) => item.event);
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
    "key"
  ].includes(event?.kind);
}
function replayDelayMs(previousEvent, event, options = {}) {
  const previousAt = recordingEventTime(previousEvent);
  const currentAt = recordingEventTime(event);
  if (previousAt === null || currentAt === null)
    return 0;
  const delta = currentAt - previousAt;
  if (!Number.isFinite(delta) || delta <= 0)
    return 0;
  const speed = Math.max(0.1, Number(options.speed || 1));
  const maxDelayMs = Math.max(0, Number(options.maxDelayMs ?? 2000));
  return Math.min(delta / speed, maxDelayMs);
}
function selectorForRecordingEvent(event) {
  const selectors = event?.element?.selectors || [];
  return selectors.find((item) => item.unique)?.selector || event?.element?.preferredSelector || event?.sortable?.rowElement?.preferredSelector || event?.sortable?.rowElement?.selectors?.find((item) => item.unique)?.selector || "";
}
function closeNumber(a, b, tolerance = 6) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right))
    return false;
  return Math.abs(left - right) <= tolerance;
}
function sameSortableMove(a, b) {
  if (!a?.sortable || !b?.sortable)
    return false;
  if (a.sortable.sourceLabel || b.sortable.sourceLabel || a.sortable.rowElement || b.sortable.rowElement) {
    const sameSourceLabel = String(a.sortable.sourceLabel || "") === String(b.sortable.sourceLabel || "");
    const sameRowSelector = selectorForRecordingEvent(a) && selectorForRecordingEvent(a) === selectorForRecordingEvent(b);
    if (sameSourceLabel || sameRowSelector)
      return true;
  }
  return String(a.sortable.sourceLabel || "") === String(b.sortable.sourceLabel || "") && Number(a.sortable.fromIndex) === Number(b.sortable.fromIndex) && Number(a.sortable.toIndex) === Number(b.sortable.toIndex) && Number(a.sortable.moveDelta) === Number(b.sortable.moveDelta);
}
function sameDragGeometry(a, b) {
  return closeNumber(a?.startX, b?.startX) && closeNumber(a?.startY, b?.startY) && closeNumber(a?.endX, b?.endX) && closeNumber(a?.endY, b?.endY);
}
function isDuplicateDragEvent(previous, next) {
  if (previous?.kind !== "drag" || next?.kind !== "drag")
    return false;
  const previousAt = recordingEventTime(previous);
  const nextAt = recordingEventTime(next);
  if (previousAt !== null && nextAt !== null && Math.abs(nextAt - previousAt) > 900) {
    return false;
  }
  if (!sameRecordingFrame(previous, next))
    return false;
  return sameSortableMove(previous, next) || sameDragGeometry(previous, next);
}
function sameClickGeometry(a, b) {
  return closeNumber(a?.x, b?.x, 12) && closeNumber(a?.y, b?.y, 12);
}
function isDuplicateClickEvent(previous, next) {
  if (previous?.kind !== "click" || next?.kind !== "click")
    return false;
  const previousAt = recordingEventTime(previous);
  const nextAt = recordingEventTime(next);
  if (previousAt !== null && nextAt !== null && Math.abs(nextAt - previousAt) > 350) {
    return false;
  }
  if (!sameRecordingFrame(previous, next))
    return false;
  return sameClickGeometry(previous, next);
}
function shouldSkipDuplicateRecordingEvent(recording, event) {
  const recentEvents = (recording?.events || []).slice(-8);
  return recentEvents.some((previous) => isDuplicateDragEvent(previous, event) || isDuplicateClickEvent(previous, event));
}
function dedupeDragEvents(events = []) {
  const normalized = [];
  for (const event of events) {
    if (normalized.slice(-8).some((previous) => isDuplicateDragEvent(previous, event) || isDuplicateClickEvent(previous, event))) {
      continue;
    }
    normalized.push(event);
  }
  return normalized;
}
async function resolveTabId(tabId, workspace) {
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const session = automationSessions.get(workspace);
      if (isDebuggableUrl(tab.url) && session && tab.windowId === session.windowId) {
        return tabId;
      }
      if (session && tab.windowId !== session.windowId) {
        console.warn(`[tabworks] Tab ${tabId} 不属于自动化窗口，重新解析`);
      } else if (!isDebuggableUrl(tab.url)) {
        console.warn(`[tabworks] Tab ${tabId} URL 不可调试 (${tab.url})，重新解析`);
      }
    } catch {
      console.warn(`[tabworks] Tab ${tabId} 已不存在，重新解析`);
    }
  }
  const windowId = await getAutomationWindow(workspace);
  const tabs = await chrome.tabs.query({ windowId });
  const debuggableTab = tabs.find((t) => t.id && isDebuggableUrl(t.url));
  if (debuggableTab?.id)
    return debuggableTab.id;
  const reuseTab = tabs.find((t) => t.id);
  if (reuseTab?.id) {
    await chrome.tabs.update(reuseTab.id, { url: BLANK_PAGE });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const updated = await chrome.tabs.get(reuseTab.id);
      if (isDebuggableUrl(updated.url))
        return reuseTab.id;
    } catch {}
  }
  const newTab = await chrome.tabs.create({
    windowId,
    url: BLANK_PAGE,
    active: true
  });
  if (!newTab.id)
    throw new Error("创建标签页失败");
  return newTab.id;
}
async function listAutomationWebTabs(workspace) {
  const session = automationSessions.get(workspace);
  if (!session)
    return [];
  try {
    const tabs = await chrome.tabs.query({ windowId: session.windowId });
    return tabs.filter((t) => isDebuggableUrl(t.url));
  } catch {
    automationSessions.delete(workspace);
    return [];
  }
}
async function resolveRecordingTabId(tabId) {
  if (tabId !== undefined && tabId !== null)
    return tabId;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs.find((item) => item.id && isDebuggableUrl(item.url));
  if (!tab?.id)
    throw new Error("未找到可录制的当前网页标签页");
  return tab.id;
}
async function sendMessageToTabFrame(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch (err) {
    throw new Error("无法连接页面录制脚本，请刷新目标页面或重新加载扩展后再试：" + (err instanceof Error ? err.message : String(err)));
  }
}
async function getTabFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return (frames || []).filter((frame) => Number.isInteger(frame.frameId)).map((frame) => ({
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      url: frame.url
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
        world: "MAIN"
      });
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["recorder-content.js"]
      });
      return;
    } catch {}
  }
  const frameIds = Number.isInteger(targetFrameId) ? [targetFrameId] : (await getTabFrames(tabId)).map((frame) => frame.frameId);
  for (const frameId of frameIds) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ["recorder-main.js"],
        world: "MAIN"
      });
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ["recorder-content.js"]
      });
    } catch {}
  }
}
async function refreshTabBeforeReplay(tabId, url, timeoutMs = 12000) {
  const targetUrl = url && isDebuggableUrl(url) ? url : null;
  const waitMs = Math.max(1000, Math.min(Number(timeoutMs) || 12000, 60000));
  await new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const finish = (error) => {
      if (done)
        return;
      done = true;
      if (timer)
        clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error)
        reject(error);
      else
        resolve();
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete")
        finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => finish(new Error("等待页面刷新超时")), waitMs);
    const navigation = targetUrl ? chrome.tabs.update(tabId, { url: targetUrl, active: true }) : chrome.tabs.reload(tabId);
    navigation.catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
  await sleep(500);
}
async function sendMessageToAllFrames(tabId, message) {
  const frames = await getTabFrames(tabId);
  const results = [];
  for (const frame of frames) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message, {
        frameId: frame.frameId
      });
      results.push({ ...frame, ok: true, response });
    } catch (err) {
      results.push({
        ...frame,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  const connected = results.filter((item) => item.ok);
  if (!connected.length) {
    const firstError = results.find((item) => item.error)?.error || "没有 frame 响应";
    throw new Error("无法连接页面录制脚本，请刷新目标页面或重新加载扩展后再试：" + firstError);
  }
  return {
    frames: results,
    primary: connected.find((item) => item.frameId === 0)?.response || connected[0]?.response || null
  };
}
async function collectFrameContexts(tabId) {
  const response = await sendMessageToAllFrames(tabId, {
    type: "tabworks-frame-context"
  });
  return response.frames.map((frame) => ({
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId,
    url: frame.response?.url || frame.url,
    ok: frame.ok,
    error: frame.error,
    frameContext: frame.response?.frameContext || null
  }));
}
async function startRecordingInFrames(tabId, sessionId, attempts = 6) {
  let latest = null;
  for (let i = 0;i < attempts; i += 1) {
    await injectRecorderIntoFrames(tabId);
    latest = await sendMessageToAllFrames(tabId, {
      type: "tabworks-recording-start",
      sessionId
    });
    const frames = await getTabFrames(tabId);
    const expectedFrameCount = frames.length;
    const connectedFrameCount = latest.frames.filter((frame) => frame.ok).length;
    if (connectedFrameCount >= expectedFrameCount)
      break;
    await sleep(300);
  }
  return latest;
}
function chooseReplayFrameId(frameEvents, frameContexts) {
  const sample = frameEvents.find((event) => frameContextFromEvent(event)) || frameEvents.find((event) => Number.isInteger(event.frameId)) || frameEvents[0] || {};
  const recordedFrameId = Number.isInteger(sample.frameId) ? sample.frameId : 0;
  const recordedContext = frameContextFromEvent(sample);
  if (recordedContext?.isTop || !recordedContext && recordedFrameId === 0) {
    return 0;
  }
  const recordedUrl = normalizeFrameUrl(recordedContext?.url || sample.frameUrl || sample.url);
  const candidates = frameContexts.filter((frame) => {
    if (!frame.ok)
      return false;
    if (!recordedUrl)
      return true;
    return normalizeFrameUrl(frame.url || frame.frameContext?.url) === recordedUrl;
  });
  const scopedCandidates = candidates.length ? candidates : frameContexts;
  if (recordedContext?.frameSelector) {
    const matched = scopedCandidates.find((frame) => frame.frameContext?.frameSelector === recordedContext.frameSelector);
    if (matched)
      return matched.frameId;
  }
  const recordedName = normalizeFrameName(recordedContext?.frameName);
  if (recordedName) {
    const matched = scopedCandidates.find((frame) => normalizeFrameName(frame.frameContext?.frameName) === recordedName);
    if (matched)
      return matched.frameId;
  }
  if (Number.isInteger(recordedContext?.frameIndex)) {
    const matched = scopedCandidates.find((frame) => frame.frameContext?.frameIndex === recordedContext.frameIndex);
    if (matched)
      return matched.frameId;
  }
  const sameId = frameContexts.find((frame) => frame.frameId === recordedFrameId);
  if (sameId)
    return sameId.frameId;
  if (candidates.length === 1)
    return candidates[0].frameId;
  return scopedCandidates[0]?.frameId ?? recordedFrameId;
}
function hasReplayFrameMatch(frameEvents, frameContexts) {
  const sample = frameEvents.find((event) => frameContextFromEvent(event)) || frameEvents.find((event) => Number.isInteger(event.frameId)) || frameEvents[0] || {};
  const recordedFrameId = Number.isInteger(sample.frameId) ? sample.frameId : 0;
  const recordedContext = frameContextFromEvent(sample);
  if (recordedContext?.isTop || !recordedContext && recordedFrameId === 0) {
    return frameContexts.some((frame) => frame.ok && frame.frameId === 0);
  }
  const recordedUrl = normalizeFrameUrl(recordedContext?.url || sample.frameUrl || sample.url);
  const candidates = frameContexts.filter((frame) => {
    if (!frame.ok)
      return false;
    if (!recordedUrl)
      return true;
    return normalizeFrameUrl(frame.url || frame.frameContext?.url) === recordedUrl;
  });
  if (!candidates.length)
    return false;
  if (recordedContext?.frameSelector) {
    return candidates.some((frame) => frame.frameContext?.frameSelector === recordedContext.frameSelector);
  }
  const recordedName = normalizeFrameName(recordedContext?.frameName);
  if (recordedName) {
    return candidates.some((frame) => normalizeFrameName(frame.frameContext?.frameName) === recordedName);
  }
  if (Number.isInteger(recordedContext?.frameIndex)) {
    return candidates.some((frame) => frame.frameContext?.frameIndex === recordedContext.frameIndex);
  }
  if (recordedFrameId !== 0) {
    return candidates.some((frame) => frame.frameId === recordedFrameId);
  }
  return candidates.length === 1;
}
function requiredReplayFrameGroups(grouped) {
  return [...grouped.values()].filter((frameEvents) => frameEvents.some((event) => {
    const context = frameContextFromEvent(event);
    return event.inFrame || context?.isTop === false || Number.isInteger(event.frameId) && event.frameId !== 0;
  }));
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
      const allReady = requiredGroups.every((frameEvents) => hasReplayFrameMatch(frameEvents, lastContexts));
      if (allReady)
        return lastContexts;
    } catch {}
    await sleep(350);
  }
  if (!requiredGroups.length && lastContexts.length)
    return lastContexts;
  throw new Error(`等待 iframe 接入超时：需要 ${requiredGroups.length} 个 iframe 分组，当前已连接 ${lastContexts.filter((frame) => frame.ok && frame.frameId !== 0).length} 个`);
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
  if (!item)
    return null;
  return {
    sessionId: item.sessionId,
    tabId: item.tabId,
    url: item.url,
    startUrl: item.startUrl,
    title: item.title,
    startTitle: item.startTitle,
    startedAt: item.startedAt,
    eventCount: item.events?.length || 0,
    frameCount: item.frames?.filter((frame) => frame.ok).length || 0
  };
}
function upsertRecordingFrame(item, frame) {
  if (!item || !Number.isInteger(frame?.frameId))
    return;
  if (!Array.isArray(item.frames))
    item.frames = [];
  const existingIndex = item.frames.findIndex((entry) => entry.frameId === frame.frameId);
  if (existingIndex >= 0) {
    item.frames[existingIndex] = { ...item.frames[existingIndex], ...frame };
  } else {
    item.frames.push(frame);
  }
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
    startUrl: tab.url,
    startTitle: tab.title,
    url: tab.url,
    title: tab.title,
    startedAt: new Date().toISOString(),
    events: []
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
async function stopUiRecording(sessionId, tabId) {
  const entries = [...recordingTabs.entries()];
  const matched = entries.find(([entryTabId, item2]) => item2.sessionId === sessionId || tabId !== undefined && Number(entryTabId) === Number(tabId));
  if (!matched)
    throw new Error("未找到正在录制的标签页");
  const [targetTabId, item] = matched;
  const response = await sendMessageToAllFrames(targetTabId, {
    type: "tabworks-recording-stop",
    sessionId: item.sessionId
  });
  item.events.push({
    seq: item.events.length + 1,
    at: new Date().toISOString(),
    url: response.primary?.url ?? item.url,
    title: response.primary?.title ?? item.title,
    kind: "stop",
    frameId: 0
  });
  recordingTabs.delete(targetTabId);
  const events = dedupeDragEvents(orderedRecordingEvents(item.events));
  const saved = {
    ...item,
    events,
    url: response.primary?.url ?? item.url,
    title: response.primary?.title ?? item.title,
    frames: response.frames,
    stoppedAt: new Date().toISOString(),
    eventCount: events.length
  };
  await storageSet({ [LAST_UI_RECORDING_KEY]: saved });
  return saved;
}
async function replayUiRecording({ sessionId, tabId, events, options } = {}) {
  const last = await getLastUiRecording();
  const saved = last && (!sessionId || last.sessionId === sessionId) ? last : null;
  const source = events || (saved ? saved.events : null);
  if (!source)
    throw new Error("没有可回放的录制");
  const orderedSource = orderedRecordingEvents(source);
  const replayEvents = dedupeDragEvents(orderedSource.filter(isContentReplayEvent));
  if (!replayEvents.length)
    throw new Error("录制中没有可回放的 UI 步骤");
  const targetTabId = await resolveRecordingTabId(tabId);
  if (options?.reloadBeforeReplay !== false) {
    const firstEventUrl = orderedSource.find((event) => (event.frameId === undefined || event.frameId === 0) && event.url)?.url;
    const replayStartUrl = saved?.startUrl || options?.startUrl || firstEventUrl || saved?.url || options?.url;
    await refreshTabBeforeReplay(targetTabId, replayStartUrl, options?.navigationTimeoutMs);
    await injectRecorderIntoFrames(targetTabId);
  }
  const grouped = new Map;
  for (const event of replayEvents) {
    const key = recordedFrameKey(event);
    if (!grouped.has(key))
      grouped.set(key, []);
    grouped.get(key).push(event);
  }
  const currentFrames = await waitForReplayFrames(targetTabId, grouped, options?.frameReadyTimeoutMs);
  const frameIdByKey = new Map;
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
  for (let chunkIndex = 0;chunkIndex < replayChunks.length; chunkIndex += 1) {
    const chunk = replayChunks[chunkIndex];
    const firstEvent = chunk.events[0];
    const delay = replayDelayMs(previousEvent, firstEvent, options);
    if (delay > 0)
      await sleep(delay);
    try {
      const response = await sendMessageToTabFrame(targetTabId, chunk.frameId, {
        type: "tabworks-recording-replay",
        events: chunk.events,
        options: {
          ...options || {},
          hideCursorOnComplete: chunkIndex === replayChunks.length - 1
        }
      });
      results.push({
        frameId: chunk.frameId,
        eventCount: chunk.events.length,
        ...response || {}
      });
    } catch (err) {
      results.push({
        frameId: chunk.frameId,
        eventCount: chunk.events.length,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
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
      message: ok && !failures.length ? `TabWorks 回放完成，执行 ${played} 步` : `TabWorks 回放完成，${failures.length} 步未命中`
    });
  } catch {}
  return {
    tabId: targetTabId,
    ok,
    played,
    skipped: results.reduce((sum, item) => sum + (item.skipped || 0), 0),
    failures,
    frames: results
  };
}
async function handleCommand(cmd) {
  const workspace = getWorkspaceKey(cmd.workspace);
  resetWindowIdleTimer(workspace);
  try {
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
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
async function handleExec(cmd, workspace) {
  if (!cmd.code)
    return { id: cmd.id, ok: false, error: "缺少 code 字段" };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await cdpEvaluate(tabId, cmd.code);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
async function handleMouse(cmd, workspace) {
  if (!["click", "press", "drag"].includes(cmd.op)) {
    return { id: cmd.id, ok: false, error: `未知 mouse op: ${cmd.op}` };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = cmd.op === "click" ? await cdpMouseClick(tabId, cmd.x, cmd.y) : cmd.op === "press" ? await cdpMousePress(tabId, cmd.x, cmd.y, cmd.durationMs) : await cdpMouseDrag(tabId, cmd.fromX, cmd.fromY, cmd.toX, cmd.toY, cmd.durationMs);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
async function handleKey(cmd, workspace) {
  if (!cmd.key)
    return { id: cmd.id, ok: false, error: "缺少 key 字段" };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await cdpKeyPress(tabId, cmd.key);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
async function handleNavigate(cmd, workspace) {
  if (!cmd.url)
    return { id: cmd.id, ok: false, error: "缺少 url 字段" };
  if (!isSafeNavigationUrl(cmd.url)) {
    return {
      id: cmd.id,
      ok: false,
      error: "不安全的 URL scheme，仅允许 http:// 和 https://"
    };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  const beforeTab = await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;
  if (beforeTab.status === "complete" && isTargetUrl(beforeTab.url, targetUrl)) {
    return {
      id: cmd.id,
      ok: true,
      data: {
        title: beforeTab.title,
        url: beforeTab.url,
        tabId,
        timedOut: false
      }
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
      if (settled)
        return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer)
        clearTimeout(checkTimer);
      if (timeoutTimer)
        clearTimeout(timeoutTimer);
      resolve();
    };
    const isNavigationDone = (url) => isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    const listener = (id, info, tab2) => {
      if (id !== tabId)
        return;
      if (info.status === "complete" && isNavigationDone(tab2.url ?? info.url))
        finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.status === "complete" && isNavigationDone(currentTab.url))
          finish();
      } catch {}
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
    data: { title: tab.title, url: tab.url, tabId, timedOut }
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
          active: t.active
        }))
      };
    }
    case "new": {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return { id: cmd.id, ok: false, error: "不安全的 URL scheme" };
      }
      const foreground = cmd.foreground !== undefined ? cmd.foreground === true : globalForeground;
      const windowId = await getAutomationWindow(workspace, {
        focused: foreground
      });
      const tab = await chrome.tabs.create({
        windowId,
        url: cmd.url ?? BLANK_PAGE,
        active: foreground
      });
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case "close": {
      const { globalKeepTab: storedKeepTab } = await chrome.storage.local.get("globalKeepTab");
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
            error: `Tab index ${cmd.index} 不存在`
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
            error: `Tab ${cmd.tabId} 不属于自动化窗口`
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
          error: `Tab index ${cmd.index} 不存在`
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
      error: "需要提供 domain 或 url，避免导出全部 cookie"
    };
  }
  const details = {};
  if (cmd.domain)
    details.domain = cmd.domain;
  if (cmd.url)
    details.url = cmd.url;
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
      expirationDate: c.expirationDate
    }))
  };
}
async function handleScreenshot(cmd, workspace) {
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await cdpScreenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage
    });
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
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
      data
    };
  }
  if (op === "stop") {
    const data = await stopUiRecording(cmd.sessionId, cmd.tabId);
    return {
      id: cmd.id,
      ok: true,
      data
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
        eventCount: item.events?.length || 0
      }))
    };
  }
  if (op === "replay") {
    const response = await replayUiRecording({
      tabId: cmd.tabId,
      events: cmd.events,
      options: cmd.options
    });
    return {
      id: cmd.id,
      ok: response?.ok !== false,
      data: response,
      error: response?.ok === false ? response.error || "回放失败" : undefined
    };
  }
  return { id: cmd.id, ok: false, error: `未知 recording op: ${op}` };
}
async function handleCloseWindow(cmd, workspace) {
  const session = automationSessions.get(workspace);
  if (session) {
    try {
      await chrome.windows.remove(session.windowId);
    } catch {}
    if (session.idleTimer)
      clearTimeout(session.idleTimer);
    automationSessions.delete(workspace);
    broadcastSessions();
  }
  return { id: cmd.id, ok: true, data: { closed: true } };
}
async function handleSessions(cmd) {
  const now = Date.now();
  const data = await Promise.all([...automationSessions.entries()].map(async ([workspace, session]) => ({
    workspace,
    windowId: session.windowId,
    tabCount: (await chrome.tabs.query({ windowId: session.windowId })).filter((t) => isDebuggableUrl(t.url)).length,
    idleMsRemaining: Math.max(0, session.idleDeadlineAt - now)
  })));
  return { id: cmd.id, ok: true, data };
}
var globalForeground = false;
var globalKeepTab = false;
chrome.storage.local.get(["globalForeground", "globalKeepTab"], (result) => {
  if (result.globalForeground === true)
    globalForeground = true;
  if (result.globalKeepTab === true)
    globalKeepTab = true;
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
var popupPorts = new Set;
function buildStatusMsg() {
  return {
    type: "status",
    connected: ws?.readyState === WebSocket.OPEN,
    reconnecting: reconnectTimer !== null,
    foreground: globalForeground,
    keepTab: globalKeepTab
  };
}
function broadcastStatus() {
  const msg = buildStatusMsg();
  for (const port of popupPorts) {
    try {
      port.postMessage(msg);
    } catch {}
  }
}
async function buildSessionsMsg() {
  const now = Date.now();
  const sessions = await Promise.all([...automationSessions.entries()].map(async ([workspace, session]) => ({
    workspace,
    windowId: session.windowId,
    tabCount: (await chrome.tabs.query({ windowId: session.windowId })).filter((t) => isDebuggableUrl(t.url)).length,
    idleMsRemaining: Math.max(0, session.idleDeadlineAt - now)
  })));
  return { type: "sessions", sessions };
}
function broadcastSessions() {
  buildSessionsMsg().then((msg) => {
    for (const port of popupPorts) {
      try {
        port.postMessage(msg);
      } catch {}
    }
  });
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup")
    return;
  popupPorts.add(port);
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  }
  port.postMessage(buildStatusMsg());
  buildSessionsMsg().then((msg) => {
    try {
      port.postMessage(msg);
    } catch {}
  });
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === "setForeground")
      setGlobalForeground(msg.value === true);
    if (msg?.type === "setKeepTab")
      setGlobalKeepTab(msg.value === true);
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
      } catch {}
    }
  });
  port.onDisconnect.addListener(() => popupPorts.delete(port));
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "tabworks-ui-recording-start") {
    startUiRecording(message.tabId).then((data) => ({ ok: true, ...data })).then(sendResponse).catch((err) => sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }));
    return true;
  }
  if (message?.type === "tabworks-ui-recording-stop") {
    stopUiRecording(message.sessionId, message.tabId).then((data) => ({ ok: true, ...data })).then(sendResponse).catch((err) => sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }));
    return true;
  }
  if (message?.type === "tabworks-ui-recording-status") {
    const active = [...recordingTabs.values()][0] || null;
    getLastUiRecording().then((lastRecording) => ({
      ok: true,
      recording: active ? recordingStatus(active) : null,
      lastRecording
    })).then(sendResponse).catch((err) => sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }));
    return true;
  }
  if (message?.type === "tabworks-ui-recording-clear") {
    clearLastUiRecording().then((data) => ({ ok: true, ...data })).then(sendResponse).catch((err) => sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }));
    return true;
  }
  if (message?.type === "tabworks-recording-trusted-click") {
    const tabId2 = sender.tab?.id;
    if (!Number.isInteger(tabId2)) {
      sendResponse({ ok: false, error: "无法定位当前标签页" });
      return true;
    }
    cdpMouseClick(tabId2, message.x, message.y).then((data) => ({ ok: true, ...data })).then(sendResponse).catch((err) => sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }));
    return true;
  }
  if (message?.type === "tabworks-ui-recording-replay") {
    replayUiRecording(message).then((data) => ({ ok: data?.ok !== false, ...data })).then(sendResponse).catch((err) => sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }));
    return true;
  }
  if (message?.type === "tabworks-recording-sync") {
    const tabId2 = sender.tab?.id;
    const recording2 = tabId2 ? recordingTabs.get(tabId2) : null;
    sendResponse({
      ok: true,
      recording: Boolean(recording2),
      sessionId: recording2?.sessionId
    });
    return true;
  }
  if (message?.type !== "tabworks-recording-event")
    return false;
  const tabId = sender.tab?.id;
  if (!tabId)
    return false;
  const recording = recordingTabs.get(tabId);
  if (!recording || recording.sessionId !== message.sessionId)
    return false;
  const event = {
    ...message.event,
    frameId: sender.frameId ?? 0,
    frameUrl: sender.url || message.event?.url
  };
  if (shouldSkipDuplicateRecordingEvent(recording, event))
    return false;
  recording.events.push(event);
  upsertRecordingFrame(recording, {
    frameId: sender.frameId ?? 0,
    url: sender.url || message.event?.url,
    ok: true,
    response: {
      url: sender.url || message.event?.url,
      title: message.event?.title,
      frameContext: message.event?.frameContext
    }
  });
  if ((sender.frameId ?? 0) === 0) {
    if (message.event?.url)
      recording.url = message.event.url;
    if (message.event?.title)
      recording.title = message.event.title;
  }
  return false;
});
async function attachRecordingToFrame(tabId, frameId, url) {
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId))
    return;
  const recording = recordingTabs.get(tabId);
  if (!recording || !isDebuggableUrl(url))
    return;
  try {
    await injectRecorderIntoFrames(tabId, frameId);
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "tabworks-recording-start",
      sessionId: recording.sessionId
    }, { frameId });
    upsertRecordingFrame(recording, {
      frameId,
      url: response?.url || url,
      ok: true,
      response
    });
  } catch {}
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
var initialized = false;
function initialize() {
  if (initialized)
    return;
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
  if (alarm.name === "keepalive")
    connect();
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getStatus") {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN,
      reconnecting: reconnectTimer !== null,
      foreground: globalForeground
    });
  }
  return false;
});
