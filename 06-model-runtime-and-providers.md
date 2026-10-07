# 第六章模型目录、认证与提供商适配

假设用户选择一个模型，随后扩展注册了同名提供商，后台又在下载新模型目录。应用必须回答三个问题：当前可选模型是谁，真正发请求时用什么认证，以及迟到的旧目录能否覆盖新配置。本章从这些问题进入模型运行时，再沿 OpenAI Responses 和 Anthropic Messages 的具体实现追踪请求。

## 6.1 模型、提供商和 API 是三个对象

| 概念 | 例子 | 职责 |
| --- | --- | --- |
| 模型 | 一个具体模型目录条目 | ID、输入能力、上下文限制、费率、协议兼容参数 |
| 提供商 | `Provider` | 认证、模型列表、请求操作及可用性过滤 |
| API 实现 | `ProviderStreams` | 将统一消息转换成某种网络协议，再还原事件 |

同一提供商可用多种 API；多个提供商也可复用同一种 API。因此分派时既要找到模型所属提供商，也要检查模型的 `api`。

当前模型类型还包含图像生成和结构化分类，聊天类型未显式填写 `type` 时默认为 `chat`。同一个上游 ID 可以对应不同操作，目录合并应按“类型＋ID”处理，而不能只用 ID。

## 6.2 核心入口为何不自动装入所有提供商

[index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/index.ts) 的核心导出避免自动注册整个生成目录和所有提供商。使用者可以创建 `Models` 集合，再注入所需提供商。

[providers/all.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/providers/all.ts) 提供全量内置目录和工厂；`compat.ts` 则保留全局 API 注册表等兼容入口。二者有不同导入副作用和认证路径，不能因为都能调用 `streamSimple` 就当作同一个接口。

生成的 `*.models.ts` 从 JSON 数据分片读取目录，再按类型展平。这些文件不应手工修订；目录更新应沿生成脚本处理。

## 6.3 Models 集合怎样分派一次请求

[models.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/models.ts) 的 `ModelsImpl` 持有提供商 Map、凭据存储、目录存储和认证环境。

一次 `streamSimple` 的轨迹是：

```text
标准化 Context
  → 建立外层事件流
  → 确认是聊天模型并找到 Provider
  → 解析认证
  → 合并请求头、环境和认证产生的 baseUrl
  → Provider.streamSimple
  → API 实现转换请求、消费网络事件
```

请求选项按字段覆盖认证结果；`transformHeaders` 在组装后运行，且不会作为普通字段传入底层提供商。请求头合并函数按大小写不敏感的名称处理覆盖；`null` 是抑制某个默认头的约定，最终网络转换路径也必须遵守它。

`completeSimple` 只是等待对应流的 `result()`。它不会自动把所有错误结果转换成 Promise 拒绝，调用者仍需检查 `stopReason`。

## 6.4 可列出不等于可调用

`getModels` 同步读取已知目录；`getAvailable` 异步确认提供商配置了认证，再应用凭据相关过滤策略。

“认证已配置”也不等于已进行真实网络验证。OAuth 可用性检查可直接确认存储类型与处理器匹配，无需刷新 token；配置中的取 key 命令也可以先标记为已配置，到请求时才执行。

普通目录读取会把某个提供商抛错视为该提供商没有模型；可用性路径直接调用提供商方法，不能推广成所有公开读取都永不失败。

编码代理给扩展提供的 [ModelRegistry](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/model-registry.ts) 是同步快照外观。内部使用异步 `ModelRuntime`。注册后立即读取快照，可能处于暂定配置状态，后续可用性检查才会校正它。

## 6.5 认证优先级与失败语义

[auth/resolve.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/resolve.ts) 先处理显式请求 key，然后读取存储凭据。已有凭据时，按其类型选择处理器；没有存储凭据时，才进入环境变量、云平台身份等环境来源。

已有 OAuth 凭据刷新失败，不会悄悄改用环境里的另一把 key。已有凭据类型没有对应处理器，也不会被当作“没有凭据”后继续兜底。

这样的边界让调用身份可预测。例如用户以订阅身份登录，订阅 token 失效时应报告这次身份的错误；自动换成付费 API key 会改变计费身份和模型权限。

各提供商仍能在自己的 key 解析器中按字段处理环境配置。统一认证层的优先级，并不意味着所有云提供商都只有一个字符串 key。

## 6.6 OAuth 刷新为何在锁内重新检查

token 距到期不足默认五分钟时，请求进入凭据存储的 `modify`。其回调读取的是锁内当前值：

```text
A、B 都看到旧 token 即将到期
A 获得锁 → 刷新 → 保存新 token → 释放
B 获得锁 → 重新检查新 token → 无需刷新
```

OAuth refresh token 可能轮换；两个请求都使用旧 token 刷新会使后一个失败，甚至覆盖有效凭据。因此“锁外发现过期”只是准备条件，锁内重读才是权威判断。

请求刷新使用合并的取消信号和十五秒超时。显式要求最低有效期时，还会检查刷新后 token 是否满足要求；默认的提前刷新窗口则主要决定何时尝试刷新。

互斥强度取决于注入的存储实现。内存存储按提供商 Promise 链串行化；文件存储的跨进程锁见第十五章。类型接口中的约定不能让一个不正确的自定义存储自动获得互斥能力。

## 6.7 目录刷新先恢复缓存，再联网

`Models.refresh` 对选中的动态提供商并发运行，但每个提供商分成两阶段：先读取持久目录，在 `allowNetwork: false` 下恢复缓存；随后确认凭据，才进入联网刷新。

即便凭据读取失败，也先尝试恢复目录，再报告认证错误。因此启动时可以仍然显示已知模型。

目录刷新用的 OAuth 过期判断和普通请求认证不同：它主要判断 token 是否已经到期，不应把请求路径的五分钟窗口和十五秒刷新超时机械套用到这里。

静态提供商、未知 ID 和未配置动态提供商被跳过。结果包含 `aborted` 与按提供商归类的错误 Map，某一提供商失败不会要求所有目录一并消失。

## 6.8 代次怎样阻止迟到请求覆盖

每个提供商有递增的刷新代次。开始新刷新、替换提供商或删除提供商时，旧刷新被取消，并失去当前代次资格。

```text
刷新 A，代次 8，网络很慢
刷新 B，代次 9，先完成
A 后到，发布时发现 8 ≠ 9，拒绝更新内存目录
```

所有发布还按提供商进入 Promise 链。发布先检查信号和代次，再执行选定的存储写入，最后再次检查，再同步更新提供商内部状态。

两次检查有不同用途：第一次阻止已过期任务开始写；第二次阻止写入等待期间被取代的任务更新内存。

这不是跨持久存储和内存的数据库事务。若自定义存储已经写入、却不配合取消，第二次检查无法撤销那次写入；它只能拒绝后续内存发布。新代次发布会排在旧存储操作真正结束后，避免仅因调用者停止等待就提前释放队列。

## 6.9 编码代理怎样叠加配置

[ModelConfig](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/model-config.ts) 读取 `models.json`，去 BOM、去 JSON 注释、解析并验证模式，将配置深复制后冻结。它不在读取配置时解析凭据。

[provider-composer.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/provider-composer.ts) 负责组装以下层次：

```text
原生扩展提供商或内置提供商
  → models.json 的自定义模型与提供商设置
  → 扩展配置中的模型集合
  → 兼容 OAuth 的模型变换
  → models.json 的 modelOverrides
```

扩展显式提供 `models` 时是替换模型集合，不能假定它总是追加；`models.json` 自定义模型则按 ID 更新聊天模型或增加新项。用户的 `modelOverrides` 最后应用，以便覆盖扩展最终模型。

部分嵌套配置按字段合并，例如图像限制、resize、思考映射和若干路由配置；数组通常替换。新增覆盖字段时，要读这些专用函数，不能只在顶层加一个对象展开就认为行为一致。

组装失败会记录提供商错误，并尽可能保留基础提供商。配置模式有效也不等于所有组合可运行：API、baseUrl、限制值和执行实现之间仍有额外结构检查。

## 6.10 可用性刷新也需要防止旧快照回写

`ModelRuntime` 的可用性快照包括全部模型、可用模型、已配置提供商、存储凭据来源和认证检查结果。

全量刷新有序号；单提供商刷新也有自己的序号。凭据变更会使更早的全量结果失效；新的全量刷新又使更早的单提供商结果失效。

单提供商刷新只替换该提供商的数据，并保留其他提供商已经更新的状态。错误状态也有序号，避免旧检查成功后清除一个更新的错误。

这里防止的是异步完成顺序造成的内存快照回退，和第十五章防止磁盘凭据互相覆盖是不同层次。

## 6.11 凭据提交成功后，同步仍可能失败

登录、登出和运行时 key 修改按提供商排队。操作提交之后，还需重组提供商、恢复目录并刷新本地可用性。

如果凭据已保存，但后续同步失败，`CredentialSynchronizationError` 明确记录“凭据操作已提交、本地同步失败”。调用者不能把这个错误解释成登录未发生，也不能通过无条件重复登录模拟回滚。

开始前的取消可让排队操作退出；已经开始的操作要按真实任务链完成。停止等待与撤销提交不能混为一谈。

## 6.12 远程目录的条件请求和时间戳

[remote-catalog-provider.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/remote-catalog-provider.ts) 在静态内置目录上叠加持久远程目录。

远程条目需要比本地生成时间更新，才成为有效覆盖；它按“类型＋ID”合并。目录还保存 `ETag`、`Last-Modified` 和上次完成检查时间。

通常四小时内可跳过重复检查；强制刷新绕过这个窗口。有缓存实体时才发送 `If-None-Match`，避免拿到 304 却没有可用实体。

304 只推进检查时间；404/501 记录不可用状态；暂时失败保留缓存与验证器，并报告错误。正常结果经代次检查后先持久化，再更新内存。

解析器允许数组、带 `models` 的对象或条目映射，并过滤未知类型。它没有对每个远程模型字段做完整模式校验，不能把“过滤未知类型”写成“网络目录已完全验证”。

## 6.13 模型名称怎样解析

[model-resolver.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/model-resolver.ts) 区分精确引用、部分名称、通配范围和 CLI 选择。

优先尝试完整模型 ID，再判断最后一个冒号是否为思考级别。这样含冒号的真实 ID 不会先被拆坏。CLI 严格模式不会把任意无效后缀都当作思考级别修正；范围模式可以产生诊断后回退。

同一个裸 ID 可能属于多个提供商。CLI 的直接精确匹配路径会优先选择唯一已配置认证的候选，否则要求明确提供商。其他部分匹配或回退路径有自己的排序与查找逻辑，不能概括为“所有歧义一律报错”。

部分匹配优先选没有日期后缀的别名，再按 ID 字符串排序选项。这个规则不是对模型实际能力的排名。

未知模型 ID 在明确提供商的某些 CLI 路径可沿基础模型元数据构造候选，并发出警告。继承的上下文和能力只是本地假设，不能证明服务端存在或支持这个模型。

## 6.14 虚拟模型怎样路由到物理模型

[virtual-models.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/virtual-models.ts) 允许把“选择模型”与“每次请求的实际模型”分开。用户选择一个虚拟条目，路由器根据消息、调用原因和分支状态选择物理模型。

路由返回后，运行时从当前目录重新取得物理条目，拒绝再次路由到虚拟模型或未配置认证的提供商，并将思考级别限制到目标支持集合。

助手消息记录实际回答的物理模型；用户选择仍可保持虚拟模型。路由状态以分支上的自定义日志项保存。

直接摘要请求也可路由，但不保存这次路由状态。跨提供商路由时，不把原提供商的显式 key、请求头和环境配置自动发送给目标提供商；目标解析自己的认证。

不是所有入口都自动路由。API 专用的 `stream` 遇到未路由虚拟模型会失败；通用 `streamSimple` 才包含直接请求的路由路径。

## 6.15 通用参数怎样变成提供商参数

[simple-options.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/simple-options.ts) 将通用选项复制给具体 API，并按估算上下文留下 4096 token 的安全余量，限制输出预算。估算超出窗口时仍至少给出 1，不能据此宣称它总能构造被服务端接受的请求。

思考级别映射由模型能力和 API 决定。`clampThinkingLevel` 对不可用级别先向更高的可用档位查找，再向低档查找，并非一律向下取整。

预算式思考还要为最终回答留空间；自适应思考则映射 effort。若更改思考级别，应同时检查 UI 选择、模型映射、通用选项和提供商参数，避免只改一个字符串列表。

## 6.16 OpenAI Responses 的请求转换

[openai-responses.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/openai-responses.ts) 先按兼容能力决定是否折叠系统消息，再构造客户端、参数和工具声明。

请求通常含 `model`、`input`、`stream: true` 和 `store: false`。内容转换在 [openai-responses-shared.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/openai-responses-shared.ts)：用户图像成为 data URL；助手文字成为带 ID 的输出消息；工具调用和结果转换为对应 call/output 项。

Pi 的工具 ID 可把 call ID 与响应 item ID 用竖线组合。适配层分别处理两部分：结果匹配 call ID，重放原调用时还需处理 item 类型、长度和来源。换模型时会去掉不适用的配对 ID；跨来源长 ID 可缩短为确定性哈希。哈希用于协议标识，不是冲突检测锁。

模型能力决定工具是普通 function、严格 JSON 模式还是 grammar custom tool。后加入工具还可表达为额外工具声明或客户端工具搜索结果；这是将声明变化映射到协议，不会实际运行一轮服务器搜索工具。

最终 `samplingParams` 按模型默认值、请求值顺序覆盖组装参数，因此也可能覆盖前面命名字段。这个扩展口需要审查，不能把前面的参数设置当作不可绕过约束。

## 6.17 Responses 为什么按 output_index 保存内容槽

一个响应可能交错产生思考、文字和多个工具参数。共享处理器用 `output_index → 内容槽` 的 Map 关联网络事件，再用内容槽的 `contentIndex` 发送 Pi 事件。

```text
output_item.added，索引 2 → 创建工具内容槽
arguments.delta，索引 2 → 累积 JSON，更新预览
output_item.done，索引 2 → 最终参数，删除临时缓冲
response.completed → 最终状态与用量
```

结束块的最终内容是权威值，不能只信收到的增量。思考签名还可能只在最终 response 的 output 中出现，需要补齐以支持无服务端存储的历史重放。

正常 EOF 必须见过终止响应事件。工具结束若缺少 `output_item.done`，临时缓冲仍存在；即使总体状态是工具调用，也拒绝把这些未完成参数交给代理执行。

`incomplete.max_output_tokens` 映射为长度截断；其他 incomplete 原因成为错误，避免把内容过滤等状态误写为普通长度限制。

## 6.18 Anthropic Messages 的消息组织

[anthropic-messages.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/anthropic-messages.ts) 将助手工具调用变成 `tool_use`，把连续的工具结果组合成一条 user 消息里的多个 `tool_result`。

系统更新不能把调用和结果拆开。转换器暂存后续系统消息，在下一条助手之前或历史末尾发出；因此源码中的更新位置与线上的实际位置可能不同。

受保护思考保留 opaque 数据；普通思考需要有效签名才能按原思考块重放，没有签名时通常降为文字。兼容参数可允许空签名，但它是具体提供商契约。

支持原生工具变更且初始已有工具时，请求顶部工具保持稳定，后续用 `tool_addition`、`tool_removal` 表达更新；初始还加入一个始终不激活的 deferred 占位工具，以保持协议前缀形状。否则发送当前完整工具集合。

这些行为都是本提交适配层的实现，不能当作所有 Anthropic 兼容服务共同支持的能力。

## 6.19 Anthropic 的缓存、认证与思考

缓存设置为 none 时不添加缓存控制；长缓存在兼容能力允许时使用一小时 TTL。系统提示、最后一个工具以及末尾合适消息块可设置缓存断点。

订阅 OAuth token 走 Bearer 认证与对应客户端身份参数，部分工具名转换为协议要求的大小写，返回时映射回实际工具名。这个映射不改变本地工具注册和执行函数。

普通 key、显式认证头和 workload identity 分别有路径。`PiAnthropic` 禁止 SDK 再自行解析默认凭据，避免 Pi 已选择认证头后 SDK 又执行另一套凭据链。联合身份客户端缓存与配置和 fetch 身份关联，单次请求用克隆选项复用 token 缓存。

预算思考与 adaptive 思考分支不同。支持中途 effort 的模型还记录历史提供商级别，并插入相应系统配置以重放；当前请求的统一思考级别与实际 provider effort 不必是同一个字符串。

## 6.20 Anthropic 怎样解析 SSE

这里从 HTTP 原始响应读取 SSE，增量解码 UTF-8，按行累积事件和多行 data，忽略注释与不相关事件。识别消息开始、内容开始/增量/结束、用量变化和消息结束。

内容块使用提供商的块 index 关联内部内容；结束后移除 index、部分 JSON 等临时字段。用量的增量字段只在出现时覆盖，避免代理省略输入用量时把开始事件记录的值清零。

如果见过消息开始却没有消息结束，报告中断；最终结束原因仍为 pending 也失败。这里与 Responses 的工具完成检查实现不同，不应把一种 API 的所有防护自动推广到另一种。

服务端回退在尚未输出内容时可处理；已输出内容后再出现回退块则拒绝，以免一条响应混入不受支持的模型输出。实际 responseModel 和允许回退的费率可用于用量记录。

## 6.21 严格模式是模式转换，不是一个开关

[constrained-sampling.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/constrained-sampling.ts) 把可支持的对象模式转换为提供商严格子集：所有属性变成 required，原本可选属性允许 `null`，并禁止额外属性。

引用、部分组合模式、元组和其他不支持形状会失败。要求严格模式时明确拒绝；仅偏好严格模式时可回退。Anthropic 还有额外不支持关键词检查。

grammar 工具使用一个必需字符串字段；原始文本流被编码成这个属性对应的 JSON 增量。缓冲要求文本只追加增长，关闭后不能改变。它不能拿来任意包装多个独立必需字段。

提供商生成约束和本地执行前验证仍是两层。前者减少错误生成，后者保护运行入口，不能因为打开 strict 就删掉参数验证。

## 6.22 重试有两层，不能无限相乘

提供商请求层处理 HTTP 状态、服务端 retry 头和建立响应时的错误。OpenAI/Anthropic 请求明确禁用 SDK 自带重试，再用 `retryProviderRequest` 提供可取消等待；其默认重试次数为零，由上层选项决定。

服务端请求等待超过默认六十秒上限时直接报错，而非把一个巨大等待静默截短。没有服务端等待指令时，指数退避带随机抖动。

助手调用层 `retryAssistantCall` 则检查返回消息的错误文字与策略。账单、额度耗尽等排除规则优先于临时错误规则；取消结果不重试。这里使用有上限的指数等待，不能因注释提到 jitter 就说当前函数也一定加了随机抖动。

提供商层在取得流之前重试请求；取得流以后出现的中断可能交给助手层或应用会话恢复。多层配置需同时评估最大尝试次数，不能只看其中一层。

## 6.23 用量与费用如何归一化

Responses 输入总量包含缓存部分，适配层减去缓存读写后记录普通输入；Anthropic 分别提供这些字段，Pi 再计算总量。

`calculateCost` 按输入、缓存读写合计寻找严格超过阈值的最高匹配费率档位；不是按数组位置简单选最后一项。费用按每百万 token 换算，长缓存写入另有公式，reasoning 不重复计入输出。

Responses 还可按服务 tier 修改费用乘数。它是本地目录和适配规则计算结果，不是账单系统的最终对账凭据。

## 6.24 修改模型层时应检查什么

| 修改目标 | 必须跟踪的路径 |
| --- | --- |
| 新增模型元数据 | 生成脚本、JSON 分片、类型目录和默认选择 |
| 新增提供商 | 工厂、认证、模型列表、API 实现、全量注册入口 |
| 新增配置字段 | ModelConfig 模式、composer 合并、运行时请求解析 |
| 修改动态刷新 | 代次、取消、存储发布、内存发布和错误快照 |
| 修改流式工具参数 | 块关联、预览解析、结束检查、帧重放、执行前验证 |
| 修改认证 | 读/改锁、轮换 token、显式覆盖和提交后同步 |

练习：旧目录请求晚到，为何仅在发请求前检查一次代次不够？网络等待期间新代次可能已生效，发布时必须再次判断。

练习：凭据已保存，本地可用性刷新失败，是否应该显示“登录没发生”？不应如此；提交和同步是两个边界。

练习：同一工具 ID 在两个 API 中长度和格式不同，应只改调用 ID 吗？还必须同步结果关联，并保留或移除与来源相关的 item 标识和签名。

## 6.25 OpenAI Chat Completions：兼容协议也需要适配

[openai-completions.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/openai-completions.ts) 服务于多个提供商。它先推断默认兼容能力，再用模型的显式 `compat` 字段逐项覆盖。是否接受 developer 角色、是否支持 `store`、最大输出参数叫什么、是否提供结束原因，都是独立选择。

例如，上游要求工具结果之后必须接助手消息，Pi 会在需要时插入桥接消息。历史里已经用过工具、当前却没有可调用工具时，还可能发送 `tools: []`。这些细节解决的是具体服务的消息契约，不能因为接口名字相同就省略。

请求转换还处理以下情况：

| 统一消息中的内容 | 线上的处理 |
| --- | --- |
| 起始系统提示 | 按模型能力使用 system 或 developer |
| 对话中途的系统更新 | 支持时保留；工具新增还需要对应能力同时成立 |
| 助手文字 | 通常合并成字符串，避免服务把数组当作普通文本 |
| 思考 | 使用提供商约定的字段，或在明确兼容配置下转成文字 |
| 工具结果中的图片 | 文本结果先成为 tool 消息，图片集中到后续 user 消息 |
| Responses 来源的复合调用 ID | 缩短、规范化并同步修改调用与结果的关联 |

受保护思考可能位于 `reasoning_details`，不能当作可显示的普通文字。适配器保留必要的不透明元数据用于重放；跨协议转换仍应遵守来源条件。

同一增量可能包含 `reasoning_content`、`reasoning`、`reasoning_text`。当前实现取首个非空字段，避免把同一内容重复加入输出。工具调用优先按 index、其次按 ID 关联；ID 或名称晚到时补齐已有槽位，参数逐步累积并进行宽容 JSON 预览解析。

EOF 时先结束内容块，再检查取消、错误和结束原因。声明支持 finish reason 的模型若没有收到它，会被视为异常；声明不支持时才允许推导 stop 或 toolUse。这条路径没有 Responses 的 `output_item.done` 事件，因此不能声称两者使用同一种完整性检查。本地参数验证仍负责阻止不合格参数进入工具。

普通输入用量按 `max(0, prompt - cacheRead - cacheWrite)` 计算。输出 token 已包含上游给出的推理部分时，不能再加一次 reasoning。响应声明的实际模型可被记录，但不代表这条路径必然重新查找实际模型费率。

## 6.26 思考、缓存与路由参数为何不能统一写死

Chat Completions 的思考参数有多种形式：普通 `reasoning_effort`、OpenRouter 的 `reasoning.effort`、Qwen 的 `enable_thinking` 或 `chat_template_kwargs`、DeepSeek 的 thinking 对象，以及其他兼容服务的专用字段。

`off` 也不总等于发送同一个 false。有的配置要求省略字段，有的要求 disabled，有的只接受字符串。模型的映射及默认值决定具体请求。最终 sampling 参数仍可覆盖已经构造的字段，应把它理解为受调用者控制的扩展口。

缓存同样分层：session ID 可用于请求关联或缓存亲和；`prompt_cache_key`、缓存保留时间、Anthropic 风格 `cache_control` 则只有对应能力允许时发送。设置 none 会影响这些分支，但不能据此认定服务端绝不会保留任何数据。

一个缓存断点通常放在系统消息、最后一个工具或末尾合适文本块，而不是给所有块都加同一标记。修改缓存策略时，应核对消息前缀稳定性、工具声明变化和每种 API 的字段支持。

## 6.27 Google：同一块内容的签名和显示用途不同

[google-shared.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/google-shared.ts) 为 Generative AI 与 Vertex 共用消息转换。中途系统消息会先折叠；起始系统提示成为请求配置中的 `systemInstruction`。

`thought: true` 决定块是否为可显示思考；`thoughtSignature` 本身不是“这一定是思考文本”的判断依据。有效签名只在同一提供商、同一模型的重放路径保留。没有文字但带有效签名的块也可能有协议意义，不能随意删除。跨来源思考通常降为文字并去掉签名。

工具调用 ID 在特定模型上会规范化为允许字符并限制长度。响应缺失 ID 或返回重复 ID 时，本地创建新的调用 ID。调用参数通常在一次函数块中完整出现，随后立即发出开始、参数与结束事件；这和逐字符流式 JSON 的适配方式不同。

连续工具结果可组合进一个 user 消息。Gemini 3 及以上把结果图片放入函数响应的 parts；较早 Gemini 使用额外 user 图片消息。模型不支持的图片不会因为统一消息类型能表达它就获得支持。

严格工具声明使用新参数字段；旧模式走另一条模式清理路径。旧清理器不能被概括成完整 JSON Schema 引用展开器，数组节点等细节必须按实际实现判断。

流处理把连续同类文字或思考合并成块，保留收到的有效签名。STOP 在存在工具调用时变成 toolUse；MAX_TOKENS 变成 length；其他异常结束原因以及没有结束原因的流成为 error。

用量中普通输入为 prompt 减缓存部分，输出包含候选输出和思考 token；这里没有缓存写入用量。不能将 Chat Completions 的钳制公式或 Anthropic 的缓存写字段直接搬过来。

## 6.28 Generative AI、Vertex 与 Azure 的客户端配置

[google-generative-ai.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/google-generative-ai.ts) 使用 SDK 请求流。当前实现拒绝自定义 fetch；它也没有按原始 HTTP 请求路径触发统一 `onResponse` 回调。`onChunk` 被等待，因此慢回调会延迟消费后续块。请求取消信号与结束时的取消检查都保留。

Gemini 的离散思考级别与预算思考采用不同分支。关闭思考也受模型能力限制，可能被映射到最低可用级别。Generative AI 和 Vertex 的预算默认值存在具体差异，不能只看共用转换器就推断全部配置相同。

[google-vertex.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/google-vertex.ts) 区分直接 API key 与应用默认凭据。默认凭据路径要求项目与区域，并可设置服务账号文件。带 `{location}` 占位符的目录地址交给 SDK 的标准路由；自定义地址另行处理路径和 API 版本，避免重复版本段。

[azure-openai-responses.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/azure-openai-responses.ts) 复用 Responses 消息转换与响应处理器，但单独解决地址、部署名称和 API 版本。Azure 地址可规范化到 `/openai/v1`；普通自定义路径不会一概被重写。部署名称优先采用请求选项，其次环境映射，最后模型 ID。

Azure 禁用 SDK 自带重试，再接入公共请求重试；请求包含 `store: false`，思考重放按共享 Responses 规则处理。最终 sampling 参数仍可覆盖生成参数。共用协议处理器减少重复代码，不能消除客户端配置差异。

## 6.29 提供商工厂：选择能力与解析认证

[providers](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/providers) 下许多小文件只把目录、认证与现有 API 组合起来。复杂网络转换放在 `api`，这样新增一个兼容提供商不必复制整个流解析器。

| 工厂或类别 | 需要特别核对的行为 |
| --- | --- |
| 多数 Chat Completions 提供商 | 目录、环境 key 名、baseUrl 和兼容字段 |
| GitHub Copilot | 三种聊天 API、OAuth 可用模型过滤、按历史设置请求身份与图片标记 |
| Cloudflare AI Gateway | 账户、网关与 key 分字段解析；注入网关认证并抑制上游默认认证头 |
| Google Vertex | key、默认凭据或服务账号文件；可用性检查不等于联网认证成功 |
| Amazon Bedrock | bearer、profile 或 SDK 凭据链；认证结果不复制整套云凭据 |
| OpenRouter | 聊天、图像生成与分类是分别注册的能力 |
| Typesafe | 结构化分类能力，不应列为同一种聊天实现 |
| Radius | 基线目录、存储目录恢复、网络配置刷新和受代次约束的发布 |

工厂可延迟加载 API 模块。图像 API 注册表也会缓存导入 Promise；当前实现没有在导入失败后自动清空缓存，因此“下一次调用必然重新导入”并不成立。

Opencode 的 session header 包装只在已有 session ID、且请求头没有同名字段时注入。该行为属于请求关联，不由遥测开关决定。

学习这类工厂时，先确认操作种类，再追踪认证解析，最后进入它选择的 API。仅看工厂十几行代码，无法说明它继承的历史重放、取消和流完成保证。

## 6.30 分类模型怎样返回概率

[system-one-shared.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/system-one-shared.ts) 把 state 与 questions 发送给分类服务。公共 bool 问题在线上叫 `noul`；返回时再变成概率值。choice 与 score 各有自己的结果形状。

解析器按请求中的问题逐项检查，缺失答案、错误类型或非有限数会失败；它并没有进一步要求所有概率位于 `[0, 1]`、概率之和等于 1，或 choice 一定属于给定选项。不要把形状验证写成完整语义验证。

请求最多默认重试两次，超时按每次尝试建立；结果解析在网络请求成功之后进行，不会因为答案形状不合格而自动再发同一次分类。用量先写入结果、后解析答案，保留“请求计费了，但答案不可用”的事实。

[typesafe-system-one.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/typesafe-system-one.ts) 采用直接 System One 外壳；[cloudflare-workers-ai-system-one.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/cloudflare-workers-ai-system-one.ts) 则解开 Cloudflare 的 success/result 包装，还区分直接答案与 Completed 运行记录。共用算法通过 transport 注入 URL、请求外壳和响应解包规则。

## 6.31 本地 llama.cpp 分类为什么要先查 token

[llama-cpp-classify.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/llama-cpp-classify.ts) 不依赖模型生成一整段 JSON。它给候选答案分配标签，读取下一位置这些标签的对数概率，再只在候选集合中归一化。

```text
choice 有甲、乙、丙三项
  → 分配 A、B、C
  → /tokenize 确认每个标签只有一个 token，且 token 不重复
  → /apply-template 渲染模型自己的聊天模板
  → /completion 请求一个位置的采样前概率
  → 对 A、B、C 的 logprob 做 softmax
  → 概率最大的标签还原为实际选项
```

softmax 先减去最大值再取指数，避免直接指数计算造成溢出。调用者的分类 temperature 用于缩放这些 logprob，必须是正有限数；它和请求给服务器的生成 temperature 不是同一个用途。

bool 使用 Yes/No；score 使用数字标签，结果是级别索引的概率加权平均。choice 限制 2 至 62 项，score 限制 2 至 10 级。

top logprob 列表可能没有某个标签，因此先取 `max(256, 16 × 标签数)`，不足时扩大到 4096、32768，仍缺失就报错；不能把没进入榜单当作精确零概率。

标签 token 的 Promise 按服务器、模型与标签缓存，失败时删除以允许后续重试。这个缓存没有把调用者的认证或 fetch 身份纳入 key；修改缓存范围时应考虑不同客户端是否真的访问同一词表。

同一分类请求的多个问题串行运行，让共同前缀有机会复用服务器提示缓存。一个问题失败时公开结果的 answers 清空；此前的网络工作并不会因此撤销。当前路径不返回逐题 token 用量。

## 6.32 图像生成和绑定传输

[openrouter-images.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/openrouter-images.ts) 将文字与输入图片组成单条 user 消息，用非流式 Chat Completions 请求 image 或 image/text modalities。它只提取第一项选择中的文字与符合 data URL 格式的 base64 图片，普通远程 URL 被跳过。

因此 stop 结果可能仍然没有图片；调用者应检查 output，而不是仅检查 stopReason。费用来自目录与返回 token 计算，不能把它推断为按张计费的实际账单。

[cloudflare-ai-binding.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/cloudflare-ai-binding.ts) 的职责更小：检查 AI binding 的 fetch 是否存在，并提前 bind 它。请求地址必须已经指向绑定支持的路由；这个包装不改地址、不缓存流、不重新编码正文。绑定身份认证与常规 HTTPS key 认证是不同传输条件，哨兵头只是满足上层适配器的本地认证前置检查。

## 6.33 Pi 自身的消息协议

[pi-messages.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/pi-messages.ts) 向 `<baseUrl>/messages` POST `{ model, context, options }`，直接发送 Pi 的统一上下文。它不再把每个角色转换成另一家提供商的格式。

服务端返回 SSE：客户端按 contentIndex 累积文字、思考和工具 JSON；块结束的完整内容覆盖增量预览。done/error 设置用量、响应 ID 与结束状态，还可记录服务端重写提示词的影响诊断。

必须收到终止事件；普通 EOF 会失败。这不是完全不可信事件的模式验证器：JSON 解析后主要按已约定的类型与事件顺序访问内容槽；缺失开始事件等错误可以在处理时抛出。

此解析器只取每个 SSE 事件的首个 data 行，没有实现通用多行 data 拼接。网络中途异常会创建新的空内容错误消息，不能保证已收到的部分文字一定保留在最终错误结果中。这里也没有接入公共请求重试或 options.timeoutMs 的独立超时；这些保证不能从其他提供商实现推移过来。

## 6.34 Mistral 的原生路径

[mistral-conversations.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/mistral-conversations.ts) 的 API 名称容易误导：本提交实际请求原生 `v1/chat/completions`，而不是服务端会话存储接口。

调用 ID 规范化为九位字母数字；请求级正向和反向 Map 发现规范化碰撞时重新派生 ID，并让调用与结果使用同一映射。文字、思考、工具结果图片和错误提示分别转换，工具模式使用严格 JSON 采样转换器。

请求对象先采用内部 camelCase 字段，再在发送时转换为 wire 的 snake_case。服务端 SSE 支持多行 data 与多种换行，取消会取消 reader；默认六十秒超时覆盖请求与流读取。该实现直接 fetch，没有复用公共请求重试函数。

流必须给出 finish reason，模型长度与输出长度都映射为 length；未知原因失败。工具参数仍为宽容预览解析，完成事件随后由代理执行层验证。思考附近的空文字增量被跳过，避免把本应连续的思考分裂成多块后造成历史重放错误。

## 6.35 Bedrock：云 SDK 与消息协议共同决定行为

[bedrock-converse-stream.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/bedrock-converse-stream.ts) 先折叠系统消息，再构造 `ConverseStreamCommand`。连续工具结果合入一个 user 消息；空必需文字用占位符代替；工具参数对象还会递归去掉空键名，避免 SDK 的文档序列化限制。

区域优先取模型 ARN 中的区域，其次显式选项与环境，再进入其他默认分支。自定义 endpoint 保留；内置标准 endpoint 不应强行压过用户设置的区域或 profile。显式 profile 会阻止直接注入环境 access key，从而让 SDK 凭据链按 profile 解析。

bearer 模式使用 token 认证；普通云凭据使用 SDK 签名。自定义头在 build 中间件阶段加入，但跳过 authorization、host 和 `x-amz-*`，避免覆盖签名关键头。原始响应头通过 deserialize 中间件观察，缺少该观察时才用 SDK 元数据补出有限信息。

它直接调用 SDK，没有按 options 配置公共请求重试、fetch 或独立 timeout；不要把其他提供商的 SDK 重试禁用策略推广到这里。SDK 默认行为仍是需要单独审查的依赖边界。

响应按 Bedrock contentBlockIndex 找内部内容槽。受保护思考以字节片段累积，结束时编码成 base64，保存时删除临时 Uint8Array 数组。普通签名和加密内容不能混在同一个签名字符串；重放时也分别成为签名思考或 redactedContent。

必须收到结束原因；过滤、guardrail 等未映射原因成为 error。即使没有每个内容块的 stop 事件，最终路径仍清理临时字段，但这不是 Responses 那种“缺少工具块 done 就拒绝”的相同算法。

## 6.36 订阅 Responses：两种传输复用一个内容处理器

[openai-codex-responses.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/openai-codex-responses.ts) 是本提交保留的订阅后端实现。它从 token 的 JWT 内容提取 account ID，设置专用身份头，再复用 Responses 消息转换和内容流处理器。

JWT 内容解析只用来取得请求字段，不是本地密码学验签。token 是否有效由认证服务与后续后端处理决定。

请求使用 `store: false`，并包含加密思考重放字段。SSE 路径可用运行时支持的 zstd 压缩正文；压缩不可用或失败时发送原 JSON。WebSocket 则发送 `response.create` JSON 帧。

SSE 的 options.timeoutMs 在这里主要用于等待响应头；取得响应后，不应描述为整个流的总时长限制。WebSocket 的连接超时默认十五秒，options.timeoutMs 用于没有待消费事件时的空闲等待。两种计时边界不同。

网络事件先规范化为共用 Responses 事件，包括终止事件与 endTurn。服务端错误、坏 JSON 和用户回调抛错分别有专用类型；这些错误不能一概视为网络断线并重发请求。

## 6.37 WebSocket 缓存怎样处理并发与续接

连接缓存按 session ID 与 account ID 建立。已有连接空闲、仍打开且未超过五十五分钟时，先同步设置 busy，再复用；已忙时创建临时连接，使用后关闭。成功的缓存连接变为空闲，并设置五分钟空闲关闭计时器。

```text
A 取得缓存连接 → busy = true → 发送请求
B 同一会话请求 → 看到 busy → 建立临时连接
A 完成 → busy = false → 等待后续复用
B 完成 → 关闭临时连接
```

busy 保护的是已存在连接，首次建连并没有缓存共享 Promise。因此两个请求都看到缓存为空时，仍可能各自联网建连，后完成者覆盖缓存入口。这是按实现可推导的建连边界，不是“所有同会话请求已串行”。缓存 key 也没有包含 URL、完整认证头或 token；定制连接复用时应审查这些配置变更条件。

续接先比较除 input 和 previous_response_id 外的请求字段，再检查当前输入是否完整包含“上一请求输入＋上一响应项”的前缀。比较采用 JSON 序列化结果；匹配才发送 previous_response_id 和剩余 input。不匹配就清空续接状态，发送完整上下文。

这里使用连接内的响应状态，不需要把 store 改成 true。明确选择 `auto` 或 `websocket-cached` 才启用当前函数中的续接分支；外层 transport 缺省按 auto 选传输，但内层检查的是 options 字段本身。缺省选择与显式 auto 在这一细节上并非完全相同。

清理函数关闭会话连接；失败时清空续接状态并关闭当前连接。释放时按对象身份检查缓存入口，避免旧连接的结束逻辑删掉后来替换的新入口。

## 6.38 为什么流开始后不能直接换传输重来

WebSocket 尚未输出事件时发生可回退传输错误，可改走 SSE。已经输出事件后再断线，则报告这次错误，避免在同一助手消息里混入重新生成的答案。连接额度和 previous_response_not_found 各有一次专门重试，不能扩展为任意无限重试。

发生传输失败的 session 会记录 SSE 回退状态，后续可跳过 WebSocket。显式 websocket 选择也经过这些分支，不能把选项名字解释成绝对禁止 SSE 的保证。

SSE 自有重试循环默认次数为零。状态分类、错误格式化和 catch 后的文字规则共同决定重试，不能只看最初的状态判断就说所有非临时 HTTP 错误永不重试。

WebSocket 事件队列没有独立长度上限；message 回调还会异步解码 Blob 等数据，没有显式串行解码链。通常字符串事件的顺序容易保持，但不能推断任意自定义异步数据解码都自动有同样的顺序保证。

## 6.39 OAuth 基础：授权码、PKCE 与 state

OAuth 登录让用户在认证服务授权，再把取得的凭据交给应用。授权码是一次交换材料；access 是请求凭据；refresh 供后续续期使用，但部分提供商会复用字段表达自己的身份材料。

[pkce.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/pkce.ts) 用 Web Crypto 生成 32 字节随机 verifier，将其 SHA-256 摘要编码为不带 padding 的 base64url challenge。浏览器授权发送 challenge，交换授权码时发送 verifier，服务端据此绑定这次交换。

state 用于关联本次授权与回调；它和 PKCE 的目的不同。有的流程使用独立随机 state，有的把 verifier 也用作 state。不能仅因为 URL 中有 code 就接受它属于当前登录。

教材中的端点、scope 和字段均描述本提交代码；修改认证协议时，应重新核验目标服务契约。

## 6.40 回调与手工输入怎样避免重复完成

[callback-server.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/callback-server.ts) 建立本地 HTTP 服务，检查 GET、path 和配置的 state。第一次有效 code 到达时，在 await 交换前先同步设置 claimed；随后有效重复请求返回 409。settled 再保证等待 Promise 只结算一次。

```text
浏览器回调 A → 验证 → claimed = true → 等待 token 交换
回调 B 到达 → claimed 已为 true → 409
用户完成手工输入 → cancel()
  → 若尚未 claimed，停止回调等待，采用手工结果
  → 若已经 claimed，等待正在进行的回调完成
```

取消回调等待不会自动撤销已经开始的 token 请求。交换函数是否接受相同取消信号，是另一层边界。close 结束等待并关闭监听；不要把它描述为任意网络副作用的回滚。

共同辅助函数同时启动手工提示，浏览器成功后取消手工提示。没有 callback 时则直接使用手工输入。认证页面通过 [oauth-page.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/oauth-page.ts) 对消息和错误详情进行 HTML 转义，避免将服务错误文字直接当作标签执行。

## 6.41 设备码轮询：退避与到期是不同判断

[device-code.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/device-code.ts) 接受 pending、slow_down、failed 或 complete。缺省间隔五秒，最短一秒；slow_down 若给出有效间隔就采用它，否则增加五秒。每次 sleep 都可被信号取消，且最多等待剩余有效期。

到期检查在轮询前后及等待边界进行，并不会单独强制中止一个正在等待、且不响应取消的 poll 函数。各提供商是否给 HTTP 请求添加独立超时，需要读它自己的请求函数。

不是所有登录都等待第一次间隔：GitHub、Kimi、Meta、xAI 的相应流程明确要求首次等待；旧 Codex 与 Radius 的相应调用没有启用这个选项。

## 6.42 各提供商凭据为什么不完全同构

| 源码 | 登录与续期特点 |
| --- | --- |
| [anthropic.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/anthropic.ts) | 浏览器或 copy code；存储到期时间减五分钟，token HTTP 请求另有三十秒超时 |
| [openai-chatgpt.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/openai-chatgpt.ts) | 每次动态注册 client；回调必须包含 issued client ID；检查 direct token scope；将 access 直接用于普通 OpenAI API |
| [openai-codex.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/openai-codex.ts) | 旧订阅后端流程，浏览器或设备码；从 access 内容提取 account ID |
| [github-copilot.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/github-copilot.ts) | GitHub 身份 token 保存为 refresh，换得 Copilot token；登录还查询可用模型并尝试启用未配置策略 |
| [kimi-coding.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/kimi-coding.ts) | 设备码；刷新对网络、429、5xx 做有上限重试；请求认证返回 Bearer 头 |
| [meta.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/meta.ts) | 身份 token 保存为 refresh；续期实际是重新铸造 Model API key，身份失效需重新登录 |
| [xai.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/xai.ts) | 设备码；仅允许 https 验证链接；刷新未返回新 refresh 时保留旧值 |
| [openrouter.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/openrouter.ts) | PKCE 换得 API key，expires 设为极大值，refresh 不做联网续期；随机回调 path 与临时端口 |
| [radius.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/auth/oauth/radius.ts) | 浏览器授权地址由网关发现；token 和设备码接口仍固定在选定网关；模型目录另由 provider 负责 |

这些处理器主要负责协议，持久化与刷新互斥仍由统一 Models 和凭据存储负责。若只修改某个 OAuth 文件、绕开统一存储，会丢失第 6.6 节讨论的锁内重读保证。

## 6.43 同样的回调端口也有不同处理

直接 ChatGPT 登录必须成功占用 1455，否则明确失败，以免浏览器把回调送到另一个登录进程。它的手工路径要求完整的 origin、path、state 和 issued client ID。结束时除 close 之外，还关闭已有连接，防止浏览器预先建立的空闲连接将下一次登录回调送到旧服务。

旧 Codex 登录占用端口失败后可退到手工粘贴；它对手工输入允许纯 code，并只在提供了 state 时检查 state。Anthropic 也有相似的手工输入差异。不能概括为“所有手工 OAuth 输入都要求完整 URL”。

Copilot 的策略启用是登录过程的服务端写操作，采用串行 best effort 批次；已经成功启用的模型不会因为后续一个模型失败而回滚。刷新模型权限时又采用不同重试预算，因此登录和 refresh 的全部网络行为并不相同。

## 6.44 辅助函数的边界也属于架构

[node-http-proxy.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/node-http-proxy.ts) 按目标协议读取 proxy 环境，并处理 no_proxy 的主机、子域和可选端口；只接受 HTTP/HTTPS 代理。环境空值使用 `||` 回退，不能靠空字符串保证抑制环境中的代理。

[overflow.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/overflow.ts) 先排除限流等非溢出错误，再匹配错误文字；还可用成功结果的输入用量，或 length 且零输出、输入接近窗口的条件判断压力。这是恢复启发式，不是对所有服务端静默截断的可靠检测。

[uuid.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/uuid.ts) 在进程内维护时间与序列，普通调用遇到时钟回拨时不后退；显式时间参数则原样保留。它不通过跨进程锁建立全局严格序号。

[image-models.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/image-models.ts) 是兼容静态目录读取，和运行时 Models 可用性检查不同。[cli.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/cli.ts) 则是简化认证开发入口：在当前目录直接读写 auth.json，没有编码代理凭据存储的文件锁与权限流程。学习时必须区分开发辅助入口和正式应用路径。

## 6.45 缓存预热为什么也需要生命周期检查

问题：模型的提示词缓存快到期时，能否发一次很小的请求延长缓存？[cache-warmer.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/cache-warmer.ts) 用 `maxTokens:1`、`maxRetries:0` 发起预热，但必须先判断缓存期限、重放能力和费用。

例如缓存期限为五分钟，正常请求已经使用了一批缓存 token。预热时间取 `min(0.9 × TTL, TTL − 10秒)`；TTL 不超过十秒则不安排。定时器如果因休眠而严重晚到，预热可能已经变成一次全价请求，所以实现给计划时间增加半个余量作为最后允许时间，在执行前后检查是否错过。

费用判断先看当前分支最后一条 assistant 的输入与缓存用量，再估算：

```text
未预热的预期损失 = 后续继续概率 × 缓存未命中的额外费用
预热费用 = 全部提示词按缓存读取计费 + 一个输出 token
预期净收益 = 未预热的预期损失 − 预热费用
```

当前继续概率在 streaming 阶段取 1，idle 阶段取 0.15，默认收益门槛为 0.05 美元。缺失有效期限或价格时，默认决策不会假装知道收益。扩展可以参与决策，但判断完成后仍要核对当前运行身份与截止时间。这个公式是代码中的经济估算，不是提供商承诺的计费结果。

每次真实回合开始建立一个 `ActiveRun`；替换运行先清定时器并取消旧请求。对象身份和 `isCurrent()` 共同决定某次异步返回还有没有权修改当前状态：

```text
旧回合预热开始 → 用户切换会话 → 新 ActiveRun 建立
旧请求即使忽略取消并完成，也不能追加到新会话
```

同一 run 在请求完成后才重新安排下一次定时器，因此正常情况下不会自我重叠；但旧提供商若不响应取消，旧请求与新 run 的请求仍可能在网络层同时存在。身份检查保护的是结果归属，并不保证远端请求已经停止或没有收费。

streaming 预热观察期为从真实回合开始算起的一小时，idle 为三十分钟；成功预热不会不断延长这个起点。结果只追加 `cache_warm` 用量，不把预热的 assistant 加进对话，也不执行其中的工具调用。Anthropic 的某些非 adaptive reasoning 请求被认为不适合重放，需看 `isReplayable()` 的实际条件，不能把所有模型都视为可安全重复同一请求。

## 6.46 本地模型不是把文件路径交给聊天接口

内置 Llama 扩展管理的是已经运行的 llama-server。[extensions/llama/index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/llama/index.ts) 注册提供商和 `/llama` 命令；它不在这一入口中启动本地模型服务器。聊天请求仍走 OpenAI 兼容适配器，模型管理则使用 [client.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/llama/client.ts) 的另一组接口。

客户端将 http/https base URL 去掉 query、hash、尾斜杠以及末尾 `/v1`，再访问管理根路径：`/models`、`/props`、加载/卸载接口和 `/models/sse`。普通管理请求默认十五秒超时。一个反复轮询的操作由多次请求组成，所以“每次请求十五秒”不等于“整个加载十五秒内必定结束”。

`loadAndWait()` 同时观察事件与轮询列表。事件监听先启动，但没有等待“监听已连接”的握手；列表轮询因此仍承担发现已加载状态的责任。`unloadAndWait()` 约每一百毫秒检查一次；加载轮询约二百五十毫秒；下载轮询约五百毫秒。这些等待依赖外部取消或最终状态，没有统一总截止时间。

SSE 解析收集多个 `data:` 行后解析 JSON，忽略坏事件。这里的 CRLF 替换按收到的文本块执行，并不完整处理所有跨块 CRLF 边界；正常 EOF 的残余文本也不会自动当作完整事件提交。它是这组管理接口的具体实现，不能替代第六章其他协议适配器的流解析规则。

## 6.47 本地模型目录怎样决定“可选”

[provider.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/llama/provider.ts) 区分 loaded、sleeping 和 unloaded preset。loaded 与 sleeping 可选；unloaded preset 仅在 router 允许 autoload 且未失败时可选。目录可用不等于模型此刻已经在显存里。

上下文窗口按运行时 `meta.n_ctx`、启动参数、已缓存的有效值、训练窗口与默认 128000 的顺序推导。代码把输出上限也设为该窗口；这是一种目录估计，不能据此保证任意输入加输出都一定能容纳。思考能力通过模板是否含 `enable_thinking` 判断，是服务属性启发式。

刷新时先读取 catalog，对已加载模型并行查 props，避免为检查 sleeping 模型而唤醒它。当前实现仍为所有可选项生成 classifier 条目；“没有探测思考模板”和“没有分类模型条目”是两回事。聊天与分类可以共享模型 ID，身份仍由 operation type 区分。

认证 availability 检查主要确认 base URL 是否配置，不发 ping；解析请求 key 时可回退为 `local`。这不是服务端访问一定成功的证明。模型目录发布仍经过统一运行时的 generation 检查，防止旧刷新覆盖新状态。

## 6.48 加载、取消和搜索怎样避免旧结果污染界面

`/llama` 的替换操作可先卸载已有模型，再加载新模型。取消或失败后会尝试重新加载原模型，但卸载步骤串行执行，且不是服务端事务。另一个客户端也可能同时改变服务器状态；这五个扩展文件没有跨客户端模型管理锁。

[ui.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/llama/ui.ts) 的 `runWithProgress()` 将运行结果先包装为已处理的 settled Promise，再与用户停止动作竞速。确认停止后又检查操作是否已经完成，避免把刚完成的加载误当作需要取消的工作。实际取消先调用指定的取消操作，再在 `finally` 中 abort 本地请求，随后等待原运行收束。若取消操作本身抛错，则之后的等待路径不会继续；若底层永远不结束，也不能靠这个 UI 保证及时返回。

Hugging Face 搜索至少需要两个字符，防抖五百毫秒；修改查询会清定时器并取消旧请求。异步返回更新 UI 前检查 closed、aborted 和当前查询，同时用请求对象身份保护清理操作：旧请求不能把新请求的控制器清空。这与文件队列的尾部身份检查解决了相似的生命周期问题，但没有序列化服务器上的下载或加载。

[huggingface.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/llama/huggingface.ts) 查找 GGUF，过滤视觉投影文件、合并分片大小，并优先展示 `Q4_K_M`。合计文件大小不等于运行所需内存。扩展读取的 HF token 用于元数据访问；实际 gated 模型下载仍需要服务器自身的 HF_TOKEN，不能假设客户端 token 已随管理请求传给服务器。

补充练习：旧预热完成、旧搜索返回、旧模型目录刷新返回，三者分别用什么身份条件阻止过期结果？这些检查有没有撤销已经发生的网络费用、下载或卸载？

## 6.49 输出预算的实际计算：窗口、输入和安全余量

问题是请求了 8000 输出 token，但上下文窗口剩余空间更少。共享选项构造器 `buildBaseOptions()` 调用以下完整生产函数，输入是最终模型、规范化 transcript 和期望输出上限：

源码定位：[packages/ai/src/api/simple-options.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/simple-options.ts#L15)，第 15—19 行。

<!-- source-lines: packages/ai/src/api/simple-options.ts:15-19 -->
```ts
export function clampMaxTokensToContext(model: Model<Api>, context: TranscriptContext, maxTokens: number): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}
```

`estimateContextTokens(context).tokens` 优先使用适用的 assistant usage 并估计后续内容；没有有效 usage 时按文字、图片和工具声明估算。这里调用的是 `pi-ai/utils/estimate.ts`，不是第十四章应用压缩模块中同名的投影估算函数。

把实验输入设为窗口 10000、user 文字 8000 个 ASCII 字符、没有用量报告，输入估算为 ceil(8000/4)=2000。available=10000−2000−4096=3904；请求上限 8000 被截为 3904。窗口改成 5000，available=−1096，返回 1；这保留一个合法的正上限，但不能使已溢出的输入变小。contextWindow≤0 则视为未提供可用窗口，只保留正数下限。

这个函数没有 await，不发 HTTP，也不触发摘要。它把预算交给提供商选项构造流程；参数名称随后可能变为 max_tokens、max_completion_tokens 或 max_output_tokens。字符估算与实际 tokenizer 有偏差，所以安全余量减少风险，不能证明所有请求必然适配窗口。

## 6.50 thinking 和回答怎样共享输出空间

下面是 `adjustMaxTokensForThinking()` 完整生产函数；默认 medium 预算是 8192，high 为 16384，MIN_ANSWER_TOKENS 为 1024：

源码定位：[packages/ai/src/api/simple-options.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/simple-options.ts#L76)，第 76—92 行。

<!-- source-lines: packages/ai/src/api/simple-options.ts:76-92 -->
```ts
export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
	}

	return { maxTokens, thinkingBudget };
}
```

逐步读：先取得级别对应预算；调用者没有显式 base cap 时用 model cap，存在 base cap 时把 thinking 加入，再受 model cap 限制。只有 `maxTokens <= thinkingBudget` 时，这个函数才调用 clamp，将 thinking 限到 `max(0, ceiling−1024)`。不要把“至少留下 1024”的辅助函数目的扩大为所有组合都无条件调用；也不要把这些 token-based 分配规则套到仅发送 effort 参数的提供商。

| 输入 | maxTokens | thinkingBudget | 解释 |
| --- | ---: | ---: | --- |
| base=2000, model=10000, medium | 10000 | 8192 | 2000+8192 超过模型上限，回答可用差额为 1808 |
| base 未设置, model=4000, medium | 4000 | 2976 | 原 thinking 超过 cap，留 1024 回答空间 |
| base 未设置, model=512, high | 512 | 0 | 窗口太小，无法实际留出 1024，但不分给 thinking |

这一步分配输出，并不验证生成的回答一定足够完成任务。`length` 仍可能出现，第七章会拒绝执行该回答中的工具请求，第十四章会拒绝把不完整摘要保存为检查点。可运行 `node labs/run-offline.mjs budgets` 对照上述数值。
