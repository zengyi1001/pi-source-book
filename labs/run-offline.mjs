import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import * as transcript from "../../pi/packages/ai/src/utils/transcript.ts";
import { clampMaxTokensToContext, adjustMaxTokensForThinking } from "../../pi/packages/ai/src/api/simple-options.ts";
import { withFileMutationQueue } from "../../pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts";
import { extractTodoItems, isSafeCommand, markCompletedSteps } from "../../pi/packages/coding-agent/examples/extensions/plan-mode/utils.ts";
import { loadSource, plain, readPinnedSource } from "./source-slices.mjs";

let passed = 0;
const selected = process.argv[2];
const suites = new Set(["transcript", "budgets", "loop", "compaction", "search", "planning", "subagents", "files"]);
if (selected && !suites.has(selected)) throw new Error(`Unknown suite: ${selected}`);

// Check the complete direct-import dependency closure against the book's baseline.
for (const path of [
	"packages/ai/src/utils/transcript.ts", "packages/ai/src/utils/text.ts", "packages/ai/src/utils/estimate.ts",
	"packages/ai/src/api/simple-options.ts", "packages/coding-agent/src/core/tools/file-mutation-queue.ts",
	"packages/coding-agent/examples/extensions/plan-mode/utils.ts",
]) readPinnedSource(path);

async function check(suite, name, fn) {
	if (selected && selected !== suite) return;
	await fn();
	passed++;
	console.log(`PASS ${suite}: ${name}`);
}

function gate() {
	let release;
	const promise = new Promise((resolve) => { release = resolve; });
	return { promise, release };
}

const text = (value) => [{ type: "text", text: value }];
const tool = (name, description = name) => ({ name, description, parameters: { type: "object", properties: {} } });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason, usage, api: "offline", provider: "offline", model: "offline", timestamp: 1 });
const call = (id, name = "read") => ({ type: "toolCall", id, name, arguments: {} });

await check("transcript", "section removal and tool redefinition survive replay", () => {
	const messages = [
		{ role: "system", content: "base", sections: { cwd: "old", skills: "skill" }, toolsAdded: [tool("read")], timestamp: 0 },
		{ role: "user", content: "task", timestamp: 1 },
		{ role: "system", content: "extra", sections: { cwd: "new", skills: null }, toolsRemoved: [{ name: "read" }], toolsAdded: [tool("read", "new definition"), tool("edit")], timestamp: 2 },
	];
	assert.equal(transcript.getCurrentSystemPrompt(messages), "base\n\nextra\n\nnew");
	assert.deepEqual(transcript.getCurrentTools(messages).map((item) => item.description), ["new definition", "edit"]);
	const collapsed = transcript.collapseSystemMessages({ messages });
	assert.deepEqual(collapsed.messages.map((message) => message.role), ["system", "user"]);
	assert.deepEqual(transcript.getCurrentTools(collapsed.messages), transcript.getCurrentTools(messages));
	assert.equal(transcript.resolveTranscriptTools(messages, true).anchorsAdditions, false);
});

await check("transcript", "changed interface removes then adds the same tool", () => {
	const changes = transcript.getToolStateChanges([tool("read"), tool("bash")], [tool("read", "v2"), tool("edit")]);
	assert.deepEqual(changes.toolsRemoved, [{ name: "read" }, { name: "bash" }]);
	assert.deepEqual(changes.toolsAdded.map((item) => item.name), ["read", "edit"]);
});

await check("budgets", "context safety room clips the response ceiling", () => {
	const context = { messages: [{ role: "user", content: "x".repeat(8000), timestamp: 0 }] };
	assert.equal(clampMaxTokensToContext({ contextWindow: 10000 }, context, 8000), 3904);
	assert.equal(clampMaxTokensToContext({ contextWindow: 5000 }, context, 8000), 1);
	assert.equal(clampMaxTokensToContext({ contextWindow: 0 }, context, 8000), 8000);
});

await check("budgets", "thinking shares a cap and preserves answer room when necessary", () => {
	assert.deepEqual(adjustMaxTokensForThinking(2000, 10000, "medium"), { maxTokens: 10000, thinkingBudget: 8192 });
	assert.deepEqual(adjustMaxTokensForThinking(undefined, 4000, "medium"), { maxTokens: 4000, thinkingBudget: 2976 });
	assert.deepEqual(adjustMaxTokensForThinking(undefined, 512, "high"), { maxTokens: 512, thinkingBudget: 0 });
});

// The provider is a two-event in-memory stream. The schema validator is an identity mock:
// these cases test scheduling, not TypeBox validation or provider conversion.
const loop = loadSource("packages/agent/src/agent-loop.ts", [["export async function runAgentLoop(", null]], ["runAgentLoop"], {
	...transcript,
	validateToolArguments: (_tool, toolCall) => toolCall.arguments,
	getDefaultStreamFn: () => { throw new Error("A real provider must never be used in this lab"); },
});

async function runLoopFixture(first, tools, options = {}, signal, observeEvent = () => {}) {
	const events = [];
	const requests = [];
	const responses = [first, assistant(text("complete"))];
	const messages = await loop.runAgentLoop([{ role: "user", content: "task", timestamp: 0 }], { messages: [], tools }, {
		model: { provider: "offline" }, convertToLlm: (messages) => messages, ...options,
	}, (event) => { events.push(event); observeEvent(event); }, signal, (_model, context) => {
		requests.push([...context.messages]);
		const message = responses.shift();
		assert.ok(message, "Unexpected extra model request");
		return { result: async () => message, async *[Symbol.asyncIterator]() {
			yield { type: "start", partial: message };
			yield { type: "done", message };
		} };
	});
	return { messages, events, requests };
}

await check("loop", "all preflights finish before execution; transcript preserves call order", async () => {
	const trace = [];
	const fastDone = gate();
	const fixture = await runLoopFixture(assistant([call("A"), call("B")], "toolUse"), [{ ...tool("read"), execute: async (id) => {
		trace.push(`start:${id}`);
		if (id === "A") await fastDone.promise;
		trace.push(`end:${id}`);
		return { content: text(id), details: {} };
	} }], { beforeToolCall: ({ toolCall }) => { trace.push(`pre:${toolCall.id}`); } }, undefined, (event) => {
		if (event.type === "tool_execution_end" && event.toolCallId === "B") fastDone.release();
	});
	assert.deepEqual(trace, ["pre:A", "pre:B", "start:A", "start:B", "end:B", "end:A"]);
	assert.deepEqual(fixture.events.filter((event) => event.type === "tool_execution_end").map((event) => event.toolCallId), ["B", "A"]);
	assert.deepEqual(plain(fixture.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)), ["A", "B"]);
	assert.equal(fixture.requests.length, 2);
});

await check("loop", "one sequential tool makes the whole batch sequential", async () => {
	const trace = [];
	const make = (name, executionMode) => ({ ...tool(name), executionMode, execute: async (id) => { trace.push(id); return { content: text(id) }; } });
	await runLoopFixture(assistant([call("A", "read"), call("B", "write")], "toolUse"), [make("read"), make("write", "sequential")], {
		beforeToolCall: ({ toolCall }) => { trace.push(`pre:${toolCall.id}`); },
	});
	assert.deepEqual(trace, ["pre:A", "A", "pre:B", "B"]);
});

await check("loop", "a length stop executes no apparently valid call", async () => {
	let executions = 0;
	const fixture = await runLoopFixture(assistant([call("A"), call("B")], "length"), [{ ...tool("read"), execute: async () => { executions++; } }]);
	assert.equal(executions, 0);
	assert.equal(fixture.messages.filter((message) => message.role === "toolResult" && message.isError).length, 2);
});

await check("loop", "abort during the second preflight prevents the first prepared call", async () => {
	const controller = new AbortController();
	let executions = 0;
	const fixture = await runLoopFixture(assistant([call("A"), call("B")], "toolUse"), [{ ...tool("read"), execute: async () => { executions++; } }], {
		beforeToolCall: ({ toolCall }) => { if (toolCall.id === "B") controller.abort(); },
		finishTurn: () => ({ action: "end" }),
	}, controller.signal);
	assert.equal(executions, 0);
	assert.deepEqual(plain(fixture.messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message.isError])), [["A", true], ["B", true]]);
});

await check("loop", "termination requires every finalized result to request it", async () => {
	const calls = assistant([call("A"), call("B")], "toolUse");
	const tools = [{ ...tool("read"), execute: async (id) => ({ content: text(id), terminate: id === "A" }) }];
	assert.equal((await runLoopFixture(calls, tools)).requests.length, 2);
	tools[0].execute = async (id) => ({ content: text(id), terminate: true });
	assert.equal((await runLoopFixture(calls, tools)).requests.length, 1);
});

// Projection fixtures are already projected. Only message entries contribute in this
// converter mock; this does not test SessionManager's context-edit/tree projection.
const compaction = loadSource("packages/coding-agent/src/core/compaction/compaction.ts", [
	["export function shouldCompact(", "\n// ============================================================================\n// Cut point detection"],
	["const ESTIMATED_IMAGE_CHARS", "\nfunction isTurnStartEntry("],
	["function isProjectedTurnStart(", "\nexport function prepareCompaction("],
], ["shouldCompact", "estimateTokens", "findProjectedCutPoint"], {
	sessionEntryToContextMessages: (entry) => entry.type === "message" ? [entry.message] : [],
});
const projected = (messages) => messages.map((message, index) => ({ sourceEntry: { type: "message", id: `e${index}`, message }, messages: [message] }));
const compactMessages = [
	{ role: "user", content: "x".repeat(32) },
	assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }]),
	{ role: "toolResult", content: text("x".repeat(80)) },
	assistant(text("x".repeat(16))),
];

await check("compaction", "strict threshold and worked token counts", () => {
	assert.equal(compaction.shouldCompact(111616, 128000, { enabled: true, reserveTokens: 16384 }), false);
	assert.equal(compaction.shouldCompact(111617, 128000, { enabled: true, reserveTokens: 16384 }), true);
	assert.deepEqual(compactMessages.map(compaction.estimateTokens), [8, 4, 20, 4]);
});

await check("compaction", "budget can retain fewer tokens at a later valid cut", () => {
	assert.deepEqual(plain(compaction.findProjectedCutPoint(projected(compactMessages), 0, 4, 15)), { firstKeptEntryIndex: 3, turnStartIndex: 0, isSplitTurn: true });
});

await check("compaction", "a trailing oversized result retains its preceding call", () => {
	assert.deepEqual(plain(compaction.findProjectedCutPoint(projected(compactMessages.slice(0, 3)), 0, 3, 15)), { firstKeptEntryIndex: 1, turnStartIndex: 0, isSplitTurn: true });
});

await check("compaction", "adjacent metadata moves the raw boundary backward", () => {
	const entries = projected(compactMessages.slice(0, 3));
	entries.splice(1, 0, { sourceEntry: { type: "custom", id: "metadata" }, messages: [] });
	assert.equal(compaction.findProjectedCutPoint(entries, 0, entries.length, 15).firstKeptEntryIndex, 1);
	assert.equal(entries[1].sourceEntry.id, "metadata");
});

const search = loadSource("packages/coding-agent/src/extensions/tool-search/tool.ts", [
	["const STOP_WORDS:", "\nexport const toolSearchSchema"],
	["function isSearchable(", "\n/**\n * The `tool_search` description."],
], ["tokenize", "createToolSearchDocument", "Bm25Ranker", "searchAndLoad"]);
const rankDocuments = [{ name: "read_issue", text: "issue issue read" }, { name: "create_issue", text: "issue create" }, { name: "weather", text: "weather forecast" }];

await check("search", "BM25 numeric example and duplicate query terms", () => {
	const ranker = new search.Bm25Ranker();
	const matches = plain(ranker.rank("issues", rankDocuments, 3));
	assert.deepEqual(matches.map((match) => match.name), ["read_issue", "create_issue"]);
	assert.ok(Math.abs(matches[0].score - 0.5981864372218454) < 1e-12);
	assert.ok(Math.abs(matches[1].score - 0.4991762683023676) < 1e-12);
	assert.deepEqual(plain(ranker.rank("issue issue", rankDocuments, 3)), matches);
	console.log(`TRACE search scores=${matches.map((match) => `${match.name}:${match.score.toFixed(6)}`).join(",")}`);
});

await check("search", "Chinese-only query has no tokens; ties preserve input order", () => {
	assert.deepEqual(plain(search.tokenize("查询问题")), []);
	assert.deepEqual(plain(new search.Bm25Ranker().rank("查询问题", rankDocuments, 3)), []);
	assert.deepEqual(plain(new search.Bm25Ranker().rank("issue", [{ name: "z", text: "issue" }, { name: "a", text: "issue" }], 2)).map((match) => match.name), ["z", "a"]);
});

await check("search", "schema names and namespace instructions are searchable", () => {
	const document = search.createToolSearchDocument({ ...tool("lookup"), parameters: { properties: { ticket: { description: "Issue number" } } } }, { name: "tracker", instructions: "Incident workflow" });
	assert.ok(search.tokenize(document.text).includes("incident"));
	assert.ok(search.tokenize(document.text).includes("ticket"));
});

await check("search", "load changes only the eligible inactive tool set", () => {
	let active = ["read", "already"];
	const all = [{ ...tool("issue_read", "read issue"), exposure: "deferred" }, { ...tool("issue_create", "create issue"), exposure: "codemode" }, { ...tool("hidden_issue", "issue"), exposure: "hidden" }, { ...tool("already", "issue"), exposure: "deferred" }];
	const matches = search.searchAndLoad({ getAllTools: () => all, getActiveTools: () => [...active], setActiveTools: (names) => { active = [...names]; } }, "issue", 2);
	assert.deepEqual(plain(matches.map((match) => match.name).sort()), ["issue_create", "issue_read"]);
	assert.deepEqual(active.slice(0, 2), ["read", "already"]);
	assert.equal(active.length, 4);
	assert.ok(!active.includes("hidden_issue"));
});

await check("planning", "todo numbering is rebuilt and DONE is self-reported", () => {
	const items = extractTodoItems("Plan:\n7. Read the config file\n9. Verify regression behavior");
	assert.deepEqual(items.map((item) => item.step), [1, 2]);
	assert.equal(markCompletedSteps("[DONE:1] [DONE:1] [DONE:99]", items), 3);
	assert.deepEqual(items.map((item) => item.completed), [true, false]);
	assert.equal(extractTodoItems("计划：\n1. Read the config file").length, 0);
});

await check("planning", "command classifier permits commands with unexamined semantics", () => {
	assert.equal(isSafeCommand("cat src/config.ts"), true);
	assert.equal(isSafeCommand("npm install package"), false);
	// Strings only: this fixture does not run either command.
	assert.equal(isSafeCommand("find . -delete"), true);
	assert.equal(isSafeCommand("curl -X POST https://example.invalid/resource"), true);
});

await check("planning", "real extension restores tools and retains custom write capabilities", async () => {
	const handlers = new Map();
	const commands = new Map();
	const entries = [];
	const sent = [];
	let active = ["read", "edit", "write", "mcp_mutate"];
	const original = [...active];
	const { planModeExtension } = loadSource("packages/coding-agent/examples/extensions/plan-mode/index.ts", [["const PLAN_MODE_TOOLS", null]], ["planModeExtension"], {
		Key: { ctrlAlt: (key) => key }, extractTodoItems, isSafeCommand, markCompletedSteps,
	});
	planModeExtension({
		registerFlag() {}, registerShortcut() {}, getFlag: () => false,
		registerCommand: (name, command) => { commands.set(name, command); },
		on: (name, handler) => { handlers.set(name, handler); },
		getActiveTools: () => [...active], setActiveTools: (names) => { active = [...names]; },
		appendEntry: (customType, data) => { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage: (message, options) => { sent.push({ message, options }); }, sendUserMessage() {},
	});
	const ctx = { hasUI: true, sessionManager: { getEntries: () => entries }, ui: {
		setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_color, value) => value, strikethrough: (value) => value },
		select: async () => "Execute the plan (track progress)",
	} };
	await commands.get("plan").handler("", ctx);
	assert.ok(!active.includes("edit") && !active.includes("write"));
	assert.ok(active.includes("mcp_mutate"));
	assert.equal((await handlers.get("before_agent_start")()).message.display, false);
	assert.equal(await handlers.get("tool_call")({ toolName: "mcp_mutate", input: {} }), undefined);
	assert.equal((await handlers.get("tool_call")({ toolName: "bash", input: { command: "npm install package" } })).block, true);
	await handlers.get("agent_end")({ messages: [assistant(text("Plan:\n1. Verify regression behavior"))] }, ctx);
	assert.deepEqual(active, original);
	assert.equal(sent[1].options.deliverAs, "followUp");
	await handlers.get("turn_end")({ message: assistant(text("[DONE:1]")) }, ctx);
	await handlers.get("agent_end")({ messages: [] }, ctx);
	assert.equal(entries.at(-1).data.executing, false);
	assert.deepEqual(entries.at(-1).data.todos, []);
});

const subagents = loadSource("packages/coding-agent/examples/extensions/subagent/index.ts", [
	["const MAX_PARALLEL_TASKS", "\nfunction formatTokens("],
	["function getFinalOutput(", "\ntype DisplayItem"],
	["async function mapWithConcurrencyLimit", "\nasync function writePromptToTempFile"],
], ["getFinalOutput", "mapWithConcurrencyLimit", "isFailedResult", "getResultOutput", "truncateParallelOutput", "MAX_PARALLEL_TASKS", "MAX_CONCURRENCY"], { Buffer });

await check("subagents", "worker pool caps concurrency and keeps input order", async () => {
	const releases = Array.from({ length: 8 }, gate);
	let running = 0;
	let peak = 0;
	const started = [];
	const execution = subagents.mapWithConcurrencyLimit([...releases.keys()], subagents.MAX_CONCURRENCY, async (index) => {
		running++; peak = Math.max(peak, running); started.push(index);
		await releases[index].promise;
		running--;
		return `task-${index}`;
	});
	assert.deepEqual(started, [0, 1, 2, 3]);
	for (const index of [3, 2, 1, 0, 7, 6, 5, 4]) { releases[index].release(); await nextTick(); }
	assert.deepEqual(plain(await execution), Array.from({ length: 8 }, (_, index) => `task-${index}`));
	assert.equal(peak, 4);
});

await check("subagents", "final handoff is the first text block of the last assistant", () => {
	assert.equal(subagents.getFinalOutput([assistant(text("old")), assistant([...text("first"), ...text("second")])]), "first");
	assert.equal(subagents.isFailedResult({ exitCode: 0, stopReason: "error" }), true);
	assert.equal(subagents.isFailedResult({ exitCode: 0, stopReason: "length" }), false);
});

await check("subagents", "dispatch uses explicit arguments and parses split JSON lines", async () => {
	const dispatches = [];
	const run = loadSource("packages/coding-agent/examples/extensions/subagent/index.ts", [
		["async function runSingleAgent(", "\nconst TaskItem"],
	], ["runSingleAgent"], {
		getFinalOutput: subagents.getFinalOutput,
		getPiInvocation: (args) => ({ command: "offline-pi", args }),
		spawn: (command, args, options) => {
			dispatches.push({ command, args: [...args], options });
			const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
			queueMicrotask(() => {
				const line = JSON.stringify({ type: "message_end", message: assistant(text("child answer")) });
				proc.stdout.emit("data", Buffer.from(line.slice(0, 20)));
				proc.stdout.emit("data", Buffer.from(line.slice(20) + "\n"));
				proc.emit("close", 0);
			});
			return proc;
		},
	});
	const agents = [{ name: "scout", source: "user", systemPrompt: "", tools: ["read"] }];
	const invoke = () => run.runSingleAgent("/repo", { model: "offline/parent", thinkingLevel: "low" }, agents, "scout", "inspect", undefined, undefined, undefined, undefined, (results) => ({ results }));
	assert.equal((await invoke()).messages.length, 1);
	assert.deepEqual(plain(dispatches[0].args), ["--mode", "json", "-p", "--no-session", "--model", "offline/parent", "--thinking", "low", "--tools", "read", "Task: inspect"]);
	assert.equal(dispatches[0].options.shell, false);
	assert.equal(dispatches[0].options.cwd, "/repo");
	agents[0].model = "offline/specialist";
	await invoke();
	assert.ok(dispatches[1].args.includes("offline/specialist"));
	assert.ok(!dispatches[1].args.includes("--thinking"));
});

// Execute the complete registered method in an object wrapper. Only role discovery
// and child work are fixtures; mode selection, chain handoff and aggregation are real.
function subagentModes(runSingleAgent) {
	const { selectedTool } = loadSource("packages/coding-agent/examples/extensions/subagent/index.ts", [
		["\t\tasync execute(_toolCallId, params, signal, onUpdate, ctx) {", "\n\n\t\trenderCall("],
	], ["selectedTool"], {
		...subagents, runSingleAgent,
		discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
	}, { prefix: "const selectedTool = {\n", suffix: "\n};" });
	return selectedTool;
}

await check("subagents", "chain passes selected text and stops at a failed child", async () => {
	const tasks = [];
	let failReview = false;
	const modes = subagentModes(async (_cwd, _defaults, _agents, agent, task) => {
		tasks.push(task);
		return { agent, exitCode: failReview && agent === "reviewer" ? 1 : 0, messages: [assistant([...text("first"), ...text("second")])] };
	});
	const chain = [{ agent: "scout", task: "inspect" }, { agent: "reviewer", task: "review {previous} and {previous}" }, { agent: "writer", task: "apply {previous}" }];
	await modes.execute("id", { chain }, undefined, undefined, { cwd: "/repo", hasUI: false });
	assert.deepEqual(tasks, ["inspect", "review first and first", "apply first"]);
	tasks.length = 0; failReview = true;
	const failed = await modes.execute("id", { chain }, undefined, undefined, { cwd: "/repo", hasUI: false });
	assert.deepEqual(tasks, ["inspect", "review first and first"]);
	assert.equal(failed.isError, true);
	assert.equal(failed.details.results.length, 2);
});

await check("subagents", "parallel reports partial failure without a parent error flag", async () => {
	let executions = 0;
	const modes = subagentModes(async (_cwd, _defaults, _agents, agent) => {
		executions++;
		return { agent, exitCode: agent === "bad" ? 1 : 0, messages: [assistant(text(agent))] };
	});
	const ctx = { cwd: "/repo", hasUI: false };
	const result = await modes.execute("id", { tasks: [{ agent: "ok", task: "inspect" }, { agent: "bad", task: "inspect" }] }, undefined, undefined, ctx);
	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /Parallel: 1\/2 succeeded/);
	await modes.execute("id", { tasks: Array.from({ length: 9 }, () => ({ agent: "ok", task: "inspect" })) }, undefined, undefined, ctx);
	assert.equal(executions, 2, "An oversized batch must dispatch no children");
});

await check("files", "same path and symlink serialize actual read-modify-write", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-book-files-"));
	try {
		const path = join(directory, "counter");
		const alias = join(directory, "alias");
		await writeFile(path, "0"); await symlink(path, alias);
		const operations = [path, alias, path].map((target) => withFileMutationQueue(target, async () => {
			const value = Number(await readFile(target, "utf8"));
			await nextTick();
			await writeFile(target, String(value + 1));
		}));
		await Promise.all(operations);
		assert.equal(await readFile(path, "utf8"), "3");
		await assert.rejects(withFileMutationQueue(path, async () => { throw new Error("fixture failure"); }), /fixture failure/);
		assert.equal(await withFileMutationQueue(path, async () => "next operation"), "next operation");
	} finally { await rm(directory, { recursive: true, force: true }); }
});

console.log(`PASS ${passed} cases; ${selected ? 1 : suites.size} suites; no model/network requests`);
