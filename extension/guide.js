const APP_URL = "http://localhost:9527";
const STATUS_URL = `${APP_URL}/status`;

const openLogsBtn = document.getElementById("open-logs");
const copyReferenceBtn = document.getElementById("copy-reference");
const extensionSettingsBtn = document.getElementById("open-extension-settings");
const statusDot = document.getElementById("status-dot");
const statusDotInline = document.getElementById("status-dot-inline");
const statusTitle = document.getElementById("status-title");
const statusDetail = document.getElementById("status-detail");
const API_REFERENCE = [
  {
    code: "SYS",
    capability: "服务状态",
    method: "GET",
    endpoint: "/status",
    purpose: "检查本地服务和扩展连接状态。",
    dependency: "无",
  },
  {
    code: "NAV",
    capability: "页面导航",
    method: "POST",
    endpoint: "/open",
    purpose: "创建自动化窗口、打开 URL、跳转、选择或关闭标签页。",
    dependency: "扩展可用",
  },
  {
    code: "DOM",
    capability: "读取 DOM",
    method: "POST",
    endpoint: "/inspect",
    purpose: "获取标题、URL、正文摘要和链接列表。",
    dependency: "页面已加载",
  },
  {
    code: "JS",
    capability: "执行脚本",
    method: "POST",
    endpoint: "/run-js",
    purpose: "在目标页面上下文运行 JavaScript，读取 DOM 或调用页面函数。",
    dependency: "页面已打开",
  },
  {
    code: "TAP",
    capability: "点击元素",
    method: "POST",
    endpoint: "/tap",
    purpose: '点击指定 selector；mode: "mouse" 会走 CDP 鼠标事件，适合 antd Select。',
    dependency: "页面已打开",
  },
  {
    code: "INP",
    capability: "输入文本",
    method: "POST",
    endpoint: "/input",
    purpose: "兼容普通 input/textarea/select/contenteditable；对 React/antd 受控输入会优先走原生 setter 并触发 input/change。",
    dependency: "页面已打开",
  },
  {
    code: "API",
    capability: "请求接口",
    method: "POST",
    endpoint: "/request",
    purpose: "在页面上下文发起 fetch，可携带当前页面登录态，例如请求 /api/animals。",
    dependency: "页面权限",
  },
  {
    code: "IMG",
    capability: "页面截图",
    method: "POST",
    endpoint: "/capture",
    purpose: "截取当前视口或整页截图，可返回图片内容或保存到文件。",
    dependency: "debugger 权限",
  },
  {
    code: "CK",
    capability: "读取 Cookie",
    method: "POST",
    endpoint: "/cookies",
    purpose: "按 URL 或域名读取 cookie。",
    dependency: "cookies 权限",
  },
  {
    code: "RUN",
    capability: "会话状态",
    method: "POST",
    endpoint: "/sessions",
    purpose: "查看自动化窗口和标签页状态。",
    dependency: "本地服务",
  },
  {
    code: "REC",
    capability: "开始 UI 录制",
    method: "POST",
    endpoint: "/recording/start",
    purpose: "开始记录当前或指定标签页中的 click/input/change/submit/scroll/navigation 事件。",
    dependency: "扩展内容脚本已注入",
  },
  {
    code: "REC",
    capability: "停止 UI 录制",
    method: "POST",
    endpoint: "/recording/stop",
    purpose: "停止录制并写入 .bridge/ui-record/<sessionId>/session.json。",
    dependency: "已有录制 session",
  },
  {
    code: "REC",
    capability: "录制状态",
    method: "POST",
    endpoint: "/recording/status",
    purpose: "查看正在进行的 UI 录制 session。",
    dependency: "本地服务",
  },
];

async function copyWithFeedback(btn, text) {
  const originalText = btn.textContent;
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
  btn.classList.add("copied");
  btn.textContent = "已复制";
  setTimeout(() => {
    btn.classList.remove("copied");
    btn.textContent = originalText;
  }, 1400);
}

function sampleBodyForEndpoint(endpoint) {
  if (endpoint === "/open") return { url: "https://example.com", foreground: true };
  if (endpoint === "/inspect") return { pageId: 123 };
  if (endpoint === "/run-js") return { pageId: 123, script: "document.title" };
  if (endpoint === "/tap")
    return { pageId: 123, selector: "button[type='submit']", mode: "mouse" };
  if (endpoint === "/input")
    return { pageId: 123, selector: "input[name='q']", text: "hello" };
  if (endpoint === "/request")
    return { pageId: 123, url: "/api/animals", method: "GET" };
  if (endpoint === "/capture")
    return { pageId: 123, format: "png", fullPage: false };
  if (endpoint === "/cookies") return { url: "https://example.com" };
  if (endpoint === "/sessions") return {};
  if (endpoint === "/recording/start") return { tabId: 123 };
  if (endpoint === "/recording/stop") return { sessionId: "ui_1234567890_demo" };
  if (endpoint === "/recording/status") return {};
  return { pageId: 123 };
}

function fetchSnippet(method, endpoint) {
  const url = `http://127.0.0.1:9527${endpoint}`;
  if (method === "GET") {
    return `fetch(${JSON.stringify(url)})`;
  }

  return `fetch(${JSON.stringify(url)}, {
  method: ${JSON.stringify(method)},
  headers: {
    "Content-Type": "application/json",
    "X-TabWorks-Bridge": "1"
  },
  body: JSON.stringify(${JSON.stringify(sampleBodyForEndpoint(endpoint), null, 2).replace(/\n/g, "\n  ")})
})`;
}

function buildBridgeReference() {
  const summary = API_REFERENCE.map(
    (item) =>
      `- ${item.capability}: ${item.method} ${item.endpoint}\n  用途：${item.purpose}\n  依赖：${item.dependency}`,
  ).join("\n");
  const examples = API_REFERENCE.map(
    (item) => `## ${item.capability} (${item.method} ${item.endpoint})\n${fetchSnippet(item.method, item.endpoint)}`,
  ).join("\n\n");

  return `TabWorks Bridge 本地 bridge 接口参考

本地服务地址:
- http://127.0.0.1:9527

重要说明:
- CLI 不是使用前提；浏览器扩展无法判断系统里是否安装了 CLI。
- 扩展只能检测 localhost:9527 的 bridge/log 服务是否在线。
- 除 GET /status 外，接口需要本地服务在线、扩展已连接，并携带请求头 X-TabWorks-Bridge: 1。
- UI 录制产物写入 .bridge/ui-record/<sessionId>/session.json；该目录默认不会提交到 git。
- 导出的流程脚本可以使用 await page.sleep(ms) 表达点击后的加载、动画或接口等待。

接口总览:
${summary}

fetch 示例:
${examples}
`;
}

function buildApiRowCopy(btn) {
  const row = btn.closest(".api-row");
  if (!row || row.classList.contains("header")) return null;

  const code = row.querySelector(".cap-code")?.textContent?.trim() || "";
  const capability = row.querySelector(".cap-title strong")?.textContent?.trim() || "";
  const method = row.querySelector(".method")?.textContent?.trim() || "";
  const endpoint = row.querySelector(".endpoint")?.textContent?.trim() || "";
  const purpose = row.querySelector(".muted")?.textContent?.trim().replace(/\s+/g, " ") || "";
  const dependency = row.querySelector(".tag")?.textContent?.trim() || "";

  if (!method || !endpoint) return null;

  return `TabWorks Bridge 接口

能力: ${capability}${code ? ` (${code})` : ""}
方法: ${method}
接口: ${endpoint}
用途: ${purpose}
依赖: ${dependency}

fetch 示例:
${fetchSnippet(method, endpoint)}
`;
}

for (const btn of document.querySelectorAll("[data-copy]")) {
  btn.addEventListener("click", () => {
    const text = buildApiRowCopy(btn) || btn.getAttribute("data-copy") || "";
    copyWithFeedback(btn, text);
  });
}

openLogsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: APP_URL });
});

extensionSettingsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions" });
});

copyReferenceBtn.addEventListener("click", () =>
  copyWithFeedback(copyReferenceBtn, buildBridgeReference()),
);

async function checkStatus() {
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(1500) });
    const data = await res.json().catch(() => ({ ok: res.ok }));
    if (res.ok && data?.ok === true) {
      statusDot.className = "dot online";
      statusDotInline.className = "dot online";
      statusTitle.textContent = "本地服务在线";
      statusDetail.innerHTML =
        "日志面板和本地接口可用。回到 popup 可查看扩展握手状态和自动化窗口。";
      openLogsBtn.textContent = "打开日志面板";
      return;
    }
  } catch {
    /* service unavailable */
  }

  statusDot.className = "dot";
  statusDotInline.className = "dot";
  statusTitle.textContent = "本地服务离线";
  statusDetail.innerHTML =
    "扩展无法判断 CLI 是否安装，只能检测 <code>localhost:9527</code> 的 bridge/log 服务是否在线。";
  openLogsBtn.textContent = "打开日志";
}

checkStatus();
setInterval(checkStatus, 4000);
