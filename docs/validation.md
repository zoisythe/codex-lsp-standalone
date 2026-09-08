# 本地交付验收（2026-09-08）

本记录验证当前阶段实现，不代表 implementation-plan.md 的所有验收项已完成。

## 环境与交付

- Linux；Node.js 24.20.0；codex-cli 0.153.4；Codex 模型 `gpt-6-astra`。
- 开发 submodule 固定于 `9cc6f753d04834c148d08bbca72e3b483d6301b2`。
- 最终 bundle SHA-256：`8947693d28b1c5dcc1a2e81b27daa53398ac1255bb653b7344309cc50706c438`；再次构建哈希不变。
- 临时 `CODEX_HOME`，从仅含 dist、manifest、Hooks、marketplace 和元数据的本地交付目录安装；插件中没有 node_modules、submodule 或 Skills。插件路径与工作区路径独立，包含空格及中文。
- 使用 `codex plugin marketplace add <交付目录> --json`、`codex plugin add codex-lsp@codex-lsp-standalone --json` 实际安装，不是 npm pack dry-run。
- `.mcp.json` 的相对 `cwd: "."` 由 Codex 解析到插件根目录；`node ./dist/cli.js mcp` 握手成功。工作区由工具参数传入。
- 只在隔离 home 中使用已有登录凭据副本；不修改用户原有 Codex 配置。测试原始日志及凭据不提交。

## 完整检查

最终源码执行：

```bash
npm run check
npm test
npm run typecheck
```

全部通过：4 个 Vitest 文件、15 个测试；3 个 Node 子进程集成测试。`npm test` 现在也包含原有 worker 集成测试，覆盖 Hook/MCP 复用同一个 LSP、显式写入和复查。另由 TypeScript LSP 确认源码无类型错误。

CI 新增无 submodule、无 npm install 的独立 delivery job（Ubuntu/macOS/Windows），源码 job 重建后用 `git diff --exit-code -- dist` 检查漂移。本地没有代替远端 CI 声称 macOS/Windows 已通过。

## Hook 信任与写工具授权

1. 不绕过信任时，真实 Codex MCP `status` 成功，`sessions=none`。
2. 本地 Codex app-server `hooks/list` 返回 5 个插件 command Hook：PreToolUse、PostToolUse、SessionStart、SessionEnd、Stop；全部 `enabled=true`、`trustStatus=untrusted`，无发现错误。
3. 阅读并审核当前命令后，后续一次性自动化使用 `--dangerously-bypass-hook-trust`。这验证已审核 Hook 的执行，不冒充交互式 `/hooks` 持久信任验收。
4. 非交互 Codex 的 `never` 策略初次拒绝导航/格式化。仅在临时 home 预授权本次测试：

```toml
[plugins."codex-lsp@codex-lsp-standalone".mcp_servers.lsp]
default_tools_approval_mode = "approve"
```

正式安装仍应由用户审核 Hook 和写工具；插件不自动添加此授权。

## 最终 Codex 实测 A：TypeScript + Python

测试项目单独安装兼容的 TypeScript 5.9.3、typescript-language-server、Pyright 和 Biome 2.5.12，使用本机 Ruff；语言服务器不属于插件交付物。TypeScript 7.0.2 不含 tsserver.js，不能作为本次 typescript-language-server 的项目运行依赖。

实际 `codex exec --sandbox workspace-write` 流程：

- apply_patch 引入 TS 字符串赋给 number、Python 字符串赋给 int 和未使用的 os import。
- 自动 Hook 和 `all`/`full` 报出 TypeScript 2322、Pyright assignment error、Ruff I001/F401。
- 两次纯 `lsp_diagnostics` 都返回相同的两条类型错误，不混入 Ruff。
- definition、prepare_rename、rename 为 `renamedValue` 成功。
- 修复类型错误及未使用导入；显式格式化；最终 `full` 和 `all` 均返回 `complete; checked=2 pending=0 skipped=0 failed=0`。
- Codex 的第一次 patch 请求包含重复目标，被宿主拒绝；重试成功，不是插件通过无效补丁。

11 次成功 MCP 调用：check_diagnostics 5 次、lsp_diagnostics 2 次、lsp_navigation 3 次、lsp_format 1 次。按调用顺序文本 UTF-8 字节数：113、419、419、292、292、359、67、16、37、48、48。

## 最终 Codex 实测 B：JavaScript + ESLint

独立非 Git 项目，ESLint flat config 启用 no-undef/no-unused-vars，项目用户信任显式授权。

- shell 写入错误后同一命令 `exit 1`；实际写入仍被 Hook 检测，报告两条 ESLint 错误。
- `all`、`full`、重复 `full` 均保留错误。
- shell 移动 main.js 到 renamed.js，`all` 不再包含旧路径。
- apply_patch 修复后 `lsp_format` 使用 LSP fallback，将 `export const value={a:1};` 格式化为 `export const value = { a: 1 };`，不是 lint fix。
- 最终 `full` 和 `all` 均返回 `complete; checked=1 pending=0 skipped=0 failed=0`。

7 次成功 MCP 调用：check_diagnostics 6 次、lsp_format 1 次。文本字节数：199、199、199、205、21、48、48。

最终两组共启动 3 个真实 LSP：两个工作区各 1 个 TypeScript server，Python 工作区 1 个 Pyright。启动包装器写在工作区外计数，不改变插件。18 次 MCP 调用及多次 Hook 没有重复启动这些 LSP；不能据此推断普遍缓存命中率或冷/热检查执行次数。测试后 Ruff 缓存目录不存在。

## 实测驱动修复

- Ruff 默认生成缓存，导致非 Git Hook 将缓存当作新改动：改用 `--no-cache` 并排除 Python 常见缓存目录。
- push 诊断失效后仅清空缓存，未触发服务器重新发布，导致格式化/移动后永久 pending：失效时关闭打开的文档，后续按最终磁盘内容重新打开，保留同一个 LspManager/client。
- 显式忽略文件按内容校验缓存；超过 200 个变更保留 pending；rename 后复查所有清单内变化目标；MCP facade 验证必填项、类型、范围与枚举。

## 推送后的真实 GitHub 安装

实现提交 `50138d8` 推送到 main 后，在第二个全新隔离 Codex home 执行：

```bash
codex plugin marketplace add https://github.com/zoisythe/codex-lsp-standalone --ref main --json
codex plugin add codex-lsp@codex-lsp-standalone --json
```

安装成功；实际安装 bundle 与本地已测 bundle 逐字节一致，不含 node_modules、Skills 或 submodule 源码。随后真实 Codex MCP `status` 成功，JSON 文件主动诊断成功。最初将 package.json 当作“不支持”的负例是测试输入错误（本机实际存在 JSON server），因此另用 `.codex_acceptance_unknown` 文件复测，明确返回 `partial; checked=0 pending=0 skipped=1 failed=0` 及缺服务器说明，不伪报 clean。未执行安装时 npm install 或递归获取 submodule。

## 尚未完成的计划项

以下是后续工作，不应将当前阶段称为完整设计验收：

- worker 崩溃发生在连接竞态中的有界重连、无 pid 的陈旧锁恢复、日志/指标及更严格的跨 sandbox/执行边界隔离。
- 持久化的是会话 baseline/touched 边界，不是诊断结果；重启后结果必须重新获取。
- 队列串行化并复用完整结果，不是独立后台任务的真正 single-flight/快速编辑合并；Hook 仍可能等待接近 55 秒的请求预算。
- 扫描为排序列表的 start/offset 分页，无绑定内容版本的续扫 token；目录变动时应从头重扫。超过库存预算仍需缩小范围。
- 自定义 runner 路由、项目 exclude、多根/依赖配置状态更精细的缓存失效，以及更广泛的并发编辑与取消验收。
- `/hooks` 交互式持久信任、真实超过 10 分钟的闲置连接、跨平台 CLI 实测。现有子进程测试只加速旧长定时器。
- 远端 CI 运行结果尚未取得；不能将 CI 配置提交视作跨平台测试成功。
