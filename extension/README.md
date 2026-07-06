# TabWorks Bridge Chrome Extension

This extension connects Chrome to the local TabWorks Bridge service at `ws://127.0.0.1:9527/ext`.

It lets local tools run user-requested browser actions through the Chrome Debugger API while reusing the user's signed-in Chrome session.

## Install Locally

1. From the repository root, run `bun run extension:build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select `extension/dist/`.
6. Start the local service with `tw serve` or `bun cli/main.ts serve`.

Do not load the source `extension/` folder directly. Chrome should load the generated `extension/dist/` folder.

## Build

Extension source lives in `src/`:

- `src/*.ts` compiles to `dist/*.js`.
- `src/*.css` is processed by Tailwind into `dist/popup.css` and `dist/guide.css`.
- `manifest.json`, `popup.html`, `guide.html`, `icons/`, and `images/` are copied into `dist/`.

Before loading the unpacked extension or packaging it for the Chrome Web Store, run:

```bash
bun run extension:build
```

`extension/dist/` is generated and intentionally ignored by git.

## Popup

Click the extension icon to view:

- Bridge connection status.
- Automation window shortcut.
- Log viewer shortcut when the local bridge/log service is running.
- Foreground and keep-tab settings.
- Recording, replay, and download controls.
- Extension capability summary.
- A link to the full interface guide.

The popup is intentionally compact. Open **查看支持能力** or **接口说明** from the popup to view extension capabilities, local HTTP bridge interfaces, examples, runtime status, and permission notes in `guide.html`.

## Local Service

The CLI is optional. If a local service is running at `127.0.0.1:9527`, the extension can connect to it and the log viewer becomes available.

Optional CLI commands:

```bash
tw serve
tw daemon start
tw daemon status
tw list
tw record https://example.com
```

The service also serves the log viewer at:

```text
http://localhost:9527
```

## Permissions

- `debugger`: execute Chrome DevTools Protocol commands on automation tabs.
- `tabs`: create, select, refresh, and close automation tabs.
- `cookies`: read cookies for user-requested authenticated browser workflows.
- `webNavigation`: track page and iframe navigation lifecycle during recording and replay.
- `scripting`: inject packaged recording and replay helpers.
- `alarms`: keep the MV3 service worker connected.
- `storage`: remember popup settings and recent recording state.
- `<all_urls>`: allow user-requested automation across arbitrary sites.

## Security

- The bridge listens on `127.0.0.1`.
- WebSocket extension connections are restricted to extension origins.
- HTTP mutation routes require `X-TabWorks-Bridge: 1`.
- Automation uses a dedicated Chrome window to avoid interfering with normal browsing.
