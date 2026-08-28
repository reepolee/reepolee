/**
 * Typecheck ratchet - keeps `tsc --noEmit` error count from growing.
 *
 * The codebase carries historical type debt (strict flags were enabled late),
 * so a hard "zero errors" gate is not yet possible. Instead the current error
 * count is checked in as `.tsc-baseline`; this script fails when the count
 * rises above it and invites lowering the baseline when the count drops.
 *
 * Usage:
 *   bun scripts/typecheck_ratchet.ts            # check against baseline
 *   bun scripts/typecheck_ratchet.ts --update   # write current count as baseline
 */

import { join } from "node:path";

const BASELINE_FILE = join(process.cwd(), ".tsc-baseline");

const result = Bun.spawnSync({ cmd: ["bunx", "tsc", "--noEmit"], stdout: "pipe", stderr: "pipe" });

const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
const error_lines = output.split("\n").filter((line) => /error TS\d+:/.test(line));
const count = error_lines.length;

if (Bun.argv.includes("--update")) {
	await Bun.write(BASELINE_FILE, `${count}\n`);
	console.log(`Typecheck baseline updated: ${count} errors`);
	process.exit(0);
}

const baseline_file = Bun.file(BASELINE_FILE);
if (!(await baseline_file.exists())) {
	console.error(`\x1b[31m✗ Missing ${BASELINE_FILE}. Run: bun scripts/typecheck_ratchet.ts --update\x1b[0m`);
	process.exit(1);
}

const baseline = parseInt((await baseline_file.text()).trim(), 10);
if (!Number.isFinite(baseline)) {
	console.error(`\x1b[31m✗ Invalid baseline in ${BASELINE_FILE}\x1b[0m`);
	process.exit(1);
}

if (count > baseline) {
	console.error(`\x1b[31m✗ Typecheck ratchet failed: ${count} errors (baseline ${baseline}).\x1b[0m`);
	console.error("  New type errors were introduced. Fix them (or, if intentional, update the baseline");
	console.error("  with: bun scripts/typecheck_ratchet.ts --update). First offenders:");
	for (const line of error_lines.slice(0, 10)) {
		console.error(`  ${line}`);
	}
	process.exit(1);
}

if (count < baseline) {
	await Bun.write(BASELINE_FILE, `${count}\n`);
	console.log(`✓ Typecheck ratchet: ${count} errors (down from ${baseline}) - baseline lowered.`);
} else {
	console.log(`✓ Typecheck ratchet: ${count} errors (baseline ${baseline}).`);
}
