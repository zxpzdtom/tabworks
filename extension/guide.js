(() => {
  // extension/src/guide.ts
  var APP_URL = "http://localhost:9527";
  var STATUS_URL = `${APP_URL}/status`;
  var openLogsBtn = document.getElementById("open-logs");
  var copyReferenceBtn = document.getElementById("copy-reference");
  var extensionSettingsBtn = document.getElementById("open-extension-settings");
  var statusDot = document.getElementById("status-dot");
  var statusDotInline = document.getElementById("status-dot-inline");
  var statusTitle = document.getElementById("status-title");
  var statusDetail = document.getElementById("status-detail");
  var API_REFERENCE = [
    {
      code: "SYS",
      capability: "服务状态",
      method: "GET",
      endpoint: "/status",
      purpose: "检查本地服务和扩展连接状态。",
      dependency: "无"
    },
    {
      code: "NAV",
      capability: "页面导航",
      method: "POST",
      endpoint: "/open",
      purpose: "创建自动化窗口、打开 URL、跳转、选择或关闭标签页。",
      dependency: "扩展可用"
    },
    {
      code: "DOM",
      capability: "读取 DOM",
      method: "POST",
      endpoint: "/inspect",
      purpose: "获取标题、URL、正文摘要和链接列表。",
      dependency: "页面已加载"
    },
    {
      code: "JS",
      capability: "执行脚本",
      method: "POST",
      endpoint: "/run-js",
      purpose: "在目标页面上下文运行 JavaScript，读取 DOM 或调用页面函数。",
      dependency: "页面已打开"
    },
    {
      code: "TAP",
      capability: "点击元素",
      method: "POST",
      endpoint: "/tap",
      purpose: '点击指定 selector；mode: "mouse" 会走 CDP 鼠标事件，适合 antd Select。',
      dependency: "页面已打开"
    },
    {
      code: "PRS",
      capability: "长按元素",
      method: "POST",
      endpoint: "/press",
      purpose: "按住 selector 或坐标一段时间后释放，用于录制脚本里的长按手势。",
      dependency: "debugger 权限"
    },
    {
      code: "DRG",
      capability: "拖拽元素",
      method: "POST",
      endpoint: "/drag",
      purpose: "从 selector、from 坐标或目标元素开始拖到指定坐标/元素，也支持 deltaX/deltaY。",
      dependency: "debugger 权限"
    },
    {
      code: "KEY",
      capability: "键盘按键",
      method: "POST",
      endpoint: "/key",
      purpose: "发送可信键盘事件；UI 录制脚本会用 Space/ArrowUp/ArrowDown 稳定回放 dnd-kit 排序。",
      dependency: "debugger 权限"
    },
    {
      code: "INP",
      capability: "输入文本",
      method: "POST",
      endpoint: "/input",
      purpose: "兼容普通 input/textarea/select/contenteditable；对 React/antd 受控输入会优先走原生 setter 并触发 input/change。",
      dependency: "页面已打开"
    },
    {
      code: "API",
      capability: "请求接口",
      method: "POST",
      endpoint: "/request",
      purpose: "在页面上下文发起 fetch，可携带当前页面登录态，例如请求 /api/animals。",
      dependency: "页面权限"
    },
    {
      code: "IMG",
      capability: "页面截图",
      method: "POST",
      endpoint: "/capture",
      purpose: "截取当前视口或整页截图，可返回图片内容或保存到文件。",
      dependency: "debugger 权限"
    },
    {
      code: "CK",
      capability: "读取 Cookie",
      method: "POST",
      endpoint: "/cookies",
      purpose: "按 URL 或域名读取 cookie。",
      dependency: "cookies 权限"
    },
    {
      code: "RUN",
      capability: "会话状态",
      method: "POST",
      endpoint: "/sessions",
      purpose: "查看自动化窗口和标签页状态。",
      dependency: "本地服务"
    },
    {
      code: "REC",
      capability: "开始 UI 录制",
      method: "POST",
      endpoint: "/recording/start",
      purpose: "开始记录当前或指定标签页中的点击、输入、滚动、长按、拖拽、右键、双击、快捷键和导航事件。",
      dependency: "扩展内容脚本已注入"
    },
    {
      code: "REC",
      capability: "停止 UI 录制",
      method: "POST",
      endpoint: "/recording/stop",
      purpose: "停止 HTTP 录制会话并返回录制摘要；扩展 popup 会把录制保存在浏览器 storage。",
      dependency: "已有录制 session"
    },
    {
      code: "REC",
      capability: "录制状态",
      method: "POST",
      endpoint: "/recording/status",
      purpose: "查看正在进行的 UI 录制 session。",
      dependency: "本地服务"
    },
    {
      code: "PLY",
      capability: "回放 UI 录制",
      method: "POST",
      endpoint: "/recording/replay",
      purpose: "读取已保存的 session，在当前或指定标签页重复执行可回放的 UI 操作事件。",
      dependency: "已有录制 session，目标页面处于可回放状态"
    }
  ];
  async function copyWithFeedback(btn, text) {
    const originalText = btn.textContent;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("clipboard unavailable");
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
    if (endpoint === "/open")
      return { url: "https://example.com", foreground: true };
    if (endpoint === "/inspect")
      return { pageId: 123 };
    if (endpoint === "/run-js")
      return { pageId: 123, script: "document.title" };
    if (endpoint === "/tap")
      return { pageId: 123, selector: "button[type='submit']", mode: "mouse" };
    if (endpoint === "/press")
      return { pageId: 123, selector: "[data-testid='hold']", durationMs: 700 };
    if (endpoint === "/drag")
      return { pageId: 123, selector: "[data-testid='slider']", deltaX: 120, deltaY: 0 };
    if (endpoint === "/key")
      return { pageId: 123, key: "ArrowDown" };
    if (endpoint === "/input")
      return { pageId: 123, selector: "input[name='q']", text: "hello" };
    if (endpoint === "/request")
      return { pageId: 123, url: "/api/animals", method: "GET" };
    if (endpoint === "/capture")
      return { pageId: 123, format: "png", fullPage: false };
    if (endpoint === "/cookies")
      return { url: "https://example.com" };
    if (endpoint === "/sessions")
      return {};
    if (endpoint === "/recording/start")
      return { tabId: 123 };
    if (endpoint === "/recording/stop")
      return { sessionId: "ui_1234567890_demo" };
    if (endpoint === "/recording/status")
      return {};
    if (endpoint === "/recording/replay")
      return { sessionId: "ui_1234567890_demo", maxDelayMs: 2000 };
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
  body: JSON.stringify(${JSON.stringify(sampleBodyForEndpoint(endpoint), null, 2).replace(/\n/g, `
  `)})
})`;
  }
  function buildBridgeReference() {
    const summary = API_REFERENCE.map((item) => `- ${item.capability}: ${item.method} ${item.endpoint}
  用途：${item.purpose}
  依赖：${item.dependency}`).join(`
`);
    const examples = API_REFERENCE.map((item) => `## ${item.capability} (${item.method} ${item.endpoint})
${fetchSnippet(item.method, item.endpoint)}`).join(`

`);
    return `TabWorks Bridge 本地 bridge 接口参考

本地服务地址:
- http://127.0.0.1:9527

重要说明:
- CLI 不是使用前提；浏览器扩展无法判断系统里是否安装了 CLI。
- 扩展只能检测 localhost:9527 的 bridge/log 服务是否在线。
- 除 GET /status 外，接口需要本地服务在线、扩展已连接，并携带请求头 X-TabWorks-Bridge: 1。
- 扩展 popup 录制默认保存在浏览器 storage；用户点击下载脚本时才导出 tabworks-页面标题-ui-recording-时间.mjs。
- HTTP /recording/* 接口保留给调试和兼容使用。
- 导出的流程脚本可以使用 await page.sleep(ms) 表达点击后的加载、动画或接口等待。

接口总览:
${summary}

fetch 示例:
${examples}
`;
  }
  function buildApiRowCopy(btn) {
    const row = btn.closest(".api-row");
    if (!row || row.classList.contains("header"))
      return null;
    const code = row.querySelector(".cap-code")?.textContent?.trim() || "";
    const capability = row.querySelector(".cap-title strong")?.textContent?.trim() || "";
    const method = row.querySelector(".method")?.textContent?.trim() || "";
    const endpoint = row.querySelector(".endpoint")?.textContent?.trim() || "";
    const purpose = row.querySelector(".muted")?.textContent?.trim().replace(/\s+/g, " ") || "";
    const dependency = row.querySelector(".tag")?.textContent?.trim() || "";
    if (!method || !endpoint)
      return null;
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
  copyReferenceBtn.addEventListener("click", () => copyWithFeedback(copyReferenceBtn, buildBridgeReference()));
  async function checkStatus() {
    try {
      const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(1500) });
      const data = await res.json().catch(() => ({ ok: res.ok }));
      if (res.ok && data?.ok === true) {
        statusDot.className = "dot online";
        statusDotInline.className = "dot online";
        statusTitle.textContent = "本地服务在线";
        statusDetail.innerHTML = "日志面板和本地接口可用。回到 popup 可查看扩展握手状态和自动化窗口。";
        openLogsBtn.textContent = "打开日志面板";
        return;
      }
    } catch {}
    statusDot.className = "dot";
    statusDotInline.className = "dot";
    statusTitle.textContent = "本地服务离线";
    statusDetail.innerHTML = "扩展无法判断 CLI 是否安装，只能检测 <code>localhost:9527</code> 的 bridge/log 服务是否在线。";
    openLogsBtn.textContent = "打开日志";
  }
  checkStatus();
  setInterval(checkStatus, 4000);
})();
