# Changelog

## 0.3.5 - 2026-05-16

### Fixed

- Disabled Node's built-in fetch and WebSocket APIs for the installed Web UI server process itself, not only for the Codex app-server child.

## 0.3.4 - 2026-05-16

### Fixed

- Further reduced Node undici startup memory pressure under Codex by also disabling Node's global WebSocket and prepending a lightweight `node` wrapper for Codex-launched Node helpers.

## 0.3.3 - 2026-05-16

### Fixed

- Reduced Codex child startup memory pressure on constrained hosts by disabling Node global fetch in the app-server child environment by default.

## 0.3.2 - 2026-05-16

### Fixed

- Fixed another memory-limited startup path by resolving and spawning the native Codex binary directly instead of the Node-based `codex` launcher.

## 0.3.1 - 2026-05-16

### Fixed

- Fixed installed CLI startup on memory-limited hosts by running the prebuilt server bundle instead of loading `tsx` at runtime.

## 0.3.0 - 2026-05-13

### Added

- Added streaming HTTP file reads for the file viewer to avoid loading full files through JSON-RPC/base64 payloads.
- Added syntax-highlighted previews for common text formats and LaTeX rendering in chat markdown.
- Added a queued prompt tray so queued messages stay editable and separate from the chat history until they are actually sent.

### Changed

- Bounded rendered chat history and restored old-message collapse when returning to the latest messages, reducing browser load on long sessions.
- Improved file viewer and transfer path handling, including language detection and safer streamed downloads/previews.

### Fixed

- Fixed duplicate or stale assistant streaming snapshots reappearing after turns finalize.
- Fixed initial history loading, refresh, and reconnect behavior for restarted servers and newly created Codex sessions whose rollout file is not materialized yet.
- Fixed auth token handling so reconnects do not spuriously expire the active token.
- Fixed queue rendering so queued prompts do not disappear or get appended again when a turn finishes.
- Fixed history scroll cycling after loading older messages and scrolling back to the bottom.
