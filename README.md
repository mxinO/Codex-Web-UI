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

## Notes

- The server owns one `codex app-server` process.
- Browser disconnects do not stop Codex work while the Node server remains running.
- Runtime state is namespaced by hostname for shared filesystems.
- `!` bash command output is browser-ephemeral and is not persisted by the server.
