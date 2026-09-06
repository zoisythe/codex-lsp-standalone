# codex-lsp

[![ci](https://github.com/zoisythe/codex-lsp-standalone/actions/workflows/ci.yml/badge.svg)](https://github.com/zoisythe/codex-lsp-standalone/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Standalone Codex plugin that ports the LSP runtime from [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client). It gives Codex post-edit diagnostics plus explicit MCP tools for language-aware code work.

## Architecture

The LSP runtime lives in [`lsp-tools-mcp`](https://github.com/zoisythe/lsp-tools-mcp) and is consumed here as a git submodule at `packages/lsp-tools-mcp/`.

- `codex-lsp` keeps Codex-specific integration (`hook post-tool-use`, plugin metadata, package wiring).
- `lsp-tools-mcp` owns MCP runtime, LSP manager, and tool implementations.
- `src/cli.ts` routes `mcp` to upstream runtime and keeps `hook post-tool-use` local.

## Behavior

| Case | Result |
| ------ | -------- |
| `apply_patch` succeeds | parses `tool_input.command`, extracts added/updated/moved files, and checks each with LSP error diagnostics |
| `write` / `edit` / `multiedit` succeeds | checks `path`, `filePath`, or `file_path` aliases |
| diagnostics contain errors | returns Codex `PostToolUse` blocking feedback and injects the same diagnostics as additional context so Codex fixes the file |
| no diagnostics | emits no hook output |
| unsupported extension | emits no hook output |
| missing configured language server | surfaces the install/config message through hook or MCP output |

Deletes are ignored because they cannot introduce new diagnostics.

## MCP Tools

- `lsp.status`
- `lsp.diagnostics`
- `lsp.goto_definition`
- `lsp.find_references`
- `lsp.symbols`
- `lsp.prepare_rename`
- `lsp.rename`

`lsp.rename` applies the returned workspace edit to files. Use `lsp.prepare_rename` first when possible.

## Configuration

Project config:

```text
.codex/lsp-client.json
```

User config:

```text
~/.codex/lsp-client.json
```

Example:

```json
{
 "lsp": {
  "typescript": {
   "command": ["typescript-language-server", "--stdio"],
   "extensions": [".ts", ".tsx", ".js", ".jsx"]
  }
 }
}
```

Built-in server definitions are used when no custom config overrides them. `lsp.status` shows which configured servers are installed or missing.

## Codex Plugin

The plugin ships:

- `.codex-plugin/plugin.json` for Codex plugin discovery.
- `.mcp.json` for the `lsp` MCP server.
- `hooks/hooks.json` for the `PostToolUse` diagnostics hook.
- `skills/lsp/SKILL.md` with MCP usage guidance.

The runtime depends on `@code-yeongyu/lsp-tools-mcp` via `file:./packages/lsp-tools-mcp` from the [`zoisythe/lsp-tools-mcp`](https://github.com/zoisythe/lsp-tools-mcp) fork, so marketplace builds must include submodule contents.

The hook command is:

```bash
node "${PLUGIN_ROOT}/dist/cli.js" hook post-tool-use
```

The MCP command is:

```bash
node ./packages/lsp-tools-mcp/dist/cli.js mcp
```

## Local Development

```bash
git submodule update --init --recursive
npm run bootstrap     # installs + builds the lsp-tools-mcp submodule
npm install
npm test
npm run typecheck
npm run check
npm pack --dry-run
```

`.npmrc` sets `ignore-scripts=true` and `legacy-peer-deps=true` so `npm install` skips dependency lifecycle hooks and can coexist with the submodule's Vitest 4 peer tree. The `bootstrap` script installs and builds the `lsp-tools-mcp` git submodule so `@code-yeongyu/lsp-tools-mcp/dist/*.js` is available for the codex-lsp build. Package scripts invoke TypeScript, Vitest, and Biome through `node` so WSL does not pick up a Windows `node.exe` shim.

Smoke-test the hook:

```bash
node dist/cli.js hook post-tool-use < test/fixtures/post-tool-use.json
```

Smoke-test the MCP server:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/cli.js mcp
```

## Local Codex Installation

This repository is a standalone Codex plugin. Add it as a marketplace source, then install `codex-lsp` from that source:

```bash
codex plugin marketplace add https://github.com/zoisythe/codex-lsp-standalone.git
codex plugin marketplace add .
```

The repo marketplace lives at `.agents/plugins/marketplace.json` and points at this plugin root. After installation, enable:

```toml
[plugins."codex-lsp@codex-lsp-standalone"]
enabled = true
```

## Branch Rules and Releases

- `main` is protected by `.github/branch-ruleset.json`.
- CI runs Node 22 and 24 on Ubuntu, macOS, and Windows.
- Releases are GitHub Releases tagged as `v<semver>`.
- Publishing runs from the `publish` workflow after a GitHub Release is published.

## Privacy

This plugin runs locally. It starts configured language-server commands on your machine and does not call a network service by itself.

## License

[MIT](LICENSE).

## Related

- [pi-lsp-client](https://github.com/code-yeongyu/pi-lsp-client) - source extension this Codex plugin ports.
