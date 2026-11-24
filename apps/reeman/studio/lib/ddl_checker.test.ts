import { describe, expect, test } from "bun:test";

import { parse_ddl_file } from "./ddl_parser";
import { check_sqlite_sql, check_studio_file, format_check_report, mysql_server_url } from "./ddl_checker";
import type { StudioFile } from "./types";

const TEAMS_TABLE = [
	"CREATE TABLE teams (",
	"    id INTEGER PRIMARY KEY AUTOINCREMENT,",
	"    title TEXT NULL DEFAULT '',",
	"    display TEXT GENERATED ALWAYS AS (title) VIRTUAL",
	");",
].join("\n");

describe("check_sqlite_sql", () => {
	test("accepts a valid schema whose views expose a cast display", async () => {
		const sql = [TEAMS_TABLE, "CREATE VIEW v_teams AS SELECT t.id, CAST(t.title AS TEXT) AS display FROM teams t;"].join("\n");
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(true);
		expect(report.views_checked).toEqual(["v_teams"]);
		expect(report.issues).toEqual([]);
	});

	test("reports a syntax error in the schema", async () => {
		const report = await check_sqlite_sql("CREAT TABLE teams (id INTEGER);");
		expect(report.ok).toBe(false);
		expect(report.issues[0]!.kind).toBe("schema");
		expect(report.views_checked).toEqual([]);
	});

	test("catches a view referencing a missing column that CREATE VIEW alone accepts", async () => {
		const sql = [TEAMS_TABLE, "CREATE VIEW v_broken AS SELECT nope FROM teams;"].join("\n");
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(false);
		const issue = report.issues.find((item) => item.object_name === "v_broken")!;
		expect(issue.kind).toBe("view");
		expect(issue.message).toContain("no such column");
	});

	test("catches a view referencing a missing table", async () => {
		const sql = [TEAMS_TABLE, "CREATE VIEW v_missing AS SELECT x FROM nowhere;"].join("\n");
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(false);
		expect(report.issues[0]!.message).toContain("no such table");
	});

	test("accepts a view with no display column", async () => {
		const sql = [TEAMS_TABLE, "CREATE VIEW v_nodisplay AS SELECT t.id, t.title FROM teams t;"].join("\n");
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(true);
		expect(report.views_checked).toEqual(["v_nodisplay"]);
		expect(report.issues).toEqual([]);
	});

	test("flags an uncast display expression, which SQLite reports as untyped", async () => {
		const sql = [TEAMS_TABLE, "CREATE VIEW v_untyped AS SELECT t.id, MAX(t.title) AS display FROM teams t;"].join("\n");
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(false);
		const issue = report.issues[0]!;
		expect(issue.kind).toBe("display");
		// Message comes verbatim from the generator's validator, not from the studio.
		expect(issue.message).toContain("Display contract violation");
		expect(issue.message).toContain("string-compatible");
		expect(issue.object_name).toBe("v_untyped");
	});

	test("catches a view that selects a sibling select alias", async () => {
		const sql = [
			TEAMS_TABLE,
			"CREATE VIEW v_alias AS SELECT MAX(t.title) AS label, CAST(label AS TEXT) AS display FROM teams t;",
		].join("\n");
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(false);
		expect(report.issues[0]!.message).toContain("no such column");
	});

	test("reports the first contract violation when several views are bad", async () => {
		// Views without display columns are valid now, so the violations come
		// from uncast display expressions (untyped in SQLite).
		const sql = [
			TEAMS_TABLE,
			"CREATE VIEW v_a AS SELECT t.id, MAX(t.title) AS display FROM teams t;",
			"CREATE VIEW v_b AS SELECT t.id, MAX(t.title) AS display FROM teams t;",
		].join("\n");
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(false);
		// The generator's validator throws on the first violation, so one is
		// reported per run rather than all of them. Fixing it surfaces the next.
		expect(report.issues).toHaveLength(1);
		expect(report.issues[0]!.object_name).toBe("v_a");
	});

	test("reports every view that fails to resolve, since probing precedes the contract", async () => {
		const sql = [
			TEAMS_TABLE,
			"CREATE VIEW v_x AS SELECT nope FROM teams;",
			"CREATE VIEW v_y AS SELECT alsonope FROM teams;",
		].join("\n");
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(false);
		expect(report.issues.map((item) => item.object_name)).toEqual(["v_x", "v_y"]);
	});
});

describe("generator-owned rules the studio no longer reimplements", () => {
	test("rejects a table whose display is not a generated column", async () => {
		// require_generated = true for tables in the generator's contract. The
		// studio's own checks never covered this.
		const sql = "CREATE TABLE teams (id INTEGER PRIMARY KEY, title TEXT, display TEXT);";
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(false);
		expect(report.issues[0]!.message).toContain("must be a generated column");
	});

	test("accepts a table with no display column at all", async () => {
		const sql = "CREATE TABLE teams (id INTEGER PRIMARY KEY, title TEXT);";
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(true);
		expect(report.issues).toEqual([]);
	});

	test("accepts a v_<table> companion view without <stem>_display columns", async () => {
		// Display/_display columns are optional; a companion view that projects
		// only its own columns is valid and works off natural string columns.
		const sql = [
			TEAMS_TABLE,
			"CREATE TABLE games (",
			"    id INTEGER PRIMARY KEY AUTOINCREMENT,",
			"    team_id INTEGER NOT NULL REFERENCES teams(id),",
			"    title TEXT",
			");",
			"CREATE VIEW v_games AS SELECT g.id, g.team_id, g.title FROM games g;",
		].join("\n");
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(true);
		expect(report.issues).toEqual([]);
	});

	test("accepts the same companion view once the fk display is present", async () => {
		const sql = [
			TEAMS_TABLE,
			"CREATE TABLE games (",
			"    id INTEGER PRIMARY KEY AUTOINCREMENT,",
			"    team_id INTEGER NOT NULL REFERENCES teams(id),",
			"    display TEXT GENERATED ALWAYS AS (id) VIRTUAL",
			");",
			"CREATE VIEW v_games AS SELECT g.id, g.team_id, CAST(t.title AS TEXT) AS team_display,",
			"    CAST(g.id AS TEXT) AS display",
			"FROM games g LEFT JOIN teams t ON t.id = g.team_id;",
		].join("\n");
		const report = await check_sqlite_sql(sql);
		expect(report.ok).toBe(true);
	});
});

describe("dangling *_id detection", () => {
	test("fails a model whose *_id column has no target table", async () => {
		const model = parse_ddl_file(
			[
				"CREATE TABLE games (",
				"    id INTEGER PRIMARY KEY AUTOINCREMENT,",
				"    round_id INTEGER NOT NULL,",
				"    display TEXT GENERATED ALWAYS AS (id) VIRTUAL",
				");",
			].join("\n"),
			"example.sql",
			"sqlite",
		);
		const report = await check_studio_file(model);
		expect(report.ok).toBe(false);
		const issue = report.issues.find((item) => item.kind === "naming")!;
		expect(issue.object_name).toBe("games.round_id");
		expect(issue.message).toContain(`table "rounds" does not exist`);
		// The suggested rename must reflect that this is a number, not a code.
		expect(issue.message).toContain("round_no");
		// The error the operator would otherwise hit much later.
		expect(issue.message).toContain("missing from the DDL cache");
	});

	test("passes once the column is renamed away from _id", async () => {
		const model = parse_ddl_file(
			[
				"CREATE TABLE games (",
				"    id INTEGER PRIMARY KEY AUTOINCREMENT,",
				"    round_no INTEGER NOT NULL,",
				"    display TEXT GENERATED ALWAYS AS (id) VIRTUAL",
				");",
			].join("\n"),
			"example.sql",
			"sqlite",
		);
		const report = await check_studio_file(model);
		expect(report.ok).toBe(true);
	});
});

describe("check_studio_file", () => {
	test("routes a mysql model away from the sqlite engine", async () => {
		const model: StudioFile = { path: "sql/mysql/01-init.sql", dialect: "mysql", trailing: "\n", statements: [] };
		const report = await check_studio_file(model);
		// With no MySQL server configured this reports skipped rather than a false pass.
		// It must never be validated by the SQLite parser.
		expect(report.ok).toBe(true);
		if (report.skipped) expect(format_check_report(report)).toContain("MySQL check skipped");
	});
});

describe("mysql_server_url", () => {
	test("strips the database name, leaving a server-level url", () => {
		expect(mysql_server_url("mysql://root:pw@m4mini:3306/gsv-bun-test")).toBe("mysql://root:pw@m4mini:3306");
	});

	test("handles a url that already has no database name", () => {
		expect(mysql_server_url("mysql://root@m4mini")).toBe("mysql://root@m4mini");
	});

	test("returns null for sqlite connection strings", () => {
		expect(mysql_server_url("sqlite:app.db")).toBeNull();
		expect(mysql_server_url("sqlite://test.db")).toBeNull();
	});

	test("returns null for unparseable input", () => {
		expect(mysql_server_url("")).toBeNull();
		expect(mysql_server_url("not a url")).toBeNull();
	});
});

describe("format_check_report", () => {
	test("summarizes a passing run with the view count", async () => {
		const sql = [TEAMS_TABLE, "CREATE VIEW v_teams AS SELECT t.id, CAST(t.title AS TEXT) AS display FROM teams t;"].join("\n");
		const text = format_check_report(await check_sqlite_sql(sql));
		expect(text).toBe("DDL valid. 1 view(s) queried.");
	});
});
