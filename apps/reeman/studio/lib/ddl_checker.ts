/**
 * Studio - DDL validation against a throwaway database.
 *
 * SQLite: the schema is loaded into an in-memory database via `bun:sql` (the
 * same engine as the `sqlite3` CLI, so it catches the same class of errors)
 * without touching disk. `SQL` is used rather than `bun:sqlite` so the same
 * connection can be handed to the generator's introspectors, which take a `SQL`.
 *
 * MySQL: SQLite's parser would misread dialect syntax (ENGINE=, AUTO_INCREMENT,
 * ENUM) and its flexible typing would mask real type errors, so MySQL DDL is
 * executed against a real server in an ephemeral sandbox database - CREATE a
 * uniquely named scratch schema, run the DDL inside it, DROP it in a `finally`
 * so it is removed even when validation throws. The sandbox is created on
 * `TEST_CONNECTION_STRING` when that is MySQL, falling back to
 * `DEV_CONNECTION_STRING`; when neither is MySQL the check reports `skipped` rather
 * than a false pass.
 *
 * Both engines validate views *lazily*: `CREATE VIEW v AS SELECT missing FROM
 * nowhere` is accepted at create time (MySQL defers column resolution for views
 * over other views, and SQLite defers it entirely), so the error only surfaces
 * when the view is read. A plain `sqlite3 :memory: < schema.sql` or `mysql -e
 * "SOURCE schema.sql"` therefore exits 0 on a schema whose views are broken.
 * This checker closes that gap by probing every view after the schema loads.
 *
 * Display-contract rules are not implemented here. Once the schema loads and all
 * views resolve, `check_display_contract` runs the generator's own validators
 * against the sandbox, so the studio and the generator cannot disagree.
 */

import { DB_CONNECTION_STRING } from "$config/db";
import { sanitize_env_value } from "$lib/env";
import { SQL } from "bun";

import { check_display_contract } from "./contract_check";
import { parse_ddl_file } from "./ddl_parser";
import { serialize_studio_file } from "./ddl_writer";
import { find_dangling_id_columns } from "./schema_adaptation";
import type { StudioFile } from "./types";

export type DdlIssueKind = "schema" | "view" | "display" | "naming";

export interface DdlIssue {
	kind: DdlIssueKind;
	/** View/table the issue belongs to; "" when the failure is file-level. */
	object_name: string;
	message: string;
}

export interface DdlCheckReport {
	ok: boolean;
	skipped: boolean;
	/** Views that loaded and were queried successfully. */
	views_checked: string[];
	issues: DdlIssue[];
}

/**
 * Validate a studio model by loading it into a throwaway database:
 * in-memory SQLite, or an ephemeral sandbox schema on a live MySQL server.
 *
 * Dangling `*_id` columns are reported first: they are valid SQL, so the sandbox
 * accepts them happily, and the failure only appears much later during CRUD
 * generation as `Table "<x>" is missing from the DDL cache.`
 */
export async function check_studio_file(model: StudioFile): Promise<DdlCheckReport> {
	const naming_issues = check_dangling_id_columns(model);
	const sql = serialize_studio_file(model);
	const report = model.dialect === "sqlite" ? await check_sqlite_sql(sql) : await check_mysql_sql(sql);

	if (naming_issues.length === 0) return report;
	const issues = [...naming_issues, ...report.issues];
	return { ...report, ok: false, issues };
}

/**
 * Report `*_id` columns whose target table does not exist. Never auto-corrected -
 * renaming a column changes what the schema means and what application code reads,
 * so the operator decides between renaming the column and adding the missing table.
 */
function check_dangling_id_columns(model: StudioFile): DdlIssue[] {
	const dangling = find_dangling_id_columns(model);
	return dangling.map((item) => {
		const suggestion = item.is_integer ? `${item.column.replace(/_id$/, "")}_no` : `${item.column.replace(/_id$/, "")}_code`;
		const message = `"${item.table}.${item.column}" looks like a foreign key but table "${item.expected_table}" does not exist. `
			+ `Rename it (e.g. "${suggestion}") if it is a plain value, or add the "${item.expected_table}" table. `
			+ `Left as is, CRUD generation fails with: Table "${item.expected_table}" is missing from the DDL cache.`;
		return { kind: "naming" as const, object_name: `${item.table}.${item.column}`, message };
	});
}

/**
 * Validate MySQL DDL in an ephemeral sandbox database on the configured server.
 *
 * MySQL has no in-memory mode, so this is the over-the-wire equivalent: create a
 * uniquely named scratch schema, run the DDL inside it, then drop it. The drop
 * lives in a `finally` so the sandbox is removed even when the DDL throws.
 */
export async function check_mysql_sql(sql: string): Promise<DdlCheckReport> {
	const server_url = resolve_mysql_server_url();
	if (!server_url) {
		const message = "MySQL check skipped - no MySQL TEST_CONNECTION_STRING or DEV_CONNECTION_STRING configured, so the DDL was not executed.";
		return { ok: true, skipped: true, views_checked: [], issues: [{ kind: "schema", object_name: "", message }] };
	}

	const sandbox_name = `studio_ddl_check_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
	const server_db = new SQL(server_url);
	const issues: DdlIssue[] = [];
	const views_checked: string[] = [];
	let sandbox_created = false;

	try {
		try {
			await server_db.unsafe(`CREATE DATABASE ${backtick(sandbox_name)}`);
			sandbox_created = true;
		} catch (error) {
			const message = `MySQL check skipped - could not create sandbox database: ${error_text(error)}`;
			return { ok: true, skipped: true, views_checked: [], issues: [{ kind: "schema", object_name: "", message }] };
		}

		const sandbox_db = new SQL(`${server_url.replace(/\/*$/, "")}/${sandbox_name}`);
		try {
			const load_issue = await load_mysql_statements(sandbox_db, sql);
			if (load_issue) {
				issues.push(load_issue);
				return { ok: false, skipped: false, views_checked, issues };
			}

			const view_rows = await sandbox_db.unsafe(
				"SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME",
			) as { name: string; }[];
			for (const row of view_rows) {
				const probe_issue = await probe_mysql_view(sandbox_db, row.name);
				if (probe_issue) issues.push(probe_issue);
				else views_checked.push(row.name);
			}

			// Only run the contract once every view resolves - the generator's
			// introspector cannot read columns off a view that does not execute.
			if (issues.length === 0) {
				const violation = await check_display_contract(sandbox_db, "mysql");
				if (violation) issues.push({ kind: "display", object_name: violation.object_name, message: violation.message });
			}
		} finally {
			await sandbox_db.close().catch(() => { /* sandbox is dropped below regardless */ });
		}
	} finally {
		if (sandbox_created) {
			await server_db.unsafe(`DROP DATABASE IF EXISTS ${backtick(sandbox_name)}`).catch(() => { /* leave no sandbox behind, but never mask the real error */ });
		}
		await server_db.close().catch(() => { /* connection may already be closed */ });
	}

	return { ok: issues.length === 0, skipped: false, views_checked, issues };
}

/**
 * Execute the DDL one statement at a time so the failing statement can be named.
 * Parsed via `parse_ddl_file` rather than a raw split so CREATE TRIGGER bodies
 * (which contain top-level semicolons inside BEGIN ... END) arrive intact.
 */
async function load_mysql_statements(sandbox_db: SQL, sql: string): Promise<DdlIssue | null> {
	const parsed = parse_ddl_file(sql, "check.sql", "mysql");
	for (const statement of parsed.statements) {
		const statement_text = statement.text.trim().replace(/;$/, "").trim();
		if (!statement_text) continue;
		try {
			await sandbox_db.unsafe(statement_text);
		} catch (error) {
			return { kind: "schema", object_name: statement_label(statement), message: `${error_text(error)} (in: ${first_line(statement_text)})` };
		}
	}
	return null;
}

/**
 * Force MySQL to resolve one view's body. CREATE VIEW may accept a view over
 * another view without resolving its columns, so the error only surfaces on read.
 * Column-level rules are left to the generator's contract validator.
 */
async function probe_mysql_view(sandbox_db: SQL, view_name: string): Promise<DdlIssue | null> {
	try {
		await sandbox_db.unsafe(`SELECT * FROM ${backtick(view_name)} LIMIT 0`);
		return null;
	} catch (error) {
		return { kind: "view", object_name: view_name, message: error_text(error) };
	}
}

/**
 * Pick the MySQL server the sandbox is created on. `TEST_CONNECTION_STRING` wins
 * so schema validation creates and drops scratch databases on the test server
 * rather than the app's own, falling back to `DEV_CONNECTION_STRING` when only that
 * one is MySQL. Returns null when neither is MySQL - the check then reports
 * `skipped` instead of a false pass.
 */
function resolve_mysql_server_url(): string | null {
	const test_url = sanitize_env_value(Bun.env.TEST_CONNECTION_STRING ?? "");
	const test_server = mysql_server_url(test_url);
	if (test_server) return test_server;
	return mysql_server_url(DB_CONNECTION_STRING);
}

/**
 * Strip the database name off a MySQL connection string, leaving a server-level
 * URL the sandbox can be created from. Returns null for non-MySQL connections.
 */
export function mysql_server_url(connection_string: string): string | null {
	const trimmed = connection_string.trim();
	if (!/^mysql(2)?:\/\//i.test(trimmed)) return null;
	try {
		const url_obj = new URL(trimmed);
		url_obj.pathname = "";
		return url_obj.toString().replace(/\/*$/, "");
	} catch {
		return null;
	}
}

function backtick(name: string): string {
	const escaped = name.replaceAll("`", "``");
	return `\`${escaped}\``;
}

function first_line(text: string): string {
	const line = text.split("\n")[0]!.trim();
	return line.length > 70 ? `${line.slice(0, 70)}...` : line;
}

/** Validate raw SQLite DDL text. Exposed separately so callers can check a string without a model. */
export async function check_sqlite_sql(sql: string): Promise<DdlCheckReport> {
	const db = new SQL("sqlite://:memory:");
	const issues: DdlIssue[] = [];
	const views_checked: string[] = [];

	try {
		await db.unsafe("PRAGMA foreign_keys = ON");
		const load_issue = await load_sqlite_statements(db, sql);
		if (load_issue) {
			issues.push(load_issue);
			return { ok: false, skipped: false, views_checked, issues };
		}

		const view_rows = await db.unsafe("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name") as { name: string; }[];
		for (const row of view_rows) {
			const probe_issue = await probe_sqlite_view(db, row.name);
			if (probe_issue) issues.push(probe_issue);
			else views_checked.push(row.name);
		}

		// Only run the contract once every view resolves - the generator's
		// introspector cannot read columns off a view that does not execute.
		if (issues.length === 0) {
			const violation = await check_display_contract(db, "sqlite");
			if (violation) issues.push({ kind: "display", object_name: violation.object_name, message: violation.message });
		}
	} finally {
		await db.close().catch(() => { /* in-memory db may already be closed */ });
	}

	return { ok: issues.length === 0, skipped: false, views_checked, issues };
}

/**
 * Execute SQLite DDL one statement at a time so the failing statement can be
 * named. Parsed via `parse_ddl_file` so CREATE TRIGGER bodies (which hold
 * top-level semicolons) arrive intact.
 */
async function load_sqlite_statements(db: SQL, sql: string): Promise<DdlIssue | null> {
	const parsed = parse_ddl_file(sql, "check.sql", "sqlite");
	for (const statement of parsed.statements) {
		const statement_text = statement.text.trim().replace(/;$/, "").trim();
		if (!statement_text) continue;
		try {
			await db.unsafe(statement_text);
		} catch (error) {
			return { kind: "schema", object_name: statement_label(statement), message: `${error_text(error)} (in: ${first_line(statement_text)})` };
		}
	}
	return null;
}

/** Best available name for a statement: its own object, else the table it belongs to. */
function statement_label(statement: { object_name: string; parent_table?: string; }): string {
	return statement.object_name || statement.parent_table || "";
}

/**
 * Force SQLite to resolve one view's body. CREATE VIEW never resolves it, so a
 * view over a missing table or column is accepted at create time and only fails
 * on read. Column-level rules are left to the generator's contract validator.
 */
async function probe_sqlite_view(db: SQL, view_name: string): Promise<DdlIssue | null> {
	try {
		await db.unsafe(`SELECT * FROM ${quote_identifier(view_name)} LIMIT 0`);
		return null;
	} catch (error) {
		return { kind: "view", object_name: view_name, message: error_text(error) };
	}
}

function quote_identifier(name: string): string {
	const escaped = name.replaceAll(`"`, `""`);
	return `"${escaped}"`;
}

function error_text(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One-line-per-issue summary for toasts and CLI output. */
export function format_check_report(report: DdlCheckReport): string {
	if (report.skipped) return report.issues[0]?.message ?? "Check skipped.";
	if (report.ok) {
		const view_count = report.views_checked.length;
		return view_count > 0 ? `DDL valid. ${view_count} view(s) queried.` : "DDL valid.";
	}
	const lines = report.issues.map((issue) => (issue.object_name ? `${issue.object_name}: ${issue.message}` : issue.message));
	return lines.join(" | ");
}
