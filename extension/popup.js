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
const recorderCopyBtn = document.getElementById("recorder-copy");

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

async function bridgeFetch(path, body = {}) {
  const res = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TabWorks-Bridge": "1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error || `HTTP ${res.status}`;
    if (message.includes("未知路由") && path.startsWith("/recording/")) {
      throw new Error(
        "本地 bridge 版本还不支持 UI 录制，请重启本地服务后重试。",
      );
    }
    throw new Error(message);
  }
  return data;
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
  recorderStartBtn.disabled = !serviceOnline || Boolean(recording);
  recorderStopBtn.disabled = !serviceOnline || !recording;

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
      recorderDetail.textContent = lastRecordingResult.outDir
        ? `${lastRecordingResult.outDir}/session.json`
        : "录制产物已写入 .bridge/ui-record。";
    }
    recorderSecondary.hidden = false;
    recorderReplayBtn.disabled = !serviceOnline;
    return;
  }

  recorderTitle.textContent = serviceOnline ? "准备录制当前页面" : "等待本地服务";
  recorderState.textContent = serviceOnline ? "ready" : "offline";
  recorderDetail.textContent = serviceOnline
    ? "打开目标网页后，点开始录制；操作完成后回到这里停止。"
    : "录制需要本地 bridge 在线，用于保存操作事件。";
  recorderSecondary.hidden = true;
}

async function refreshRecordingStatus() {
  if (!serviceOnline) {
    recording = null;
    renderRecording();
    return;
  }

  try {
    const data = await bridgeFetch("/recording/status", {});
    recording = data.recordings?.[0] || null;
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
    const data = await bridgeFetch("/recording/start", {});
    recording = {
      sessionId: data.sessionId,
      tabId: data.tabId,
      url: data.url,
      title: data.title,
      outDir: data.outDir,
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
  recorderDetail.textContent = "正在停止录制并保存产物…";
  try {
    const data = await bridgeFetch("/recording/stop", { sessionId });
    lastRecordingResult = data;
    chrome.storage.local.set({ lastUiRecording: data });
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
    const data = await bridgeFetch("/recording/replay", {
      sessionId: lastRecordingResult.sessionId,
      maxDelayMs: 2000,
    });
    lastRecordingResult = { ...lastRecordingResult, lastReplay: data };
    chrome.storage.local.set({ lastUiRecording: lastRecordingResult });
  } catch (err) {
    recorderError = err instanceof Error ? err.message : "回放失败。";
  }
  recorderReplayBtn.disabled = false;
  renderRecording();
});

recorderCopyBtn.addEventListener("click", () => {
  const source = recording || lastRecordingResult;
  if (!source) return;
  const text = [
    "TabWorks UI 录制",
    `sessionId: ${source.sessionId}`,
    source.tabId ? `tabId: ${source.tabId}` : "",
    source.eventCount !== undefined ? `events: ${source.eventCount}` : "",
    source.title ? `title: ${source.title}` : "",
    source.url ? `url: ${source.url}` : "",
    source.outDir ? `file: ${source.outDir}/session.json` : "",
  ]
    .filter(Boolean)
    .join("\n");
  copyWithFeedback(recorderCopyBtn, text);
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
