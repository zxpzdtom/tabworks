const dot = document.getElementById("dot");
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
      "扩展已接入本地 bridge",
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
      "本地日志服务在线",
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
  serviceTools.querySelector("span").textContent = "日志服务已启动";
  logsBtn.textContent = "打开日志";
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
  recorderDot.classList.toggle("active", Boolean(recording));
  recorderStartBtn.disabled = Boolean(recording);
  recorderStopBtn.disabled = !recording;

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
    }`;
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
        : `已在当前页面回放 ${replay.played || 0} 个操作。`;
    } else {
      recorderTitle.textContent = "录制已保存";
      recorderState.textContent = `${lastRecordingResult.eventCount || 0} events`;
      recorderDetail.textContent = "录制已保存在浏览器扩展中，可回放或下载为脚本。";
    }
    recorderSecondary.hidden = false;
    recorderReplayBtn.disabled = false;
    return;
  }

  recorderTitle.textContent = serviceOnline ? "准备录制当前页面" : "等待本地服务";
  recorderTitle.textContent = "准备录制当前页面";
  recorderState.textContent = "ready";
  recorderDetail.textContent =
    "打开目标网页后，点开始录制；操作完成后回到这里停止。";
  recorderSecondary.hidden = true;
}

async function refreshRecordingStatus() {
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
  recorderDetail.textContent = "请保持目标页面为当前活动标签页。";
  try {
    const data = await sendRuntimeMessage({
      type: "tabworks-ui-recording-replay",
      sessionId: lastRecordingResult.sessionId,
      options: { maxDelayMs: 2000 },
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
  return (
    event?.element?.preferredSelector ||
    event?.element?.selectors?.[0]?.selector ||
    ""
  );
}

function normalizeEvents(events = []) {
  const playable = events.filter((event) =>
    ["click", "input", "scroll", "submit", "navigation"].includes(event.kind),
  );
  const normalized = [];
  for (const event of playable) {
    const previous = normalized[normalized.length - 1];
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
  lines.push(`  const opened = await bridge('/open', { url: ${jsString(recordingData.url || "https://example.com")}, foreground: true });`);
  lines.push("  const pageId = opened.pageId || opened.tabId;");
  lines.push("  await sleep(800);");
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
    } else if (event.kind === "input" && selector && !event.redacted) {
      lines.push(`  await bridge('/input', { pageId, selector: ${jsString(selector)}, text: ${JSON.stringify(event.value ?? "")} });`);
    } else if (event.kind === "scroll") {
      lines.push(`  await bridge('/run-js', { pageId, script: ${jsString(`window.scrollTo(${event.scrollX || 0}, ${event.scrollY || 0})`)} });`);
    } else if (event.kind === "submit" && selector) {
      lines.push(`  await bridge('/run-js', { pageId, script: ${jsString(`document.querySelector(${JSON.stringify(selector)})?.requestSubmit?.()`)} });`);
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

recorderDownloadBtn.addEventListener("click", () => {
  if (!lastRecordingResult) return;
  const script = buildDownloadedScript(lastRecordingResult);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadTextFile(`tabworks-recording-${stamp}.mjs`, script);
  const originalText = recorderDownloadBtn.textContent;
  recorderDownloadBtn.textContent = "已下载";
  setTimeout(() => {
    recorderDownloadBtn.textContent = originalText;
  }, 1400);
});

async function checkViewerStatus() {
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
