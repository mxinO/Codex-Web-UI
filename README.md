# Codex Web UI

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
npm install -g git+ssh://git@github.com/mxinO/Codex-Web-UI.git
```

The installed command serves the committed UI bundle from the package install directory, while new Codex sessions default to the directory where `codex-web-ui` is launched. Runtime state defaults to `${XDG_STATE_HOME:-~/.local/state}/codex-web-ui`; override it with `--state-dir <path>` or `CODEX_WEB_UI_STATE_DIR`.
When changing frontend code, run `npm run build` before committing so the installable bundle stays current.

## Notes

- The server owns one `codex app-server` process.
- Browser disconnects do not stop Codex work while the Node server remains running.
- Runtime state is namespaced by hostname for shared filesystems.
- `!` bash command output is browser-ephemeral and is not persisted by the server.
