import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(directory, "../pi");
const checkOnly = process.argv[2] === "--check";
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && checkOnly), "Usage: sync-book.mjs [--check]");
const read = (path) => readFileSync(path, "utf8");
assert.ok(!existsSync(resolve(directory, "BOOK.md")), "Keep textbook chapters in separate files; remove BOOK.md");
const chapterNames = readdirSync(directory).filter((name) => /^\d{2}-.+\.md$/.test(name)).sort();
chapterNames.forEach((name, index) => assert.equal(Number(name.slice(0, 2)), index + 1, "Chapter numbering must be consecutive"));
const chapters = chapterNames.map((name) => read(resolve(directory, name)));
const count = chapters.length;
const characters = chapters.reduce((sum, chapter) => sum + [...chapter].length, 0);
const appendixPath = resolve(directory, "appendix-evidence-and-glossary.md");
const appendix = read(appendixPath).replace(/正文共 \d+ 章、\d+ 个字符/, `正文共 ${count} 章、${characters} 个字符`);
const readmePath = resolve(directory, "README.md");
const readmeSource = read(readmePath).replace(/正文已完成，共 \d+ 章，约 \d+ 万字符/, `正文已完成，共 ${count} 章，约 ${Math.round(characters / 10000)} 万字符`);

function headings(markdown) {
	return markdown.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, "").split("\n")
		.filter((line) => /^#{1,6} /.test(line)).map((line) => line.replace(/^#{1,6} /, ""));
}

function slug(title) {
	return title.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
}

const titles = chapters.map((chapter) => headings(chapter)[0]);
const toc = titles.map((title, index) => `- [${title}](${chapterNames[index]})`).join("\n");
const tocPattern = /(## 全书目录\n\n)[\s\S]*?(?=\n\n- \[附录 A)/;
assert.ok(tocPattern.test(readmeSource), "Missing chapter directory in README.md");
const readme = readmeSource.replace(tocPattern, (_, heading) => `${heading}${toc}`);
for (const [path, content] of [[appendixPath, appendix], [readmePath, readme]]) {
	if (checkOnly) assert.equal(read(path), content, `Out of date: ${path}`);
	else if (read(path) !== content) writeFileSync(path, content);
}

let excerptCount = 0;
for (let index = 0; index < chapters.length; index++) {
	for (const match of chapters[index].matchAll(/<!-- source-lines: ([^:]+):(\d+)-(\d+) -->\n```ts\n([\s\S]*?)\n```/g)) {
		const [, path, first, last, quoted] = match;
		const lines = read(resolve(root, path)).split("\n").slice(Number(first) - 1, Number(last));
		assert.equal(quoted, lines.join("\n"), `Source excerpt differs: ${chapterNames[index]} ${path}:${first}`);
		excerptCount++;
	}
	assert.ok(!chapters[index].includes("<!-- insert-source"), `Unfilled excerpt: ${chapterNames[index]}`);
}
assert.ok(excerptCount >= 18, "Missing production source excerpts");

const inventory = read(resolve(directory, "reading-inventory.tsv")).trimEnd().split("\n").slice(1);
const baselineHashes = new Map(inventory.map((line) => {
	const [path, , , , hash] = line.split("\t");
	return [path, hash];
}));
const sourceChanges = new Map();
for (const line of read(resolve(directory, "verified-source-changes.tsv")).trimEnd().split("\n").slice(1)) {
	const [path, baseline, current] = line.split("\t");
	assert.ok(!sourceChanges.has(path), `Duplicate reviewed change: ${path}`);
	assert.equal(baselineHashes.get(path), baseline, `Reviewed change baseline differs: ${path}`);
	assert.match(current, /^[a-f0-9]{64}$/, `Invalid reviewed change hash: ${path}`);
	sourceChanges.set(path, current);
	assert.equal(createHash("sha256").update(readFileSync(resolve(directory, "labs/overlay", path))).digest("hex"), current, `Reviewed overlay differs: ${path}`);
}
for (const line of inventory) {
	const [path, , , , baseline] = line.split("\t");
	const expected = sourceChanges.get(path) ?? baseline;
	assert.equal(createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex"), expected, `Inventory hash differs: ${path}`);
}

const teachingSources = read(resolve(directory, "teaching-source-hashes.tsv")).trimEnd().split("\n").slice(1);
const teachingPaths = new Set();
for (const line of teachingSources) {
	const [path, expected] = line.split("\t");
	assert.ok(!baselineHashes.has(path), `Teaching source already belongs to baseline: ${path}`);
	assert.ok(!teachingPaths.has(path), `Duplicate teaching source: ${path}`);
	assert.match(expected, /^[a-f0-9]{64}$/, `Invalid teaching source hash: ${path}`);
	assert.equal(createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex"), expected, `Teaching source differs: ${path}`);
	teachingPaths.add(path);
	assert.equal(createHash("sha256").update(readFileSync(resolve(directory, "labs/overlay", path))).digest("hex"), expected, `Teaching overlay differs: ${path}`);
}
assert.equal(teachingSources.length, 2, "Missing teaching example or integration test");

const solutions = read(resolve(directory, "36-exercise-solutions.md"));
const answerSections = [...solutions.matchAll(/^## 36\.(\d+) /gm)].map((match) => Number(match[1]));
assert.deepEqual(answerSections, Array.from({ length: count - 1 }, (_, index) => index + 1), "Missing chapter exercise solutions");

const markdownFiles = [...readdirSync(directory).filter((name) => name.endsWith(".md")).map((name) => resolve(directory, name)), resolve(directory, "labs/README.md")];
const anchorCache = new Map();
let linkCount = 0;
for (const path of markdownFiles) {
	const content = read(path).replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, "");
	for (const match of content.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
		const sourcePrefix = "https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/";
		const target = match[1].startsWith(sourcePrefix)
			? resolve(root, match[1].slice(sourcePrefix.length))
			: match[1];
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
		const [file, anchor] = target.split("#");
		const destination = file ? resolve(dirname(path), decodeURIComponent(file)) : path;
		assert.ok(existsSync(destination), `Broken link: ${path} -> ${target}`);
		if (anchor && extname(destination) === ".md") {
			if (!anchorCache.has(destination)) {
				const used = new Map();
				const anchors = new Set(headings(read(destination)).map((title) => {
					const base = slug(title);
					const number = used.get(base) ?? 0;
					used.set(base, number + 1);
					return number === 0 ? base : `${base}-${number}`;
				}));
				anchorCache.set(destination, anchors);
			}
			assert.ok(anchorCache.get(destination).has(decodeURIComponent(anchor)), `Broken anchor: ${path} -> ${target}`);
		}
		linkCount++;
	}
}
const output = read(resolve(directory, "labs/expected-output.txt"));
const cases = (read(resolve(directory, "labs/run-offline.mjs")).match(/^await check\(/gm) ?? []).length;
assert.equal((output.match(/^PASS [a-z]+:/gm) ?? []).length, cases, "Expected output case count differs");
assert.ok(output.endsWith(`PASS ${cases} cases; 8 suites; no model/network requests\n`));
const integrationOutput = read(resolve(directory, "labs/integration-expected-output.txt"));
let integrationCases = 0;
for (const [suite, path] of [
	["coding", "packages/coding-agent/test/suite/book-session-walkthrough.test.ts"],
	["durable", "packages/durable/test/harness-tools-recovery.test.ts"],
]) {
	const names = [...read(resolve(root, path)).matchAll(/^\s*it\("([^"\n]+)"/gm)].map((match) => match[1]);
	assert.ok(names.length > 0, `No integration tests: ${path}`);
	const lines = integrationOutput.split("\n").filter((line) => line.startsWith(`PASS integration ${suite}: `));
	assert.equal(lines.length, names.length, `Integration output count differs: ${suite}`);
	for (let index = 0; index < names.length; index++) {
		assert.ok(lines[index].endsWith(` ${names[index]}`), `Integration output name differs: ${suite} ${names[index]}`);
	}
	integrationCases += names.length;
}
assert.ok(integrationOutput.endsWith(`PASS ${integrationCases} integration cases; faux models; temporary files and SQLite\n`));
assert.equal((integrationOutput.match(/^TRACE /gm) ?? []).length, 3, "Missing integration traces");
console.log(`PASS book: ${count} chapters, ${characters} characters, ${excerptCount} source excerpts, ${inventory.length} baseline hashes (${sourceChanges.size} reviewed changes), ${teachingSources.length} teaching hashes, ${linkCount} local links, ${answerSections.length} answer sections, ${integrationCases} integration cases`);
