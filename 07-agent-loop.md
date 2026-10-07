# 第七章代理循环与工具调度

模型本身只产生消息。它输出“调用 edit”时，并不会直接修改磁盘。Pi 需要一个循环把消息里的工具调用交给本地代码，再把工具结果作为下一次模型请求的输入。本章分析这条最核心的控制流。

## 7.1 三种层次的工作

| 层次 | 主要对象 | 负责什么 |
| --- | --- | --- |
| 模型接口 | `StreamFn` | 接收消息，产生助手事件流 |
| 无界面循环 | `runAgentLoop`、`runAgentLoopContinue` | 请求模型、运行工具、决定继续 |
| 有状态代理 | `Agent` | 持有消息、运行标记、取消控制器和输入队列 |

这些代码位于 `packages/agent/src/`。编码代理应用在其上增加会话持久化、扩展、配置、压缩和交互模式；不要把所有应用行为都归到 `Agent` 内。

`StreamFn` 被作为依赖传入。核心循环因此不必自己选择提供商、弹出登录界面或读取用户配置。没有显式流函数时，可使用已安装的默认函数；没有默认函数则明确报错。

## 7.2 从一次输入追踪两轮模型请求

用户输入“把 alpha 改为 ALPHA”，模型第一轮返回一个 `edit`，工具成功后模型第二轮给出完成说明。

```text
用户消息
  → 第一轮请求
  → 助手消息，含 edit 工具调用
  → edit 执行
  → toolResult 消息
  → 第二轮请求，包含上面的消息与结果
  → 助手普通文本
  → 运行结束
```

代理循环所说的一轮，是“一次助手响应及其工具结果”。一次用户任务可以包含很多轮。工具调用不是一条额外的用户消息，工具结果通过 `toolCallId` 关联原调用。

## 7.3 Agent 保持单次运行约束

[agent.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/agent.ts) 的 `activeRun` 保存当前运行的 Promise、完成函数和 `AbortController`。`prompt`、`continue`、`reset` 在已有运行时拒绝开始另一次独立运行。

这是对同一个 `Agent` 对象的并发约束，不是全局禁止多个代理，也不禁止这一轮内部的多个工具并行。

输入字符串被转换为用户消息；附图追加为图像内容块。传入完整消息或消息数组时走相应分支。

启动执行之前，`runWithLifecycle` 同步设置 `activeRun` 与 `isStreaming`。这样第二个调用不会因为第一个还没进入某个异步阶段而错误地看到空闲状态。

`finally` 调用 `finishRun`，清空临时响应和待结束工具集合，完成等待空闲的 Promise。

## 7.4 消息数组复制提供什么保护

初始状态、赋值工具和消息数组，以及创建上下文快照时，都复制顶层数组。这防止调用者后来给原数组增删元素直接改变代理持有的数组。

但是浅复制不会深复制消息对象和内容块。不能把这个行为写成“代理拿到了完全不可变的深层快照”。读写对象字段仍需遵守调用契约。

系统提示也不是独立任意可写的字段。它从对话中的系统消息重放得到；要改变提示，应追加包含内容或 sections 的系统消息。工具声明变化也以系统消息表达，从而能在后续请求与历史重放中再现。

## 7.5 声明工具与执行工具必须一致

模型可见的工具声明存在系统消息中；运行时可执行的工具对象存在 `context.tools`。两者可能因扩展加载或配置变化而不同。

`declareToolChanges` 比较重放得到的声明与当前可执行集合，将差异写成 `toolsAdded/toolsRemoved`。如果本轮已有待追加系统消息，则在其中重新计算工具字段；否则插入新的系统消息。

因此，动态加载工具不只是向一个数组 `push`。模型必须在下一次请求前得到声明变化，否则它可能继续调用已删除工具，或不知道新工具存在。

工具声明只包含模型使用所需的描述和参数结构，实际 `execute` 函数不能被作为 JSON 发给模型。

## 7.6 两层循环分别处理什么

[agent-loop.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/agent-loop.ts) 的 `runLoop` 有内外两层循环。

内层循环处理自然连续工作：上一轮有工具结果，或者有插入当前任务的 steering 消息，就继续请求。外层在代理本来准备停止时检查 follow-up 队列，如果有后续输入，再进入内层。

每次请求之前按顺序执行：

1. 如已完成上一轮，调用 `prepareNextTurn`，允许压缩或更新运行状态。
2. 追加准备产生的消息和待处理输入。
3. 调用 `prepareRequest`，得到本次请求的上下文、模型和思考级别。
4. 变换上下文并转换为模型消息。
5. 取得当前有效 API key。
6. 调用流函数并消费事件。

长工具调用可能跨越短期凭据过期时间，因此 API key 在请求边界动态获取，而不是只在 Agent 构造时取得一次。

## 7.7 部分响应与最终消息不同

`streamAssistantResponse` 在收到 `start` 后把部分助手消息加入当前上下文。文本、思考和工具参数增量更新这条部分消息。

收到 `done` 或 `error` 后，等待 `response.result()`，用最终助手消息替换部分消息。如果流从未产生 `start`，则为最终消息补发开始事件。

工具参数的增量只用于观察和显示。实际工具执行发生在得到最终助手消息之后，不在每次 `toolcall_delta` 到达时执行。

输出被长度限制截断时，流式 JSON 的尽力解析可能产生“结构合法但内容缺失”的参数。循环因此在 `stopReason === "length"` 且消息含工具调用时，让这些调用全部返回错误，不运行潜在截断的文件修改。

这项判断检查的是助手响应整体的结束原因。不能因为某一个工具参数看起来可解析，就绕过该防护。

## 7.8 工具调用分为准备、执行和结果整理

准备阶段执行：查找工具、调用 `prepareArguments`、验证模式、运行 `beforeToolCall`、检查取消。

未知工具、无效参数、取消或钩子阻止会产生立即结果。允许的调用保存工具对象和已验证参数，等下一阶段执行。

执行阶段调用 `execute(toolCallId, args, signal, onUpdate)`。返回值可以包含 `isError: true`；抛错也会转换为错误结果。只在文本里写“失败”却不标记错误，不符合工具协议。

结果整理阶段运行 `afterToolCall`，允许更改内容、界面细节、错误状态、用量和终止提示。内容数组整体替换，不进行元素级深合并。若替换了内容但没有同步提供结构化结果，会丢弃原来的 `structuredContent`，避免它与内容矛盾。

实现用 `??` 选择多个替代字段，`null` 与 `undefined` 的具体语义应按代码阅读，不能从“可替换”推导任意值都能作为删除指令。

## 7.9 并行模式也先顺序准备

`executeToolCallsParallel` 先依模型声明顺序逐个发送开始事件并准备调用。通过准备的调用先保存为待执行函数，不立刻启动。

全部准备完成后，用 `Promise.all` 启动允许的函数。这样准备钩子按顺序运行，工具副作用在执行阶段才并发发生。

例如第二个 `beforeToolCall` 要询问扩展策略时，第一项尚未开始实际写入。这是并行前预检的顺序边界，不能把“并行模式”理解为从查找工具开始所有阶段都并发。

每个工具完成和整理后立即发出 `tool_execution_end`，所以 B 可以先在界面结束。所有调用完成后，`Promise.all` 的结果仍按源顺序排列，再依次生成 `toolResult` 消息。

```text
模型顺序：A，B
完成事件：B end，A end
结果消息：A result，B result
```

这满足两个不同需求：界面及时反馈，模型上下文保持可预测顺序。

## 7.10 顺序工具会影响整批

如果配置指定 `toolExecution: "sequential"`，或者本消息中任何已声明工具的 `executionMode` 是 `"sequential"`，整批进入顺序执行路径。

实现不是把顺序工具插为局部屏障、其余工具分组并行。顺序路径让每项准备、执行、整理和结果事件完成后，再处理下一项。

经典 `edit` 与 `write` 默认依靠文件队列来保护单文件，所以不需要仅为同文件排队把所有工具都设为顺序模式。

## 7.11 取消传播与局部输出生命周期

准备与执行阶段接收同一个取消信号。工具必须在自己的能力边界配合信号；代理不能承诺外部副作用即时消失。

工具的 `onUpdate` 在本次 `execute` Promise 结束后关闭。迟到的回调被忽略，已经接受的更新事件则会在结束结果之前等待完成。这样一个旧工具的晚到输出不会继续冒充活跃调用更新界面。

顺序路径在每项结束后检查取消并停止处理余下项；并行路径在准备和启动阶段检查信号，已经运行的工具是否停止仍取决于其实现。

`pendingToolCalls` 在开始事件时登记，在结束事件时移除。在并行预检期间，这个集合也可能含尚未启动副作用的调用，不能把集合大小直接当作操作系统正在执行的任务数。

## 7.12 终止提示与结束原因

整批结果只有在非空且每项都设置 `terminate === true` 时，才满足工具批次的提前终止规则。单个被阻止调用的终止提示不能压过其他正常结果。

正常完成后，`finishTurn` 可返回 `end` 或 `continue`。`continue` 保证发生下一次请求，但如果工具、steering 或 follow-up 已经自然选择了后续请求，不会再额外多请求一次。

模型结果为 `error` 或 `aborted` 时是硬退出路径，不能用 `finishTurn` 的继续建议无限掩盖失败。

停止还要区分“无工具、无插入消息”“扩展要求结束”“错误或取消”和“长度截断但产生错误工具结果”。这些分支给上层应用提供不同处理依据。

## 7.13 steering 与 follow-up 的排队时机

`steer` 表示在当前助手轮次及其工具完成之后插入新方向；它不会自动跳过本轮余下工具。`followUp` 只在代理本来准备停止时取出。

两者默认 `one-at-a-time`，每次取最早的一条；也可以配置为 `all`。队列可以查看、清空和检测是否有输入。

上一轮后的准备步骤可能耗时很长，例如上下文压缩。如果先前还没有取到 steering，循环会在准备结束后再检查，接住这段时间里输入的消息；如果已有一条，就不会额外再取一条破坏逐条模式。

`continue()` 面对最后消息为助手的状态时，也会尝试把已排队输入变成新 prompt；没有输入时拒绝从助手消息直接继续。

## 7.14 事件结束不等于已经空闲

`processEvents` 先更新代理状态，再按订阅顺序等待监听器。会话保存可以由监听器完成，界面也可以响应同一事件。

`agent_end` 发出时运行对象仍存在，直到监听器结束并进入 `finishRun` 才空闲。`waitForIdle` 等的是这个更晚的边界。

例如结束监听器正在保存日志，新 prompt 若立刻开始，可能与尚未完成的状态保存重叠。当前 Agent 的运行标记避免把循环的最后事件误判为所有工作已经完成。

但这依赖监听器返回它真正工作的 Promise。如果监听器启动后台保存后立刻返回，Agent 无法自动发现那个脱离等待链的工作。

## 7.15 嵌套工具调用为什么复用执行管线

`runToolCall` 让一个工具调用另一个工具时复用参数准备、校验及前后钩子，防止嵌套调用跳过策略。

它本身不发代理生命周期事件，也不追加模型消息，而是返回 `AgentToolCallOutcome`。上层应用负责把嵌套活动接入相应展示与记录。

这与“直接调用另一个工具的 execute”不同：后者可能绕过钩子和参数校验。只要嵌套调用会产生副作用，是否经过同一管线就是必须审查的路径。

## 7.16 代理模型代理与远程会话协议不同

[proxy.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/proxy.ts) 的 `streamProxy` 把模型请求发给服务器的 `/api/stream`，由服务器管理模型认证。传输的是模型增量事件，客户端据此重建部分助手消息。

为了减少带宽，代理事件不携带每次都增长的完整 `partial`，而传递文本增量、内容索引和终止统计。客户端维护缓冲，处理跨读取块的文本行，还会处理末尾没有换行的事件。

若连接正常 EOF 却没有 `done/error`，实现将它标为响应中断错误，防止 `result()` 无法完成。这与 `packages/protocol` 的远程 Pi 会话协议是不同层次，后者另章说明。

## 7.17 源码定位与练习

| 源码 | 核心函数 |
| --- | --- |
| [agent.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/agent.ts) | `prompt`、`runWithLifecycle`、`processEvents` |
| [agent-loop.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/agent-loop.ts) | `runLoop`、`streamAssistantResponse` |
| 同文件 | `prepareToolCall`、`executeToolCallsParallel`、`finalizeExecutedToolCall` |
| [types.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/types.ts) | `AgentLoopConfig`、`AgentEvent`、`AgentToolResult` |
| [proxy.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/proxy.ts) | `streamProxy`、`processProxyEvent` |

练习：A 和 B 并行，B 先结束，模型下一轮先看到谁？答案是 A 的结果，结果消息按模型原声明顺序写入。

练习：某工具声明 `executionMode: "sequential"`，同消息另外三个工具是否仍分组并行？答案是否定的，当前整批走顺序路径。

练习：收到 `agent_end` 后，结束监听器还要异步保存 100 毫秒，`waitForIdle` 何时完成？答案是监听器完成并清理当前运行以后。

## 7.18 顺序执行的判断发生在整批工具上

下面是 `executeToolCalls()` 完整生产函数。它由 runLoop 在 assistant 最终消息形成后调用；length 路径在调用本函数前已转去失败结果处理：

源码定位：[packages/agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/agent-loop.ts#L508)，第 508—523 行。

<!-- source-lines: packages/agent/src/agent-loop.ts:508-523 -->
```ts
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}
```

`filter` 得到当前回复的工具请求，`some` 只需找到一个被声明为 sequential 的工具，就选择整批顺序分支。显式 `config.toolExecution="sequential"` 同样控制全批。根据当前可执行 tools 查 executionMode，而不是相信模型在参数中自行声称“只读”。找不到的工具将在准备阶段形成错误结果。

例如 read(A)、write(B) 同一回复出现，write 的 executionMode 是 sequential，则轨迹为“准备 A → 执行 A → 形成 A 结果 → 准备 B → 执行 B”；不会同时启动 A。这个分支选择解决需要严格顺序的工具批次；同文件互斥仍由第十一章的队列处理，不能由这里推导跨 Agent 实例或跨进程互斥。

## 7.19 并行实现逐段拆解：闭包与 Promise 不是同一时刻

下面是 `executeToolCallsParallel()` 的完整生产函数。保留它的全部取消分支，因为省略它们会使读者误以为先准备的工具已经开始执行：

源码定位：[packages/agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/agent-loop.ts#L586)，第 586—660 行。

<!-- source-lines: packages/agent/src/agent-loop.ts:586-660 -->
```ts
async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies FinalizedToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}
```

输入包括当前上下文、发出请求的 assistant、按回复顺序排列的 toolCalls、钩子配置、取消信号与异步 emit。结果返回 messages 数组与 terminate，不直接修改当前上下文；runLoop 的调用者将结果追加到 currentContext.messages/newMessages，然后完成 turn_end，再决定续跑。

第一段 for-of 在每项开始发出 tool_execution_start，然后 **await prepareToolCall**。准备顺序是找工具、prepareArguments、schema 验证、beforeToolCall、取消/阻止判断。即使第一项已准备成功，也只是 `finalizedCalls.push(async () => {...})`：存入函数不会调用 execute。已阻止或找不到的项直接放入结果对象，发出执行结束事件。

第二段 `Promise.all(finalizedCalls.map(...))` 才调用这些函数。每个闭包在入口再检查 signal，因此第二项准备期间发生取消时，第一项也不能继续执行。不能把“tool_execution_start 已出现”解读为磁盘操作已经开始。

第三段在全部闭包完成后依次生成 toolResult。Promise.all 返回顺序跟输入一致，而 tool_execution_end 在各项真正结束时发出：

```text
preflight A → preflight B → execute A → execute B
B 执行结束事件 → A 执行结束事件
最终 message_start/end(result A) → message_start/end(result B)
runLoop 追加 result A、result B → 下一次模型请求
```

所以界面的执行完成顺序和模型 transcript 的结果顺序可以不同。异步 emit 的等待又是额外边界；工具 execute 返回，可能还需要等待输出更新与 afterToolCall。

terminate 判断要求已形成结果非空，而且每项 result.terminate 都严格为 true。一项要求结束、另一项普通成功，仍会继续模型请求。取消导致准备循环提前 break 时，只处理已经纳入的项，不能声称从未准备的所有后续调用都生成了结果。

配套 `loop` 实验用真实循环完整定义和两次内存模型响应，验证预检顺序、结束事件与 transcript 顺序、整批 sequential、length 拒绝、预检取消和 terminate 规则。schema 验证器在实验中被替换为原参数返回，故它不覆盖 TypeBox 参数拒绝或真实提供商协议。运行：`node labs/run-offline.mjs loop`。
