# 附录 B 阅读范围、实验记录与术语

本书以 Git 提交 `11449730c8a733953ce1bcce70e066bccaa778a5` 为源码基准，工作区另包含 B.3 记录的测试修复、辅助改动与新增教学示例。正文共 36 章、443610 个字符；这个字符数包含代码和 Markdown 标记，不是中文汉字数，也不含本附录与逐文件索引。最新核验日期为 2026 年 10 月 4 日。

## B.1 “通读源码”的具体范围

已完整阅读十三个包中归类为运行源码的 669 个文件，共 174120 行，包含 src 中的 TypeScript、JavaScript、HTML、CSS 以及 native C/Objective-C/header 等实现。内置扩展、经典 CLI、Durable、新远程应用和运行时测试辅助实现均在这一范围内。

另完整阅读了 26 个工程脚本、21 个代表性测试或测试辅助文件、50 个配置/说明/评估支持文件，以及 1 个生成文件。阅读状态与每个文件的内容哈希保存在 [reading-inventory.tsv](reading-inventory.tsv)，运行源码与章节导航见 [附录 A](appendix-source-index.md)。

本次补读 Plan Mode 的 index.ts、utils.ts 与 README，以及经典 Subagent 的 index.ts、agents.ts 与 README，共 6 个示例分类文件；第 34 章据此分析规划、角色发现、子进程与调度。它们不改变“669 个运行源码”的分母，也不代表其余示例均已通读。

清单按基准提交的 tracked 路径生成，分类以路径与扩展名为依据。`fully_read:true` 表示该文件已从头到尾查看；正文按机制组织，并不为每个桶文件、重新导出或小型常量文件单独重复说明。

本次修复又完整阅读了 stream.test.ts 和 cloudflare-stream.test.ts；原阅读清单保留基准时的状态与哈希，新增的已审核文件差异保存在 [verified-source-changes.tsv](verified-source-changes.tsv)。这份记录同时固定原始与修复后的哈希，不放宽其他文件的校验。

以下不计入“669 个运行源码”的分母，也不声称已全部逐文件通读：

- 所有历史 CHANGELOG、规划文档和说明文档。
- 全部测试集合、演示扩展与示例应用脚本。
- 剩余开发诊断与发布辅助脚本。
- 生成的模型类型分片、未物化的模型 JSON、lockfile 和安装锁。
- HTML 导出所用的第三方压缩库与 Doom 的第三方代码。

这一区分用于让读者准确核对证据：项目自身的运行机制已通读；不能据此说每一条历史记录、每个外部依赖或全部测试都已审计。外部依赖提供的行为仅在已读取的调用契约范围内说明。

## B.2 初版局部实验的历史记录

以下是初版撰写期间的记录：使用本机 Node.js 24.19.0，无模型请求、依赖安装或网络服务。直接导入可独立运行的源码；对依赖较多的大模块，提取完整相关定义、擦除 TypeScript 类型后在 VM 中执行。临时程序未保留，因此“通过”只表示初版记录，不能作为当前交付可以重复运行的证据。当前已交付实验见 B.3；没有声称重建了下表全部用例。

| 实验集 | 方法与覆盖 | 结果 | 对应章节 |
| --- | --- | --- | --- |
| 经典文件队列 | 直接导入；同文件顺序及尾部清理、符号链接、不同文件、硬链接、失败后继续，共 5 项 | 通过 | [11](11-file-concurrency.md) |
| Codemode 静态辅助 | 直接导入 source/declarations/identifier；8 项语法与声明检查 | 通过 | [23](23-codemode.md) |
| MCP 客户端 | 实际 McpClient + 内存 transport；握手、乱序响应、进度续期、取消、错误结果、游标、关闭，共 7 项 | 通过 | [22](22-mcp.md) |
| 提示模板参数 | 提取完整参数解析与替换函数；8 项位置参数和引用行为检查 | 通过 | [17](17-resources-packages-and-trust.md) |
| 扩展 runner | 提取完整 runner 定义，注入最小协作对象；7 组事件与上下文检查 | 通过 | [16](16-extensions.md) |
| JSONL 与模式事件 | 直接导入 reader/converter；3 组 UTF-8 分块、事件身份、最终消息检查 | 通过 | [21](21-sdk-modes-and-rpc.md) |
| 终端输入与文本 | 直接导入 stdin、键、撤销、kill ring；提取换行函数并注入显示宽度；5 组 | 通过 | [19](19-input-editor.md) |
| 交互模式身份 | 提取实际 TUI 引用和 selector 方法；5 组实时引用与过期完成检查 | 通过 | [20](20-interactive-mode.md) |
| Chord | 直接导入；9 组 delta、服务、状态复制和 bundle 生命周期检查 | 通过 | [24](24-chord-services-and-state.md) |
| Durable 数据 | 实际 Session、Memory、临时 JSONL 和 Node SQLite；9 组事务与恢复检查 | 通过 | [25](25-durable-data-and-transactions.md) |
| Durable 执行环境 | 实际 Node 环境、队列、输出与进度；8 组文件和本地子进程检查 | 通过 | [27](27-environments-and-storage.md) |
| 远程基础模块 | 实际 framing、CBOR、SessionRouter、TestServerHost；7 组帧、编码和路由检查 | 通过 | [28](28-remote-protocol.md) |
| 实验性应用辅助 | 提取 WorkerLifecycle、ServerLifetime、命令注册和中继编码；4 组可控计时与身份检查 | 通过 | [29](29-experimental-applications.md) |
| 遥测 | 实际内存实现执行 9 个后端无关一致性用例，另 3 组数组复制、no-op 与类型模式检查 | 通过 | [30](30-telemetry-and-diagnostics.md) |

临时脚本的目标是核验正文中的局部结论，未作为仓库正式测试或配套程序交付。模拟定时器不证明真实进程交接；内存传输不证明 HTTP/OAuth；注入显示宽度不证明所有 Unicode 终端表现；局部源码导入不证明发布产物可安装。

## B.3 本次交付的可复现实验与检查

配套程序位于 [labs](labs/README.md)，在教材目录执行 `node labs/run-offline.mjs`。本次在 macOS、Node.js 24.21.0 上运行全部 8 组、26 个命名用例，均通过。完整固定输入、断言、源码提取边界和 [预期标准输出](labs/expected-output.txt) 随教材保存。

| 组 | 用例数 | 验证内容 | 关键限制 |
| --- | ---: | --- | --- |
| transcript | 2 | 提示章节删除、工具重定义、system 收敛 | 不覆盖提供商 payload |
| budgets | 2 | 输入安全余量、thinking/回答分配 | 字符估算，不是真实 tokenizer |
| loop | 5 | 预检与执行、结果顺序、整批串行、length、取消、terminate | 内存模型 stream、模拟 schema validator |
| compaction | 4 | 阈值、数值切点、超大末尾结果、元数据边界 | 输入已投影，不覆盖完整树与摘要模型 |
| search | 4 | BM25 数值、中文、同分顺序、搜索字段、激活 | 工具注册表 API 为内存模拟 |
| planning | 3 | 计划编号、DONE、命令判定、真实扩展切换 | UI/会话模拟；命令字符串不执行 |
| subagents | 5 | 四 worker、输入顺序、输出选择、dispatch、JSON 分块、chain 交接与失败、parallel 部分失败 | spawn/角色发现/子任务模拟，不证明真实进程生命周期 |
| files | 1 | 实际同文件与符号链接读改写、失败后继续 | 不证明跨进程或硬链接互斥 |

大模块实验执行从源码提取的完整相关定义，没有另写算法替身；模拟对象和直接导入的区别见实验说明。源码哈希不匹配会拒绝运行。文档同步程序结合基准清单与已审核变更记录验证全部文件哈希，并验证源码节录、本地链接与锚点、编号、分章目录和章节统计。

为运行工程检查，使用 `npm ci --ignore-scripts` 安装了固定锁文件依赖，再按 `nix/model-catalog.json` 固定的 revision 下载并校验模型目录，使用仓库 hydrate-model-catalog.ts 准备被 Git 忽略的模型数据。没有执行安装生命周期脚本，没有改依赖、lockfile、生成模型文件或运行时源码。run-offline.mjs 不需要这些安装与目录下载，新增集成实验使用已准备好的依赖与数据。

首次 `npm run check` 曾在 [stream.test.ts 第 705 行](labs/overlay/packages/ai/test/stream.test.ts#L705) 报 TS2345：Cloudflare AI Gateway 测试使用 `claude-sonnet-4-5`，固定目录中同一 Sonnet 4.5 模型的标识为 `claude-sonnet-4.5`。本次修正该调用和用例标题，保留原来的文本、工具、流式、thinking 与多轮测试。已核对目录中的 Anthropic Messages API、网关路径和 reasoning 字段；没有通过类型断言绕过检查，也没有修改固定模型目录。

修复后完整 `npm run check` 通过：Biome、固定依赖、运行依赖、相对导入、入口图、安装锁、TypeScript 和 browser-smoke 全部通过。

另从 packages/ai 运行指定的 stream.test.ts 与 cloudflare-stream.test.ts，使用临时 HOME 和不继承凭据的环境，并禁用本地模型。2 个 Cloudflare 离线用例通过；233 个真实提供商用例因无凭据跳过，stream.test.ts 的模块加载与用例收集成功。跳过不表示真实模型行为已验收。

本次未运行完整 Vitest、npm test、npm run build、发布脚本、Docker 模型评估或真实提供商请求。因此不能把本次局部实验与文档核验称为整个项目检查通过。

因此，“已有测试覆盖此场景”在正文中表示已读取的断言或可定位的测试，不自动表示该测试在本次运行通过。“根据实现可推导”表示执行顺序分析，不能换成未经验证的集成结果。

源码未来更新时，可以先核对清单哈希，再沿第三十三章的方法重新追踪受影响的调用链；不要只更新教材日期而保留旧实现结论。

## B.3.1 本次补充的完整会话与开发案例

第 8 章加入 AgentSession 实际输入构造、应用 run、settled 和持久化顺序的连续源码；第 26 章加入 scheduler 的 reserve、gated、step 完整方法及具体竞态。第 35 章连接完整可运行会话和扩展开发；第 36 章按原章节回答前 35 章的全部练习。

新增 [book-session-walkthrough.test.ts](labs/overlay/packages/coding-agent/test/suite/book-session-walkthrough.test.ts) 共 7 个命名用例，使用 suite/harness.ts 和 faux provider。文件编辑用例实际保存 JSONL 并重新打开，会话恢复后检查原 toolResult 已进入新请求，写入计数仍为 1。失败批次实际检查零写入、原文件和持久错误结果。字面搜索示例覆盖算法、扩展声明/执行/会话记录与读取前参数拒绝。

开发过程中实际执行过错误正则实现的回归用例：查找 `.` 时预期 `[2]`、实际 `[1,2,3]`，测试失败。改用 includes 后全部 7 项通过，错误版本没有保留在交付实现。这个失败记录与最终源码分别标注，不把错误片段当可用示例。

另运行既有 [harness-tools-recovery.test.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/test/harness-tools-recovery.test.ts) 的全部 9 个命名用例，使用实际 Node SQLite 与 Harness close/reopen，全部通过。包含 safe 策略的三种组合、cwd 与取消选择、意图前后钩子恢复、取消及 faulted 结果、真实本地 bash 中断，以及旧进度清理。测试没有真实模型请求，也不做强制杀进程或断电注入。

统一可复现入口为 [run-integration.mjs](labs/run-integration.mjs)，完整输出见 [integration-expected-output.txt](labs/integration-expected-output.txt)。它使用已有固定依赖，临时 HOME 与不继承凭据的环境，明确选择两个测试文件；16 个用例无失败、无跳过、无 todo。本次补充完成后再次运行完整 `npm run check`，所有工程检查通过。

为统一真实文件 cwd 与日志 cwd，harness 只增加可选 cwd，默认仍是原临时目录；改动记入 [verified-source-changes.tsv](verified-source-changes.tsv)。新增示例与测试另由 [teaching-source-hashes.tsv](teaching-source-hashes.tsv) 固定，原基准阅读清单不变。它们不计入基准的 669 个运行源码文件。

前面的 run-offline.mjs 仍不要求 npm 依赖；新增集成入口要求安装依赖与固定模型数据。不能再把两种实验的前置条件合为一句“均无依赖”。

## B.4 基础术语

| 术语 | 本书中的含义 | 首读章节 |
| --- | --- | --- |
| 进程 / cwd | 一次操作系统程序运行 / 当前工作目录 | [1](01-node-runtime.md) |
| Promise / await | 未来结果对象 / 等待结果并让出当前异步函数 | [1](01-node-runtime.md) |
| 事件循环 | 在同步代码结束后调度就绪工作的运行机制 | [1](01-node-runtime.md) |
| Buffer / UTF-8 | 字节容器 / 文字与字节之间的编码 | [1](01-node-runtime.md) |
| 类型 / schema | 开发期值形状描述 / 运行时数据模式 | [2](02-typescript.md) |
| 判别联合 | 由不同标签区分多种结构的类型 | [2](02-typescript.md) |
| 依赖注入 | 从外部传入协作对象或能力 | [2](02-typescript.md) |
| provider / API | 模型提供方 / 具体请求协议实现 | [6](06-model-runtime-and-providers.md) |
| SSE | 通过 HTTP 文本流交付分隔事件的协议形式 | [6](06-model-runtime-and-providers.md) |
| PKCE / state | 授权码交换的证明 / 关联本次登录与回调的值 | [6](06-model-runtime-and-providers.md) |
| toolCall / toolResult | 模型提出的工具请求 / 运行时返回的关联结果 | [5](05-model-messages-and-events.md) |
| 竞态 / 临界区 | 交错改变结果的问题 / 应由互斥覆盖的操作区间 | [11](11-file-concurrency.md) |
| 队列 / 锁 | 按顺序交接执行位置 / 参与者约定的互斥所有权 | [11](11-file-concurrency.md)、[15](15-settings-and-credential-locks.md) |
| BOM / CRLF | 文件开头的编码标记 / 回车加换行的行结束形式 | [10](10-file-editing.md) |
| diff / patch | 变化的展示 / 可供其他工具处理的差异文本格式 | [10](10-file-editing.md) |
| JSONL | 每行一个 JSON 记录的文件形式 | [13](13-session-log-and-tree.md) |
| leaf / projection | 当前树末端 / 从日志生成的某种可见内容 | [13](13-session-log-and-tree.md) |
| compaction | 用摘要和保留段降低模型上下文大小 | [14](14-compaction-and-summary.md) |
| generation | 用于区分异步工作或插件生命周期的代次 | [6](06-model-runtime-and-providers.md)、[24](24-chord-services-and-state.md) |
| delta / base | 表达变化的操作 / 重建状态的完整基线 | [24](24-chord-services-and-state.md)、[25](25-durable-data-and-transactions.md) |
| commit / checkpoint | 一笔状态提交 / 可用于恢复的已保存工作位置 | [25](25-durable-data-and-transactions.md)、[26](26-durable-tasks-and-recovery.md) |
| 幂等 / replay | 重复请求不增加额外效果 / 重新执行或重放工作 | [26](26-durable-tasks-and-recovery.md) |
| CBOR / framing | 二进制数据编码 / 将字节流分隔成完整消息帧 | [28](28-remote-protocol.md) |
| attachment / service | 一次会话附着的路由身份 / 可远程调用和订阅的应用能力 | [28](28-remote-protocol.md)、[29](29-experimental-applications.md) |

## B.5 回答问题时应采用哪一种证据

问“当前代码保证什么”，定位状态与执行顺序；问“这个特定场景实际发生了什么”，找对应实验或集成测试；问“真实服务目前支持什么”，需要另行核验服务端与官方协议。教材中的模型名单、兼容修正与价格字段均属于基准提交，不是对未来服务状态的保证。

对每个结论说明作用域即可：某个对象、模块实例、文件、进程、存储事务或外部服务。作用域明确后，“有锁”“可恢复”“已完成”才成为能够检验的技术说法。
