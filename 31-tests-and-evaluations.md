# 第三十一章 测试与评估：怎样证明行为符合预期

测试首先要说明自己证明了什么。文件队列测试可以验证两个异步写入的顺序，却不能证明另一个操作系统进程不会覆盖文件；模拟模型可以验证工具调度，却不能证明真实模型一定会生成正确参数。本章把这些证据分开，说明仓库如何在确定的输入下检查运行时，又如何用真实模型评估文档的效果。

## 31.1 从最小断言理解测试

第二章介绍了函数和类型。测试增加一个简单步骤：给函数输入，再检查输出是否符合约定。例如 `createTaskPlan(cases, "fixture/model", 2)` 应当生成四个任务，而不是两个：每次重复都分别运行有文档和无文档两组。

```text
第 1 次：无文档 → 有文档
第 2 次：有文档 → 无文档
```

如果程序只检查四个任务的数量，就可能漏掉某一组被重复生成的问题。因此 [plan.test.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/test/plan.test.ts) 同时断言任务数量与具体顺序。一个有效测试应当覆盖容易出错的行为差异，而不是重复实现中的每一行。

## 31.2 测试目录与运行环境

| 位置 | 主要职责 | 阅读时需要注意的边界 |
| --- | --- | --- |
| `packages/ai/test` | 消息转换、提供商协议、认证、模型行为 | 部分测试需要真实端点或凭据 |
| `packages/agent/test` | 代理循环、工具执行和事件 | 不包含完整终端应用 |
| `packages/coding-agent/test/suite` | 用真实 AgentSession 和模拟提供商检查应用行为 | 资源加载器等依赖可以替换 |
| `packages/tui/test` | 终端组件、键盘和文本处理 | 使用 Node 的测试运行器 |
| `packages/chord/test`、`packages/durable/test` | 状态协议、存储、事务和任务恢复 | 内存实现与真实文件实现应分别验证 |
| `packages/evals/test` | 评估计划、隔离和报告的普通测试 | 不等于已经运行真实模型评估 |
| `packages/evals/evals` | 由模型完成任务的评估案例 | 可能产生真实模型请求和费用 |

[vitest.base.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/vitest.base.ts) 为工作区包设置源码别名，让测试读取当前源码；各包配置再指定自己的范围和环境。编程代理配置默认设置离线模式，但 AI 包的配置不能因此被理解为禁止一切真实网络测试。

[test.sh](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/test.sh) 以经过筛选的环境启动测试：创建专用临时 HOME、缓存和 npm 配置目录，禁用本地模型和部分隐式凭据来源，不把当前 shell 的全部认证环境传进去。清理前还检查目录形状、符号链接和所有权标记。这解决的是“开发机器的环境意外改变测试行为”的问题。

本书的核验没有运行完整测试集；已有测试的阅读不代表运行通过。配套离线实验与工程检查的实际结果在附录 B 分开列出。遵循项目约定时，普通测试使用根目录 `./test.sh`，或从相应包目录运行指定测试文件；不能把直接运行整个 Vitest 集合当作无网络风险的默认检查。

## 31.3 为什么需要 faux provider

假设要验证“模型请求两个写入工具，第二个预检查取消后，两个工具都不得执行”。如果使用真实模型，模型可能只请求一个工具，也可能更换参数；失败原因便混在模型行为与代理实现之间。

[providers/faux.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/providers/faux.ts) 提供一个模拟提供商。测试提前放入响应队列，下一次模型请求取出下一项。响应可以是固定消息，也可以是函数；函数能检查当前模型上下文和请求选项，再返回指定结果或抛出故障。

```text
测试预置：assistant(tool A, tool B)
真实 AgentSession.prompt("run both writes")
真实代理循环请求模型
faux 返回预置工具调用
真实工具预检查、执行、事件和会话保存
测试断言：没有写入，仍有成对的开始/结束事件
```

这里模拟的是模型边界。工具调度和会话逻辑仍使用应用实现。因此它比“直接调用一个内部辅助函数”覆盖更多，又比真实模型请求稳定。

## 31.4 响应队列怎样决定并发请求的归属

`createFauxCore` 在创建一次流式调用时同步取走队列首项，并增加调用次数；随后才进入异步生产阶段。两个请求 A、B 即使最终 B 先完成，也按调用先后领取不同响应。

```text
A 调用 stream：取响应 1；响应函数等待某个 Promise
B 调用 stream：取响应 2；立即产生文本
B 完成
A 的 Promise 解除，A 完成
```

队列领取顺序与完成顺序是不同概念。这种设计便于构造并发测试，但不会给真实提供商增加排序保证。响应在流式执行前被克隆，防止同一个预置消息在两次请求中被改写为不同模型信息时互相污染。

没有预置响应时，faux 会产生错误消息；这能暴露测试忘记准备第二轮模型输出的问题，而不是悄悄生成一个“合理回答”。

## 31.5 模拟流并不天然消除所有随机性

faux 可以逐段产生文本、思考和工具参数事件。默认分块大小可在区间内随机选择，工具调用 ID 和时间戳也可能自动生成。需要断言精确事件序列时，测试应当显式指定 ID、时间以及固定分块大小。

工具参数会被序列化成 JSON，再作为参数增量发送。中间部分消息的工具参数不必已经等于最终对象；最终消息才是权威结果。部分事件只复制外层消息，内部内容可能继续变化，不能把保存的每个 partial 引用都当作冻结快照。

faux 的 token 计数是基于文本长度的近似值，费用为零。其缓存模拟按会话 ID 保存前一次提示词并比较公共前缀，适合测试“缓存字段有没有被传递”，不适合证明某家提供商的真实计费与缓存命中规则。

取消同样是协作式：如果正在等待延迟定时器，信号不会自动缩短该定时器；下一次检查信号时才停止发送。已经取消的调用也可能先领取一个预置响应。因此测试不能假设取消必然使响应队列保持原样。

## 31.6 deferred 模式能够测试什么

延迟响应会先返回一个可查询的句柄，若干次查询返回 pending，之后才执行预置响应函数并得到最终内容。它用于验证上层等待、查询和取消流程。

句柄在模拟提供商自己的 Map 中保存。普通顺序查询会复用已经得到的最终结果；实现没有用一个共享的 in-flight Promise 包住所有并发查询。根据 `if (!entry.final)` 后再异步求值的顺序可以推导：两个并发查询可能同时开始执行响应工厂。不能把顺序查询测试的结果扩展成“任意并发下只执行一次”。这仍是模拟实现的边界，不是对所有远程异步 API 的判断。

## 31.7 会话测试 harness 怎样组装应用

[suite/harness.ts](labs/overlay/packages/coding-agent/test/suite/harness.ts) 为每个测试创建临时工作目录和独立的 faux 注册项，使用内存设置、凭据与模型目录，再构造真正的 Agent 和 AgentSession。测试可以指定工具、内联扩展工厂以及模型请求钩子。

它还保存会话事件，供 `eventsOfType` 等辅助方法筛选。清理时注销提供商、处置会话并删除临时目录。清理本身不是“任意后台工作已经完成”的证明，测试应当先等待自己启动的工作结束。

资源加载器在此处可以是预置实现；因此测试“扩展事件是否执行”不自动覆盖“从磁盘发现、信任并导入扩展”的路径。后者需要资源加载器测试或更完整的集成环境。

## 31.8 三个具体回归案例

第一，[agent-session-tool-orchestration.test.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/test/suite/agent-session-tool-orchestration.test.ts) 注册一个调用其他工具的 `run_tools`。它检查模型可见工具与嵌套可调用工具是两张不同的列表，检查父子调用 ID，并确认嵌套调用记录进入会话日志。`model-only` 工具不能通过 `ctx.executeTool` 递归调用自身，这也是明确断言的行为。

第二，[8935-parallel-preflight-abort.test.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/test/suite/regressions/8935-parallel-preflight-abort.test.ts) 预置两次外部写入。第二次 `tool_call` 预检查调用 abort。测试要求实际执行数组为空，同时两个工具都有对应的错误结束事件和工具结果。它证明的是“这一批工具在全部预检查完成前没有开始写入”，不是已经开始的外部写入能够回滚。

第三，[5208-late-bash-output.test.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/test/suite/regressions/5208-late-bash-output.test.ts) 让替换的 BashOperations 在 Promise 完成后再触发输出回调。测试要求最终文本只包含完成前的输出。它抓住的是异步回调越过生命周期边界的问题，单看退出码无法发现这个错误。

阅读回归测试时，应当找出输入、可控故障点、真正执行的生产代码与断言对象。测试名称和注释不是运行路径的替代品。

## 31.9 模型评估解决另一类问题

普通测试能证明扩展加载器按规则导入文件，无法证明模型读过文档后会正确创建扩展。`packages/evals` 把模型作为执行者，让它完成具体安装配置任务，再用程序检查结果。

[extensions.docs.eval.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/evals/extensions.docs.eval.ts) 要求模型创建 `hello` 工具，重载资源后调用它。评分同时检查扩展加载错误、工具是否真正注册、工具结果以及调用参数。只写一句“已经完成”无法通过。

[models.docs.eval.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/evals/models.docs.eval.ts) 要求给现有提供商增加模型，再检查原有模型仍存在。[openai-provider.docs.eval.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/evals/openai-provider.docs.eval.ts) 和 [custom-provider.docs.eval.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/evals/custom-provider.docs.eval.ts) 检查新增提供商是否真的向测试服务器发出正确请求。

## 31.10 协议 fixture 与真实模型的分界

[acme-server.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/evals/acme-server.ts) 在回环地址开启临时 HTTP 端口，验证 URL、方法、Content-Type、凭据、模型 ID 和流式请求字段。一个模式返回 OpenAI 风格 SSE，另一个返回逐行 JSON 的自定义流。

[configured-runtime.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/evals/configured-runtime.ts) 读取重载后的 ModelRuntime，调用 `completeSimple` 进行探测，并返回实际文本、停止原因及 token 字段。模型配置目录刷新禁止联网，不代表后面的 completion 不联网；探测会连接本地 fixture 服务器。

“配置任务的执行者”仍可能是真实外部模型，“新配置提供商的验收端点”才是本地模拟服务器。这两个边界必须区分，否则容易把整个评估误认为纯离线测试。

## 31.11 终端评估怎样检查用户看到的东西

[tui.docs.eval.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/evals/tui.docs.eval.ts) 要求模型用扩展把上下文百分比替换为十格进度条。验证代码创建真实 InteractiveMode，但终端换成记录输出的 RecordingTerminal，不需要操作用户当前终端。

它从同步渲染开始与结束标记之间提取完整帧，去掉 ANSI 控制码，检查 42.2%、65% 和 120% 三组输入。120% 的显示应当被夹到 100%。评分还检查原来的数字形式是否消失、其他测试进度条是否错误残留，以及会话计算出的上下文百分比是否仍正确。

Levenshtein 相似度用于描述其他状态文本的保留程度；此案例的主要分数是行为正确时 1、错误时 0，不能把相似度说明读成评分公式本身。验证结束必须停止界面、处置运行时并恢复临时修改的离线环境变量。

## 31.12 对照实验怎样生成计划

[plan.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/src/plan.ts) 将 Vitest 案例名称解析成评估集和案例 ID，拒绝重复身份；模型标识必须含提供商与模型，重复次数必须是正的安全整数。

[cli.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/src/cli.ts) 分别在有文档、无文档镜像中发现案例，要求两边案例集合一致、镜像 ID 不同，再写出完整任务计划和哈希。每个案例、模型、重复次数产生一对任务。奇数次先无文档，偶数次先有文档，以减轻固定执行顺序带来的偏差。

这不是随机化实验，也没有自动给出置信区间。一两个重复只能说明本次观测；不能直接推断真实总体收益。CLI 当前按顺序运行各个隔离任务，普通非零容器退出可形成失败观测；如果连 Docker 进程都无法启动，则可能在基础设施层直接终止。

## 31.13 文档差异怎样受到控制

[docker.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/src/docker.ts)、[Dockerfile](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/docker/Dockerfile) 和 [install-runtime.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/docker/install-runtime.mjs) 构造两个安装环境。无文档组删除编程代理包的 README、CHANGELOG、docs 和 examples，且从系统提示词中移除对应文档段落；两组都使用打包后的运行时，而不是把整个可读源码仓库交给模型。

镜像中的评估源码等敏感目录由 root 持有；运行代理前进一步降到专用 UID/GID。根文件系统只读，临时目录和结果目录可写。这使模型能够创建配置和扩展，同时限制它读取评分实现或直接修改安装包。

容器仍需要连接模型服务，不能把这里的隔离说成没有网络。也不能说只读根目录意味着整个容器没有可写位置：任务明确需要临时文件和输出目录。

## 31.14 harness 的初始化、身份切换与清理

[harness.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/src/harness.ts) 为每次运行创建工作目录、HOME、agentDir 和会话文件，检查 fixture 路径不得越过工作目录，装入选定模型凭据，创建真正的 SDK 会话，然后执行 prompt 与 reload 步骤。

凭据首先读入内存。进入工具执行身份之前，临时认证文件被移除，已解析的特定认证环境变量也被清理，避免工具直接读取这些来源。它不是对任意环境变量的全面脱敏；允许哪些工具和保留哪些环境仍属于具体运行设置。

POSIX 身份切换使用 `setgroups`、`setgid` 和 `setuid`，切换后检查 UID，并验证受保护的转换源码无法读取。身份降低不能在同一进程中简单恢复，所以每个实验组使用独立容器进程。临时替换 HOME、PI_CODING_AGENT_DIR 等全局进程环境也要求串行运行；harness 内没有为并发运行建立环境变量互斥锁。

取消监听会调用会话 abort，并在 finally 中等待这次 abort Promise。它依然依赖会话和工具的协作，不提供强制终止任意用户回调的能力。评估配置的超时也不能被泛化为 Docker 调用拥有一个独立、可靠的总墙钟期限。

## 31.15 保存证据比保存一句分数更重要

harness 校验实际系统提示词，记录其哈希、模型身份、token、工具调用次数、耗时及可能的估算费用。估算费用依赖模型价格元数据；缺失价格不能被默认为真正免费。

运行结束即使出现错误，也尽量保存原生会话 JSONL，让调查者能够重新追踪具体工具调用。清理失败与原始运行失败需要一起报告，不能让 finally 的错误把真正失败原因完全掩盖。耗时从整体运行开始计量，包含初始化和清理，并非只有模型生成时间。

报告读取逻辑会验证实际运行模型是否匹配任务；否则记录错误观测，避免“请求模型 A，实际跑了模型 B”仍被计入 A 的效果。

## 31.16 缺失结果为什么必须阻止通过率

[report.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/evals/src/report.ts) 区分 scored、unscored、errored、skipped 和 pending。分数 0 是有效评分，缺失分数不是 0。可用指标必须是有限且非负的数；缺失指标保留为缺失。

配对键由评估集、案例、模型和重复编号组成，每一边都必须恰好有一个预期任务和一个 scored 观测。缺失、重复、意外观测或未评分都会阻塞该配对。只要某个评估集有阻塞配对，该集的标题通过率和提升值就置为 null。

```text
预期：A 无文档、A 有文档、B 无文档、B 有文档
实际：A 两边完整；B 有文档运行失败
错误算法：仅计算 A，宣称所有任务完成并得到收益
当前算法：保留 A 的证据；整个评估集标题通过率不发布
```

这里的通过定义为分数至少 1；0.9 仍不计入通过。提升是有文档通过率减去无文档通过率，显示为百分点差。CLI 的失败退出由阻塞配对决定，不能理解为任何较低分数都自动导致非零退出。

## 31.17 性能指标与业务成功率的分母

配对性能指标只统计两边都有该指标的完整有效配对。例如只有无文档组记录了耗时，不能把有文档组当成 0 毫秒。

运行总量则可以纳入错误运行中仍有效的 token 与耗时，并报告有多少运行提供了该指标。这样既不会隐瞒失败请求产生的消耗，也不会让它们冒充成功配对。没有有效数据时输出 null，不输出看似准确的零。

报告还标出没有收益、负收益、满分饱和以及重复运行间的通过状态波动。这些标记用于提醒读者检查实验；它们不是统计显著性的替代计算。

## 31.18 怎样选择自己的测试层

修改精确编辑算法，优先给定小文件检查匹配、重复匹配和换行保留；修改取消队列，构造一个执行中仍占用文件的 Promise；修改会话事件，使用 suite harness 检查真实事件与日志；修改模型协议，使用可控响应流检查请求和事件转换；修改文档指引效果，再考虑完整模型评估。

本书增加文档和配套实验，已安装固定依赖并执行工程检查。首次 TypeScript 检查发现 Cloudflare 测试使用的模型标识与固定目录不一致；将 `claude-sonnet-4-5` 修正为目录中的 `claude-sonnet-4.5` 后，完整 `npm run check` 通过。另在隔离环境运行 stream.test.ts 与 cloudflare-stream.test.ts：2 个离线用例通过，233 个真实服务用例跳过，详情见附录 B。没有启动 Docker 构建或调用真实模型。工程检查与局部实验通过，仍不能被称为整个项目的测试已通过。

## 31.19 存储一致性不能只断言主表内容

[storage-conformance.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/testing/storage-conformance.ts) 提供与具体测试运行器无关的一组用例。调用者传入断言接口和 `withStorage()`，每个用例获得独立存储，再检查同一份 Storage 契约。[runner.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/testing/runner.ts) 与 [assertions.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/testing/assertions.ts) 将它接到 Vitest/Jest 风格接口，而不让存储契约依赖其中一个运行器。

一个关键轨迹是：先建立 task、submission 和 document；下一笔提交改变任务状态、改变 submission 状态、追加 entry，最后故意创建冲突 document。提交应失败，而且所有主表与二级索引都保持原样。

```text
失败前：task=pending，requestId 指向 queued submission
失败提交：task→running，submission→unanswered，增加 entry，制造地址冲突
失败后：task 仍 pending；pending 查询仍能找到它；requestId 查询仍返回原记录；entry 不存在
```

只验证 `task(id)` 会漏掉“主表回滚了，但状态索引没回滚”的错误。用例因此同时检查精确读取、过滤扫描和逻辑地址查询。

其他契约检查包括：输入和返回值的深层引用分离；`__proto__` 等键不改变对象原型；乱序 ID 的索引顺序；分页中新增记录不会重放已经越过的部分；多层 fork 的每级截止点；document 的 base/delta、版本转换、历史与退休区间；复制来源歧义；全局 ID 命名空间与耗尽；close 后操作失败。这些是已阅读的断言，不代表所有存储 adapter 在本工作区已经运行通过。

[storage-benchmark.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/testing/storage-benchmark.ts) 通过公开接口生成 1k/10k 规模数据、0/16/128/1024 个 delta 尾部、历史 base 前后和八级 fork，再提供读写样本。样本还声明预期结果，避免一个返回错误空值的实现反而“跑得最快”。文件本身没有给出所有 adapter 的性能结论，性能必须结合实际测量环境。

## 31.20 练习

1. 在响应工厂中增加一个可手动解除的 Promise，构造两个请求完成顺序与领取顺序相反的测试。
2. 为什么断言所有工具都有结束事件，还不足以证明这些工具没有产生外部写入？应当增加哪个断言？
3. 给一个三配对计划删除一条观测，解释标题通过率、有效配对性能指标和运行总消耗各自如何变化。
4. 为什么无文档组不能只删除磁盘 docs，却保留系统提示词中的文档指引段落？
5. 给终端进度条评估增加 0% 输入。说明应检查显示、会话百分比和其他状态文本中的哪些行为。

下一章转向构建与交付：源码怎样成为可安装包，浏览器与 Node 入口怎样分开，以及独立二进制需要哪些特殊资源处理。

## 31.21 使用配套实验核验本书的局部结论

[labs/README.md](labs/README.md) 给出 8 组离线用例的完整输入、执行方式、断言与限制。先运行 `node labs/run-offline.mjs loop`，观察预检、实际执行、结束事件和 transcript 顺序；再运行 compaction/search，把第十四、二十三章的数字与真实函数返回值比较。最后用 sync-book.mjs --check 验证源码节录、哈希、分章目录和章节统计。

配套程序使用可控 Promise、内存模型流和模拟 spawn。它刻意不替代 suite/harness.ts 的会话集成范围；若要修改产品，应在相应正式测试层补齐验证。初版临时实验与本次可复现用例也分别记录，避免把历史“通过”当成当前可重新执行的证据。
