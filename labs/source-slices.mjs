import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const labDirectory = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(labDirectory, "../../pi");
const inventory = new Map(
	readFileSync(resolve(labDirectory, "../reading-inventory.tsv"), "utf8")
		.trimEnd().split("\n").slice(1).map((line) => {
			const fields = line.split("\t");
			return [fields[0], fields[4]];
		}),
);

export function readPinnedSource(path) {
	const bytes = readFileSync(resolve(repoRoot, path));
	assert.equal(createHash("sha256").update(bytes).digest("hex"), inventory.get(path), `Source changed: ${path}`);
	return bytes.toString("utf8");
}

// Boundaries select complete definitions, never rewritten algorithm bodies.
export function sliceSource(path, ranges) {
	const source = readPinnedSource(path);
	return ranges.map(([start, end]) => {
		const first = source.indexOf(start);
		assert.ok(first >= 0 && source.indexOf(start, first + 1) === -1, `Non-unique start: ${start}`);
		const last = end === null ? source.length : source.indexOf(end, first + start.length);
		assert.ok(last > first, `Missing end: ${end}`);
		return source.slice(first, last);
	}).join("\n");
}

export function loadSource(path, ranges, names, bindings = {}, wrapper = {}) {
	const source = sliceSource(path, ranges);
	const executable = stripTypeScriptTypes(`${wrapper.prefix ?? ""}${source}${wrapper.suffix ?? ""}`, { mode: "strip", sourceUrl: path })
		.replace(/^export default function /gm, "function ")
		.replace(/^export (?=(?:async )?function |class |const )/gm, "");
	return new Script(`${executable}\n;({${names.join(",")}});`, { filename: path })
		.runInNewContext({ ...bindings }, { timeout: 5000 });
}

// VM values have a different prototype; compare fixture data in this realm.
export function plain(value) {
	return JSON.parse(JSON.stringify(value));
}
