# 第三十五章 完整会话实验与扩展开发实战

前面的章节说明了机制，本章把它们连接成可运行的工程案例：创建会话 → 声明工具 → 模型调用 read/edit → 写入文件 → 保存 JSONL → 重新打开会话 → 在新请求中检查已有结果。随后开发一个扩展工具，用失败测试定位错误，再通过会话级测试证明它真正接入代理。

源码文件和测试程序随书交付。测试中的模型响应由 faux provider 提供：它按预设步骤返回助手消息，并允许检查真实请求上下文。认证、设置和资源发现使用测试夹具；AgentSession、代理循环、参数验证、扩展 runner、文件工具和 JSONL 保存路径使用项目实现。

## 35.1 先运行完整程序

前提是 Node.js 24 和已安装的仓库依赖。没有依赖时进入同级 `../pi` 仓库，按项目要求执行 `npm ci --ignore-scripts`；模型目录数据还应符合仓库固定版本，检查方法见第 32 章。本次工作区已具备这些依赖和固定模型数据。此处不需要构建 dist，不需要 API key，也不请求真实模型。

在教材目录执行：

```sh
node labs/run-integration.mjs coding
```

它只运行 [book-session-walkthrough.test.ts](labs/overlay/packages/coding-agent/test/suite/book-session-walkthrough.test.ts) 的 7 个用例，不触发全套测试。通过时会输出三个关键观察：

```text
TRACE session requests=3 tools=read,edit writes=1 persisted=6 resumedWrites=1
TRACE conflict writes=0 toolError=true persistedError=true
TRACE extension declared=literal_search lines=2 count=1 persisted=true
PASS 7 integration cases; faux models; temporary files and JSONL
```

coding 组使用文件与 JSONL，durable 组使用 SQLite。`persisted=6` 指重开后投影里的六条非 system 消息，不是 JSONL 总行数；第三行的 persisted 指扩展结果进入当前会话分支，该扩展用例使用内存 SessionManager。两个指标不能混为同一种磁盘保证。

[run-integration.mjs](labs/run-integration.mjs) 为子进程重新构造环境：临时 HOME，不继承认证、服务端点和用户扩展配置，设置 `PI_OFFLINE=1`。它调用指定测试文件，解析 Vitest JSON 报告，拒绝失败、跳过或 todo，最后清理临时目录。输入、工具选择和测试次数固定，读者能重复运行同一轨迹。

## 35.2 创建一个真正修改临时文件的会话

初始 `config.ts` 内容是：

```ts
export const retries = 1;
export const timeout = 10;
```

目标是两行分别变为 3 和 30。`persistedFixture()` 创建临时 cwd、真实 read/edit 工具和磁盘 SessionManager。它只给 edit 的文件操作接口增加计数，实际读取和写入仍调用 Node 文件系统。

源码定位：[配套测试](labs/overlay/packages/coding-agent/test/suite/book-session-walkthrough.test.ts#L23)，第 23—52 行，完整夹具。

<!-- source-lines: packages/coding-agent/test/suite/book-session-walkthrough.test.ts:23-52 -->
```ts
async function persistedFixture() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-book-session-"));
	directories.push(cwd);
	await writeFile(join(cwd, "config.ts"), ORIGINAL);
	let writes = 0;
	const tools = [
		createReadTool(cwd),
		createEditTool(cwd, {
			operations: {
				access: async (path) => {
					await access(path);
				},
				readFile: async (path) => readFile(path),
				writeFile: async (path, content) => {
					writes++;
					await writeFile(path, content);
				},
			},
		}),
	];
	const manager = SessionManager.create(cwd, join(cwd, "sessions"));
	const harness = await createHarness({
		cwd,
		tools,
		sessionManager: manager,
		settings: { compaction: { enabled: false } },
	});
	harnesses.push(harness);
	return { cwd, tools, harness, getWrites: () => writes };
}
```

三个 cwd 必须指向同一目录：文件工具解析相对路径所用 cwd、AgentSession 提供给扩展的 cwd，以及 JSONL header 记录的 cwd。为此 harness 增加可选的 `cwd` 参数；已有测试仍默认使用其临时目录。这是测试辅助代码的改动，应用运行时没有改动。

此案例显式关闭自动压缩，使短历史的角色序列可以直接核对；模型与认证来自 faux 夹具，文件和日志不是模拟对象。`getWrites()` 计量 edit 的 writeFile 调用次数，配合文件内容断言判断实际成功结果。

## 35.3 三次模型请求分别看到了什么

固定响应不是盲目返回：每个 faux 回调先验证上一阶段生成的真实上下文，再给下一步调用。

| 请求 | 先检查的真实输入 | 固定模型输出 | 下一阶段 |
| --- | --- | --- | --- |
| 1 | `getCurrentTools()` 为 read、edit | callId `book-read`，读取 config.ts | 实际读取，保存 toolResult |
| 2 | 最近的 toolResult 文本等于初始文件 | callId `book-edit`，同一次 edit 含两项替换 | 验证和计算整批 edits，一次写回 |
| 3 | 最近结果 callId 为 book-edit，isError 为 false | `updated retries=3 timeout=30` | 下层结束，再完成应用收尾 |

第二次请求传入的参数是：

```json
{
  "path": "config.ts",
  "edits": [
    { "oldText": "export const retries = 1;", "newText": "export const retries = 3;" },
    { "oldText": "export const timeout = 10;", "newText": "export const timeout = 30;" }
  ]
}
```

`fauxToolCall()` 构造的是模型消息，不是直接调用 edit 函数。请求之后仍由代理循环解析调用、验证参数、调用真正的工具并构造下一轮上下文。因此测试能发现“工具未声明”“结果没有交给下一轮”“修改没有进入日志”等接线问题。

完成后断言实际文件等于目标文本，writeFile 只调用一次，edit details 的 patch 含新增 retries 行，最后事件为 `agent_settled` 且 `isIdle` 为 true。只有最后的助手文本不会产生这些证据；模型说“已修改”不等于磁盘已经修改。

## 35.4 JSONL 保存、事件观察与恢复

公开 message_end 监听器在两条 toolResult 到达时立即查 branch，对应条目均尚未追加。这验证第 8 章的事件先于日志追加。等 prompt 完成后，测试读取真正 JSONL，检查 header 的 cwd，然后 dispose 原会话、从路径重新打开 SessionManager。

恢复的非 system 上下文是：

```text
user
assistant       toolCall book-read
toolResult      toolCallId book-read
assistant       toolCall book-edit
toolResult      toolCallId book-edit
assistant       最终答案
```

JSONL 还包含会话头、选择或 system 更新等记录；上表是上下文投影，不是原日志的逐行复制。恢复时应使用 SessionManager 的投影 API，不能按“每行必定是一条聊天消息”解析。

实际恢复代码和断言如下：

源码定位：[配套测试](labs/overlay/packages/coding-agent/test/suite/book-session-walkthrough.test.ts#L127)，第 127—152 行。

<!-- source-lines: packages/coding-agent/test/suite/book-session-walkthrough.test.ts:127-152 -->
```ts
		harness.session.dispose();
		const reopened = SessionManager.open(path);
		expect(
			reopened
				.buildSessionContext()
				.messages.filter((message) => message.role !== "system")
				.map((message) => message.role),
		).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"]);
		const resumed = await createHarness({
			cwd,
			tools,
			sessionManager: reopened,
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(resumed);
		resumed.setResponses([
			(context) => {
				expect(
					context.messages.some((message) => message.role === "toolResult" && message.toolCallId === "book-edit"),
				).toBe(true);
				return fauxAssistantMessage("history restored; no further edits");
			},
		]);
		await resumed.session.prompt("Report the previous result without editing.");
		expect(getWrites()).toBe(1);
		expect(await readFile(join(cwd, "config.ts"), "utf8")).toBe(EDITED);
```

第二个 AgentSession 使用重开的日志，但运行时模型和工具重新装配。新请求先断言存在旧 book-edit 结果，然后只返回总结，没有新 toolCall；计数仍为 1，磁盘仍是 3/30。这证明日志重建进入了新请求，并且这个固定回复没有重做完成的工具。

本案例在同一个测试进程里重建对象；没有把旧 AgentSession 的消息数组传给新对象，也没有模拟历史内容。但它没有启动新 OS 进程或在保存期间强制杀进程，不能将结论延伸为任意中途崩溃自动恢复。尚未完成的工具恢复应看第 26 章。

## 35.5 一个失败反例证明整批修改的边界

第二个会话用例把第二项 oldText 改成 `export const timeout = 20;`，文件中却是 10。第一项能匹配，第二项不能。执行轨迹是：

```text
读取原文件 → 第一项定位成功 → 第二项匹配失败
→ writeFile 调用次数为 0
→ 原文件仍为 retries=1、timeout=10
→ toolResult.isError=true
→ 下一次模型请求看到错误
→ 重开 JSONL 仍可看到 book-conflict 的错误结果
```

它验证第 10、33 章的“先计算整批、最后写回”，不是“两项已写入后再回滚”。这项保证局限于一个 edit 调用内失败的替换；外部编辑器并发写入、跨文件事务及 writeFile 期间故障不属于该测试。

## 35.6 实战需求：增加字面文本搜索工具

新增扩展 [book-literal-search.ts](labs/overlay/packages/coding-agent/examples/extensions/book-literal-search.ts) 提供 `literal_search`。字面搜索把点号、方括号等当普通文本。输入为文件路径、非空 text 和可选 caseSensitive；输出是匹配行号与行数，同一行多次出现只算一次。行号从 1 开始，支持 LF 和 CRLF，默认区分大小写。

先把可独立验证的计算提取为 `findLiteralLines()`，再用扩展 API 连接文件读取。这不是为了抽象增加层次：纯函数同时被 execute 与测试调用，便于把搜索算法错误和会话接入错误分开定位。

不区分大小写采用 JavaScript `toLowerCase()`，不是语言学意义上的完整 Unicode 折叠。工具一次读取整个 UTF-8 文件，适合小文件教学；没有复用内置 read 的截断、图像转换或大文件预算。`resolve(ctx.cwd, path)` 允许相对和绝对路径，也不能称为 cwd 沙箱。要扩展为大文件扫描，需要另行定义读取上限或流式行为。

## 35.7 实际失败：正则把点号当成任意字符

开发时先写了错误版本，把用户 text 直接交给正则表达式：

```ts
// 开发过程的错误版本；不在交付实现中。
const expression = new RegExp(needle, caseSensitive ? "" : "i");
return source.split(/\r?\n/).flatMap((line, index) =>
  expression.test(line) ? [index + 1] : [],
);
```

真实运行的回归用例输入 `alpha\npi.ts\nbeta`，查找 `.`。期望 `[2]`，实际得到 `[1,2,3]`，Vitest 失败为 `expected [ 1, 2, 3 ] to deeply equal [ 2 ]`。这是本次实际观察到的失败，不是推测“可能会出问题”。正则的点号匹配任意字符，三行都非空，因此错误输出完全符合该错误实现。

修复后不用正则解释用户 text，而是使用 `includes()`。只对明确的 CRLF/LF 分隔使用正则，用户 text 不进入它。

源码定位：[扩展实现](labs/overlay/packages/coding-agent/examples/extensions/book-literal-search.ts#L7)，第 7—14 行，完整计算函数。

<!-- source-lines: packages/coding-agent/examples/extensions/book-literal-search.ts:7-14 -->
```ts
export function findLiteralLines(source: string, needle: string, caseSensitive = true): number[] {
	if (needle.length === 0) throw new Error("Search text must not be empty");
	const query = caseSensitive ? needle : needle.toLowerCase();
	return source.split(/\r?\n/).flatMap((line, index) => {
		const candidate = caseSensitive ? line : line.toLowerCase();
		return candidate.includes(query) ? [index + 1] : [];
	});
}
```

query 在循环前计算一次，candidate 按每行处理。未传 caseSensitive 或传 undefined 时使用默认 true；false 时两边都转小写。`flatMap()` 每行返回空数组或一个行号，所以同一行中两个 Pi 不会返回两个相同行号。空查询会匹配每一行，故函数主动拒绝空字符串。

当前用例同时检查点号和 `[x]`，避免只把点号特殊处理却留下其他正则语法。还覆盖默认大小写、显式忽略大小写、CRLF、同一行重复、无结果和空输入。这些是需求边界，而不是单纯逐行复写实现。

## 35.8 工具 schema 与执行接线

下面是实际交付的注册函数：

源码定位：[扩展实现](labs/overlay/packages/coding-agent/examples/extensions/book-literal-search.ts#L16)，第 16—33 行，完整注册函数。

<!-- source-lines: packages/coding-agent/examples/extensions/book-literal-search.ts:16-33 -->
```ts
export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "literal_search",
		label: "Literal search",
		description: "Find line numbers containing literal text in a UTF-8 file. Each matching line is counted once.",
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to the session cwd or absolute" }),
			text: Type.String({ minLength: 1, description: "Literal text; regular expression syntax is not interpreted" }),
			caseSensitive: Type.Optional(Type.Boolean({ description: "Defaults to true" })),
		}),
		async execute(_id, { path, text, caseSensitive }, signal, _onUpdate, ctx) {
			const source = await readFile(resolve(ctx.cwd, path), { encoding: "utf8", signal });
			const lines = findLiteralLines(source, text, caseSensitive);
			const details = { path, lines, count: lines.length };
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
}
```

`Type.Object` 同时提供模型可读的输入声明和运行时验证的 schema。description 解释字面搜索语义，text 的 minLength 防止模型调用空查询。纯函数仍保留空字符串检查，因为直接调用该函数不经过 Agent 的 schema 验证。

execute 从真实扩展 ctx 获取 cwd，向 readFile 传入本次 AbortSignal，然后调用计算函数。content 给模型可读的 JSON 文本，details 给程序结构化结果。details 本身不保证自动进入模型对话，故这里显式把同一结果写成 content。工具没有添加 outputSchema，不能据这个示例断言 codemode 会直接返回结构化对象。

readFile 抛出的文件错误交由工具流水线处理；例子没有把读取失败伪装成零匹配。对已经开始的文件 I/O，AbortSignal 也不提供回滚语义。

## 35.9 从纯函数通过到真实会话通过

只有 `findLiteralLines()` 单元测试通过，还不能证明扩展可用。会话测试先用 `extensionFactories` 加载真实注册函数，`bindExtensions({})` 完成绑定，禁止预先激活基础工具，再写入实际 notes.txt。

第一次模型请求检查最终声明恰好是 `literal_search`，随后生成 book-search 调用；第二次请求解析真实 toolResult 的文字 JSON，断言 `{path:"notes.txt",lines:[2],count:1}`。完成后还检查 details 和 branch 中的 callId。这条链路覆盖注册 → 声明 → 参数验证 → cwd 文件读取 → 结果转换 → 下一次模型请求 → 会话记录。

非法参数反例调用 `path:"missing.txt", text:""`。结果应含 `Validation failed for tool "literal_search"` 和 text 的长度错误，不含 ENOENT。空 text 在文件读取之前被 schema 拒绝；如果直接执行到 readFile，缺失路径会产生另一种错误。通过这组不同结果，可以观察验证与执行的先后。

开发闭环因此有两个层次：错误纯函数造成预期失败 → 修复字面匹配 → 全部算法边界通过 → 真实会话接入和非法参数边界通过。最终 7 个 coding 用例全部通过；`npm run check` 校验类型、格式、依赖与入口图等工程约束。没有运行项目构建或全套模型测试。

## 35.10 与 Durable 恢复实验一起运行

```sh
node labs/run-integration.mjs
node labs/run-integration.mjs durable
```

第一条运行 7 个 coding 用例和 9 个现有 Durable 用例，共 16 个命名用例；第二条只运行恢复部分。完整标准输出保存在 [integration-expected-output.txt](labs/integration-expected-output.txt)。Durable 的源码别名配置直接复用根配置与包配置，解决未构建 dist 的模块定位，不改任务调度行为。

第 26 章分析 SQLite 中保存的 execute 意图、safe 双重判定和进度清理。将它与本章并排看，才能区分“完成消息历史重新装载”和“未完成阶段按持久检查点恢复”。两者都不自动为文件或外部 API 创建跨系统事务。

## 35.11 自己扩展实验时的验收问题

1. 把 faux 第二次响应改成非法 edit 参数，错误是在模型回调、schema 验证还是文件操作阶段？
2. 把 `persistedFixture` 改成内存 SessionManager，哪些持久化断言应该失败，哪些文件断言仍应通过？
3. 在 extension execute 返回值中只留下 details，下一次模型请求能否获得原 JSON 文字？
4. 若要支持大文件，输入限制、输出行号上限和取消检查应该分别放在哪里？

参考答案见 [第 36 章](36-exercise-solutions.md)。本章提供可运行的完整文件；正文节录只为定位关键边界，不需要读者把片段拼成另一份 Agent 实现。
