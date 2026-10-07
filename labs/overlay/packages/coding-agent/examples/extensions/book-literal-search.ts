/** Textbook example: find lines containing literal text, with optional case folding. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function findLiteralLines(source: string, needle: string, caseSensitive = true): number[] {
	if (needle.length === 0) throw new Error("Search text must not be empty");
	const query = caseSensitive ? needle : needle.toLowerCase();
	return source.split(/\r?\n/).flatMap((line, index) => {
		const candidate = caseSensitive ? line : line.toLowerCase();
		return candidate.includes(query) ? [index + 1] : [];
	});
}

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
