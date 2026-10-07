import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../pi/", import.meta.url));
const cli = join(repo, "node_modules/vitest/dist/cli.js");
const suites = {
	coding: { cwd: "coding-agent", file: "test/suite/book-session-walkthrough.test.ts", config: [] },
	durable: {
		cwd: "durable",
		file: "test/harness-tools-recovery.test.ts",
		config: ["--config", fileURLToPath(new URL("./vitest-durable.config.mjs", import.meta.url))],
	},
};
const selected = process.argv.slice(2);
if (selected.length > 1 || (selected.length === 1 && !Object.hasOwn(suites, selected[0]))) {
	throw new Error("Usage: node labs/run-integration.mjs [coding|durable]");
}
if (!existsSync(cli)) throw new Error("Install the repository dependencies with npm ci --ignore-scripts first.");
const directory = mkdtempSync(join(tmpdir(), "pi-book-integration-"));
const runNames = selected.length === 0 ? Object.keys(suites) : selected;
let passed = 0;
try {
	const home = join(directory, "home");
	const temporary = join(directory, "tmp");
	mkdirSync(home);
	mkdirSync(temporary);
	// Do not inherit auth, endpoints, extensions or the user's actual home directory.
	const env = {
		PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: temporary,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_NO_LOCAL_LLM: "1",
		PI_OFFLINE: "1",
		AWS_EC2_METADATA_DISABLED: "true",
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		NO_COLOR: "1",
	};
	for (const name of runNames) {
		const suite = suites[name];
		const report = join(directory, `${name}.json`);
		const result = spawnSync(process.execPath, [cli, "--run", suite.file, ...suite.config,
			"--reporter=json", "--outputFile", report, "--silent=false", "--disableConsoleIntercept"], {
			cwd: join(repo, "packages", suite.cwd), env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			process.stderr.write(result.stdout ?? "");
			process.stderr.write(result.stderr ?? "");
			throw new Error(`${name} tests failed (${result.status ?? result.signal})`);
		}
		const summary = JSON.parse(readFileSync(report, "utf8"));
		assert.equal(summary.success, true);
		assert.equal(summary.numFailedTests, 0);
		assert.equal(summary.numPendingTests, 0);
		assert.equal(summary.numTodoTests, 0);
		for (const file of summary.testResults) {
			for (const test of file.assertionResults) {
				assert.equal(test.status, "passed", test.fullName);
				console.log(`PASS integration ${name}: ${test.fullName}`);
				passed++;
			}
		}
		for (const line of result.stdout.split(/\r?\n/)) {
			if (line.startsWith("TRACE ")) console.log(line);
		}
	}
	const storage = runNames.includes("durable") ? "temporary files and SQLite" : "temporary files and JSONL";
	console.log(`PASS ${passed} integration cases; faux models; ${storage}`);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
