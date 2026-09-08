# Codex LSP 改造计划

状态：设计范围已与用户确认；当前阶段实现及 Linux Codex CLI 实测已通过，本文不是全部计划完成声明。完整证据、未完成项见 [validation.md](validation.md)。

## 2026-09-08 当前阶段进度

- 已实现自包含 bundle、无 Skills 交付、四个静态 MCP 工具、共享 workspace worker、会话 baseline/touched 缓存、自动 lint 和显式格式化。
- 已补齐显式忽略文件内容校验、超预算 pending 保留、rename 变化目标复查、MCP 参数验证，并修复 Codex 实测暴露的 Ruff 缓存自触发和 push 诊断永久 pending。
- `npm run check`、`npm test`（15 个 Vitest + 3 个子进程测试）、`npm run typecheck` 通过；隔离 Codex 0.153.4 从无 submodule/node_modules 的插件目录安装，真实 TS/Python/Biome/Ruff 与 JS/ESLint 两组流程共 18 次 MCP 调用成功，最终 all/full 均完整零问题。
- MCP 入口采用经 Codex 0.153.4 实证的相对 `cwd: "."` + `node ./dist/cli.js mcp`：Codex 将 cwd 解析到安装插件根，用户工作区通过工具参数单独传递；不是由模型猜测 cwd。
- 尚未通过的设计验收（worker 竞态恢复、更严格执行边界、持久诊断缓存、稳定续扫 token、跨平台/长闲置/交互 Hook 信任等）明确列在 validation.md，不按已完成处理。
- 本轮用户另行明确授权：本地 Codex CLI 测试通过后提交、推送。该授权取代下文原计划阶段的“不授权提交或推送”限制，不代表授权未测试发布。

## 已确认的设计

- 保留 `packages/lsp-tools-mcp` submodule 用于开发，提交自包含 bundle 供安装运行。
- 使用 GitHub marketplace 链接安装；安装路径不执行 npm install、不递归获取 submodule、不下载运行时代码。
- 只注册 MCP 和 Hooks，不安装 Skills。
- 自动检查已变更文件；格式化必须显式调用，默认不运行格式化或 lint fix。
- 按工作区共享后台进程及缓存；首批独立 lint runner 为 Biome、ESLint、Ruff，使用已有项目工具。
- 只参考 pi-lens 的工具组织方式，不移植 AST、符号索引、项目图或诊断标记体系。
- 所有工具静态注册，不实现 Pi 专用动态激活接口，不依赖 MCP tools/list_changed。
- 尽量保持长任务 prompt 缓存与运行时缓存，输出简洁；不能承诺由模型服务决定的具体缓存命中率。

## 现状与证据

1. `.mcp.json` 使用 `node ./packages/lsp-tools-mcp/dist/cli.js mcp`，并设置相对 `cwd`。
   当前检出直接运行此命令得到 `MODULE_NOT_FOUND`，进程在 initialize 前退出。
   这是本地复现原因，用户已安装副本的 stderr 尚未取得，不能断言其唯一根因。
2. 顶层 `dist/cli.js` 虽已跟踪，但仍依赖 `file:./packages/lsp-tools-mcp` 包；只改 MCP 入口不能解决干净安装。
3. `src/codex-hook.ts` 为每次 Hook 独立调用诊断，进程结束时释放 LSP；只请求 error，且 reason/additionalContext 重复输出。
4. 当前变更识别未使用 Hook 的 cwd/session_id/turn_id，未覆盖 Bash 修改；移动补丁会同时收集原路径和目标路径。
5. 上游 MCP CLI 默认空闲 `10 * 60_000` 毫秒后 `process.exit(0)`。长时间不调用工具后会断开连接；空闲回收必须与 stdio 生命周期分离。
6. 当前 CI 会递归拉取并构建 submodule，package smoke 仅 dry-run，无法验证 GitHub 普通克隆后的实际握手。
7. 本机 Codex 为 `codex-cli 0.153.4`。在线文档说明支持 MCP tool hooks，但实际版本兼容性必须通过测试验证。

## 建议的固定工具表

以下具体 schema 是实施建议；工具名称、顺序和描述发布后应保持稳定。

| 工具 | 职责 |
| --- | --- |
| `check_diagnostics` | 统一 LSP/lint 结果。`mode=delta` 当前会话/轮次增量，`all` 当前会话已触及文件缓存，`full` 主动扫描仓库；`status` 返回简短运行状态。 |
| `lsp_diagnostics` | 对指定文件、路径列表或目录主动执行纯 LSP 诊断；不混入独立 lint runner。 |
| `lsp_navigation` | 合并 definition、references、symbols、prepare_rename、rename；复用已有上游能力，不凭工具名称扩大能力承诺。 |
| `lsp_format` | 显式格式化指定路径；优先项目配置的 formatter，支持 LSP formatting；不执行语义性 lint fix。 |

不单列 status、definitions、references、symbols、rename 工具；不提供 activate_tools 或空壳 AST 工具。
`all` 不是全仓扫描，缺失、超时或陈旧结果不能输出为“检查通过”。
导航 rename 和格式化都属于写操作，必须串行应用文件编辑，并重新提交变更检查。

## 运行架构

```text
Codex --stdio--> dist/cli.js mcp -------+
                                      +--> 工作区 worker --> LspManager / lint runners
Codex --Hook--> dist/cli.js hook -------+                      --> 统一结果缓存
```

- MCP facade 只处理协议、参数验证、结果呈现。initialize 不等待语言服务器、扫描、安装或 worker 冷启动。
- stdout 仅用于协议/Hook JSON；日志和运行错误写 stderr，详细日志保存在插件数据目录。
- Hook 是短命客户端，worker 按规范化工作区路径、用户、运行版本及信任/配置边界隔离。
- Unix socket / Windows named pipe 作为本地 IPC；使用私有目录、访问权限和握手凭据，验证请求路径，禁止跨工作区访问。
- worker 不是权限绕过通道；不同信任/执行边界不得共享可执行命令配置。仓库配置不能提升用户授权。
- 启动加互斥锁，并发请求合并；崩溃、陈旧锁、版本升级可恢复。MCP/Hook 的重连需有界，不允许重启风暴。
- worker 空闲且无任务/租约时退出；MCP stdio 在 Codex 连接期间不因空闲主动退出。worker 回收后下次请求透明重建。
- 保持 LSP 子进程由 `LspManager` 唯一所有；执行使用 `withLspClient(...)`，不另建平行 LSP 管理器。
- 支持的 Codex 上可评估原生 MCP tool hook，但不把它作为首版正确性的前置条件；不得为内部 Hook 操作暴露额外模型工具。

## 自动检查

1. 解析 Hook 的 cwd、session_id、turn_id、tool_use_id 及真实 Codex tool_input。
2. apply_patch/Write/Edit 等获取最终新增、修改、移动目标；删除清理缓存，不检查已不存在的旧路径。
3. Bash 等工具的文件修改通过受限工作区变更跟踪与文件指纹确认，不通过猜测 shell 命令确定修改路径。
   Git 仓库需覆盖 staged/unstaged/untracked；非 Git 工作区使用受限文件快照。观察器只作加速，不能作为唯一正确性来源。
4. 会话初始 dirty 状态单独记录，不能把已有改动和旧问题都归为本轮新增。失败的 shell 也可能修改文件，按实际变更决定是否检查。
5. 合并同一文件的快速连续编辑，按最终内容版本同步 LSP；旧版本任务完成后丢弃过期结果。
6. 按配置选用 Biome/ESLint/Ruff。自动 lint 只检查，不写入、不自动安装、不运行任意项目 script。
   Biome/ESLint 共存时按明确配置和职责路由，避免重复检查；配置加载本身可能执行代码，应遵循项目信任策略。
7. 日常输出覆盖 error/warning；同一指纹反馈一次，无诊断则静默。工具缺失/超时作为简短降级提示去重，不当成源码错误。
8. Hook 内只等待有界预算；尚未完成标记 pending，后续检查或 Stop 汇总补齐，不伪报干净。
9. Stop 做会话已变更文件的有界补查，不默认全仓扫描。若用阻止结束反馈，仅针对新鲜且确认的错误，并设置防循环约束；warning 不阻止结束。

## 缓存与输出

### 运行时缓存

- 复用 LSP 连接、runner 解析和结果；并发相同请求 single-flight。
- 结果键包含真实文件内容版本、runner/server 身份、配置和相关依赖状态。
- config、lockfile、项目边界或导入依赖变化必须失效或标记结果陈旧；不能只靠 TTL/mtime 证明结果新鲜。
- 持久缓存与会话反馈分离：多会话可复用分析结果，但 delta、已显示标记和 touched files 不串会话。
- 删除、移动、分支切换、worker 重启后显式校验；扫描未完成/未知与完整零问题分别建模。

### Prompt 缓存与紧凑输出

- 固定工具 schema/顺序/描述；不把工作区状态、时间戳或动态说明写入工具描述。
- 不安装 Skills，不向静态 developer/system 提示反复塞诊断；用短工具/Hook 消息递增传递。
- 单一人类可读呈现，不同时重复完整文本和 JSON 诊断列表；结构化内部记录供去重和分页使用。
- 输出格式：`path:line:column severity [source/rule] message`，稳定排序、相对路径。
- 建议初始上限：Hook 最多 10 条且 2 KiB；显式诊断最多 50 条且 8 KiB。超限必须说明省略数量并提供续读方式。
- 格式化只列改动路径和失败摘要，不默认返回整文件或完整 diff。
- 不为减少输出隐藏旧的未解决错误：`all` 必须能重新查询；反馈去重不等于缓存删除。

## 仓库级扫描

- `full` 扫描全部支持语言，而不是按目录推测一个扩展名。
- 尊重 Git ignore/项目 exclude，跳过依赖、构建产物和越界 symlink；显式文件的 ignore 行为单独定义并测试。
- 文件数、耗时、并发和结果数量均有预算；提供稳定续扫状态。
- 输出 checked/skipped/pending/failed 和 complete/partial；达到上限不能叫全仓通过。
- 默认不主动扫描全仓，不自动运行安全/依赖重型扫描、全量测试或 lint fix。

## 发布与安装

- 开发从固定 submodule commit 构建，通过 bundler 将所有运行所需 JS 依赖（包含动态导入）封装到跟踪的 dist。
- bundle 可有随附资源，但运行时不得读取 submodule/node_modules；开发 file dependency 移到开发侧，避免 npm 包运行依赖仍指向 submodule。
- 构建不是“dist 存在就跳过”；CI 重建比较，防止旧 bundle 与源代码/submodule 指针漂移。
- `.mcp.json` 使用经实际 Codex 验证的插件根目录入口；插件代码位置与用户工作区 cwd 必须分开。
- 移除 manifest 的 skills 字段、package files 中 skills，以及插件根默认可发现的 skills 目录；仅删 manifest 字段不够。
- 保留 LICENSE/NOTICE 及上游归属；README 明确 Node/LSP/linter 前提。无安装时网络不等于捆绑所有语言服务器。
- 安装文档以 `codex plugin ... --help` 和临时 Codex home 实测为准；区分添加 marketplace 与安装插件。
- Hooks 首次使用及定义变更后需要 Codex 审核信任；不得承诺零授权静默启用。

## 实施顺序与验收门槛

### 1. 先修安装与协议生命周期

先写失败测试，再实现 bundle、绝对插件入口、去 Skills、stdio 生命周期。

验收：

- 从不含 submodule 内容、node_modules、构建工具的安装目录启动。
- 使用不同 cwd，包含空格/非 ASCII 路径；initialize、initialized、tools/list、ping、EOF 都通过。
- 缺少任何语言服务器时 initialize 仍成功，显式诊断返回可行动的缺依赖提示。
- 协议 stdout 无日志污染；闲置超出旧 10 分钟阈值仍能调用；取消和退出清理正确。
- Ubuntu/macOS/Windows CI 运行真实子进程 smoke，不仅检查 JSON 文本或 npm pack dry-run。

### 2. 共享运行时与统一诊断

先测试多 Hook/MCP 连接，再实现 worker、缓存、诊断 model、四工具 facade 与多语言目录扫描。

验收：

- 同工作区连续 Hook 不重复启动 LSP；并发相同内容仅执行一次。
- 工作区/会话/版本/信任边界隔离，旧请求不覆盖新文件结果。
- worker 崩溃/闲置回收后恢复；MCP 不掉线；所有进程最终退出。
- 缓存命中、失效、超时、partial 状态有可断言证据。

### 3. 自动 lint、显式格式化与低噪声反馈

先覆盖 Codex payload、重复反馈、旧问题和文件竞态，再接入 runner 和 Hook/Stop。

验收：

- apply_patch、多文件编辑、移动/删除、Bash、非零退出但改了文件、非 Git 工作区均有覆盖。
- TS/JS 与 Python 项目验证 LSP 加 Biome/ESLint/Ruff；项目配置优先，未安装则降级。
- 日常 Hook 不修改文件；format/rename 仅修改指定授权范围、检测并发改动并重新诊断。
- 重复问题静默但 all 仍可查；修复后缓存清除；未知绝不当成功。
- 紧凑输出快照验证去重、稳定排序、上限和分页；tools/list 跨调用保持相同。

### 4. 发布验证与文档

- 本机 `codex-cli 0.153.4` 使用隔离 Codex home 验证实际插件发现、MCP 握手和 Hook 信任流程，不改用户现有配置。
- CI 同时覆盖源码构建与无需 submodule 的交付产物；运行 `npm test`、`npm run typecheck`、`npm run check`。
- 记录冷/热检查次数、LSP spawn 次数、输出字节数和工具 schema 稳定性，不用一次性能样本宣称普遍命中率。
- 在仓库变更提交并推送之后才验证真实 GitHub 安装；本计划不授权提交或推送。

## 参考

- Codex Hooks：<https://learn.chatgpt.com/docs/hooks>
- Codex Plugins：<https://developers.openai.com/codex/plugins>
- 本地 pi-lens `docs/agent-tools.md`：动态激活依赖 Pi 主机 API，并非通用 MCP 能力。
