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
const copyCapabilitiesBtn = document.getElementById("copy-capabilities-btn");
const sessionsEl = document.getElementById("sessions");

const APP_URL = "http://localhost:9527";
const STATUS_URL = `${APP_URL}/status`;
const CAPABILITIES_REFERENCE = `TabWorks Bridge 浏览器扩展能力摘要

本地服务地址: http://127.0.0.1:9527
说明: CLI 不是使用前提；扩展无法判断 CLI 是否安装，只能检测 localhost:9527 的 bridge/log 服务是否在线。
除 GET /status 外，请求需要本地服务在线、扩展已连接，并携带请求头 X-TabWorks-Bridge: 1。

支持能力:
- 执行脚本: POST /run-js，在目标页面上下文运行 JavaScript。
- 页面导航: POST /open，创建自动化窗口、打开 URL、跳转、选择或关闭标签页。
- 点击元素: POST /tap，支持 mode: "mouse" 走 CDP 鼠标事件，适合 antd Select。
- 输入文本: POST /input，兼容普通 input/textarea/select/contenteditable；对 React/antd 受控输入会优先走原生 setter 并触发 input/change。
- 请求接口: POST /request，在页面上下文发起 fetch，可携带当前页面登录态，例如请求 /api/animals。
- 读取 DOM: POST /inspect，读取标题、URL、正文摘要和链接列表。
- 读取 Cookie: POST /cookies，按 URL 或域名读取 cookie。
- 页面截图: POST /capture，截取当前视口或整页截图。

辅助接口:
- GET /status: 检查本地服务和扩展连接状态。
- POST /sessions: 查看自动化窗口和标签页状态。
`;

const port = chrome.runtime.connect({ name: "popup" });

let bridgeState = {
  connected: false,
  reconnecting: false,
  foreground: false,
  keepTab: false,
};
let serviceOnline = false;

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
copyCapabilitiesBtn.addEventListener("click", () =>
  copyWithFeedback(copyCapabilitiesBtn, CAPABILITIES_REFERENCE),
);

async function checkViewerStatus() {
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json().catch(() => ({ ok: true }));
      serviceOnline = data?.ok === true;
      renderStatus();
      return;
    }
  } catch {
    /* service unavailable */
  }
  serviceOnline = false;
  renderStatus();
}

checkViewerStatus();
port.postMessage({ type: "getSessions" });
const statusTimer = setInterval(checkViewerStatus, 3000);
const sessionTimer = setInterval(
  () => port.postMessage({ type: "getSessions" }),
  3000,
);
window.addEventListener("unload", () => {
  clearInterval(statusTimer);
  clearInterval(sessionTimer);
});
