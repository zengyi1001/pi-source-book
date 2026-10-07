# 第八章：应用会话怎样组织输入、工具与恢复

底层 `Agent` 已经能请求模型、执行工具并继续下一轮，为什么还需要 `AgentSession`？一个实际应用还要加载扩展、保存消息、压缩历史、恢复临时网络错误，并决定取消后什么时候可以再次输入。这些工作由 [agent-session.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/agent-session.ts) 组织，交互、打印和 RPC 模式共同使用它。

本章先读正常输入链路，再看状态和错误恢复。第七章解释底层循环，第十三章解释会话日志；本章连接两者。

## 8.1 同时存在三种会话状态

| 层次 | 对象 | 主要职责 |
| --- | --- | --- |
| 当前执行 | `Agent.state` | 消息、模型、工具、正在进行的请求和工具状态 |
| 历史与投影 | `SessionManager` | 原始日志、当前分支、压缩与上下文修改 |
| 应用生命周期 | `AgentSession` | 输入展开、扩展、事件、重试、压缩、待交付消息 |

不能简单把三个对象中的“消息”都理解为同一个数组。`_refreshFinalizedContext()` 用日志生成当前投影，再更新 Agent 的 finalized transcript。请求准备阶段也会重新取投影，使压缩或 `context_edit` 能真正影响下一次请求。

`AgentSession` 构造时就订阅 Agent 事件，用于持久化和内部处理；用户没有订阅 UI 事件，并不意味着消息不保存。构造器还安装工具钩子、下一轮准备、请求投影、回合边界、隐藏声明和强制提示词投影。

## 8.2 一次普通 prompt 的完整前置处理

以用户输入 `/review src/app.ts` 为例。`prompt()` 不是直接把字符串交给 Agent：

1. 如果它是已注册的扩展命令，立即调用命令 handler。
2. 检查手工压缩是否正在运行。
3. 发出 `input` 事件，允许扩展处理或转换输入。
4. 展开 `/skill:name` 和文件提示模板。
5. 如果应用已在运行，按 `steer` 或 `followUp` 入队。
6. 空闲路径先清理可落入历史的待交付消息，检查模型和认证配置。
7. 对上一条回答执行必要的压缩检查。
8. 发出 `before_agent_start`，允许扩展调整提示词选项和模型。
9. 按最终模型的限制处理图片。
10. 构造 user、自定义消息和 system 更新，再启动 Agent。

扩展命令优先执行，而且在流式回答期间也可以执行。它不是普通排队提示词；`steer()`、`followUp()` 会拒绝把已注册扩展命令当作排队消息。

`input` 事件发生在技能和模板展开前，因此扩展能观察原始命令形式。若返回 handled，输入已经被扩展处理，后续模型链路停止。若返回 transform，使用转换后的文本与图片继续。

## 8.3 为什么图片要在模型选择之后处理

扩展可以在 `before_agent_start` 中切换模型。不同模型可能有不同图片尺寸限制，所以 `prompt()` 在该事件后调用 `_normalizePromptImages()`，而不是在输入刚到达时就固定处理参数。

处理失败的输入图片转换成文字提示；成功图片和必要说明进入实际 user 消息。工具结果图片采用 [tool-result-images.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/tool-result-images.ts) 的另一策略：先经过 `tool_result` 扩展钩子，再统一处理，这也覆盖扩展新插入的图片；处理失败时保留原图片。不要把两条失败路径混成同一策略。

SDK 的 `blockImages` 还会在转换模型消息时替换图片，属于更后面的请求保护层。第九章讲具体图像处理实现。

## 8.4 steer、followUp 与旁注是不同队列

steering 在当前 assistant 回合的工具全部处理后、下一次模型请求前交付；follow-up 等底层循环没有更多工具与 steering 时交付。

应用另外维护两组文本数组，用来显示待发送输入。底层真正交付 user 消息时，上层根据文本从显示队列中移除对应项，再发出 `queue_update`。文本列表是显示状态，不是下层队列的完整复制；扩展自定义消息和图片并不都体现在这个计数中。

自定义消息还有以下方式：

| 情况 | 行为 |
| --- | --- |
| `deliverAs:"nextTurn"` | 与下次普通用户 prompt 一起发送 |
| 正在运行，允许触发回合 | 加入 Agent steering 或 follow-up |
| 正在运行，`triggerTurn:false` | 暂存到当前工具结果结束后的边界 |
| 空闲且 `triggerTurn:true` | 启动新的代理运行 |
| 空闲且不触发 | 直接保存并刷新上下文 |

为什么不马上插入运行中的旁注？模型可能刚发出 toolCall，而相应 toolResult 还没保存。插入 user/custom 内容会把调用与结果分开，一些提供商会拒绝这种消息序列。

用户主动执行的 bash 结果也会在代理运行时暂存，但它的刷新位置主要是整个应用运行结束的 finally；与回合末刷新 custom 消息不是完全相同的时间点。

## 8.5 系统提示词由可更新章节组成

[system-prompt.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/system-prompt.ts) 构建 preamble、tools、rules、docs、addendum、project_context、skills、cwd 等部分。除 preamble 外，章节包在对应标签中。

`diffSystemPromptSections()` 比较旧章节与新章节，只返回修改值；消失章节用 `null` 标记删除。更新记录作为 system 消息保存在 transcript 中，使当前提示词能从日志重放。

工具清单和提示规则随当前工具选择变化。技能目录只在存在可读技能文件的 `read` 或 `bash` 工具时加入提示词。声明一个技能名字并不等于自动把技能全文写入每次请求；显式 `/skill:name` 会读取技能文件、剥离 frontmatter，并构造技能内容块。

扩展也可以返回一个强制完整 systemPrompt。上层仍保存结构化提示词变化，在请求投影的最后阶段把所有 system 消息收敛成开头的一条强制文本消息。强制文本本身不按同样形式写入 transcript。这避免提供商继续采用原来开头的系统提示词。

## 8.6 已注册、已激活、可被其他工具调用

工具注册表保存定义、参数 schema、来源、渲染方式和执行包装器。工具是否在表中、是否直接声明给模型、是否能由另一个工具调用，是三个不同判断。

| exposure | 通常的声明与调用方式 |
| --- | --- |
| `direct` | 激活后声明给模型，也可由其他工具调用 |
| `model-only` | 可声明给模型，不进入其他工具的 callable 集合 |
| `codemode`、`deferred` | 不依赖普通激活集合即可被其他工具调用 |
| `hidden` | 普通激活路径不声明，也不进入上述 callable 集合 |

显式 loadout 操作与 `prepareLoadout` 还会调整声明，应检查最终请求投影，不能只凭 exposure 字段断言某次请求的内容。

工具 allowlist、denylist 在注册表构建阶段筛选；扩展和 SDK 自定义工具可以用同名定义替换基础定义，SDK 自定义工具位于合并序列后面。

工具动态注册时，直接可声明且 `defaultActive` 没有设为 false 的新工具通常会自动激活。恢复会话或 reload 时尚未连接的 MCP 工具名称暂存在 `_pendingToolNames`，注册完成后激活；开始新的 agent run 或替换掉原有 loadout 时有清理规则。这对应“日志记得一个工具，但服务器还在连接”的状态。

## 8.7 请求时重新投影并处理虚拟模型路由

`_installAgentRequestProjection()` 在每次请求前用 `SessionManager.buildSessionProjection()` 替换上下文消息，工具则使用当前可执行实现。

如果选中虚拟模型，调用 `ModelRuntime.resolveModel()` 决定本次实际模型和思考级别。路由理由可以是 user、continuation 或 retry。路由状态作为自定义条目保存在当前分支，便于恢复。

Agent state 中仍保留用户选择的虚拟模型，实际回答消息记录物理模型。路由后再按物理模型的 contextWindow 检查压缩，防止用一个没有真实请求限制的虚拟选择来判断上下文大小。

## 8.8 事件、扩展修改与持久化有先后关系

在 `message_end` 中，当前顺序是：

```text
Agent 已形成最终消息对象
→ 扩展 message_end 钩子，可返回替换消息
→ 原对象就地更新，以保持各处引用一致
→ 公开 AgentSession 监听器
→ SessionManager 追加消息
→ 建立消息对象到条目 ID 的映射
```

因此公开监听器收到 `message_end` 时，对应日志追加仍在后面。不能在这个回调里假定“消息已经持久化完毕”。

公开 `_emit()` 同步调用监听器，没有逐个 await 返回的 Promise。它也没有对每个监听器加独立的 try/catch。扩展 runner 的调度和底层 Agent 的异步订阅另有实现，不能用它们的保证替代公开会话监听器的行为。

嵌套工具的记录在外层 toolResult 的 `message_start` 前附加到结果对象中，随后随这条结果保存。分支或恢复后的对象映射可以根据投影位置重新建立。

## 8.9 回合边界允许扩展提交上下文变更

`turn_end` 和 `agent_before_settle` 扩展可以提出 custom、custom_message、context_edit 或 compaction 草稿。上层用一个内存 `SessionManager` 应用草稿，预览它们将产生的模型上下文，再提交到真正日志。

预览很必要。例如扩展删除了最后一个 assistant 并增加一条 user 内容，就可能产生可续跑的上下文；仅要求 continue，却留下一个已经完成的 assistant，未必能再次请求。

`canContinue` 结合最后一条模型消息、是否有非 system 内容、待发送消息和所在边界计算。错误续跑请求被记录为扩展诊断。

草稿预览不等于持久化事务。实际 `_applyBoundaryDrafts()` 逐条追加；其中一条抛错时，本模块没有回滚已经追加的前面条目。

## 8.10 agent_end 与 agent_settled

`_runAgentPrompt()` 等待一次底层 Agent 运行后，进入上层 post-run 循环：

```text
agent.prompt()
→ 分析最后一次回答
→ 必要时等待重试或进行溢出压缩
→ 必要时 agent.continue()
→ 处理 agent_end 中新加入的队列
→ agent_before_settle
→ 如扩展有有效续跑请求，再 continue
→ 清理运行状态和待保存消息
→ agent_settled
```

`agent_end` 表示这一次下层运行结束；上层仍可能继续。上层转发该事件时增加 `willRetry`，供界面决定是否保留等待状态。

在 settled 事件中发起 prompt，会被放入 `_deferredSettledActions`，等当前 settled 分发结束再执行，避免直接在相同阶段嵌套启动。

`isStreaming` 代表整个应用代理运行及其 post-run 续跑。`isIdle` 检查这段运行和压缩、分支摘要状态，但不包括独立用户 bash 的运行集合，也不把 settled 监听器自身的执行全部算作活动。`waitForIdle()` 因此不是等待所有后台任务和监听器结束的通用屏障。

## 8.11 三层重试要分开

提供商 SDK/适配器可重试一次 HTTP 请求；应用代理可重试一次已经形成 error assistant 的逻辑回答；摘要生成也有自己的重试回调。这些层次的预算和触发点不同。

应用 `_prepareRetry()` 根据设置计算延迟，默认最多 3 次、基础延迟 2000 ms。它先用 `context_edit:null` 把失败回答从模型投影中省略，同时保留原始日志，等待可取消的退避，再调用 continue。

不能直接把失败 assistant 原样放在上下文末尾继续，因为那会让恢复请求错误地继承一次未完成或失败的回答。对于虚拟模型，失败响应还单独保存为下一次路由的 failed 参数。

成功的 assistant 回复会重置应用重试计数，避免一次长工具链中不同模型请求的临时失败累积成同一个预算。

上下文溢出不走普通网络重试，因为再次提交同样大小的请求通常仍会失败；它走下一节的压缩恢复。

## 8.12 手工压缩、阈值压缩与溢出恢复

手工 `compact()` 先取消并等待当前代理活动，设置手工压缩 controller，准备要总结的历史，允许扩展取消或提供压缩结果，然后保存 compaction 并刷新上下文。它不会自动继续被用户中断的原回合。

自动压缩分为：

- threshold：达到配置阈值，压缩后不重复一条已完成回答。
- overflow：成功回复的用量超过限制，压缩但保留完成回复。
- overflow 恢复：显式上下文错误或可恢复的 length 截断，省略失败回答和相关工具结果，压缩后重试一次。

`_overflowRecoveryAttempted` 防止相同恢复无限循环；新的用户输入会重置它。旧模型的错误不能简单用新模型的限制判断，旧压缩之前的 usage 也不能当成新上下文大小。

自动压缩成功后，如果有排队消息，可以继续一次把消息交付。手工压缩状态在成功的 `compaction_end` 公开事件前清除，方便该事件的监听器提交新 prompt；自动路径的状态清理在 finally，时间点不同。

压缩后若还没有有效的新 assistant usage，`getContextUsage()` 返回 tokens 和 percent 为 null。null 表示未知，不是零；界面不应显示为“上下文完全空了”。

## 8.13 嵌套工具的执行与记录

工具通过 `ctx.executeTool()` 再调用工具时，[nested-tool-calls.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/nested-tool-calls.ts) 分配形如 `外层ID/1`、`外层ID/1/1` 的子 ID，走同一工具参数检查和前后钩子，并发出带 `parentToolCallId` 的执行事件。

子调用不单独追加顶层 toolResult，而是把调用摘要和累计 usage 写到外层结果。记录最多保留 256 个调用；单次参数最多 8 KiB、累计参数最多 32 KiB，超限省略参数或调用并标记 incomplete。记录限制不等于禁止执行更多调用；被省略调用的 usage 仍可累加。

需要串行的子调用等待专门的 Promise 尾链。正在持有该队列的工具继续嵌套调用时，通过 `holdsQueue` 避免等待自己形成死锁。普通非串行调用可以绕过这条队列，因此该队列不能被描述为排除所有其他并行子调用的全局互斥锁。

工具失败通常返回 `isError:true`。事件监听器抛错、参数记录序列化异常等外围失败仍可能使调用抛错，不能把“工具失败被转成结果”推广为“整个 API 永远不 reject”。

## 8.14 取消、dispose 与 reload

`abort()` 中止重试、压缩、分支摘要和底层 Agent，并等待应用空闲；独立用户 bash 有单独 `abortBash()`。取消是合作式的，真正文件写入与子进程收尾的保证见第十一、十二章。

`dispose()` 发出相应取消请求、使扩展上下文失效、解除订阅和模型会话资源，但该同步方法本身不等待所有任务结束。运行时切换在调用它之前有单独等待当前代理 abort 的步骤。

`reload()` 使旧 runner 失效，重载设置和资源，重建工具包装器与扩展绑定。旧扩展持有的 ctx 不能继续使用；会话替换 API 提供的 `withSession` 用于拿到新上下文。

reload 会激活新加入默认设置的工具；从默认设置移除的工具不一定自动从本次会话激活集合中移除，因为源码还保留会话期间的工具选择。reload 方法本身也没有包住所有调用的全局调度锁，调用模式须负责安排适当的操作时机。

## 8.15 API 并发边界要沿 await 检查

底层 Agent 拒绝同一个实例上同时启动独立 run。上层 prompt 前置处理却包含扩展、认证、压缩和图片处理等多个 await，而且 `_isAgentRunActive` 在真正启动路径中才设置。

所以两个调用者同时提交 prompt，不能仅靠入口的 `isStreaming` 检查就推导为“全部前置处理已按调用顺序串行”。宿主需要遵守对应模式的调度约定，避免同时修改模型、loadout 或发起替换操作。第七章的底层运行保护与第十一章的文件队列，也都不自动替这些上层操作提供事务。

## 8.16 检查理解

1. 为什么扩展命令在回答期间也能立即执行，却不能作为 steering 命令排队？
2. 工具结果和扩展旁注之间应维持什么顺序？
3. 收到公开 `message_end` 能否立刻认定 JSONL 已保存？
4. 一次 agent_end 之后还可能执行哪些操作？
5. 网络重试为何省略失败回答但保留它的原始日志？
6. 可被 codemode 调用的工具是否必然直接声明给模型？
7. `isIdle` 为 true 时，独立用户 bash 是否可能仍在执行？

沿这条链路阅读后，就可以把“用户输入”具体拆成输入转换、请求准备、工具流水线、日志追加和恢复阶段，而不会只看到一个巨大类中的方法列表。

## 8.17 实际源码怎样产生提示章节补丁

问题是切换 cwd、技能或工具说明之后，历史里的旧提示仍在。会话构造新章节后，使用以下完整生产函数与 transcript 重放出的旧章节比较：

源码定位：[packages/coding-agent/src/core/system-prompt.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/system-prompt.ts#L204)，第 204—216 行。

<!-- source-lines: packages/coding-agent/src/core/system-prompt.ts:204-216 -->
```ts
export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}
```

输入 previous 允许 null，因为它描述 system delta 的字段形状；正常重放后的当前章节已不含删除项。第一轮遍历 current，只把与 previous 不同的值写入 patch。第二轮遍历旧键，对新对象中不存在的章节写 null。返回 undefined 表示没有变化，使调用者可以避免额外更新记录。它是同步纯比较，不保存日志，也不请求模型。

具体数据：previous=`{preamble:"base", cwd:"old", skills:"skill"}`，current=`{preamble:"base", cwd:"new", rules:"rule"}`；patch=`{cwd:"new", rules:"rule", skills:null}`。preamble 没变，不重复写入。system 重放更新 cwd、增加 rules、删除 skills，之后由提供商根据中途 system 支持情况原位发送或收敛。

章节 diff 比较完整字符串，不做 token 级 diff；增加 rules 的位置遵循对象迭代与重放 Map 的规则，也不是任意重排章节的指令。如果只是改位置而文字相同，不能用本函数自动表示新的顺序。

## 8.18 结构化提示与强制完整提示的函数边界

下面是完整生产函数：

源码定位：[packages/coding-agent/src/core/system-prompt.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/system-prompt.ts#L186)，第 186—192 行。

<!-- source-lines: packages/coding-agent/src/core/system-prompt.ts:186-192 -->
```ts
export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	content: string;
	sections?: SystemPromptSections;
} {
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	return { content: "", sections: buildSystemPromptSections(input) };
}
```

`forceSystemPrompt !== undefined` 意味着空字符串也算显式强制输入；不是 truthy 判断。强制路径返回 content，不附 sections。普通路径 content 为空，通过 buildSystemPromptSections 构造命名章节。返回值描述提示状态，外层再把它用于 system 消息或强制请求投影。

它不能单独证明强制提示在日志中怎样保存。8.5 已说明 AgentSession 仍维护结构化历史，强制完整文本在最后请求投影阶段生效；这里要把“构建返回值”与“持久化和最终请求的调用位置”分开。教程实验 `transcript` 验证重放删除语义；要验收整个会话的 force/reload/分支行为，需使用第三十一章的会话 harness，而不是仅调用本函数。

## 8.19 进入 run 前，输入怎样成为真实消息

问题：前面的输入钩子、图片归一化和工具选择都可能修改本轮内容。若过早创建 user 消息，模型看到的内容可能与最后选定的模型、工具不一致。`prompt()` 在这些异步处理完成之后，才执行下面这段实际实现。

源码定位：[agent-session.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/agent-session.ts#L2028)，第 2028—2063 行。这是 `prompt()` 的末段，前置认证和钩子见 8.2、8.3。

<!-- source-lines: packages/coding-agent/src/core/agent-session.ts:2028-2063 -->
```ts
		const normalized = await this._normalizePromptImages(currentImages);
		const userText = normalized.hints.length > 0 ? `${expandedText}\n\n${normalized.hints.join("\n")}` : expandedText;

		// Build messages only after hooks and image normalization have completed.
		const messages: AgentMessage[] = [];
		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: userText }];
		userContent.push(...normalized.images);
		messages.push({
			role: "user",
			content: userContent,
			timestamp: Date.now(),
		});

		// Inject any pending "nextTurn" messages as context alongside the user message
		for (const msg of this._pendingNextTurnMessages) {
			messages.push(msg);
		}
		this._pendingNextTurnMessages = [];

		for (const msg of result.messages) {
			messages.push({
				role: "custom",
				customType: msg.customType,
				// Untyped extensions can pass null/missing content; normalize at ingestion.
				content: msg.content ?? [],
				display: msg.display,
				details: msg.details,
				timestamp: Date.now(),
			});
		}
		const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
		this._runSystemPromptOptions = result.systemPromptOptions;
		if (updateMessage) messages.unshift(updateMessage);

		preflightResult?.("started");
		await this._runAgentPrompt(messages);
```

以无图片、无扩展自定义消息的一次输入为例：`expandedText` 成为 `userText`，`messages` 先得到一条 user。如果提示词或工具声明有变化，`updateMessage` 插到数组开头；没有变化就不追加这条 system 更新。因此“本轮发送一个用户输入”不等于“传给 Agent 的数组只有一个元素”。

`nextTurn` 消息在 user 后加入，再清空待交付数组；`before_agent_start` 返回的自定义消息随后加入。清空是内存中的交付决定，不是一个同时覆盖队列、JSONL 和外部文件的事务。`preflightResult("started")` 也发生在等待实际 run 之前，只报告本轮已经进入启动路径，不能当作模型回答或工具修改已经成功。

这里有三个可观察的边界：钩子完成后才构造最终 user；system 更新排在本轮消息之前；真正运行由 `_runAgentPrompt()` 接管。对于同时调用两个 prompt 的宿主，前置的多个 await 仍不构成互斥，8.15 的约束没有因这段数组构造而消失。

## 8.20 实际 run 函数为什么比 agent.prompt 多一层循环

问题：底层 Agent 结束后，应用可能决定重试、压缩或接受扩展的续跑。如果 UI 只等待第一次 `agent.prompt()`，它可能在应用尚未完成时允许下一次独立运行。

下面是完整生产方法，不是重写的流程伪代码：

源码定位：[agent-session.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/agent-session.ts#L1775)，第 1775—1804 行。

<!-- source-lines: packages/coding-agent/src/core/agent-session.ts:1775-1804 -->
```ts
	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._agentRunAbortRequested = false;
		// Compaction before the prompt may have scheduled a retry; the new prompt replaces it.
		this._failedResponse = undefined;
		this._recordSelection();
		// The run records the loadout in the transcript; restored tools that did not register by now
		// are dropped, so a tool that never registers does not stay pending.
		this._pendingToolNames.clear();
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (!this._agentRunAbortRequested) {
				if (await this._handlePostAgentRun()) {
					if (this._agentRunAbortRequested) break;
					await this.agent.continue();
					continue;
				}
				if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary())) break;
				if (this._agentRunAbortRequested) break;
				await this.agent.continue();
			}
		} finally {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = undefined;
			this._runSystemPromptOptions = undefined;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			await this._emitAgentSettled();
		}
	}
```

| 执行位置 | 状态变化 | 为什么需要 |
| --- | --- | --- |
| 进入方法 | 清除旧失败响应、记录模型和工具选择、清空尚未注册的待恢复工具名 | 新 prompt 使用此时可用的选择，不无限保留旧 retry 或未出现的工具 |
| 第一次 prompt 前 | `_isAgentRunActive = true` | 把后续重试等待、压缩恢复和续跑也算入应用 run |
| `_handlePostAgentRun()` 返回 true | 调用 `agent.continue()`，然后重新检查 | 应用恢复之后还需要一次底层运行；不能直接宣布 settled |
| post-run 没有续跑 | 等待 `_runBeforeSettleBoundary()` | 给扩展最后一次提交上下文与有效续跑请求的机会 |
| finally | 清理失败引用和本轮提示选项，刷新 bash/custom，再发 settled | 正常结束、取消及异常退出都经过应用收尾 |

短轨迹是：第一次请求临时失败 → Agent 发 `agent_end` → 上层等待退避 → `agent.continue()` 再发请求 → 第二次成功 → before-settle 没有续跑 → finally。这个过程有两次底层结束，只有最后才进入应用 settled。

每个等待之后再次检查 `_agentRunAbortRequested`，因为取消可能恰好发生在等待期间。只在循环入口检查一次，可能在用户已经取消后又启动 continuation。这里解决的是应用层继续运行的准入；工具已经发生的磁盘效果仍按第十一章处理。

finally 保证尝试收尾，不能理解为“其中任一步抛错也一定发出全部剩余事件”。例如刷新消息或扩展 settled 钩子抛错，仍可能影响后续步骤。正常实验没有注入这些故障，不能据正常通过声称任意存储错误都能恢复。

## 8.21 settled 回调中的新输入如何避免嵌套启动

假设扩展在 `agent_settled` 中提交下一步 prompt。应用先把 run 标志清除，才能给监听器正确的空闲状态；但立即启动新 run 会嵌在当前 settled 分发中，使状态和事件交错。源码用单独的分发标志和延迟动作处理这个问题。

源码定位：[agent-session.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/agent-session.ts#L1050)，第 1050—1071 行，完整方法。

<!-- source-lines: packages/coding-agent/src/core/agent-session.ts:1050-1071 -->
```ts
	private async _emitAgentSettled(): Promise<void> {
		this._cacheWarmer?.onAgentSettled();
		this._isAgentRunActive = false;
		this._isEmittingAgentSettled = true;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._isEmittingAgentSettled = false;
		}

		const deferred = this._deferredSettledActions.splice(0);
		if (deferred.length > 0) {
			try {
				for (const action of deferred) await action();
			} finally {
				this._resolveIdleWaitIfIdle();
			}
			return;
		}
		this._resolveIdleWaitIfIdle();
	}
```

`prompt()` 入口检测 `_isEmittingAgentSettled`，把动作放入 `_deferredSettledActions` 后返回。上面的 `splice(0)` 取走当前一批动作，在 settled 分发标志清除后逐个 await；最后只有真的空闲才释放 idle 等待者。`splice` 同时使原数组重新为空，防止这批动作重复执行。

注意两个不同的完成：settled 钩子里的 `await session.prompt(...)` 只等到动作排队；实际新 prompt 随后才执行。外部代码若需要等待应用达到空闲，应使用相应的 idle API，并遵守宿主的输入调度约定。公开 `_emit()` 没有等待异步监听器返回值，所以这里也不是全部监听器工作完成的通用屏障。

## 8.22 用真实 JSONL 验证事件和保存的顺序

8.8 的顺序可以直接在源码与运行中对照。下面保留 `_handleAgentEvent` 中公开派发和日志追加的连续代码；后面的 retry 计数处理不在这个节录内。

源码定位：[agent-session.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/agent-session.ts#L1110)，第 1110—1136 行。

<!-- source-lines: packages/coding-agent/src/core/agent-session.ts:1110-1136 -->
```ts
		// Emit to extensions first, then notify public listeners.
		await this._emitExtensionEvent(event);
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			let entryId: string | undefined;
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				entryId = this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "system" ||
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				entryId = this.sessionManager.appendMessage(event.message);
			}
			if (entryId) this._entryIdsByMessage.set(event.message, entryId);
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere
```

第 35 章的测试使用真正的 AgentSession、read/edit 工具和磁盘 JSONL。公开监听器收到两条 toolResult 的 `message_end` 时，分别查当前 branch，得到 `[false, false]`；等待 `session.prompt()` 完成后重开 JSONL，两条结果都存在。这个断言没有把保存函数替换为记录器，因此它核验的是正常文件路径上的派发先后。

恢复后的上下文还包含 `book-edit` 的 toolResult，新模型请求能看到原编辑结果，文件写入计数保持 1。它证明完成历史被重建且这次新请求没有重复发 edit。faux provider 决定回复文本和工具选择；测试没有证明真实模型一定会选择同样的工具，也没有覆盖“文件已修改、toolResult 保存失败”这个窗口。

完整输入、预期文件、保存条目和执行命令见 [第 35 章](35-session-development-workshop.md)。本章练习的参考解答见 [第 36 章](36-exercise-solutions.md)。
