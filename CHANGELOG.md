# Changelog

## Unreleased

- Restore `.codex-plugin/plugin.json` so this repository is a standalone Codex plugin again.
- Point package, plugin, and marketplace metadata at [`zoisythe/codex-lsp-standalone`](https://github.com/zoisythe/codex-lsp-standalone).
- Disable npm lifecycle scripts during install so native optional packages cannot run install hooks.
- Upgrade Biome to 2.5.12, Vitest to 5.0.0, and `@types/node` to 26.4.1. Require Node.js 22.12+ and enable `legacy-peer-deps` so the submodule's Vitest 4 tree can install beside it.
- Point the `packages/lsp-tools-mcp` submodule at [`zoisythe/lsp-tools-mcp`](https://github.com/zoisythe/lsp-tools-mcp) and pin `main` at `9cc6f75`.
- Install `smol-toml` as an optional dependency so Cargo workspace parsing works after a parent `npm install`.
- Require Node.js 24.20.0 LTS (Krypton).

## 0.2.0

- Extracted the LSP runtime and MCP server into [`@code-yeongyu/lsp-tools-mcp`](https://github.com/code-yeongyu/lsp-tools-mcp).
- codex-lsp now consumes that runtime as a git submodule at `packages/lsp-tools-mcp`.
- Kept the Codex-specific PostToolUse hook in this package and routed MCP serving through the upstream CLI.

- Extract LSP runtime to `lsp-tools-mcp` upstream and consume it via git submodule at `packages/lsp-tools-mcp`.
- Renamed the MCP server namespace to `lsp` and exposed shorter tool names such as `lsp.diagnostics`.
- Use portable Codex hook interpolation and add package smoke coverage for hook/MCP entrypoints.
- Spawn language servers without shell mode; Windows `.cmd` and `.bat` shims are routed through `cmd.exe` with explicit arguments.
- Cap directory diagnostics file traversal and run CI on Windows in addition to Ubuntu and macOS.
- Replace the external JSON-RPC runtime dependency with an internal LSP framing layer so clean Codex plugin installs run without `node_modules`.

## 0.1.0

- Ported the standalone LSP client, server resolution, diagnostics aggregation, and workspace edit runtime from `pi-lsp-client`.
- Added Codex `PostToolUse` diagnostics for edit-style tools.
- Added MCP tools for status, diagnostics, definitions, references, symbols, prepare rename, and rename.
- Added Codex plugin metadata, skill docs, CI, and release automation.
