# Windows 原生验收与问题修复（2026-09-09）

使用用户指定的 `C:\Users\Zoisythe\scoop\shims\codex.exe`，从 WSL 启动 Windows 原生程序。本文记录本机实测，不代表远端 CI 或 macOS 验收通过。

## 环境和范围

- WSL2：`6.18.33.2-microsoft-standard-WSL2`。
- Windows：`10.0.26340.0`；Codex CLI：`0.153.4`；实际命令执行器：PowerShell `7.6.5` 的 `pwsh.exe`。
- Windows Node：fnm 已安装的 `24.20.0`。只在测试 PowerShell 进程中初始化 fnm，没有修改用户 profile 或默认版本。
- Windows 独立项目包含空格，位于用户临时目录；独立 Codex home 与本地 marketplace，插件安装目录没有 node_modules/submodule。项目单独安装 TypeScript 5.9.3、typescript-language-server、Biome 2.5.12。
- 源码版本保持 `0.4.0`；最终隔离安装版本为 `0.4.0+codex.20260909042107`，后缀只用于测试副本刷新。
- 最终 bundle SHA-256：`08daa4477c9bc1564fdc7dd8afc2439941972b52d33b930ac7d30c295c071433`，Windows 安装副本逐字节一致，Skill 也一致。
- 原用户 Codex 配置、系统代理、原始登录凭据未修改。隔离 home 的凭据副本测试后删除。没有提交、推送或发布。

## 问题与处理

| 问题/观察 | 结论和处理 |
| --- | --- |
| Windows TypeScript 主动诊断连续 pending，漏报类型错误 | **已修复**：诊断缓存键没有统一等价文件 URI，详见下节。 |
| 首轮子进程测试有一项超过 60 秒预算，整个进程约 159 秒才结束 | 首次触发原因未复现，不宣称已解决。分步追踪与后续原样完整复测通过。另修正测试等待逻辑：使用实际时间截止点，并响应测试取消，避免按计时器次数继续等待。 |
| 无 profile 的 PowerShell 找不到 Node | 测试环境前置条件。用现有 fnm 在当前进程启用 24.20.0，无需更改插件。 |
| all 返回 checked=0 | 第一轮测试指定了与 Hook 不同的 session，是测试输入问题。随后使用 Hook 的 session ID，主动检查前正确显示 pending。 |
| Codex turn.started 后等待较久 | 未传代理变量的会话后来同样正常完成，不能归因于插件或断言必须设置代理。原生 curl 直连超时、显式使用系统已启用的本地代理可连接，只是独立的网络探测结果。后续测试进程使用该现有代理，插件没有新增代理逻辑。 |

### 已修复：Windows URI 不一致

真实协议追踪确认：

```text
客户端 didOpen:       file:///C:/Users/.../project%20with%20spaces/main.ts
服务端 publish:      file:///c%3A/Users/.../project%20with%20spaces/main.ts
服务端诊断 codes:    [2322, 6133]
旧插件返回:          pending: No fresh diagnostics published yet
```

服务端已经返回诊断，旧客户端却按未经规范化的 URI 字符串查找，因盘符大小写与冒号编码不同而漏掉结果。

`src/language.ts` 现在通过文件路径统一 URL 转义，并仅在 Windows 统一盘符大小写。其余路径的大小写保持不变，发送给服务器的原始 URI 也不改变。诊断写入、读取和失效使用同一个缓存键。

Windows 端到端夹具现在也返回小写盘符与 `%3A` 编码，覆盖真实服务器行为，避免只测试原样回显 URI 的服务器。

## 真实 Codex 结果

在原生 Codex 中信任插件 Hook；另加仅用于验收的 `^Bash$` Hook，记录事件、工具名和平台，不保存命令正文或源码。

- 实际执行器为 `C:\Program Files\PowerShell\7\pwsh.exe`；匹配 `^Bash$` 的探针收到 `tool_name: "Bash"`、`platform: "win32"`。无需将插件 matcher 改成 PowerShell/CMD。
- PowerShell `Set-Content` 写入类型错误和未使用变量，随后 `exit 1`。PostToolUse 仍触发，Biome 报告 warning，并明确 LSP 未执行。
- 使用 Hook session 查询 all，主动检查前返回 `partial; checked=0 pending=1`。
- 修复前，两次 lsp_diagnostics 均 pending；full 中 lint complete、LSP pending。
- 修复后重新安装并用 Windows Codex 复测，两次 lsp_diagnostics 都返回 `complete; checked=1 pending=0` 和 TypeScript 2322，revision 相同。
- 修复后的 full 同时返回 TypeScript 类型错误和 Biome warning，LSP/lint 均 complete。这里 complete 指检查完成，测试项目仍故意保留错误。

本次真实 Codex 会话使用 PowerShell；没有单独验证 CMD/Git Bash 作为命令子进程，也没有做 Windows 两分钟真实闲置测试。Windows rename/format、取消、分页及退出清理由下述原生子进程端到端测试覆盖。

## 验证结果

- Windows 原生 Node 执行最终 bundle：5 个子进程测试全部通过，约 16.4 秒。包括进程隔离/复用、分页、取消、部分写入、慢 Hook、pending、Stop 去重、元数据并发及死锁持有进程退出后的恢复。
- Linux/WSL：`npm run check`、`npm test`、`npm run typecheck` 通过；32 个 Vitest 测试和 5 个子进程测试通过。
- 修复前后用真实 TypeScript 服务端直接调用 Windows MCP，结果从两次 pending 变为两次稳定报告 2322。
- 最后使用用户指定的 Windows Codex CLI 验证安装后 Hook 与主动诊断，不以直接 MCP 探针代替此项。
- 远端 CI 尚未运行；macOS 尚无本轮实测结果。

验收输出、协议元数据和安装校验保存在忽略目录 `.canon/windows-acceptance/`；不会随插件发布。最初那次未复现的超时仍保留为观察事项。
