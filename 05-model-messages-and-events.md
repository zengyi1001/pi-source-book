# 第五章模型消息、工具声明与流式事件

用户看到的是一段聊天文字，代理处理的却是带角色、内容块、标识和状态的消息。先理解这些数据结构，才能解释工具调用为什么不能只当作一段 JSON，以及流式界面为什么不能把收到的对象当作历史快照。

## 5.1 一次工具调用包含三条消息

以下是教学简化表示，省略实际类型要求的时间戳、模型标识和用量字段：

```text
user:      把 config.txt 中的 alpha 改为 ALPHA
assistant: toolCall(id="call-1", name="edit", arguments={...})
toolResult: toolCallId="call-1", content=[text("修改成功")]
```

`assistant` 表示模型输出；`toolResult` 表示本地工具的执行结果。关联依据是调用 ID，不能只按工具名称匹配：同一助手响应可以连续调用两次 `edit`。

[types.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/types.ts) 定义四种模型消息：`system`、`user`、`assistant`、`toolResult`。应用还会记录扩展自定义消息等对象，但发送给模型前必须转换成模型层接受的消息。

## 5.2 内容块比纯字符串多了哪些信息

用户消息可包含文本和图像。图像块带 MIME 类型与 base64 数据，不能把它理解成模型可以自行读取的本地文件路径。

助手内容可包含：

| 内容 | 含义 | 不能据此推导的行为 |
| --- | --- | --- |
| `text` | 面向用户的输出 | 文本中的代码不会自动执行 |
| `thinking` | 提供商允许返回的思考内容或受保护表示 | 不是所有模型都返回可读推理 |
| `toolCall` | 工具名、调用 ID、参数对象 | 声明调用还没有产生文件副作用 |

部分内容还带签名等提供商字段。它们用于后续对话的协议重放，不能因界面不显示就任意删除。工具调用的 `namespace` 和签名也不等同于本地工具执行函数。

工具结果的内容和 `details` 有不同用途：内容会参与后续模型上下文；细节常用于界面渲染或应用记录。类型系统约束 JSON 可表示的细节，仍不能代替运行时对不可信输入的检查。

## 5.3 系统消息也记录配置变化

Pi 的系统消息不只是开头的一段提示文字。它可以包含命名提示段、工具新增和工具删除。

例如，扩展激活了一个工具后，可以追加如下教学简化更新：

```text
system:
  sections: { project: "当前项目的约束" }
  toolsAdded: [工具声明]
  toolsRemoved: [{ name: "旧工具名" }]
```

[transcript.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/transcript.ts) 重放这些更新，得到当前有效提示和工具集合。提示段赋值为 `null` 表示删除；同名工具后加入的声明替换先前声明；同条更新先处理删除，再处理新增。

这解决了一个具体问题：如果应用只修改内存中的工具列表，却不记录模型可见的变化，恢复会话后就难以重现当时的调用条件。

但“记录工具声明”仍不保存执行函数。`toToolDeclaration` 只保留名称、描述、参数模式等模型所需字段，去掉本地运行和显示信息。实际可执行集合由代理和应用管理。

## 5.4 标准化上下文不是运行时验证

调用者可使用 `Context` 中的 `systemPrompt`、`tools` 便捷字段。`normalizeContext` 将非空初始提示或工具声明转换为系统消息，形成 `TranscriptContext`。

这个过程统一了下游接口，既不深复制所有消息，也不逐项验证整个对象。`TranscriptContext` 的类型标记主要帮助 TypeScript 区分“已标准化”与“尚未标准化”；它不是运行时安全校验器。

调用者如果同时提供便捷系统提示和已有首条系统消息，标准化也可能生成额外系统消息。因此 SDK 使用者需要理解两种输入方式的关系，不能把标准化理解成自动去重。

## 5.5 提供商能力决定如何重放历史

有的 API 能在对话中途接受系统提示或新增工具，有的要求把所有系统信息放在请求顶部。

`collapseSystemMessages` 将历史系统更新折叠为当前有效状态。支持中途系统消息时，可以保留原位置；不支持时，适配层发送折叠结果。

工具还存在一个更严格的条件：只有适配能力允许且变更是纯新增，才适合在原位置保留增量声明。删除或重新声明同名工具会使它成为非新增历史；此时使用当前完整集合。

工具声明比较不是通用的 JSON 语义等价证明。代码整理声明字段后比较序列化结果，参数模式内部的键顺序等表示差异仍可能影响比较结果。修改声明时应保持稳定表示，减少无意义变更。

## 5.6 流式响应是一段生命周期

普通响应的典型事件顺序如下：

```text
start
  → text_start
  → text_delta("你")
  → text_delta("好")
  → text_end("你好")
done
```

思考内容和工具调用也有开始、增量、结束事件。`contentIndex` 指向助手消息内容数组中的块。它不是消息在整个会话中的下标。

`partial` 是正在增长的助手消息。很多实现更新同一个对象，再把它放进多个事件；消费者若保存对象引用，稍后读到的可能是更新后的内容。需要历史快照时，应明确复制所需数据。

工具参数的增量 JSON 可能尚未闭合；`parseStreamingJson` 用尽力解析帮助显示当前参数。实际执行应使用最终结果并经过参数验证，不能在看到 `{"path":` 时就开始写文件。

## 5.7 终止状态怎样影响调用者

`stopReason` 区分 `pending`、正常停止、长度截断、工具调用、错误、取消和延后响应。`endTurn` 等原始提供商信息可用于诊断，但不能取代代理循环的控制逻辑。

`done` 给出成功终止的消息；`error` 给出含错误状态的助手消息。这里的“错误消息”也是一个结果对象，调用者需要检查它的结束原因。

设置阶段失败可能在 `start` 前产生 `error`。不能写一个必须先看到 `start` 才接受结束事件的消费者。

`lazyStream` 立即返回外层流，在后台进行异步认证或加载实现，再转发内层事件。设置失败被转换为零用量、错误结束的助手消息。这使异步准备过程仍能遵守统一事件接口。

## 5.8 事件队列没有自动背压

[event-stream.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/event-stream.ts) 用两组数组实现先进先出队列：新元素进入输入数组；输出数组用完时反转输入数组，再从末尾取出。这样避免每次 `shift()` 都移动大量元素。

生产者 `push` 不等待消费者。消费者很慢时，待消费事件可持续积累；当前数据结构没有容量上限，也没有自动暂停网络读取的背压机制。

另外，它是队列，不是广播中心。多个消费者同时迭代同一个流，会竞争取得事件，不会各自得到完整副本。

终止事件完成 `result()` 的结果 Promise。错误状态同样以助手消息完成这个 Promise，不必然抛出异常。仅调用无结果的 `end()` 而没有终止事件，则不能保证 `result()` 完成；自定义提供商必须正确结束流。

消费者停止迭代也不能自动证明生产者或网络请求已经取消。取消应通过约定的 `AbortSignal` 传播。

## 5.9 为什么持久化事件要使用独立帧

假设生产者已把共享 `partial` 更新为 `AB`，消费者此时才处理最早的 `start`，随后又处理增量 `A`、`B`。如果把开始对象当作不可变快照，就可能重建出 `ABAB`。

[assistant-message-frame.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/assistant-message-frame.ts) 的编码器处理这个问题：开始帧建立独立消息形状；内容开始时记录已覆盖长度；后续增量跳过已包含的前缀；内容结束时以权威最终值收束。

工具参数比文本复杂，因为开始快照可能已有参数对象，而后续增量是从头开始的 JSON 字符流。编码器使用检查点协调两种表示；解码器收到检查点后重置参数缓冲，再接续后面的增量。

解码器还检查内容下标是否合法、内容块是否按顺序开始、块类型是否匹配，以及是否对已结束块继续追加。它重建的是部分助手消息；最终终止状态和用量仍需由终止记录补齐。

这是一种事件重放实现，不是对任意共享可变对象的通用修复。新增事件字段时，必须同时检查编码、解码和最终消息收束路径。

## 5.10 参数验证为何分成多步

[validation.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/validation.ts) 首先按模式整理参数，再进行检查。其逻辑包含可选字段的 `null` 处理，以及普通 JSON Schema 的递归转换。

例如一个可选字符串字段收到 `null`，且模式不接受空值时，可以删除该字段；一个数字字段收到可转换的字符串时，可以尝试转换。对象属性、数组元素和组合模式需要沿结构递归处理。

转换不是“任意错误都能修好”。最终检查仍可能失败，错误信息会包含字段路径和原始参数。普通工具通常使用对象参数模式；不要把这一路径的行为推广成“所有顶层标量模式都必然拒绝无效值”，代码对标量转换有独立返回分支。

验证器按模式对象身份缓存在 `WeakMap` 中。相同结构但重新创建的模式对象，不一定命中同一缓存；随意原地修改已编译的模式也需要谨慎。

流式尽力解析、参数模式转换、执行前验证是三件不同的事。前者帮助显示，后两者约束最终调用；文件编辑算法中的模糊文本匹配则是另一层操作。

## 5.11 用量字段不能简单相加

`Usage` 记录输入、输出、缓存读写、总量和费用。推理 token 是输出的一部分，不能在输出之外再次相加；一小时缓存写入也是缓存写入的子集。

成本通常按每百万 token 的费率计算，费率还可能随上下文长度、缓存期限或服务层级变化。模型目录保存这些元数据，具体计算在下一章分析。

代码里的字符数估算主要帮助预算，不是提供商 tokenizer 的精确结果。模型层和编码代理压缩层各有估算逻辑，不能只改一处就认为所有预算行为一致。

## 5.12 源码定位与练习

| 源码 | 阅读目标 |
| --- | --- |
| [types.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/types.ts) | 消息、内容、工具声明、事件与用量 |
| [transcript.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/transcript.ts) | 标准化、系统提示和工具变更重放 |
| [event-stream.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/event-stream.ts) | 队列、异步迭代与最终结果 |
| [assistant-message-frame.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/assistant-message-frame.ts) | 共享部分消息的稳定编码与重建 |
| [json-parse.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/json-parse.ts) | 完整 JSON 修复与部分 JSON 解析 |
| [validation.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/validation.ts) | 模式编译、转换与错误报告 |
| [lazy.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/api/lazy.ts) | 异步设置和事件转发 |

练习：保存五个事件里的 `partial` 引用，就得到了五份历史快照吗？没有；它们可能指向同一个后来被更新的对象。

练习：两个组件分别迭代同一个事件流，会各自看到完整输出吗？不会；应让一个消费点分发事件，或明确建立广播机制。

练习：助手消息里有两个同名工具调用，应怎样匹配结果？按 `toolCallId` 匹配，不能只按名称或完成顺序。

## 5.13 从实际代码读取 transcript 的工具状态

问题是：进入规划模式或加载 MCP 工具后，下一次请求究竟应声明哪些工具？不能只读取第一条 system 的 toolsAdded，因为之后的 system 可能移除或重定义工具。以下是 `getCurrentTools()` 完整生产函数：

源码定位：[packages/ai/src/utils/transcript.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/transcript.ts#L58)，第 58—66 行。

<!-- source-lines: packages/ai/src/utils/transcript.ts:58-66 -->
```ts
export function getCurrentTools(messages: TranscriptMessages): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}
```

逐句分析：输入是按历史顺序排列的消息列表；Map 的键是工具名，值是完整声明。`isSystemMessage()` 排除 user、assistant 和工具结果。每条 system 先 delete 再 set，因此同一条 delta 中“移除 read、增加新版 read”得到新版定义。返回一个数组供提供商转换或工具状态比较使用；这里没有启动工具，也没有 await、文件保存或参数校验。

具体输入如下，工具定义的 description/parameters 为便于展示省略；这张表是轨迹，不是可直接请求提供商的完整消息：

| 次序 | 消息 | Map 状态 |
| --- | --- | --- |
| 0 | system: toolsAdded=[read(v1), bash] | read(v1), bash |
| 1 | user: 审查项目 | 不变 |
| 2 | system: toolsRemoved=[bash, read], toolsAdded=[read(v2), grep] | read(v2), grep |
| 3 | assistant: toolCall(read) | 不变；是否执行另由第七章决定 |

声明工具是模型可见接口，执行工具是运行时持有的实现。Map 返回的对象没有把 execute 函数变成提供商参数；`toToolDeclaration()` 明确只保留 name、description、parameters 和 constrainedSampling，JSON 往返也会去掉 TypeBox 的符号字段。

## 5.14 normalizeContext 的返回值与数据身份

下面是完整生产函数：

源码定位：[packages/ai/src/utils/transcript.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/src/utils/transcript.ts#L30)，第 30—34 行。

<!-- source-lines: packages/ai/src/utils/transcript.ts:30-34 -->
```ts
export function normalizeContext(context: Context): TranscriptContext {
	const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
	const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
	return { messages } as TranscriptContext;
}
```

`createInitialSystemMessage()` 把调用者的 systemPrompt/tools 简写变成 system 消息；没有这两项时不制造空消息。三元表达式在有初始消息时构造新数组，否则直接复用 `context.messages`。两条路径都没有深复制内部消息或 schema。`as TranscriptContext` 是类型断言，不在运行时增加校验器或 brand 字段。

例如输入 `{systemPrompt:"base", tools:[read], messages:[u1]}`，输出 `{messages:[s0,u1]}`；提供商入口以后从 system 重放提示与工具，而不是继续找顶层 context.tools。调用者若在 normalize 后修改 u1 的对象内容，仍可能影响输出，因为 u1 的对象身份被复用。

配套 `transcript` 实验同时验证 sections 的替换/删除、工具重定义、system 收敛与 addition-only 传输回退。它使用实际生产函数，不请求模型：`node labs/run-offline.mjs transcript`。
