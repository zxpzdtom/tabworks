# TabWorks Bridge Privacy Notice

TabWorks Bridge is a Chrome automation extension for Chinese-speaking users. Its single purpose is to connect the user's local TabWorks service to the current Chrome session through Chrome DevTools Protocol (CDP), so the user can record, replay, clear, and download browser automation steps they explicitly initiate.

## Data handled by the extension

When the user starts recording, replay, or a local automation request, the extension may process:

- The current tab URL, page title, window state, and iframe navigation state.
- User activity on the page, including clicks, keyboard input, scrolling, dragging, and mouse positions.
- Website content fragments needed to locate elements and replay actions, such as element text, selectors, coordinates, and form values.
- Cookies for a specific URL or domain only when the user explicitly calls the local automation endpoint, so locally generated scripts can run in the user's current signed-in session.

## Storage and transfer

- Recorded steps and extension settings are stored locally in Chrome extension storage by default.
- When the user clicks "Download script", the recorded content is exported as a local script file.
- The extension does not sync recorded content, cookies, or website data to any third-party server.
- The extension communicates only with the user's locally running TabWorks service to perform automation tasks explicitly initiated by the user.

## Permission usage

- `debugger`: attaches to the user-selected tab through CDP, dispatches mouse and keyboard events, and supports user-initiated recording and replay.
- `tabs`: lists, creates, switches, refreshes, or closes tabs used by the user's automation workflow.
- `cookies`: reads cookies for a specific URL or domain only when requested through the local automation endpoint.
- `storage`: stores extension settings and the latest recording result locally.
- `webNavigation`: tracks page and iframe navigation lifecycle events so recording and replay can resume in the correct context.
- `scripting` and host permissions: inject packaged recording and replay helpers into pages and frames selected by the user.
- `alarms`: keeps the extension service worker responsive and checks local bridge, recording, and replay status.

## Data sharing

TabWorks Bridge does not sell user data, transfer user data to third parties, or use user data for purposes unrelated to the extension's single purpose.

## Contact

If you have questions about this privacy notice or the extension behavior, please open an issue on the GitHub project page.

# TabWorks Bridge 隐私说明（中文）

TabWorks Bridge 是一个面向中文用户的 Chrome 自动化扩展。它的单一用途是通过 Chrome DevTools Protocol（CDP）连接用户本机的 TabWorks 服务，在用户主动操作下录制、回放并下载浏览器自动化脚本。

## 数据处理范围

扩展可能在用户主动录制、回放或调用本地自动化接口时处理以下数据：

- 当前标签页 URL、标题、窗口和 iframe 导航状态。
- 用户在页面中的点击、输入、滚动、拖拽、鼠标位置等操作步骤。
- 用于定位元素和回放操作的页面内容片段，例如元素文本、选择器、坐标和表单值。
- 用户明确请求时，按 URL 或域名读取的 Cookie，用于让本地自动化脚本在当前登录会话下运行。

## 数据存储与传输

- 录制步骤和扩展设置默认保存在浏览器本地扩展存储中。
- 用户点击“下载脚本”时，录制内容会导出为本地脚本文件。
- 扩展不会把录制内容、Cookie 或页面数据同步到第三方服务器。
- 扩展只会与用户本机启动的 TabWorks 服务通信，用于执行用户主动发起的自动化任务。

## 权限用途

- `debugger`：通过 CDP 连接用户选择的标签页，派发鼠标和键盘事件，完成录制与回放。
- `tabs`：列出、创建、切换、刷新或关闭自动化相关标签页。
- `cookies`：在用户请求本地接口时按 URL 或域名读取 Cookie。
- `storage`：保存扩展设置和最近一次录制结果。
- `webNavigation`：跟踪页面与 iframe 导航状态，以恢复录制和回放上下文。
- `scripting` 与主机权限：在用户选择的网站页面中注入录制和回放辅助脚本。
- `alarms`：维持扩展后台服务和连接状态检查。

## 数据共享

TabWorks Bridge 不出售用户数据，不把用户数据转移给第三方，也不会把用户数据用于与扩展单一用途无关的目的。

## 联系方式

如果你对隐私说明或扩展行为有疑问，可以通过 GitHub 项目页面提交 issue。
