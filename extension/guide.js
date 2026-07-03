const APP_URL = "http://localhost:9527";
const STATUS_URL = `${APP_URL}/status`;

const openLogsBtn = document.getElementById("open-logs");
const copyReferenceBtn = document.getElementById("copy-reference");
const extensionSettingsBtn = document.getElementById("open-extension-settings");
const statusDot = document.getElementById("status-dot");
const statusDotInline = document.getElementById("status-dot-inline");
const statusTitle = document.getElementById("status-title");
const statusDetail = document.getElementById("status-detail");
const BRIDGE_REFERENCE = `TabWorks Bridge 本地 bridge 接口参考

本地服务地址:
- http://127.0.0.1:9527

重要说明:
- CLI 不是使用前提；浏览器扩展无法判断系统里是否安装了 CLI。
- 扩展只能检测 localhost:9527 的 bridge/log 服务是否在线。
- 除 GET /status 外，接口需要本地服务在线、扩展已连接，并携带请求头 X-TabWorks-Bridge: 1。

接口总览:
- 服务状态: GET /status，检查本地服务和扩展连接状态。依赖: 无。
- 页面导航: POST /open，创建自动化窗口、打开 URL、跳转、选择或关闭标签页。依赖: 扩展可用。
- 读取 DOM: POST /inspect，获取标题、URL、正文摘要和链接列表。依赖: 页面已加载。
- 执行脚本: POST /run-js，在目标页面上下文运行 JavaScript，读取 DOM 或调用页面函数。依赖: 页面已打开。
- 点击元素: POST /tap，点击指定 selector；mode: "mouse" 会走 CDP 鼠标事件，适合 antd Select 这类依赖 mousedown/focus 的组件。依赖: 页面已打开。
- 输入文本: POST /input，兼容普通 input/textarea/select/contenteditable；对 React/antd 受控输入会优先走原生 setter 并触发 input/change。依赖: 页面已打开。
- 请求接口: POST /request，在页面上下文发起 fetch，可携带当前页面登录态，例如请求 /api/animals。依赖: 页面权限。
- 页面截图: POST /capture，截取当前视口或整页截图，可返回图片内容或保存到文件。依赖: debugger 权限。
- 读取 Cookie: POST /cookies，按 URL 或域名读取 cookie。依赖: cookies 权限。
- 会话状态: POST /sessions，查看自动化窗口和标签页状态。依赖: 本地服务。

请求示例:
fetch("http://127.0.0.1:9527/request", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-TabWorks-Bridge": "1"
  },
  body: JSON.stringify({
    pageId: 123,
    url: "/api/animals",
    method: "GET"
  })
})
`;

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
  copyWithFeedback(copyReferenceBtn, BRIDGE_REFERENCE),
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
