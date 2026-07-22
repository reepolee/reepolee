#!/usr/bin/env bun
/**
 * Naming check.
 *
 * AGENTS.md requires snake_case for variables, functions, and filenames in
 * server-side .ts files. This enforces that as a checked invariant instead of a
 * convention - the same reason engine_drift_check.ts exists.
 *
 * A documented-but-unchecked rule loses to whatever is already on screen: an
 * agent (or person) editing a camelCase file reads the surrounding code as the
 * house style, so every violation left in the tree teaches the next one. This
 * keeps the count at zero so there is nothing to learn from.
 *
 * WHAT IS CHECKED
 * Declaration sites only - `const`/`let`/`var` (including destructured
 * bindings), `function`, and class methods. Property *reads* are deliberately
 * not flagged, because those are frequently other people's contracts:
 *   - JS/DOM/Bun builtins:      regex.lastIndex, el.textContent, arr.indexOf
 *   - external object keys:     inputSchema, additionalProperties (MCP),
 *                               noHtmlBlocks (Bun.markdown), devDependencies
 * Renaming a builtin is an outright bug - `cust_elem_regex.last_index = 0`
 * silently breaks the custom-element loop - so only names we declare are in
 * scope here.
 *
 * Also flags half-converted names (`raw_jS`), which is what a naive
 * camelCase -> snake_case regex produces for consecutive capitals (`rawJS`).
 *
 * EXCEPTIONS
 * Two kinds, both explicit:
 *   - ALLOWED below, for identifiers that are legitimately camelCase.
 *   - .namingignore at the repo root: newline-separated path prefixes to skip,
 *     for vendored/upstream code that must be fixed at its source instead.
 * Per-file, prefix a line with `// naming-check-ignore-next-line`.
 *
 * Usage: bun run naming:check [--verbose|-v]
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const DIM = "\u001b[2m";

function ok(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string) { console.log(`  ${YELLOW}!${RESET} ${msg}`); }
function err(msg: string) { console.log(`  ${RED}✗${RESET} ${msg}`); }
function info(msg: string) { console.log(`  ${DIM}~${RESET} ${msg}`); }

const root = resolve(import.meta.dir, "..");
const VERBOSE = Bun.argv.includes("--verbose") || Bun.argv.includes("-v");

/** Never walked into, in any repo. */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"out",
	"vendor",
	"coverage",
	"tmp",
	"temp",
	".cache",
	".claude",
]);

/**
 * Identifiers that are legitimately camelCase despite being declared by us.
 * Keep this list short and justified - each entry is a hole in the rule.
 */
const ALLOWED = new Set([
	// Function name inside GENERATED CLIENT-SIDE JS (a string template that ends
	// up in the browser). AGENTS.md scopes snake_case to server-side .ts, and
	// live_reload.test.ts asserts this exact name.
	"connectLiveReload",
]);

const IGNORE_MARKER = "naming-check-ignore-next-line";
/**
 * Whole-file opt-out, for files that must mirror an external API verbatim - a
 * test double standing in for a third-party library, say, where the method
 * names are the library's contract rather than ours.
 */
const IGNORE_FILE_MARKER = "naming-check-ignore-file";

type Finding = { file: string; line: number; name: string; suggestion: string; kind: "camel" | "mangled"; };

function to_snake(name: string): string {
	// A half-converted name (raw_jS) already has its separators - the stray
	// capitals are leftovers from consecutive caps, so just lower them.
	if (name.includes("_")) return name.toLowerCase();
	return name.replace(/([a-z0-9])([A-Z]+)/g, (_m, lead: string, caps: string) => `${lead}_${caps.toLowerCase()}`).replace(
		/^([A-Z]+)/,
		(m) => m.toLowerCase()
	);
}

function load_path_ignores(): string[] {
	const file = join(root, ".namingignore");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function collect_files(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) { collect_files(full, out); } else if (entry.endsWith(".ts")) { out.push(full); }
	}
	return out;
}

/** Strip line/block comments and string+regex literals so their contents never match. */
function strip_noise(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
		.replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/"(?:\\.|[^"\\])*"/g, (m) => " ".repeat(m.length))
		.replace(/'(?:\\.|[^'\\])*'/g, (m) => " ".repeat(m.length));
}

/** Binding names introduced by a destructuring pattern. */
function bindings_from_pattern(pattern: string): string[] {
	return pattern.split(",").map((part) => {
		let p = part.trim();
		p = p.replace(/^\.\.\./, ""); // rest element
		const colon = p.indexOf(":"); // { key: binding } -> binding
		if (colon !== -1) p = p.slice(colon + 1);
		const eq = p.indexOf("="); // default value
		if (eq !== -1) p = p.slice(0, eq);
		return p.trim().replace(/[{}[\]]/g, "").trim();
	}).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

async function scan(path: string): Promise<Finding[]> {
	const source = await Bun.file(path).text();
	// Not every .ts file is TypeScript - HLS video segments are MPEG transport
	// streams with the same extension. Skip anything that isn't source text.
	if (source.indexOf(String.fromCharCode(0)) !== -1) return [];
	if (source.includes(IGNORE_FILE_MARKER)) return [];

	const lines = source.split("\n");
	const clean = strip_noise(source).split("\n");
	const findings: Finding[] = [];
	const rel = relative(root, path);

	// Depth of the innermost class body, or null when not inside a class. Method
	// declarations only count at that depth - without this, any indented call
	// (`writeFileSync(...)`, `afterEach(() => {`) reads as a method signature.
	let depth = 0;
	let class_body_depth: number | null = null;

	for (let i = 0; i < clean.length; i++) {
		const prev_depth = depth;
		const opens = (clean[i].match(/\{/g) ?? []).length;
		const closes = (clean[i].match(/\}/g) ?? []).length;
		const entering_class = /\bclass\s+[A-Za-z_$][\w$]*/.test(clean[i]);
		depth += opens - closes;
		if (entering_class && class_body_depth === null) class_body_depth = prev_depth + 1;
		else if (class_body_depth !== null && depth < class_body_depth) class_body_depth = null;

		if (i > 0 && lines[i - 1].includes(IGNORE_MARKER)) continue;
		const line = clean[i];
		const names: string[] = [];

		// const/let/var, including destructuring patterns
		for (const m of line.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.push(m[1]);
		// Destructuring: non-greedy to the first closing bracket, so defaults
		// inside the pattern (`{ type = "green", ...rest }`) are still matched.
		// Bindings pulled straight off require()/import() are someone else's
		// exports (`const { pathToFileURL } = await import("url")`) - not ours to
		// rename, and renaming them breaks the import.
		for (const m of line.matchAll(/\b(?:const|let|var)\s*(\{.*?\}|\[.*?\])\s*=\s*(.*)$/g)) {
			if (/\b(?:require|import)\s*\(/.test(m[2])) continue;
			names.push(...bindings_from_pattern(m[1]));
		}

		// function declarations
		for (const m of line.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.push(m[1]);

		// Class methods - only at class-body depth, and only signatures (ending in
		// `{`), so a call like `write_file_sync(a, b);` is never mistaken for one.
		if (class_body_depth !== null && prev_depth === class_body_depth) {
			const method = /^\s*(?:(?:public|private|protected|static|readonly)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^{;]+)?\{\s*$/.exec(line);
			if (method) names.push(method[1]);
		}

		for (const name of names) {
			if (ALLOWED.has(name)) continue;
			// PascalCase is the convention for classes, types, and namespaces.
			if (/^[A-Z]/.test(name)) continue;
			if (/^[a-z0-9_$]+$/.test(name)) {
				// Already snake_case, but check for a half-converted name (raw_jS).
				if (/[A-Z]/.test(name)) findings.push({ file: rel, line: i + 1, name, suggestion: to_snake(name), kind: "mangled" });
				continue;
			}
			if (/[a-z][A-Z]/.test(name)) {
				const kind = /_/.test(name) ? "mangled" : "camel";
				findings.push({ file: rel, line: i + 1, name, suggestion: to_snake(name), kind });
			}
		}
	}
	return findings;
}

async function main() {
	const path_ignores = load_path_ignores();
	const scan_roots = readdirSync(root).filter((entry) => {
		if (SKIP_DIRS.has(entry)) return false;
		const full = join(root, entry);
		return existsSync(full) && statSync(full).isDirectory();
	});

	console.log(`\n${BOLD}Naming check${RESET}  ${DIM}(snake_case for server-side .ts - AGENTS.md)${RESET}`);

	const files: string[] = [];
	for (const dir of scan_roots) { collect_files(join(root, dir), files); }
	for (const entry of readdirSync(root)) {
		if (entry.endsWith(".ts") && statSync(join(root, entry)).isFile()) files.push(join(root, entry));
	}

	const checked = files.filter((f) => {
		const rel = relative(root, f);
		return !path_ignores.some((prefix) => rel === prefix || rel.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"));
	});
	const skipped = files.length - checked.length;

	const findings: Finding[] = [];
	for (const file of checked) { findings.push(...await scan(file)); }

	if (findings.length === 0) {
		console.log();
		ok(`${checked.length} file(s) clean`);
		if (skipped > 0) {
			info(`${skipped} file(s) skipped via .namingignore (vendored - fix at the source, then re-vendor)`);
		}
		console.log();
		process.exit(0);
	}

	console.log();
	const by_file = new Map<string, Finding[]>();
	for (const f of findings) { by_file.set(f.file, [...(by_file.get(f.file) ?? []), f]); }

	const shown = VERBOSE ? [...by_file] : [...by_file].slice(0, 15);
	for (const [file, list] of shown) {
		err(`${file}`);
		for (const f of (VERBOSE ? list : list.slice(0, 6))) {
			const note = f.kind === "mangled" ? " (half-converted)" : "";
			console.log(`      ${DIM}${f.line}:${RESET} ${f.name} -> ${GREEN}${f.suggestion}${RESET}${note}`);
		}
		if (!VERBOSE && list.length > 6) info(`  ... ${list.length - 6} more in this file`);
	}
	if (!VERBOSE && by_file.size > 15) info(`... ${by_file.size - 15} more file(s). Run with --verbose for all.`);

	console.log();
	err(`${findings.length} naming violation(s) in ${by_file.size} file(s).`);
	info("Rename the declaration and its references. Do NOT rename property reads on builtins or external schemas.");
	if (skipped > 0) info(`${skipped} file(s) skipped via .namingignore.`);
	console.log();
	process.exit(1);
}

main();
