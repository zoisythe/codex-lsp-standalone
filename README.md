# codex-lsp

[![ci](https://github.com/zoisythe/codex-lsp-standalone/actions/workflows/ci.yml/badge.svg)](https://github.com/zoisythe/codex-lsp-standalone/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Standalone Codex plugin that bundles an LSP worker for post-edit diagnostics plus four static MCP tools. Development still uses the [`lsp-tools-mcp`](https://github.com/zoisythe/lsp-tools-mcp) submodule; installed copies run only the committed `dist/cli.js` bundle.

## Architecture

```text
Codex --stdio--> dist/cli.js mcp -------+
                                      +--> workspace worker --> LspManager / lint runners
Codex --Hook--> dist/cli.js hook -------+                      --> shared result cache
```

- MCP initialize does not start language servers.
- Hooks are short-lived clients; the worker is shared per normalized workspace.
- Everyday hooks never format or lint-fix. `lsp_format` and rename are explicit writes.
- No Skills are installed.

## MCP tools

| Tool | Role |
| --- | --- |
| `check_diagnostics` | Unified LSP/lint state: `delta`, `all`, `full`, `status` |
| `lsp_diagnostics` | Active pure-LSP diagnostics for paths/directories |
| `lsp_navigation` | definition / references / symbols / prepare_rename / rename |
| `lsp_format` | Explicit formatter or LSP formatting for scoped paths |

All tools require an absolute `workspace` path. Positions for navigation are 1-based. `all` only reads this session's touched files; it is not a repository scan. `full` and directory checks use a bounded inventory (10,000 files, 1 MiB per file), with up to 200 checks per request. Follow `start`/`offset` continuations on an unchanged tree; narrow the scope if inventory is incomplete. Explicit files bypass ignore filtering, but must resolve inside the workspace and are content-validated before cache reuse.

Navigation is conservatively marked as a write-capable tool because it includes rename. Codex may ask for approval even for definition/prepare-rename. Non-interactive `codex exec` with approval policy `never` will reject these calls unless the user has explicitly approved the plugin tool policy.

## Hooks

| Event | Behavior |
| --- | --- |
| `SessionStart` | Record the current file fingerprint baseline |
| `PostToolUse` | Recheck files whose content changed since the baseline, including shell mutations |
| `PreToolUse` | Recover a missing initial baseline without replacing an existing one |
| `Stop` | Bounded retry of pending/stale touched files; fresh errors can block once |
| `SessionEnd` | Drop session delivery state |

Hook output is compact additional context after edits, or a single Stop reason. Missing tools/timeouts degrade to short notes; incomplete results are never reported as clean.

## Configuration

Project LSP config (requires user trust for executable project settings):

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
  },
  "trustedWorkspaces": ["/absolute/path/to/repo"]
}
```

Put `trustedWorkspaces` in the **user** config, not repository config; a repository cannot trust itself. Independent lint runners (Biome, ESLint, Ruff) run only for trusted workspaces and only when the matching project config is present. Biome takes precedence over ESLint for JS/TS when both configs exist; Python uses Ruff. They check; they do not fix or install packages. Ruff runs with `--no-cache` so it does not introduce files into Hook tracking.

Language servers themselves are not bundled. Install the servers your projects need on `PATH`.

## Codex plugin layout

- `.codex-plugin/plugin.json` — plugin discovery
- `.agents/plugins/marketplace.json` — local/GitHub marketplace entry
- `.mcp.json` — `node ./dist/cli.js mcp`, with plugin-relative `cwd: "."`
- `hooks/hooks.json` — SessionStart / PreToolUse / PostToolUse / Stop / SessionEnd
- `dist/cli.js` — self-contained runtime bundle

Codex CLI 0.153.4 resolves the MCP `cwd` relative to the installed plugin root; the user's project is supplied separately as `workspace`. Hook commands use `${PLUGIN_ROOT}`. This was tested with separate plugin/workspace paths containing spaces and Chinese characters, without submodule contents or runtime `node_modules` in the plugin.

## Install from GitHub marketplace

```bash
codex plugin marketplace add https://github.com/zoisythe/codex-lsp-standalone
codex plugin add codex-lsp@codex-lsp-standalone
```

Adding a marketplace does not install its plugin. Start a new Codex session after installation and use `/hooks` to review/trust the exact Hook definitions. New or changed definitions require review again; installing does not grant Hook trust. The commands above follow `codex-cli 0.153.4` help (`plugin add`, not `plugin install`).

The plugin itself requires no `npm install`, recursive submodule checkout, or runtime JS download. Node, language servers and project linters are prerequisites, not part of that promise. In particular, `typescript-language-server` requires a TypeScript distribution containing `tsserver.js`; the acceptance project uses TypeScript 5.9.3, separate from this repository's TypeScript 7 build compiler.

See [validation evidence and remaining limitations](docs/validation.md).

## Local development

```bash
git submodule update --init packages/lsp-tools-mcp
npm install
npm run bootstrap   # rebuild submodule types/JS used by the source tree
npm test
npm run typecheck
npm run check       # typecheck + biome + rebuild dist bundle
```

Node.js `>=24.20.0` is required.

## Privacy

The plugin runs locally. It does not phone home. Diagnostics stay on the machine that runs Codex and the worker process.
