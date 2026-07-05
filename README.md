# TabWorks Bridge

TabWorks Bridge connects local automation code to the signed-in Chrome session you already use. It is made of four parts:

- `extension/`: Chrome extension for WebSocket connection and Chrome Debugger API operations.
- `bridge/`: local localhost service that exposes browser actions and log APIs.
- `viewer/`: local execution log viewer served by the bridge.
- `cli/`: optional command line helper for routines, recording, exploring and daemon management.

The Chrome extension is distributed separately through the Chrome Web Store. The CLI package contains only the local bridge, viewer assets, and routine tooling; it does not include the browser extension source directory.

## Name

Recommended product name: **TabWorks Bridge**.

Why this name:

- It describes the core capability without naming any company or internal system.
- It works for both extension and CLI.
- It leaves room for future workflow features beyond a single browser routine.

CLI names:

- Full command: `tabworks`
- Short command: `tw`

## Quick Start

```bash
bun install
cd bridge && bun install
cd ../viewer && bun install
cd ..
bun run extension:build
bun cli/main.ts serve
```

Open Chrome, go to `chrome://extensions`, enable developer mode, and load the `extension/` folder.

This unpacked extension step is only for source development. End users should install the published TabWorks Bridge extension from the Chrome Web Store.

Once connected, open the extension popup to view status, common commands, execution options and the log viewer entry.

## Common Commands

```bash
tw serve
tw daemon start
tw daemon status
tw list
tw example read-title
tw record https://example.com
tw explore --url https://example.com --site example --name read-page
```

## Optional CLI Setup

For local development, you can add aliases with:

```bash
bash scripts/setup.sh
```

Or run directly:

```bash
bun cli/main.ts serve
```

When publishing the CLI package, keep `tabworks` and `tw` as the exposed binaries. The CLI package should not include `extension/`; the extension is packaged and published separately.

## Chrome Web Store Notes

The extension is now generic and contains no company-specific naming or internal URLs.

Before submission:

- Build the extension with `bun run extension:build`.
- Build the viewer with `cd viewer && bun run build`.
- Keep `extension/manifest.json` permissions aligned with actual usage.
- Explain why `debugger`, `tabs`, `cookies`, and `<all_urls>` are needed: the extension executes local user-requested browser automation in the signed-in session.
- Package only the `extension/` directory for Chrome Web Store.
- Do not include local logs, `.bridge/`, source maps, or development-only files in the store zip.

## Architecture

```text
Local tool or CLI
  -> http://127.0.0.1:9527
  -> bridge/scripts/browser-bridge.mjs
  -> ws://127.0.0.1:9527/ext
  -> Chrome extension service worker
  -> chrome.debugger API
  -> signed-in Chrome tabs
```

The bridge listens only on `127.0.0.1`. HTTP mutation routes require the `X-TabWorks-Bridge: 1` header.

## Logs

Execution logs are written to `logs/YYYY-MM-DD.jsonl` and shown in the viewer at:

```text
http://localhost:9527
```

The extension popup also links to this viewer when the local service is online.
