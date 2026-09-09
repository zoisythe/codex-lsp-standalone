# 0.4.0 本地验收（2026-09-08）

本轮为隔离执行架构及后续追加的工具说明 Skill。0.3.0 的共享 worker 验收已移至 [历史记录](history/validation-0.3.0.md)，不能用作本版本通过证据。没有提交、推送或发布。

2026-09-09 已补充 [Windows 原生验收与修复](windows-validation.md)：修复诊断 URI 不一致，Windows 五项子进程测试及真实 Codex Hook/诊断通过。下列 2026-09-08 安装哈希为该批次历史值；当前 bundle 哈希以 Windows 验收记录为准。

## 最终交付与检查

- Linux，Node.js 24.20.0，codex-cli 0.153.4。
- 开发 submodule：`9cc6f753d04834c148d08bbca72e3b483d6301b2`，未修改。
- 发布版本保持 `0.4.0`；隔离安装使用仅存在于测试副本中的 `0.4.0+codex.20260908155418` 缓存后缀。
- 2026-09-08 验收 bundle SHA-256：`79d48fddf9b88bfbed90cd818095389f929855afe684c0d590c67c5530c5a36e`。
- 安装副本的 bundle 与 `skills/lsp/SKILL.md` 均逐字节匹配源码交付物；安装插件目录中没有 node_modules 或 submodule/packages。
- `npm run check`、`npm test`、`npm run typecheck` 全部通过。共 32 个 Vitest 测试、5 个 Node 子进程测试；最后一次完整测试包含元数据持锁进程崩溃恢复。
- Skill 通过 skill-creator 的 `quick_validate.py`；manifest 和 npm files 清单均包含 skills，干净安装测试实际复制并读取该文件。
- `git diff --check` 通过。

## 已验证的运行行为

子进程测试执行交付 bundle，不引用开发 submodule：

- 初始化不启动 LSP；同一 MCP 进程复用客户端，第二个 MCP 进程独立启动；Hook 不启动 LSP，Hook-only touched 文件在 MCP 中显示 pending。
- 排队取消不终止正在执行的请求；执行中取消清理 LSP。慢 Runner 在 Hook 预算内被终止，pending 可在下一次 Hook 补查。
- 格式化和 rename 部分写入后取消：已写文件被准确报告，后续文件不再写入；请求不自动重放，随后主动诊断能够恢复。EOF 后分析进程退出。
- Hook 的 warning 不阻止 Stop；同一新鲜 error 只阻止一次；并发 Hook 不丢 touched，元数据不保存完整 findings。
- 对元数据原子替换前注入进程强制退出，随后两个 Hook 并发恢复：死进程锁被安全移走，状态保留，pending 完成。不可变锁标识墓碑防止旧恢复请求移走新写入者的锁。
- 超过 200 文件时声明范围显示 partial，并能带 revision 继续；配置、内容、增删文件使旧 revision 失效。错误模式使用 refresh 会报参数错误。

补充行为覆盖：用户配置覆盖路径与信任一致、项目不能自授信任、lint 字段合并与 exclude 整体覆盖、Runner auto/显式/off/缺失、不回退、显式文件绕过 exclude、被排除的直接工具配置仍使缓存失效、refresh 绕过结果，以及超过 10,000 文件的仓库中仍可主动检查小目录。依赖清单不完整时不复用旧结果。

## Linux 真实 Codex

在独立 Codex home 和独立测试项目中，通过本地 marketplace 实际安装；项目工具为 TypeScript 5.9.3、typescript-language-server 和 Biome 2.5.12。登录凭据仅复制到隔离测试 home，原用户配置未修改，原始会话及凭据不提交。

真实交互流程：

1. Codex 显示五个 Hook 需要审阅，完成持久信任；未使用 Hook 信任绕过参数。
2. apply_patch 引入 TypeScript 类型错误及未使用变量。自动 Hook 报告 Biome `noUnusedVariables` warning，并明确 `LSP not executed`。
3. 主动 LSP 前调用 all，得到 `checked=0 pending=1`。连续两次 lsp_diagnostics 报告 TypeScript 2322，未混入独立 lint 结果。
4. prepare_rename 成功；rename 同时更新声明和引用。修复后 full 返回 LSP/lint 两个通道 complete、零诊断。
5. 保持 130.000 秒实际闲置后再次调用诊断成功。11:01:16 UTC 的 full 与 11:03:40 UTC 的后续 LSP 调用间没有 MCP 调用；旧 LSP PID 6143 已退出，新 PID 7416 启动。未使用加速时钟。
6. 另将 main.ts 压成未格式化单行，实际 lsp_format 返回 `Formatted: main.ts` 并展开布局；随后 full 为 `complete; checked=1 pending=0 skipped=0 failed=0`，LSP 与 lint 均 complete。

元数据锁恢复和 Skill 是上述完整交互之后的追加修改，已由最终源码的完整测试覆盖；最终安装还单独验证 Skill 读取和主动诊断，结果见下文。

## 最终 Skill 调用验证

使用最终安装副本启动新的 Codex exec 会话，显式请求 `$lsp`：Codex 实际读取安装目录中的 `skills/lsp/SKILL.md`，选择 `check_diagnostics mode=full`，使用指定的项目、main.ts 和 session=skill-validation。MCP 返回：

```text
complete; checked=1 pending=0 skipped=0 failed=0
main.ts channels: lsp=complete lint=complete
```

此调用没有修改文件。它验证了最终 bundle 的主动诊断，以及 Skill 的发现、读取和工具选择。

## CI 与范围边界

`.github/workflows/ci.yml` 保留 Linux/macOS/Windows 源码检查，并让无 submodule、无 node_modules 的 delivery job 执行安装及 runtime 端到端子进程测试。**本轮没有远端 CI 结果**：尚未提交或推送，不能把本地 Linux 通过或 workflow 文件视为三平台通过。

没有实现持久诊断缓存、后台调度、通用 Runner 框架、多根依赖图或指标系统。外部配置依赖、虚拟环境和工具安装变化不承诺自动发现，使用 refresh 主动刷新。多文件写入不承诺事务回滚。complete 只指本次声明范围及执行通道完成，不代表项目构建或测试全部通过。
