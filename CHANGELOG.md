# Changelog

## Unreleased

### Added

- Added persistent automatic resume for temporary model-capacity failures, with bounded backoff, Stop support, restart recovery, and a visible waiting state.

### Fixed

- Prevented repeated turn-start and experimental raw completion events from dropping goal activity cards or clearing the live Running state.
- Allowed dependency install scripts during `codex-web-ui --update`, ensuring native dependencies such as `better-sqlite3` are installed correctly.
- Added browser WebSocket heartbeats and stale-connection recovery so live progress resumes automatically after silent network or SSH tunnel failures.

## 0.3.9 - 2026-06-30

### Fixed

- Fixed `codex-web-ui --update` getting permanently stuck on npm `EISDIR`/`ENOTEMPTY` rename failures left by stale global-package retirement directories.

## 0.3.8 - 2026-05-16

### Added

- Added streaming HTTP file reads for the file viewer to avoid loading full files through JSON-RPC/base64 payloads.
- Added syntax-highlighted previews for common text formats and LaTeX rendering in chat markdown.
- Added a queued prompt tray so queued messages stay editable and separate from the chat history until they are actually sent.

### Changed

- Bounded rendered chat history and restored old-message collapse when returning to the latest messages, reducing browser load on long sessions.
- Improved file viewer and transfer path handling, including language detection and safer streamed downloads/previews.
- Improved low-memory startup behavior by running the prebuilt server bundle, spawning the native Codex binary directly when available, and reducing Node web API memory pressure for Codex-launched helpers.
- Improved opt-in Codex startup diagnostics with descendant process tracing, node-wrapper tracing, and `CODEX_WEB_UI_CODEX_LAUNCH_MODE=path` for launcher comparison.

### Fixed

- Fixed installed CLI startup on memory-limited hosts.
- Fixed duplicate or stale assistant streaming snapshots reappearing after turns finalize.
- Fixed initial history loading, refresh, and reconnect behavior for restarted servers and newly created Codex sessions whose rollout file is not materialized yet.
- Fixed auth token handling so reconnects do not spuriously expire the active token.
- Fixed queue rendering so queued prompts do not disappear or get appended again when a turn finishes.
- Fixed history scroll cycling after loading older messages and scrolling back to the bottom.
- Fixed Web UI startup on memory-limited Node 22 hosts where Node's internal undici WebAssembly allocation can reject during Codex app-server startup before the browser server begins listening.
