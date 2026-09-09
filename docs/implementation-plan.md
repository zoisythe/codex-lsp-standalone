# 0.4.0 隔离执行、短 Hook 与可控诊断

本轮范围来自已确认计划。提交、推送、发布均不在授权范围内。0.3.0 的共享 worker 架构及其恢复/重连待办已被替代；历史验收见 [历史记录](history/validation-0.3.0.md)。

用户后续追加：交付一个简短的 `skills/lsp/SKILL.md`，说明四个工具的用途与调用规范；取代此前不交付 Skills 的约定。

## 已实施的架构

- 每个 MCP 进程按真实工作区路径维护 Engine，工作区内串行请求，LspManager 管理客户端。初始化不启动 LSP；工作区闲置两分钟释放客户端并失效结果，stdio 保持连接。取消、EOF 和退出清理分析进程。
- Hook 独立运行 Biome/ESLint/Ruff，不启动 LSP，也没有 socket、token、worker 发现、启动锁、重连或跨进程执行通道。
- 用户、真实工作区、session ID 隔离的 metadata-v4 仅保存 baseline 内容哈希、touched/current/pending、轮次、状态版本及反馈/阻止指纹。互斥锁仅覆盖短更新，原子替换；分析不持锁，提交核对版本和内容。死进程锁通过不可变锁标识墓碑恢复，避免并发恢复抢走新锁。SessionEnd 使用版本化墓碑，避免旧请求复活会话。
- Hook 缺少 session_id 则提示降级。MCP 单会话自动选择，多会话要求指定 session。all/delta 读取本 MCP 的结果及共享 touched 边界，Hook-only 文件显示 pending。
- 每个运行实例的固定类别错误日志最多 1 MiB，保留一个轮转文件；不记录源码、环境变量值、配置或原始异常正文。

## 预算与写入

| Hook | 总预算目标 | 宿主 timeout |
| --- | --- | --- |
| SessionStart / PreToolUse / PostToolUse | 5 秒 | 10 秒 |
| SessionEnd | 2 秒 | 3 秒 |
| Stop | 45 秒 | 50 秒 |

日常 Hook 分配 4.4 秒给根目录定位、状态读取、变更发现和 lint，并留出提交/输出余量；Stop 分配 44 秒，SessionEnd 分配 1.6 秒。取消信号传入 Git、遍历和 Runner。发现不完整不推进 baseline；先登记变化和 pending，再检查本次变化及排序后的 pending。未完成文件下次补查。

Hook 明示仅运行 lint。Stop 重新检查当前内容，只有新鲜 Linter error 可按指纹阻止一次；warning、pending、缺工具和未执行 LSP 不阻止。反馈只持久化去重指纹。

rename/format 串行写入，不自动重试；取消后不开始后续写入。部分成功时报告已写路径并失效缓存，不提供事务回滚。

## 配置、范围和分页

- 用户/项目 lsp-client.json：lint.javascript = auto/biome/eslint/off；lint.python = auto/ruff/off；exclude 为相对正斜杠 glob，不支持否定。
- lint 按字段项目 > 用户 > 默认，项目 exclude 整体覆盖用户数组。未信任项目的插件设置忽略；独立 Runner 需要用户信任。配置覆盖路径与信任读取统一，项目不能授予自身信任。
- auto 保留 Biome 优先于 ESLint、Python 使用 Ruff；显式选择不回退，工具/匹配配置缺失明确报告。lint off 不影响显式格式化选择。
- 有效配置、Runner/LSP 身份、直接工具配置内容参与新鲜度。工作区内容保守失效；直接工具配置即使被 exclude 隐藏仍读取指纹。外部 extends/imports、虚拟环境或工具安装变化可使用 refresh 主动刷新。
- check_diagnostics mode=full 与 lsp_diagnostics 接受 refresh:true，绕过缓存、重建客户端；其他模式拒绝 refresh。
- 声明范围单独扫描，忽略/exclude 后最多 10,000 文件清单、每次最多检查 200 文件、单文件最多 1 MiB。显式文件绕过忽略，但不绕过大小和工作区边界限制。
- 工作区依赖清单不完整时禁止缓存复用。小目录可完成主动检查，同时注明全工作区依赖新鲜度未验证；根范围超限保持 partial。
- start/offset 非零必须带首轮返回的 revision，绑定工具、模式、范围、清单、内容、配置；all/delta 也绑定结果版本。不保存分页任务或 token 服务。
- complete 只描述声明范围及实际执行通道，不能替代项目类型检查、构建或测试。

## 验收与后续

当前取得的命令、真实 Codex 和 CI 证据记录在 [validation.md](validation.md) 及 [Windows 验收](windows-validation.md)。三平台 workflow 配置不是远端 CI 通过证据。

暂缓：持久诊断缓存、后台调度、通用 Runner 框架、多根依赖图、外部配置依赖自动发现、性能指标系统。它们是可选后续项，不属于本轮交付。
