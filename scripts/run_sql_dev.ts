#!/usr/bin/env bun
/**
 * Dev SQL runner CLI - execute a .sql file against the current DB config and
 * print per-statement `{ meta, records }` JSON. Uses the `lib/sql_runner`
 * runner (`bun:sql` `unsafe()`), same dev helper as the MCP `run_sql_dev` tool.
 *
 * Statements are split before execution: `unsafe()` only returns the first
 * result set of a multi-statement string, so a whole-file call would silently
 * drop every statement after the first. Each statement reports its own
 * `{ meta, records }` (and `error` when it fails); the process exits non-zero
 * if any statement errored.
 *
 * Usage (reads a .sql file, inline SQL, or stdin when no input is given):
 *   bun run sql path/to/file.sql
 *   bun run sql "SELECT * FROM modules"
 *   bun run sql SELECT * FROM modules
 *   printf 'SELECT 1;' | bun run sql
 *   printf 'UPDATE users SET name = "x" WHERE id = 1;' | bun run sql --allow-changes
 *   bun run sql path/to/file.sql --allow-changes --limit=50
 *
 * Read-only by default: only a single SELECT per statement is allowed and
 * returned records are capped. Pass --allow-changes to permit write
 * statements and DDL.
 *
 * Flags:
 *   --allow-changes  Permit writes/DDL (default: read-only)
 *   --limit=N        Cap returned records per statement (default 100, max 1000)
 *
 * Options may appear before or after the file path.
 *
 * Runs against the app's own DB connection - treat write statements as
 * destructive.
 */

// Route the DB startup banner (config/db.ts) to stderr so stdout carries only
// the JSON result - same mechanism scripts/mcp/start.ts uses for the MCP.
Bun.env.MCP_STDIO = "true";

import { existsSync } from "node:fs";
import { join } from "node:path";

const { close_db } = await import("$config/db");
const { db_type } = await import("$lib/resolve_db_type");
const { normalize_query_limit, run_sql, run_sql_read_only, split_sql_statements } = await import("$lib/sql_runner");
import type { ReadOnlySqlRunnerResult, SqlRunnerResult } from "$lib/sql_runner";

const args = process.argv.slice(2);
const allow_changes = args.includes("--allow-changes");
const limit_arg = args.find((arg) => arg.startsWith("--limit="));
const limit = limit_arg ? Number(limit_arg.split("=")[1]) : undefined;

if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
	console.error(`✗ Invalid --limit value: ${limit_arg}`);
	process.exit(1);
}

// Any non-flag argument is input: a .sql file path, inline SQL (quoted as one
// argument or split across several), or nothing (which reads stdin).
const positional = args.filter((arg) => !arg.startsWith("--"));

/** Heuristic: did the user intend this argument to be a file path? */
function looks_like_file_path(arg: string): boolean {
	return (
		arg.endsWith(".sql") ||
		arg.endsWith(".sqlite") ||
		arg.startsWith(".") ||
		arg.startsWith("/") ||
		arg.startsWith("~") ||
		arg.includes("\\") ||
		/^[A-Za-z]:[\\/]/.test(arg)
	);
}

let content: string;
let source: string;
if (positional.length === 0) {
	// No input given - read the SQL from stdin (grep-style).
	content = await new Response(Bun.stdin).text();
	source = "stdin";
} else {
	const first = positional[0] ?? "";
	const resolved = join(process.cwd(), first);
	if (positional.length === 1 && existsSync(resolved)) {
		content = await Bun.file(resolved).text();
		source = first;
	} else if (positional.length === 1 && looks_like_file_path(first)) {
		console.error(`✗ File not found: ${first}`);
		process.exit(1);
	} else {
		content = positional.join(" ");
		source = "inline";
	}
}

const statements = split_sql_statements(content, db_type);

if (statements.length === 0) {
	console.error("✗ No executable statements found in input (empty or comment-only)");
	process.exit(1);
}

/** Apply the same client-side cap + truncated flag as the unguarded MCP tool. */
function cap_records(result: SqlRunnerResult, requested: number | undefined): ReadOnlySqlRunnerResult {
	const safe_limit = normalize_query_limit(requested ?? 100);
	const records = result.records.slice(0, safe_limit);
	return { meta: { ...result.meta, record_count: records.length }, records, truncated: result.records.length > safe_limit };
}

// Bun's SQL connection does not keep the event loop alive - hold it open
// while the queries run (same pattern as init_sqlite_db.ts / clone_db.ts).
const stay_alive = setInterval(() => {}, 2_147_483_647);
let failed = 0;

try {
	const results = [];
	for (const statement of statements) {
		try {
			const result = allow_changes
				? cap_records(await run_sql(statement), limit)
				: await run_sql_read_only(statement, undefined, limit);
			results.push({ statement, meta: result.meta, records: result.records, truncated: result.truncated });
		} catch (error) {
			failed += 1;
			const message = error instanceof Error ? error.message : String(error);
			const hint = message === "Only a single SELECT query is allowed" ? " (pass --allow-changes to permit writes/DDL)" : "";
			results.push({ statement, error: message + hint });
		}
	}

	console.log(JSON.stringify({ file: source, dialect: db_type, statements: results }, null, 2));
} finally {
	clearInterval(stay_alive);
	await close_db();
}

if (failed > 0) process.exit(1);
