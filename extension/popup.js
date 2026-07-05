const isExtensionPage = location.protocol === "chrome-extension:";
const needsChromeMock = !isExtensionPage || !globalThis.chrome?.runtime?.connect;
const isPreviewRuntime =
  needsChromeMock ||
  (!isExtensionPage && location.search.includes("preview="));
const previewRecordingState = new URLSearchParams(location.search).get(
  "recordingState",
);

if (needsChromeMock) {
  globalThis.chrome = {
    runtime: {
      connect: () => ({
        onDisconnect: { addListener() {} },
        onMessage: { addListener() {} },
        postMessage() {},
      }),
      getURL: (path) => path,
      sendMessage: (_message, callback) => {
        callback?.({ ok: false, error: "Chrome runtime unavailable" });
      },
    },
    storage: {
      local: {
        get: (_keys, callback) => callback?.({}),
        set() {},
      },
    },
    tabs: {
      create: ({ url }) => window.open(url, "_blank", "noopener"),
    },
  };
}

const dot = document.getElementById("dot");
const popupEl = document.querySelector(".popup");
const statusEl = document.getElementById("status");
const statusTitle = document.getElementById("status-title");
const statusDetail = document.getElementById("status-detail");
const serviceMeta = document.getElementById("service-meta");
const serviceTools = document.getElementById("service-tools");
const serviceState = document.getElementById("service-state");
const foregroundToggle = document.getElementById("foreground-toggle");
const keepTabToggle = document.getElementById("keeptab-toggle");
const logsBtn = document.getElementById("logs-btn");
const guideBtn = document.getElementById("guide-btn");
const sessionsEl = document.getElementById("sessions");
const recorderDot = document.getElementById("recorder-dot");
const recorderTitle = document.getElementById("recorder-title");
const recorderState = document.getElementById("recorder-state");
const recorderDetail = document.getElementById("recorder-detail");
const recorderStartBtn = document.getElementById("recorder-start");
const recorderStopBtn = document.getElementById("recorder-stop");
const recorderSecondary = document.getElementById("recorder-secondary");
const recorderReplayBtn = document.getElementById("recorder-replay");
const recorderDownloadBtn = document.getElementById("recorder-download");

const APP_URL = "http://localhost:9527";
const STATUS_URL = `${APP_URL}/status`;

const port = chrome.runtime.connect({ name: "popup" });

let bridgeState = {
  connected: false,
  reconnecting: false,
  foreground: false,
  keepTab: false,
};
let serviceOnline = false;
let recording = null;
let lastRecordingResult = null;
let recorderError = "";

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (response?.ok === false) {
        reject(new Error(response.error || "操作失败"));
        return;
      }
      resolve(response);
    });
  });
}

function setStatusVisual(kind, label, title, detail) {
  dot.className = `dot ${kind}`;
  statusEl.textContent = label;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
}

function renderStatus(state = bridgeState) {
  bridgeState = { ...bridgeState, ...state };

  if (bridgeState.connected) {
    setStatusVisual(
      "connected",
      "已连接",
      "本地 bridge",
      "可以接收本地服务发来的浏览器自动化命令。",
    );
  } else if (bridgeState.reconnecting) {
    setStatusVisual(
      "connecting",
      "重连中",
      "正在等待 bridge 握手",
      "扩展已启用，本地服务恢复后会自动连接。",
    );
  } else if (serviceOnline) {
    setStatusVisual(
      "connecting",
      "服务在线",
      "本地 bridge",
      "HTTP 服务可用，但扩展 WebSocket 还未完成握手。",
    );
  } else {
    setStatusVisual(
      "disconnected",
      "未连接",
      "未检测到本地服务",
      "如果只想查看扩展能力，可以直接打开接口说明。",
    );
  }

  foregroundToggle.checked = bridgeState.foreground === true;
  keepTabToggle.checked = bridgeState.keepTab === true;
  serviceMeta.textContent = serviceOnline ? "localhost:9527" : "extension";
  serviceTools.classList.toggle("visible", serviceOnline);
  serviceTools.querySelector("span").textContent = serviceOnline
    ? "日志服务已启动"
    : "日志服务未启动";
  logsBtn.disabled = !serviceOnline;
  logsBtn.textContent = serviceOnline ? "打开日志" : "日志离线";
  logsBtn.title = serviceOnline
    ? "打开本地日志服务"
    : "需要先启动 localhost:9527";
  serviceState.textContent = serviceOnline
    ? "日志服务已检测到"
    : "日志服务未检测到";
  renderRecording();
}

function renderSessions(sessions = []) {
  if (!sessions.length) {
    sessionsEl.textContent = "暂无活动窗口";
    return;
  }

  const tabCount = sessions.reduce((sum, item) => sum + (item.tabCount || 0), 0);
  sessionsEl.textContent = `${sessions.length} 个窗口 / ${tabCount} 个标签页`;
}

function openGuide(hash = "interfaces") {
  chrome.tabs.create({ url: chrome.runtime.getURL(`guide.html#${hash}`) });
}

function shortSessionId(sessionId = "") {
  if (!sessionId) return "";
  return sessionId.length > 18
    ? `${sessionId.slice(0, 11)}…${sessionId.slice(-4)}`
    : sessionId;
}

function renderRecording() {
  const isRecording = Boolean(recording);
  const hasSavedRecording = Boolean(lastRecordingResult) && !recorderError;

  recorderDot.classList.toggle("active", Boolean(recording));
  popupEl.classList.toggle("is-recording", isRecording);
  popupEl.classList.toggle("is-saved", !isRecording && hasSavedRecording);
  popupEl.classList.toggle("is-ready", !isRecording && !hasSavedRecording);
  recorderStartBtn.hidden = isRecording;
  recorderStopBtn.hidden = !isRecording;
  recorderStartBtn.disabled = isRecording;
  recorderStopBtn.disabled = !isRecording;
  recorderStartBtn.textContent = recording
    ? "录制中"
    : lastRecordingResult
      ? "重新录制"
      : "开始录制";
  recorderStartBtn.classList.toggle("primary", !lastRecordingResult);
  recorderReplayBtn.classList.toggle("primary", Boolean(lastRecordingResult));

  if (recorderError) {
    recorderTitle.textContent = "录制操作失败";
    recorderState.textContent = "error";
    recorderDetail.textContent = recorderError;
    recorderSecondary.hidden = true;
    return;
  }

  if (recording) {
    recorderTitle.textContent = "正在录制当前流程";
    recorderState.textContent = `${recording.eventCount || 0} events`;
    recorderDetail.textContent = `${shortSessionId(recording.sessionId)} · ${
      recording.title || recording.url || "当前标签页"
    } · ${recording.frameCount || 0} frames`;
    recorderSecondary.hidden = true;
    return;
  }

  if (lastRecordingResult) {
    if (lastRecordingResult.lastReplay) {
      const replay = lastRecordingResult.lastReplay;
      recorderTitle.textContent = replay.failures?.length
        ? "回放完成，有步骤未命中"
        : "回放完成";
      recorderState.textContent = `${replay.played || 0} steps`;
      recorderDetail.textContent = replay.failures?.length
        ? `完成 ${replay.played || 0} 步，${replay.failures.length} 步未找到元素。`
        : `已刷新到录制起点，并回放 ${replay.played || 0} 个操作。`;
    } else {
      recorderTitle.textContent = "录制已保存";
      recorderState.textContent = `${lastRecordingResult.eventCount || 0} events`;
      recorderDetail.textContent =
        "回放会先刷新到录制起点，再按步骤执行。";
    }
    recorderSecondary.hidden = false;
    recorderReplayBtn.disabled = false;
    return;
  }

  recorderTitle.textContent = "准备录制当前页面";
  recorderState.textContent = "ready";
  recorderDetail.textContent =
    "打开目标网页后，点开始录制；操作完成后回到这里停止。";
  recorderSecondary.hidden = true;
}

async function refreshRecordingStatus() {
  if (isPreviewRuntime && previewRecordingState) {
    renderRecording();
    return;
  }
  try {
    const data = await sendRuntimeMessage({ type: "tabworks-ui-recording-status" });
    recording = data.recording || null;
    if (!recording && data.lastRecording && !lastRecordingResult) {
      lastRecordingResult = data.lastRecording;
    }
  } catch {
    recording = null;
  }
  renderRecording();
}

async function copyWithFeedback(button, text) {
  const originalText = button.textContent;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
  } catch {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    document.body.append(textArea);
    textArea.select();
    document.execCommand("copy");
    textArea.remove();
  }
  button.textContent = "已复制";
  setTimeout(() => {
    button.textContent = originalText;
  }, 1400);
}

port.onDisconnect.addListener(() => {
  bridgeState = { ...bridgeState, connected: false, reconnecting: false };
  renderStatus();
  checkViewerStatus();
});

port.onMessage.addListener((msg) => {
  if (msg?.type === "status") renderStatus(msg);
  if (msg?.type === "sessions") renderSessions(msg.sessions);
});

foregroundToggle.addEventListener("change", () => {
  port.postMessage({
    type: "setForeground",
    value: foregroundToggle.checked,
  });
});

keepTabToggle.addEventListener("change", () => {
  port.postMessage({ type: "setKeepTab", value: keepTabToggle.checked });
});

logsBtn.addEventListener("click", () => {
  if (!serviceOnline) return;
  chrome.tabs.create({ url: APP_URL });
});

guideBtn.addEventListener("click", () => openGuide("interfaces"));

recorderStartBtn.addEventListener("click", async () => {
  recorderStartBtn.disabled = true;
  recorderError = "";
  recorderDetail.textContent = "正在连接当前标签页录制脚本…";
  try {
    const data = await sendRuntimeMessage({ type: "tabworks-ui-recording-start" });
    recording = {
      sessionId: data.sessionId,
      tabId: data.tabId,
      url: data.url,
      title: data.title,
      eventCount: 0,
    };
    lastRecordingResult = null;
    recorderError = "";
  } catch (err) {
    recording = null;
    recorderError =
      err instanceof Error ? err.message : "请刷新目标页面后重试。";
  }
  renderRecording();
});

recorderStopBtn.addEventListener("click", async () => {
  if (!recording?.sessionId) return;
  const sessionId = recording.sessionId;
  recorderStopBtn.disabled = true;
  recorderError = "";
  recorderDetail.textContent = "正在停止录制并保存到浏览器扩展…";
  try {
    const data = await sendRuntimeMessage({
      type: "tabworks-ui-recording-stop",
      sessionId,
    });
    lastRecordingResult = data;
    recording = null;
    recorderError = "";
  } catch (err) {
    recorderError =
      err instanceof Error ? err.message : "停止录制失败。";
  }
  renderRecording();
});

recorderReplayBtn.addEventListener("click", async () => {
  if (!lastRecordingResult?.sessionId) return;
  recorderReplayBtn.disabled = true;
  recorderError = "";
  recorderTitle.textContent = "正在回放录制";
  recorderState.textContent = "replay";
  recorderDetail.textContent = "正在刷新到录制起点，然后按步骤回放。";
  try {
    const data = await sendRuntimeMessage({
      type: "tabworks-ui-recording-replay",
      sessionId: lastRecordingResult.sessionId,
      options: { maxDelayMs: 2000, reloadBeforeReplay: true },
    });
    lastRecordingResult = { ...lastRecordingResult, lastReplay: data };
    chrome.storage.local.set({ lastUiRecording: lastRecordingResult });
  } catch (err) {
    recorderError = err instanceof Error ? err.message : "回放失败。";
  }
  recorderReplayBtn.disabled = false;
  renderRecording();
});

function jsString(value) {
  return JSON.stringify(String(value ?? ""));
}

function selectorForEvent(event) {
  const selectors = event?.element?.selectors || [];
  return (
    selectors.find((item) => item.unique)?.selector ||
    event?.element?.preferredSelector ||
    selectors.find((item) => item.selector)?.selector ||
    ""
  );
}

function selectorForSortableEvent(event) {
  const selectors = event?.sortable?.rowElement?.selectors || [];
  return (
    selectors.find((item) => item.unique)?.selector ||
    event?.sortable?.rowElement?.preferredSelector ||
    ""
  );
}

function numberLiteral(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : fallback;
}

function eventTime(event) {
  const time = Date.parse(event?.at || "");
  return Number.isFinite(time) ? time : null;
}

function orderedEvents(events = []) {
  return events
    .map((event, index) => ({ event, index, time: eventTime(event) }))
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
      selectorForEvent(a) &&
      selectorForEvent(a) === selectorForEvent(b);
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
  const previousAt = eventTime(previous);
  const nextAt = eventTime(next);
  if (
    previousAt !== null &&
    nextAt !== null &&
    Math.abs(nextAt - previousAt) > 900
  ) {
    return false;
  }
  return sameSortableMove(previous, next) || sameDragGeometry(previous, next);
}

function dedupeDragEvents(events = []) {
  const normalized = [];
  for (const event of events) {
    if (
      event?.kind === "drag" &&
      normalized.slice(-8).some((previous) => isDuplicateDragEvent(previous, event))
    ) {
      continue;
    }
    normalized.push(event);
  }
  return normalized;
}

function smoothScrollScript(scrollX, scrollY) {
  return `(() => new Promise((resolve) => {
  const requestedX = ${numberLiteral(scrollX, 0)};
  const requestedY = ${numberLiteral(scrollY, 0)};
  const maxX = Math.max(0, document.documentElement.scrollWidth, document.body?.scrollWidth || 0) - window.innerWidth;
  const maxY = Math.max(0, document.documentElement.scrollHeight, document.body?.scrollHeight || 0) - window.innerHeight;
  const targetX = Math.max(0, Math.min(requestedX, maxX));
  const targetY = Math.max(0, Math.min(requestedY, maxY));
  const startX = window.scrollX;
  const startY = window.scrollY;
  const deltaX = targetX - startX;
  const deltaY = targetY - startY;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance < 1) {
    window.scrollTo(targetX, targetY);
    resolve(true);
    return;
  }
  const duration = Math.max(260, Math.min(900, distance * 0.55));
  const startedAt = performance.now();
  function tick(nowTime) {
    const progress = Math.min(1, (nowTime - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    window.scrollTo(startX + deltaX * eased, startY + deltaY * eased);
    if (progress < 1) requestAnimationFrame(tick);
    else resolve(true);
  }
  requestAnimationFrame(tick);
}))()`;
}

function normalizeEvents(events = []) {
  const playable = dedupeDragEvents(orderedEvents(events)).filter((event) =>
    [
      "click",
      "input",
      "scroll",
      "submit",
      "navigation",
      "long-press",
      "drag",
      "double-click",
      "context-menu",
      "key",
    ].includes(event.kind),
  );
  const normalized = [];
  for (const event of playable) {
    const previous = normalized[normalized.length - 1];
    if (
      event.kind === "double-click" &&
      previous?.kind === "click" &&
      selectorForEvent(previous) === selectorForEvent(event)
    ) {
      normalized.pop();
      const prior = normalized[normalized.length - 1];
      if (prior?.kind === "click" && selectorForEvent(prior) === selectorForEvent(event)) {
        normalized.pop();
      }
    }
    if (
      event.kind === "input" &&
      previous?.kind === "input" &&
      selectorForEvent(previous) === selectorForEvent(event) &&
      previous.value === event.value
    ) {
      previous.at = event.at || previous.at;
      continue;
    }
    normalized.push(event);
  }
  return normalized;
}

function needsExtensionReplay(events = []) {
  return events.some((event) => {
    const selector = selectorForEvent(event);
    return (Number.isInteger(event.frameId) && event.frameId !== 0) || selector.includes(">>>");
  });
}

function buildDownloadedScript(recordingData) {
  const events = normalizeEvents(recordingData.events || []);
  const lines = [];
  lines.push("#!/usr/bin/env node");
  lines.push("// Generated by TabWorks Bridge UI Recorder");
  lines.push(`// Source: ${recordingData.title || recordingData.url || "unknown"}`);
  lines.push("");
  lines.push('const BRIDGE = process.env.TABWORKS_BRIDGE || "http://127.0.0.1:9527";');
  lines.push("");
  lines.push("async function bridge(path, body) {");
  lines.push("  const res = await fetch(`${BRIDGE}${path}`, {");
  lines.push("    method: body === undefined ? 'GET' : 'POST',");
  lines.push("    headers: { 'Content-Type': 'application/json', 'X-TabWorks-Bridge': '1' },");
  lines.push("    body: body === undefined ? undefined : JSON.stringify(body),");
  lines.push("  });");
  lines.push("  const data = await res.json().catch(() => ({}));");
  lines.push("  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);");
  lines.push("  return data;");
  lines.push("}");
  lines.push("");
  lines.push("const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));");
  lines.push("");
  lines.push("async function main() {");
  lines.push(`  const opened = await bridge('/open', { url: ${jsString(recordingData.startUrl || recordingData.url || "https://example.com")}, foreground: true });`);
  lines.push("  const pageId = opened.pageId || opened.tabId;");
  lines.push("  await sleep(800);");
  if (needsExtensionReplay(events)) {
    lines.push("  await bridge('/recording/replay', {");
    lines.push("    pageId,");
    lines.push(`    title: ${jsString(recordingData.title || "")},`);
    lines.push(`    startUrl: ${jsString(recordingData.startUrl || recordingData.url || "")},`);
    lines.push(`    url: ${jsString(recordingData.url || "")},`);
    lines.push(`    events: ${JSON.stringify(events, null, 4).replace(/\n/g, "\n    ")},`);
    lines.push("    maxDelayMs: 2000,");
    lines.push("    reloadBeforeReplay: true,");
    lines.push("  });");
    lines.push("}");
    lines.push("");
    lines.push("main().catch((error) => {");
    lines.push("  console.error(error);");
    lines.push("  process.exit(1);");
    lines.push("});");
    lines.push("");
    return lines.join("\n");
  }
  let previousAt = null;
  for (const event of events) {
    if (previousAt && event.at) {
      const delta = new Date(event.at).getTime() - new Date(previousAt).getTime();
      if (Number.isFinite(delta) && delta > 100) {
        lines.push(`  await sleep(${Math.min(Math.round(delta), 2000)});`);
      }
    }
    previousAt = event.at || previousAt;
    const selector = selectorForEvent(event);
    if (event.kind === "click" && selector) {
      lines.push(`  await bridge('/tap', { pageId, selector: ${jsString(selector)}, mode: 'mouse' });`);
    } else if (event.kind === "long-press" && selector) {
      lines.push(`  await bridge('/press', { pageId, selector: ${jsString(selector)}, durationMs: ${Math.max(100, Math.round(Number(event.durationMs || 700)))} });`);
    } else if (event.kind === "drag" && selector) {
      const sortableDelta = Number(event.sortable?.moveDelta);
      if (Number.isInteger(sortableDelta) && sortableDelta !== 0) {
        lines.push(`  await bridge('/run-js', { pageId, script: ${jsString(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus?.(); return document.activeElement === el; })()`)} });`);
        lines.push("  await bridge('/key', { pageId, key: 'Space' });");
        lines.push("  await sleep(120);");
        const key = sortableDelta > 0 ? "ArrowDown" : "ArrowUp";
        for (let i = 0; i < Math.abs(sortableDelta); i += 1) {
          lines.push(`  await bridge('/key', { pageId, key: '${key}' });`);
          lines.push("  await sleep(80);");
        }
        lines.push("  await bridge('/key', { pageId, key: 'Space' });");
      } else {
        const body = [
          "pageId",
          `selector: ${jsString(selector)}`,
          `deltaX: ${numberLiteral(event.deltaX, 0)}`,
          `deltaY: ${numberLiteral(event.deltaY, 0)}`,
          `durationMs: ${Math.max(80, Math.round(Number(event.durationMs || 450)))}`,
        ];
        if (Number.isFinite(Number(event.startOffsetX))) {
          body.push(`offsetX: ${numberLiteral(event.startOffsetX, 0)}`);
        }
        if (Number.isFinite(Number(event.startOffsetY))) {
          body.push(`offsetY: ${numberLiteral(event.startOffsetY, 0)}`);
        }
        lines.push(`  await bridge('/drag', { ${body.join(", ")} });`);
      }
    } else if (event.kind === "input" && selector && !event.redacted) {
      lines.push(`  await bridge('/input', { pageId, selector: ${jsString(selector)}, text: ${JSON.stringify(event.value ?? "")} });`);
    } else if (event.kind === "scroll") {
      lines.push(`  await bridge('/run-js', { pageId, script: ${jsString(smoothScrollScript(event.scrollX || 0, event.scrollY || 0))} });`);
    } else if (event.kind === "submit" && selector) {
      lines.push(`  await bridge('/run-js', { pageId, script: ${jsString(`document.querySelector(${JSON.stringify(selector)})?.requestSubmit?.()`)} });`);
    } else if (event.kind === "double-click" && selector) {
      lines.push(`  await bridge('/run-js', { pageId, script: ${jsString(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'center', inline: 'center' }); const rect = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 })); return true; })()`)} });`);
    } else if (event.kind === "context-menu" && selector) {
      lines.push(`  await bridge('/run-js', { pageId, script: ${jsString(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'center', inline: 'center' }); const rect = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 })); return true; })()`)} });`);
    } else if (event.kind === "key") {
      lines.push(`  await bridge('/run-js', { pageId, script: ${jsString(`(() => { const target = document.activeElement || document.body; const init = ${JSON.stringify({ key: event.key, code: event.code, ctrlKey: Boolean(event.ctrlKey), metaKey: Boolean(event.metaKey), altKey: Boolean(event.altKey), shiftKey: Boolean(event.shiftKey) })}; target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init })); return true; })()`)} });`);
    } else if (event.kind === "navigation" && event.url) {
      lines.push(`  await bridge('/goto', { pageId, url: ${jsString(event.url)} });`);
    } else {
      lines.push(`  // Skipped ${event.kind}: ${selector || "no stable selector"}`);
    }
  }
  lines.push("}");
  lines.push("");
  lines.push("main().catch((error) => {");
  lines.push("  console.error(error);");
  lines.push("  process.exit(1);");
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/javascript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function filenameSlug(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[\\/:*?"<>|#%{}$!'@+`=&\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return normalized || "untitled-page";
}

function filenameTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

recorderDownloadBtn.addEventListener("click", () => {
  if (!lastRecordingResult) return;
  const script = buildDownloadedScript(lastRecordingResult);
  const title = filenameSlug(lastRecordingResult.title || lastRecordingResult.url);
  downloadTextFile(`tabworks-${title}-ui-recording-${filenameTimestamp()}.mjs`, script);
  const originalText = recorderDownloadBtn.textContent;
  recorderDownloadBtn.textContent = "已下载";
  setTimeout(() => {
    recorderDownloadBtn.textContent = originalText;
  }, 1400);
});

async function checkViewerStatus() {
  if (isPreviewRuntime) {
    serviceOnline = true;
    bridgeState = { ...bridgeState, connected: true, reconnecting: false };
    renderStatus();
    await refreshRecordingStatus();
    return;
  }

  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json().catch(() => ({ ok: true }));
      serviceOnline = data?.ok === true;
      renderStatus();
      await refreshRecordingStatus();
      return;
    }
  } catch {
    /* service unavailable */
  }
  serviceOnline = false;
  renderStatus();
}

checkViewerStatus();
refreshRecordingStatus();
chrome.storage.local.get(["lastUiRecording"], (result) => {
  if (result.lastUiRecording) {
    lastRecordingResult = result.lastUiRecording;
    renderRecording();
  }
});
port.postMessage({ type: "getSessions" });
const statusTimer = setInterval(checkViewerStatus, 3000);
const sessionTimer = setInterval(
  () => port.postMessage({ type: "getSessions" }),
  3000,
);
const recordingTimer = setInterval(refreshRecordingStatus, 1500);
window.addEventListener("unload", () => {
  clearInterval(statusTimer);
  clearInterval(sessionTimer);
  clearInterval(recordingTimer);
});

if (isPreviewRuntime) {
  window.__tabworksPreviewSetRecording = (nextState = {}) => {
    recording = nextState.recording || null;
    lastRecordingResult = nextState.lastRecordingResult || null;
    recorderError = nextState.recorderError || "";
    renderRecording();
  };

  if (previewRecordingState === "recording") {
    recording = {
      sessionId: "preview-session-1234567890",
      eventCount: 7,
      title: "Preview page",
      frameCount: 1,
    };
    lastRecordingResult = null;
    recorderError = "";
    renderRecording();
  } else if (previewRecordingState === "saved") {
    recording = null;
    lastRecordingResult = {
      sessionId: "preview-session-1234567890",
      eventCount: 18,
      title: "Preview page",
      events: [],
    };
    recorderError = "";
    renderRecording();
  }
}
