---
name: lsp
description: Use the codex-lsp plugin for scoped diagnostics, symbol navigation, rename, and explicit formatting. Consult when selecting or calling its MCP tools, especially after lint-only Hook feedback.
---

# Codex LSP tools

| Tool | Use |
| --- | --- |
| `check_diagnostics` | `full` actively checks LSP and lint; `all` reads session-touched results; `delta` reads the current turn; `status` reports runtime state. |
| `lsp_diagnostics` | Actively check files or directories with LSP only. |
| `lsp_navigation` | `definition`, `references`, `symbols`, `prepare_rename`, or `rename`. |
| `lsp_format` | Explicitly format scoped files using a project formatter or LSP. |

- Set `workspace` to the absolute user repository path, never the plugin directory. Prefer narrow `path` or `paths`; relative paths resolve inside that workspace. Navigation uses 1-based `line` and `column` and requires `path`.
- Hooks run independent lint, not LSP. Hook-only files appear pending in `all`/`delta`; use `full` or `lsp_diagnostics` for active checks. Results belong to the current MCP process. Specify `session` when multiple sessions share the workspace; use the ID in Hook feedback.
- Scans check at most 200 files per request, with a 10,000-file inventory and 1 MiB per file. Explicit files bypass exclusions. An incomplete workspace dependency inventory prevents cache reuse even if a smaller scope finishes.
- Follow returned `start`/`offset` continuations with the same tool, mode, scope, and `revision`. Every nonzero continuation requires that revision; if rejected, restart from zero.
- Use `refresh: true` after external configuration or tool-installation changes. It bypasses cached results and rebuilds LSP clients; only `lsp_diagnostics` and `check_diagnostics mode=full` accept it.
- Run rename/format only when requested or already authorized, and keep write calls sequential. Prepare rename when the symbol range is uncertain. On failure or cancellation, inspect reported modified paths before deciding what to do next; never automatically replay writes.

`complete` describes the requested scope and executed channels, not a passing build or test suite. Report LSP and lint states separately; pending, stale, skipped, or failed checks do not establish a clean project. Missing tools require an explicit user-directed setup task, not automatic installation.
