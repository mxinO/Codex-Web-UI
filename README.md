<h1>
  <img src="dist/icon.svg" width="32" height="32" alt="Codex Web UI icon" align="center">
  Codex Web UI
</h1>

A lightweight browser interface for Codex CLI using `codex app-server`.

## Requirements

- Node.js 20+
- Codex CLI authenticated on the host
- Bash

## Start

```bash
npm install
npm run build
npm start -- --host 127.0.0.1 --port 3001
```

Open the URL printed by the server. The default URL includes a random access token.

## Install as a command

From a clone:

```bash
npm install
npm run install:global
```

Then start the UI from any workspace:

```bash
cd /path/to/project
codex-web-ui --host 0.0.0.0 --port 3001
```

You can also install directly from GitHub:

```bash
npm install -g https://github.com/mxinO/Codex-Web-UI/archive/refs/heads/main.tar.gz
```

To update an installed command:

```bash
codex-web-ui --update
```

That reruns the global install from the GitHub `main` tarball and exits without starting or restarting a server. To update from another package spec or tarball, use `codex-web-ui --update --source <tarball-url-or-package-spec>`.

The installed command serves the committed UI and server bundles from the package install directory, while new Codex sessions default to the directory where `codex-web-ui` is launched. Runtime state defaults to `${XDG_STATE_HOME:-~/.local/state}/codex-web-ui`; override it with `--state-dir <path>` or `CODEX_WEB_UI_STATE_DIR`.
When changing frontend code, run `npm run build` before committing so the installable bundle stays current.

## Notes

- The server owns one `codex app-server` process.
- Browser disconnects do not stop Codex work while the Node server remains running.
- Runtime state is namespaced by hostname for shared filesystems.
- `!` bash command output is browser-ephemeral and is not persisted by the server.
- Installed Web UI server and Codex child processes inherit `NODE_OPTIONS=--no-experimental-fetch --no-experimental-websocket --no-experimental-eventsource` by default, and the Codex child `PATH` includes a temporary `node` wrapper with the same options, to avoid Node undici WebAssembly allocation failures on memory-limited login nodes. Set `CODEX_WEB_UI_PRESERVE_NODE_WEB_APIS=1` before starting the server if your Codex-launched Node commands require global `fetch`, `WebSocket`, or `EventSource`. The older `CODEX_WEB_UI_PRESERVE_NODE_FETCH=1` opt-out also works. To diagnose a remaining startup crash, start with `CODEX_WEB_UI_TRACE_CODEX_PROCESSES=1`; the server will log Codex descendant process command lines, same-PID identity changes, node-wrapper invocations, and selected non-secret Node environment fields for a few seconds. Use `CODEX_WEB_UI_CODEX_LAUNCH_MODE=path` to force the installed `codex` launcher instead of the native package binary for comparison.
