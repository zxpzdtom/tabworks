# TabWorks Bridge Chrome Extension

This extension connects Chrome to the local TabWorks Bridge service at `ws://127.0.0.1:9527/ext`.

It lets local tools run user-requested browser actions through the Chrome Debugger API while reusing the user's signed-in Chrome session.

## Install Locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this `extension/` folder.
5. Start the local service with `tw serve` or `bun cli/main.ts serve`.

## Build

Extension source lives in `src/`:

- `src/*.ts` compiles to the root `*.js` files referenced by `manifest.json`.
- `src/*.css` is processed by Tailwind into the root `popup.css` and `guide.css`.

Before loading the unpacked extension or packaging it for the Chrome Web Store, run:

```bash
bun run extension:build
```

Chrome loads the generated root files; keep them committed with the source files.

## Popup

Click the extension icon to view:

- Bridge connection status.
- Automation window shortcut.
- Log viewer shortcut only when the local bridge/log service is running.
- Foreground and keep-tab settings.
- Extension capability summary.
- A link to the full interface guide.

The popup is intentionally compact. Open "查看支持能力" or "接口说明" from the
popup to view extension capabilities, local HTTP bridge interfaces, examples,
runtime status and permission notes in `guide.html`.

## Local Service

The CLI is optional. If a local service is running at `127.0.0.1:9527`, the
extension can connect to it and the log viewer becomes available.

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
- `tabs`: create, select and close automation tabs.
- `cookies`: read cookies for user-requested authenticated browser workflows.
- `alarms`: keep the MV3 service worker connected.
- `storage`: remember popup settings.
- `<all_urls>`: allow user-requested automation across arbitrary sites.

## Security

- The bridge listens on `127.0.0.1`.
- WebSocket extension connections are restricted to extension origins.
- HTTP mutation routes require `X-TabWorks-Bridge: 1`.
- Automation uses a dedicated Chrome window to avoid interfering with normal browsing.
