# codex-lsp

[![ci](https://github.com/zoisythe/codex-lsp-standalone/actions/workflows/ci.yml/badge.svg)](https://github.com/zoisythe/codex-lsp-standalone/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Standalone Codex plugin with four static MCP tools and short, independent lint Hooks. Installed copies run the self-contained `dist/cli.js`; only development uses the [`lsp-tools-mcp`](https://github.com/zoisythe/lsp-tools-mcp) submodule. Requires Node.js `>=24.20.0`.

## Execution and tools

```text
Codex --stdio--> MCP process --> workspace Engine --> LspManager / lint
Codex --Hook---> short Hook process ----------------> independent lint
                          shared session metadata only
```

Each MCP process owns its LSP clients and results. Initialization is lazy; after two idle minutes the workspace releases LSP clients while keeping stdio open. The next active request recreates clients. Hooks never start LSP or send commands to another process. Automatic checks never install tools, format, or lint-fix. A short `lsp` Skill explains tool selection and calling conventions; invoke `$lsp` when needed.

| Tool | Behavior |
| --- | --- |
| `check_diagnostics` | `delta`: current turn; `all`: session touched files; `full`: active scoped LSP/lint; `status`: runtime |
| `lsp_diagnostics` | Active LSP-only checks of files or directories |
| `lsp_navigation` | definition / references / symbols / prepare_rename / rename |
| `lsp_format` | Explicit scoped project formatter or LSP formatting |

Every tool requires an absolute `workspace`. Navigation positions are 1-based. Rename and format write files sequentially, report partial writes on failure, and invalidate affected results; they are never automatically retried or rolled back.

`all` is not a repository scan. It reads this MCP process's results against the shared session touched boundary. Files checked only by Hooks show **pending**, requiring active diagnostics. Supply `session` when more than one session uses the workspace; a single session is selected automatically.

## Scopes and continuation

Scans allow at most 10,000 inventoried files, 200 checked files per request, and 1 MiB per file. Directory budgets apply to the requested scope after ignore/exclude filtering. Explicit files bypass filtering but must remain inside the workspace and satisfy the size limit.

A small directory can be actively checked even when the workspace dependency inventory is incomplete; results then say that whole-workspace dependency freshness is unverified and cannot be reused as fresh cached diagnostics. An over-budget root scan is always partial.

The first page returns `revision=<hash>`. Pass that value with every nonzero `start` or `offset`, using the same tool, mode and scope. File additions, removals, content/config changes or changed cached results invalidate continuation; restart from zero. `all`/`delta` output pagination uses the same rule.

`complete` means the declared scope and executed channels completed. It does **not** mean the project passed all type checks, builds, or tests. Combined checks display LSP and lint channel states separately.

## Hooks

| Event | Behavior | Budget / host timeout |
| --- | --- | --- |
| SessionStart / PreToolUse | Establish a missing baseline, preserve an existing one | 5 s / 10 s |
| PostToolUse | Register mutations, lint changes then pending files | 5 s / 10 s |
| Stop | Recheck touched/pending content; fresh lint errors may block once | 45 s / 50 s |
| SessionEnd | Clear session boundaries using a versioned tombstone | 2 s / 3 s |

The budget includes root discovery, state reads, Git/traversal and lint, with time reserved for cleanup/output. Incomplete discovery retains the baseline; unfinished checks stay pending for a later Hook. Feedback is deduplicated by content, effective configuration and finding fingerprints. Hooks identify lint separately and say **LSP not executed**; use `check_diagnostics mode=full` when needed. Warnings, missing tools, pending checks and unexecuted LSP never block Stop. Missing `session_id` disables automatic checking with a short note.

## Configuration

User settings: `$CODEX_HOME/lsp-client.json` (default `~/.codex/lsp-client.json`). Project settings: `<workspace>/.codex/lsp-client.json`. `LSP_TOOLS_MCP_USER_CONFIG` and `LSP_TOOLS_MCP_PROJECT_CONFIG` override these paths; relative user overrides resolve from the home directory, relative project overrides from the workspace. Trust is always read from that same effective **user** file.

```json
{
  "trustedWorkspaces": ["/absolute/path/to/repo"],
  "lint": { "javascript": "auto", "python": "auto" },
  "exclude": ["generated/**", "**/*.snapshot"],
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"]
    }
  }
}
```

Put `trustedWorkspaces` in the user file; a repository cannot trust itself. Project settings are ignored without user trust, and independent linters require trust. `CODEX_LSP_TRUST_PROJECT=1` is an explicit environment opt-in for controlled automation.

- JavaScript selection: `auto | biome | eslint | off`, covering the existing JS/TS/JSON/CSS extensions supported by the Runner. Python: `auto | ruff | off` for `.py`.
- `auto` prefers Biome over ESLint when matching configuration exists; Python uses Ruff. Explicit selection tries only that tool and requires matching project configuration. Missing tools/config are reported without fallback. `off` disables lint, not explicit formatting.
- `lint` merges by field: project > user > default. A project `exclude` replaces the entire user array. Exclusions use Node's built-in glob matching on workspace-relative forward-slash paths; no negation rules.
- Effective plugin configuration, LSP/Runner identity and direct tool configuration content participate in cache validation. Workspace content changes conservatively invalidate results. Configuration changes recreate clients as necessary.

After changing external configuration dependencies, virtual environments or tool installations, use `refresh: true` on `lsp_diagnostics` or `check_diagnostics mode=full`. It bypasses results and rebuilds LSP clients in that workspace. Other modes reject `refresh`. No dependency graph or persistent diagnostic cache is maintained.

Language servers and project linters are prerequisites, not bundled or automatically installed. TypeScript language servers need a TypeScript distribution containing `tsserver.js`, separate from this repository's build compiler. Ruff runs with `--no-cache`.

## Install

```bash
codex plugin marketplace add https://github.com/zoisythe/codex-lsp-standalone
codex plugin add codex-lsp@codex-lsp-standalone
```

Start a new Codex session and use `/hooks` to review/trust the exact Hook definitions. Installation does not grant Hook trust; changed definitions need review again. The plugin requires no install-time `npm install` or recursive submodule checkout. MCP uses plugin-relative `cwd: "."` and `node ./dist/cli.js mcp`; the project is supplied separately as `workspace`.

Version 0.4.0 replaces the shared worker architecture. It uses a separate `metadata-v4-<user>` directory and never imports old worker state or connects to old workers; old workers expire under their original idle policy.

## Windows

Windows shell calls still match the Codex Hook name `Bash`; the actual executor can be PowerShell. Native Windows Codex 0.153.4 with PowerShell 7.6.5 was verified, including Hook feedback after a command exits with code 1. Use Windows absolute paths for `workspace` when running Windows Codex from WSL.

Node must be available in the process that launches Codex. With fnm, initialize its PowerShell environment and select the installed Node version in that same session. No global profile change is required. See [Windows results and resolved issues](docs/windows-validation.md), including the fixed TypeScript URI mismatch and the initial unreproduced test timeout.

## Development and validation

```bash
npm install
npm run check
npm test
npm run typecheck
```

The bootstrap script builds submodule types/JS for development; the committed bundle is sufficient for installed use. CI defines Linux/macOS/Windows source and dependency-free bundle jobs. Actual results and Linux Codex acceptance are recorded in [validation.md](docs/validation.md), distinct from historical 0.3.0 evidence.

## Privacy

Execution is local. Session metadata under `CODEX_LSP_CACHE` (default: a user-specific temporary directory) contains content hashes and delivery boundaries, never findings, commands or permission credentials. A short per-session mutex protects atomic updates; contention degrades with a bounded note. Dead-writer locks are recovered using immutable lock-identity tombstones, preserving mutual exclusion across concurrent recovery. Analysis never holds that mutex.

Fixed-category startup, abnormal-exit, timeout and cleanup errors use local `logs-v4` files, at most 1 MiB per instance plus one rotated file. Logs contain no source, environment values, configuration body or raw error text. Normal stdout is reserved for MCP/Hook protocol output. The plugin sends no telemetry.
