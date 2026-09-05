import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { classify_statement, parse_column, parse_ddl_file, split_statements } from "./ddl_parser";
import { serialize_studio_file } from "./ddl_writer";
import type { Dialect } from "./types";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

const SAMPLE_FILES: { path: string; dialect: Dialect; }[] = [
	{ path: "sql/sqlite/demos/05-frameworks.sql", dialect: "sqlite" },
	{ path: "sql/mysql/demos/05-frameworks.sql", dialect: "mysql" },
	{ path: "sql/sqlite/demos/06-init-books.sql", dialect: "sqlite" },
	{ path: "sql/mysql/demos/06-init-books.sql", dialect: "mysql" },
	...lego_league_files(),
];

function lego_league_files(): { path: string; dialect: Dialect; }[] {
	return readdirSync(join(REPO_ROOT, "sql/mysql/lego_league_ddl"))
		.filter((file) => file.endsWith(".sql"))
		.sort()
		.map((file) => ({ path: `sql/mysql/lego_league_ddl/${file}`, dialect: "mysql" as Dialect }));
}

describe("round-trip", () => {
	for (const { path, dialect } of SAMPLE_FILES) {
		test(`${path} parses and serializes byte-identically`, () => {
			const source = readFileSync(join(REPO_ROOT, path), "utf-8");
			const model = parse_ddl_file(source, path, dialect);
			expect(serialize_studio_file(model)).toBe(source);
		});
	}
});

describe("statement splitting", () => {
	test("trigger bodies with internal semicolons stay one statement", () => {
		const source = readFileSync(join(REPO_ROOT, "sql/sqlite/demos/05-frameworks.sql"), "utf-8");
		const model = parse_ddl_file(source, "sql/sqlite/demos/05-frameworks.sql", "sqlite");
		const triggers = model.statements.filter((s) => s.kind === "trigger");
		expect(triggers.length).toBe(3);
		expect(triggers[0]!.text).toContain("END;");
	});

});

describe("classification", () => {
	test("index statements know their parent table", () => {
		const source = readFileSync(join(REPO_ROOT, "sql/sqlite/demos/05-frameworks.sql"), "utf-8");
		const model = parse_ddl_file(source, "x.sql", "sqlite");
		const index = model.statements.find((s) => s.kind === "index" && s.object_name === "frameworks_name_unique");
		expect(index!.parent_table).toBe("frameworks");
	});

	test("table-level MySQL UNIQUE KEY is retained when a table is regenerated", () => {
		const source = `CREATE TABLE reading_ranges (
    id INT NOT NULL,
    metric_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    UNIQUE KEY reading_ranges_metric_id_name(metric_id,name)
);`;
		const model = parse_ddl_file(source, "x.sql", "mysql");
		const table = model.statements[0]!.table!;
		expect(table.table_unique_keys).toEqual([{ key_name: "reading_ranges_metric_id_name", columns: ["metric_id", "name"], columns_raw: "metric_id,name" }]);
		model.statements[0]!.dirty = true;
		expect(serialize_studio_file(model)).toContain("UNIQUE KEY reading_ranges_metric_id_name(metric_id,name)");
	});

	test("every CREATE TABLE spelling is classified as create_table", () => {
		const cases: { sql: string; object_name: string; prefix: string; }[] = [
			{ sql: "CREATE TABLE developers (\n    id INTEGER PRIMARY KEY\n);", object_name: "developers", prefix: "TABLE " },
			{ sql: "CREATE TABLE IF NOT EXISTS teams (\n    id INTEGER PRIMARY KEY\n);", object_name: "teams", prefix: "TABLE IF NOT EXISTS " },
			{ sql: "CREATE TEMP TABLE scratch (\n    id INTEGER\n);", object_name: "scratch", prefix: "TEMP TABLE " },
			{ sql: "CREATE TEMPORARY TABLE IF NOT EXISTS scratch (\n    id INTEGER\n);", object_name: "scratch", prefix: "TEMPORARY TABLE IF NOT EXISTS " },
			{ sql: "CREATE TABLE IF NOT EXISTS `order` (\n    id INTEGER\n);", object_name: "order", prefix: "TABLE IF NOT EXISTS " },
			{ sql: "CREATE TABLE \"my table\" (\n    id INTEGER\n);", object_name: "my table", prefix: "TABLE " },
			{ sql: "CREATE TABLE [x] (\n    id INTEGER\n);", object_name: "x", prefix: "TABLE " },
			{ sql: "CREATE TABLE main.users (\n    id INTEGER\n);", object_name: "users", prefix: "TABLE " },
			{ sql: "CREATE TABLE IF NOT EXISTS `main`.`users` (\n    id INTEGER\n);", object_name: "users", prefix: "TABLE IF NOT EXISTS " },
		];
		for (const c of cases) {
			const stmt = classify_statement({ gap: "", text: c.sql });
			expect(stmt.kind).toBe("create_table");
			expect(stmt.object_name).toBe(c.object_name);
			expect(stmt.table!.create_prefix_raw).toBe(c.prefix);
			expect(stmt.table!.name_raw).toBeTruthy();
		}
	});

	test("CREATE TABLE ... AS SELECT stays raw and never breaks opening", () => {
		const stmt = classify_statement({ gap: "", text: "CREATE TABLE report AS SELECT id FROM users;" });
		expect(stmt.kind).toBe("raw");
	});

	test("backquoted DROP VIEW IF EXISTS names classify with a bare object_name", () => {
		const stmt = classify_statement({ gap: "", text: "DROP VIEW IF EXISTS `v_emails`;" });
		expect(stmt.kind).toBe("drop_view");
		expect(stmt.object_name).toBe("v_emails");
	});

	test("CREATE INDEX IF NOT EXISTS with quoted and schema-qualified names", () => {
		const stmt = classify_statement({ gap: "", text: "CREATE INDEX IF NOT EXISTS `weird idx` ON `main`.`users`(name);" });
		expect(stmt.kind).toBe("index");
		expect(stmt.object_name).toBe("weird idx");
		expect(stmt.parent_table).toBe("users");
	});

	test("backquoted column names parse in place (MySQL reserved words)", () => {
		const source = `CREATE TABLE IF NOT EXISTS points (\n    ` + "`rank`" + `              INT          DEFAULT NULL,\n    points              INT          DEFAULT NULL\n);`;
		const model = parse_ddl_file(source, "x.sql", "mysql");
		const table = model.statements[0]!.table!;
		expect(table.columns.map((c) => c.name)).toEqual(["`rank`", "points"]);
		model.statements[0]!.dirty = true;
		expect(serialize_studio_file(model)).toContain("`rank`              INT          DEFAULT NULL");
	});
});

describe("parse_column", () => {
	test("sqlite plain pk", () => {
		const col = parse_column("id         INTEGER   PRIMARY KEY")!;
		expect(col.is_primary_key).toBe(true);
		expect(col.nullability).toBe("unspecified");
		expect(col.modifier_order).toEqual(["primary_key"]);
	});

	test("sqlite generated virtual column", () => {
		const col = parse_column("display    TEXT      GENERATED ALWAYS AS (name) VIRTUAL")!;
		expect(col.is_generated).toBe(true);
		expect(col.generated_expr).toBe("name");
		expect(col.generated_kind).toBe("VIRTUAL");
	});

	test("sqlite inline references with on update", () => {
		const col = parse_column("developer_id    INTEGER   NOT NULL REFERENCES developers(id) ON UPDATE CASCADE")!;
		expect(col.references).toEqual({ table: "developers", column: "id", on_update: "CASCADE" });
		expect(col.nullability).toBe("not_null");
		expect(col.modifier_order).toEqual(["nullability", "references"]);
	});

	test("mysql id column with comment", () => {
		const col = parse_column("id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU'")!;
		expect(col.type_string).toBe("INT UNSIGNED");
		expect(col.is_auto_increment).toBe(true);
		expect(col.comment).toBe("ICU");
		expect(col.modifier_order).toEqual(["nullability", "auto_increment", "primary_key", "comment"]);
	});

	test("mysql markdown pseudo-type via comment", () => {
		const col = parse_column("bio            TEXT         NULL DEFAULT '' COMMENT 'MARKDOWN'")!;
		expect(col.nullability).toBe("null");
		expect(col.default_value).toBe("''");
		expect(col.comment).toBe("MARKDOWN");
	});

	test("mysql on update current timestamp", () => {
		const col = parse_column("updated_at     TIMESTAMP    NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP")!;
		expect(col.on_update_current_timestamp).toBe(true);
		expect(col.default_value).toBe("NULL");
	});

	test("sqlite default before null keeps order", () => {
		const col = parse_column("author       TEXT     DEFAULT '' NULL")!;
		expect(col.default_value).toBe("''");
		expect(col.nullability).toBe("null");
		expect(col.modifier_order).toEqual(["default", "nullability"]);
	});

	test("table-level foreign key line returns null", () => {
		expect(parse_column("FOREIGN KEY(author_id) REFERENCES authors(id) ON UPDATE CASCADE")).toBe(null);
	});

	test("default with quoted string containing escaped quote", () => {
		const col = parse_column("name TEXT DEFAULT 'it''s'")!;
		expect(col.default_value).toBe("'it''s'");
	});
});
