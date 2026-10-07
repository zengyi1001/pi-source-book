import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import literalSearchExtension, { findLiteralLines } from "../../examples/extensions/book-literal-search.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createEditTool } from "../../src/core/tools/edit.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const ORIGINAL = "export const retries = 1;\nexport const timeout = 10;\n";
const EDITED = "export const retries = 3;\nexport const timeout = 30;\n";
const directories: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.length = 0;
});

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

describe("Textbook complete session", () => {
	it("reads, edits, persists and resumes without replaying the completed edit", async () => {
		const { cwd, tools, harness, getWrites } = await persistedFixture();
		const requests: string[] = [];
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["read", "edit"]);
				requests.push("request:read");
				return fauxAssistantMessage([fauxToolCall("read", { path: "config.ts" }, { id: "book-read" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				expect(getMessageText(result)).toBe(ORIGINAL);
				requests.push("request:edit");
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"edit",
							{
								path: "config.ts",
								edits: [
									{ oldText: "export const retries = 1;", newText: "export const retries = 3;" },
									{ oldText: "export const timeout = 10;", newText: "export const timeout = 30;" },
								],
							},
							{ id: "book-edit" },
						),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				expect(result).toMatchObject({ toolCallId: "book-edit", isError: false });
				requests.push("request:answer");
				return fauxAssistantMessage("updated retries=3 timeout=30");
			},
		]);
		const visiblePersistence: boolean[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				const callId = event.message.toolCallId;
				visiblePersistence.push(
					harness.sessionManager
						.getBranch()
						.some(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolCallId === callId,
						),
				);
			}
		});
		await harness.session.prompt("Set retries to 3 and timeout to 30; keep other content.");
		expect(requests).toEqual(["request:read", "request:edit", "request:answer"]);
		expect(visiblePersistence).toEqual([false, false]);
		expect(await readFile(join(cwd, "config.ts"), "utf8")).toBe(EDITED);
		expect(getWrites()).toBe(1);
		expect(getToolResult(harness, "edit").details).toMatchObject({
			patch: expect.stringContaining("+export const retries = 3;"),
		});
		expect(harness.events.at(-1)?.type).toBe("agent_settled");
		expect(harness.session.isIdle).toBe(true);
		const path = harness.sessionManager.getSessionFile();
		if (path === undefined) throw new Error("Expected a persisted JSONL session");
		const records: unknown[] = (await readFile(path, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records[0]).toMatchObject({ type: "session", cwd });
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
		console.log("TRACE session requests=3 tools=read,edit writes=1 persisted=6 resumedWrites=1");
	});

	it("persists a failed batch without writing its first replacement", async () => {
		const { cwd, harness, getWrites } = await persistedFixture();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"edit",
						{
							path: "config.ts",
							edits: [
								{ oldText: "export const retries = 1;", newText: "export const retries = 3;" },
								{ oldText: "export const timeout = 20;", newText: "export const timeout = 30;" },
							],
						},
						{ id: "book-conflict" },
					),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
					isError: true,
				});
				return fauxAssistantMessage("old text missing; no changes applied");
			},
		]);
		await harness.session.prompt("Apply the two replacements.");
		expect(getWrites()).toBe(0);
		expect(await readFile(join(cwd, "config.ts"), "utf8")).toBe(ORIGINAL);
		const path = harness.sessionManager.getSessionFile();
		if (path === undefined) throw new Error("Expected a persisted JSONL session");
		expect(
			SessionManager.open(path)
				.buildSessionContext()
				.messages.find((message) => message.role === "toolResult"),
		).toMatchObject({ toolCallId: "book-conflict", isError: true });
		console.log("TRACE conflict writes=0 toolError=true persistedError=true");
	});
});

describe("Textbook literal search development", () => {
	it("treats dots and brackets as literal text", () => {
		expect(findLiteralLines("alpha\npi.ts\nbeta", ".")).toEqual([2]);
		expect(findLiteralLines("x\n[x]\ny", "[x]")).toEqual([2]);
	});

	it("counts each line once and supports explicit case folding and CRLF", () => {
		expect(findLiteralLines("Pi Pi\r\npi\r\nnone", "Pi")).toEqual([1]);
		expect(findLiteralLines("Pi Pi\r\npi\r\nnone", "Pi", false)).toEqual([1, 2]);
		expect(findLiteralLines("none", "missing")).toEqual([]);
	});

	it("rejects an empty search string", () => {
		expect(() => findLiteralLines("anything", "")).toThrow("must not be empty");
	});

	it("registers, declares, executes and persists a real extension tool", async () => {
		const harness = await createHarness({ initialActiveToolNames: [], extensionFactories: [literalSearchExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await writeFile(join(harness.tempDir, "notes.txt"), "alpha\npi.ts\nbeta\n");
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["literal_search"]);
				return fauxAssistantMessage(
					[fauxToolCall("literal_search", { path: "notes.txt", text: "." }, { id: "book-search" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				expect(
					JSON.parse(getMessageText(context.messages.findLast((message) => message.role === "toolResult"))),
				).toEqual({ path: "notes.txt", lines: [2], count: 1 });
				return fauxAssistantMessage("line 2 contains a dot");
			},
		]);
		await harness.session.prompt("Find lines containing a literal dot.");
		expect(getToolResult(harness, "literal_search").details).toEqual({ path: "notes.txt", lines: [2], count: 1 });
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "book-search",
				),
		).toBe(true);
		console.log("TRACE extension declared=literal_search lines=2 count=1 persisted=true");
	});

	it("rejects invalid parameters before the extension reads a file", async () => {
		const harness = await createHarness({ initialActiveToolNames: [], extensionFactories: [literalSearchExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("literal_search", { path: "missing.txt", text: "" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("invalid search rejected"),
		]);
		await harness.session.prompt("Search with an empty string.");
		const result = getToolResult(harness, "literal_search");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain('Validation failed for tool "literal_search"');
		expect(getMessageText(result)).toContain("text: must not have fewer than 1 characters");
		expect(getMessageText(result)).not.toContain("ENOENT");
	});
});
