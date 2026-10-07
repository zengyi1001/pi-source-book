# 第三十四章 规划、经典多代理与任务交接

用户提出“定位配置丢失问题，给出计划，再修改并检查”，并不意味着底层循环已经有一个独立规划器。第七章的循环接收模型回复、执行工具、继续请求；工作分解可以来自模型文字，也可以由扩展保存和调度。本章用两个经典示例说明规划与委派怎样具体实现，再与第二十九章的 Durable Subagent 对照。

本章讨论的是基准提交中的示例扩展；安装或加载这些示例才会获得对应命令和工具。不能把示例代码写成所有 Pi 会话默认启用的功能。

## 34.1 先区分四种“计划”

| 机制 | 具体输入与状态 | Pi 中的实现位置 |
| --- | --- | --- |
| 模型工作分解 | assistant 文字中的步骤，随后由模型选择工具 | 第七章循环；本身没有任务依赖图 |
| Plan Mode | 模式标志、todo 数组、工具集合、完成标签 | [plan-mode/index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/examples/extensions/plan-mode/index.ts)、[utils.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/examples/extensions/plan-mode/utils.ts) |
| 经典 Subagent | single、tasks、chain 参数；临时子进程结果 | [subagent/index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/examples/extensions/subagent/index.ts)、[agents.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/examples/extensions/subagent/agents.ts) |
| Durable 任务 | 持久化任务身份、子会话、输入请求身份、完成条目 | [durable/subagent.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/experimental/durable/subagent.ts)、第二十五至二十六章 |

ReAct 在这里指模型交替选择行动、读取观察结果、再决定下一步的组织方式。一次 `toolCall → toolResult → 下一次 assistant` 具有这种交替结构；源码没有因此承诺模型一定产生显式推理文字，也没有实现一个名为 ReAct 的固定规划状态机。提供商的 thinking 是生成机制，todo 是应用状态，二者也不能互相替代。

必要机制是把任务、工具结果和下一步输入连起来。依赖图、独立规划模型、自动重规划与形式化完成验证都是额外设计，不能根据模型写出了编号列表就推导它们已经存在。

## 34.2 Plan Mode 的入口与状态转换

加载示例后，`--plan` 可以在会话启动时启用；`/plan` 与快捷键调用同一个 `togglePlanMode()`。扩展闭包保存 `planModeEnabled`、`executionMode`、`todoItems` 和 `toolsBeforePlanMode`，不是往 Agent 核心里增加一种新角色。

```text
普通模式 → /plan → 规划模式
规划模式 → 模型输出 Plan: → agent_end 显示选择
选择 Execute → 执行模式，恢复工具，发送 follow-up
执行模式 → turn_end 读取 [DONE:n] → 更新 todo
全部完成 → agent_end 发送完成说明，清空执行状态
```

再次切换 `/plan` 会清空当前 todo 并退出执行模式。计划不是一份不可变任务规格；模型可以在下一次回复中给出新列表，扩展用新提取结果替换旧数组。

## 34.3 工具过滤到底保证什么

下面是 `getPlanModeTools()` 的生产源码完整函数。它读取进入规划前的工具名，移除特定名称，再补充探索工具：

源码定位：[packages/coding-agent/examples/extensions/plan-mode/index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/examples/extensions/plan-mode/index.ts#L90)，第 90—95 行。

<!-- source-lines: packages/coding-agent/examples/extensions/plan-mode/index.ts:90-95 -->
```ts
	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}
```

例如进入前为 `[read, edit, write, mcp_mutate]`，进入后保留 `read` 和 `mcp_mutate`，去掉 `edit`、`write`，并请求增加 `bash/grep/find/ls/questionnaire`。不存在的工具是否真正可激活，由会话注册表处理；列出 `questionnaire` 不会凭空注册它。

因此，“内置 edit/write 被禁用”是准确描述；“任何写入能力都被禁用”则不成立。自定义工具可能仍能写文件或修改远程服务，`tool_call` 钩子也只检查名为 `bash` 的工具。

退出时优先恢复保存的原工具集合，随后清除快照。它不会把规划期间所有工具选择变化合并回原集合。这个取舍使进入与退出可预测，但不能把它称为并发工具变更的事务合并。

## 34.4 Bash 过滤是字符串判断

`isSafeCommand()` 的完整源码如下；两组正则定义位于同文件前面：

源码定位：[packages/coding-agent/examples/extensions/plan-mode/utils.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/examples/extensions/plan-mode/utils.ts#L97)，第 97—101 行。

<!-- source-lines: packages/coding-agent/examples/extensions/plan-mode/utils.ts:97-101 -->
```ts
export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}
```

它先找已知破坏性单词和重定向形式，再要求命令开头匹配允许模式。`cat src/config.ts` 返回 true，`npm install package` 返回 false。实验还只对字符串调用分类器，验证 `find . -delete` 与 `curl -X POST ...` 返回 true；没有实际执行这些命令。

原因是允许 `find` 或 `curl` 开头并不解析参数的作用，也不分析 shell 的完整执行语义。误判还可能来自引号里的文字、复合命令或子命令。这里的“safe”是函数命名和示例约定，不能当成操作系统权限隔离的证明。

如果宿主需要严格探索模式，必要设计是限制真实能力：在统一工具执行管线审核每一种有副作用的工具，或给子进程提供限制过的执行环境。完善命令解析可以降低误判，但仍需区分本地写入、联网和远程修改。这里是在说明设计边界，并未替教材修改产品功能。

## 34.5 提示注入、列表提取与完成判断

`before_agent_start` 返回 `plan-mode-context` 自定义消息，要求模型只探索、提问，并在 `Plan:` 标题下输出编号步骤；`display:false` 只控制显示，消息仍可进入模型上下文。执行模式注入的 `plan-execution-context` 列出未完成步骤，要求在完成后写 `[DONE:n]`。

`extractTodoItems()` 使用英语 `Plan:` 标题与编号正则。它清理 Markdown 和部分动词前缀，再按成功提取的顺序重新编号。原文的 `7.`、`9.` 会变成内部的第 1、2 步；中文标题“计划：”不会自动匹配。

这解释了一个具体失败方式：模型仍按原编号返回 `[DONE:7]`，内部数组里却没有 step 7，这个标签不能完成第 1 步。执行提示会列出重编号后的列表，因此正确交接依赖模型使用这份列表。

完成标记使用的是以下实际函数：

源码定位：[packages/coding-agent/examples/extensions/plan-mode/utils.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/examples/extensions/plan-mode/utils.ts#L161)，第 161—168 行。

<!-- source-lines: packages/coding-agent/examples/extensions/plan-mode/utils.ts:161-168 -->
```ts
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}
```

它返回识别到的标签数量，包含重复或不存在的编号；不是新完成任务数。`[DONE:1] [DONE:1] [DONE:99]` 返回 3，只把 step 1 标为完成。没有读取测试结果、diff 或磁盘状态来验证“完成”。必要的验收应来自真实工具证据和断言；完成标签适合界面进度，不能替代验收。

## 34.6 follow-up 为什么用于开始执行

选择 Execute 后，扩展先关闭规划、开启执行、恢复工具并保存状态。然后发送两个自定义消息：一条显示 todo；另一条 `plan-mode-execute` 携带执行指令，设置 `triggerTurn:true`、`deliverAs:"followUp"`。

这发生在 `agent_end` 钩子中。第八章已经说明下层 `agent_end` 后，上层会话还会处理新队列；follow-up 使执行计划成为后续输入，而不是在正在结束的工具批次中途插入内容。

`context` 钩子在退出规划后过滤旧 `plan-mode-context`，也会过滤含 `[PLAN MODE ACTIVE]` 的 user 文本。后者按文字匹配，所以用户讨论这个标记的正常消息也可能被过滤。它不能被解释为只删除扩展自己创建的消息。

## 34.7 状态恢复不等于 Durable 调度

`persistState()` 通过 `appendEntry("plan-mode", ...)` 保存模式、todo、执行标志和原工具集合。`session_start` 从 `sessionManager.getEntries()` 找最后一个对应 custom 条目；执行中恢复时，再从最后一个 `plan-mode-execute` 之后的 assistant 文字重建完成标记。

当前代码使用整个日志的 `getEntries()`，没有在这里改用当前分支投影。因此不能直接声称跨 `/tree` 的规划恢复严格沿当前分支；旁支中的条目可能影响这个查找。它也不恢复一个正在运行的 OS 子进程，更没有为每一步外部效果保存重放意图。

第二十六章的 Durable 恢复则围绕任务身份、意图记录和提交位置展开。保存一个 todo 数组解决“重新打开时还能显示进度”，并不解决“崩溃前的写入能否安全重跑”。

## 34.8 经典 Subagent 怎样发现角色

`agents.ts` 从用户 agent 目录和最近祖先目录的 `.pi/agents` 读取顶层 `.md` 文件。frontmatter 必须有字符串 name、description，正文作为追加系统提示；tools 可用逗号字符串或字符串数组描述，model 可指定提供商与模型。

默认 scope 是 user。project 只看项目角色，both 合并两者，同名时项目定义覆盖用户定义。查找最近 `.pi/agents` 沿父目录到文件系统根，不等于自动以 Git 根为边界。

工具配置缺失或解析后为空会回到子 Pi 的默认工具行为；空 tools 不能当成禁止所有工具。角色名是配置选择键，系统提示才是对模型的任务说明，不能把名称本身当成执行能力。

请求项目角色时，可在有 UI、未信任项目且启用确认的条件下弹出确认。无 UI 不走这条确认分支；信任提示也不会为子进程建立文件系统沙箱。第十七章的包信任与这里的角色确认应分别追踪。

## 34.9 子进程启动参数与上下文隔离

`runSingleAgent()` 先按名字查找配置；未知角色直接返回失败结果，不能启动进程。找到后，参数构造部分如下，保留源码原样：

源码定位：[packages/coding-agent/examples/extensions/subagent/index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/examples/extensions/subagent/index.ts#L300)，第 300—307 行。

<!-- source-lines: packages/coding-agent/examples/extensions/subagent/index.ts:300-307 -->
```ts
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
```

`--mode json` 提供 JSON 事件流，`-p` 使用单次输出模式，`--no-session` 避免为这次经典子调用保存普通会话。显式 agent.model 优先；没有显式模型时继承父会话的模型和 thinking level。选择自己的模型时不自动继承父 thinking，避免把父模型配置直接套到不同模型。

角色提示写到随机临时目录下的文件，创建模式为 `0600`，通过 `--append-system-prompt` 传入。这里是追加，子 Pi 自身的系统提示和按启动流程加载的资源仍可能参与请求。任务作为一个 argv 字符串 `Task: ...` 传入，spawn 设置 `shell:false`，不把任务文字作为 shell 命令解释。

默认 cwd 是父会话目录，也允许任务指定 cwd。子进程没有复制父消息历史，主要交接内容是任务文字、角色提示与子进程自行加载的资源。这叫对话上下文隔离；多个子进程仍可能修改同一磁盘文件，也继承宿主进程环境中的可用配置。第十一章的文件队列在各模块实例中独立存在，不能跨进程避免更新丢失。

## 34.10 JSON 事件、用量与输出选择

stdout 按换行缓存并解析 JSON，`message_end` 将完成消息加入结果；assistant 的 input/output/cacheRead/cacheWrite/cost 累加，contextTokens 保存最近用量。无效 JSON 行被忽略，stderr 单独累积；进程 error 使退出码为 1。

当前流处理对每个字节块直接 `data.toString()`，没有像第二十一章的 JSONL reader 那样使用流式 UTF-8 解码。JSON 行跨块能被缓存，并不证明中文字符跨字节块不会损坏。这是两种 reader 实现的区别。

最终文字选择使用以下完整源码：

源码定位：[packages/coding-agent/examples/extensions/subagent/index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/examples/extensions/subagent/index.ts#L170)，第 170—180 行。

<!-- source-lines: packages/coding-agent/examples/extensions/subagent/index.ts:170-180 -->
```ts
function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}
```

它从后向前找到 assistant，然后返回该消息里的第一个 text 块；不是把全部 text 块拼接。若末尾 assistant 没有 text，会继续寻找更早的 assistant。因此 child 输出两个块“发现”和“建议”时，交给下一步的可能只有“发现”。tool details 中仍有完整消息，可用于界面展开；下一步任务文字并不自动得到这些 details。

退出码非零，或最终 stopReason 为 error/aborted，被 `isFailedResult()` 视为失败。length 不在这个判断中，因此不能推广为“所有截断子回答都会停止 chain”。取消路径发送 SIGTERM，安排五秒后的 SIGKILL 检查；`proc.killed` 表示发送过信号，不能证明进程真正退出，也不能证明整个后代进程组已结束。

## 34.11 single、parallel 与 chain 的具体调度

三个非空模式只能选一个。single 返回一个角色的结果；parallel 接收最多 8 个任务，用最多 4 个 worker 调度。下面是完整 worker pool：

源码定位：[packages/coding-agent/examples/extensions/subagent/index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/examples/extensions/subagent/index.ts#L219)，第 219—237 行。

<!-- source-lines: packages/coding-agent/examples/extensions/subagent/index.ts:219-237 -->
```ts
async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
```

四个异步 worker 在首次 await 前各取一个 `nextIndex++`。一个 worker 完成后再取下一项；不是一次性启动所有 8 个子进程。结果按原任务下标写入 `results`，所以输入顺序与完成顺序分离。实验用手动释放的 Promise 控制完成顺序，验证峰值为 4、返回仍为 0 至 7。

parallel 将每项输出截到 50 KiB 的主体预算，并附截断说明，完整结果留在 details；说明本身还会增加最终长度。某项失败后其他任务可以继续，最后返回成功数和各项文字；该 parallel 返回对象没有统一设 `isError:true`。不能只凭父工具的 isError 判断所有子任务是否成功。

chain 则逐项 `await runSingleAgent()`，把当前 task 中所有 `{previous}` 替换为前一个成功结果的最终文字。具体轨迹为：

```text
scout(task="寻找配置入口") → output="entry=src/config.ts"
reviewer(task="审阅 {previous}") → 收到 "审阅 entry=src/config.ts"
implementer(task="依据 {previous} 修改") → 收到 reviewer 的最终文字
```

它不会自动把 scout 的完整历史再传给 implementer，也不会逐步累积全部输出；需要保留的事实必须进入后一步的任务或输出。失败条件成立时立即返回 `isError:true` 并附已经执行的步骤，后续步骤不运行。前面的磁盘写入不会回滚。

这个调度器没有一般依赖图、自动角色选择、争议仲裁、独立结果验收或全局费用上限。模型可以据任务选择角色和模式，但静态 tools/roles 配置与运行时调度的职责仍需分开。

## 34.12 与 Durable Subagent 的关键差异

Durable 示例的工具标记 `replay:"safe"`，并在事务中按当前 `api.taskId` 查找已拥有的子会话；首次创建后配置为移除 Subagent 扩展，避免这个子会话继续委派。关键执行片段如下：

源码定位：[packages/coding-agent/src/experimental/durable/subagent.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/experimental/durable/subagent.ts#L34)，第 34—52 行。

<!-- source-lines: packages/coding-agent/src/experimental/durable/subagent.ts:34-52 -->
```ts
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// Starts as a copy of this conversation's agent; without this extension it cannot delegate further.
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, created.id, { extensions: { remove: [Subagent] } });
					return created.id;
				}, context);
				await api.details({ conversationId: child }, context);
				const handle = (await api.conversation(child, context))!;
				const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await handle.submit(request, context)).wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Subagent ${child} failed: ${settled.status}`);
				}
				const text = await answerText(api, settled.answer, context);
				return { content: [{ type: "text", text }], details: { conversationId: child } };
			},
```

同一个任务重跑时可以找到原子会话；`requestId:subagent:<taskId>` 让输入请求具备稳定关联，而不是每次崩溃恢复都无条件新建一次聊天。它等待子输入请求 settled 为 done，再从 answer 条目读取文字并返回 conversationId。子会话持久存在，可供用户之后切换继续对话。

| 维度 | 经典示例 | Durable 示例 |
| --- | --- | --- |
| 调度单位 | OS 子进程和内存结果 | 持久化 task、conversation 和 input request |
| 历史交接 | task 字符串与追加角色提示 | task 输入；不直接看到父对话 |
| 恢复身份 | 本函数未保存子调用恢复位置 | ownerTaskId 与稳定 requestId |
| 进一步委派 | 本示例未自动移除自身扩展 | 子配置移除 Subagent |
| 组合模式 | single/parallel/chain | 此工具一次委派一个子会话 |
| 外部效果 | 独立工具可能写共享文件 | 仍受各工具 replay 策略及环境边界限制 |

`replay:"safe"` 在这里说明编排能找回同一子会话与请求；它不为任意外部文件写入创造恰好一次语义。关于意图记录与实际副作用之间的间隙，仍要回到第二十六、二十七章。

## 34.13 交接契约怎样写得可检验

以“定位并修复配置丢失”为例，交给 scout 的任务至少应说明入口范围、期望返回的路径和函数，以及不要修改的约束；交给 reviewer 时应包含 scout 的结论和要检查的反例；交给 implementer 时应包含最终需求与离线验收命令。

这是基于现有 task 字符串边界的使用设计，不是示例已经实现的 schema。若要自动验证交接，需增加结构化结果和验收器，例如要求返回 `locations`、`evidence`、`unresolved`，再由宿主检查路径、证据和未解决问题。单纯要求子模型“认真检查”不能给运行时一个可判定的通过条件。

多代理主要改变工作分配与上下文范围；同一文件并发、费用、取消和恢复必须分别设计。对独立只读探索，parallel 可以减少等待；对有前后依赖的审查与实施，chain 明确交接；对需要跨崩溃继续的任务，Durable 提供更完整的保存位置。每一种选择应由具体任务性质决定。

## 34.14 离线实验与练习

在教材目录执行以下配套程序，不会启动真实 Pi 子代理或访问模型：

```sh
node labs/run-offline.mjs planning
node labs/run-offline.mjs subagents
```

planning 执行真实扩展闭包与纯函数，替换 UI、会话 API 和消息发送为内存记录；subagents 执行真实 worker pool、输出选择、dispatch 与工具 execute 方法，以 EventEmitter 模拟 spawn，用固定子任务结果验证 chain 交接、失败停止及 parallel 部分失败。它们能验证调用顺序与参数，不能证明 OS 子进程取消、真实提供商或 Durable 崩溃恢复已经通过集成测试。完整输入、断言和预计输出见 [实验说明](labs/README.md)。

1. 原工具里有 `mcp_mutate`，开启 `/plan` 后为什么它仍能执行？应在哪个共同入口限制真实副作用？
2. 原计划编号 7、9，执行消息 `[DONE:7]` 为什么不能完成第 1 个 todo？
3. 八项 parallel 任务中第 3 项最先完成，结果数组为何仍按输入排序？
4. chain 第 2 项写入成功、第 3 项失败，哪些状态保留？哪个机制能撤销磁盘写入？
5. 同一 Durable task 重跑，哪两个身份减少重复编排？为什么仍不能推导所有子工具效果恰好一次？

阅读到这里，应能沿“计划输入 → 状态与能力集合 → 委派参数 → 子执行 → 结果交接 → 验收或恢复”逐项定位源码，而不是只把多代理理解为多个模型名称。
