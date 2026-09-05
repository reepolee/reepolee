import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parse_ddl_file } from "./ddl_parser";
import { render_create_table, serialize_studio_file } from "./ddl_writer";
import { make_default_table } from "./domain_types";
import type { Dialect } from "./types";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

function lego_league_files(): { path: string; dialect: Dialect; }[] {
	// 411-views.sql has no CREATE TABLE statements, so the regeneration-fidelity
	// loop below (which asserts tables exist) skips it.
	return readdirSync(join(REPO_ROOT, "sql/mysql/lego_league_ddl"))
		.filter((file) => file.endsWith(".sql") && file !== "411-views.sql")
		.sort()
		.map((file) => ({ path: `sql/mysql/lego_league_ddl/${file}`, dialect: "mysql" as Dialect }));
}

const SAMPLE_FILES: { path: string; dialect: Dialect; }[] = [
	{ path: "sql/sqlite/demos/05-frameworks.sql", dialect: "sqlite" },
	{ path: "sql/mysql/demos/05-frameworks.sql", dialect: "mysql" },
	{ path: "sql/sqlite/demos/06-init-books.sql", dialect: "sqlite" },
	{ path: "sql/mysql/demos/06-init-books.sql", dialect: "mysql" },
	...lego_league_files(),
];

describe("regeneration fidelity", () => {
	for (const { path, dialect } of SAMPLE_FILES) {
		test(`${path} - every CREATE TABLE regenerates byte-identically`, () => {
			const source = readFileSync(join(REPO_ROOT, path), "utf-8");
			const model = parse_ddl_file(source, path, dialect);
			const tables = model.statements.filter((s) => s.kind === "create_table");
			expect(tables.length).toBeGreaterThan(0);

			for (const stmt of tables) {
				const regenerated = render_create_table(stmt.table!, dialect);
				expect(regenerated).toBe(stmt.text.trim());
			}
		});
	}
});

describe("serialize with edits", () => {
	test("IF NOT EXISTS clause survives a dirty save while untouched statements stay byte-identical", () => {
		const path = "sql/mysql/lego_league_ddl/241-team_statuses.sql";
		const source = readFileSync(join(REPO_ROOT, path), "utf-8");
		const model = parse_ddl_file(source, path, "mysql");

		const team_statuses = model.statements.find((s) => s.kind === "create_table" && s.object_name === "team_statuses")!;
		team_statuses.table!.columns.push({
			name: "note",
			type_string: "VARCHAR(255)",
			nullability: "unspecified",
			default_value: "''",
			is_primary_key: false,
			is_auto_increment: false,
			is_unique: false,
			is_generated: false,
			on_update_current_timestamp: false,
			modifier_order: ["default"],
		});
		team_statuses.dirty = true;

		const output = serialize_studio_file(model);
		// The IF NOT EXISTS leading clause is preserved on regeneration.
		expect(output).toContain("CREATE TABLE IF NOT EXISTS team_statuses (");
		// Untouched statements stay byte-identical: every non-create_table
		// statement from the source appears verbatim in the output.
		for (const stmt of model.statements.filter((s) => s.kind !== "create_table")) {
			expect(output).toContain(stmt.text);
		}
	});

	test("dirty table regenerates, everything else stays verbatim", () => {
		const path = "sql/sqlite/demos/05-frameworks.sql";
		const source = readFileSync(join(REPO_ROOT, path), "utf-8");
		const model = parse_ddl_file(source, path, "sqlite");

		const languages = model.statements.find((s) => s.kind === "create_table" && s.object_name === "languages")!;
		languages.table!.columns.push({
			name: "locale",
			type_string: "TEXT",
			nullability: "unspecified",
			default_value: "''",
			is_primary_key: false,
			is_auto_increment: false,
			is_unique: false,
			is_generated: false,
			on_update_current_timestamp: false,
			modifier_order: ["default"],
		});
		languages.dirty = true;

		const output = serialize_studio_file(model);
		// Column names are padded to the longest in the table, which is now
		// archived_by_user_id (19 chars + 1 space).
		expect(output).toContain("locale              TEXT      DEFAULT ''");
		// Untouched statements stay byte-identical
		expect(output).toContain("INSERT INTO main.languages (id, name) VALUES");
		expect(output).toContain("CREATE TRIGGER languages_updated_at_trigger AFTER UPDATE ON languages");
		// File only differs inside the languages CREATE TABLE
		const diff_size = Math.abs(output.length - source.length);
		expect(diff_size).toBeLessThan(60);
	});

	test("new table gets drop, create, index and trigger spliced in", () => {
		const path = "sql/sqlite/demos/05-frameworks.sql";
		const source = readFileSync(join(REPO_ROOT, path), "utf-8");
		const model = parse_ddl_file(source, path, "sqlite");

		const table = make_default_table("tags", "sqlite");
		model.statements.push({
			gap: "",
			kind: "create_table",
			object_name: "tags",
			text: "",
			table,
			is_new: true,
		});

		const output = serialize_studio_file(model);
		expect(output).toContain("DROP TABLE IF EXISTS tags;");
		expect(output).toContain("CREATE TABLE tags (\n    id         INTEGER   PRIMARY KEY,");
		expect(output).toContain("CREATE INDEX tags_name ON tags(name);");
		expect(output).toContain("CREATE TRIGGER tags_updated_at_trigger");
		// Drop sits immediately before the create, 05-frameworks interleaved style
		expect(output).toContain("DROP TABLE IF EXISTS tags;\n\nCREATE TABLE tags");
		// Create goes after the last table statement, before the view
		expect(output.indexOf("CREATE TABLE tags")).toBeGreaterThan(output.indexOf("INSERT INTO main.frameworks"));
		expect(output.indexOf("CREATE TABLE tags")).toBeLessThan(output.indexOf("CREATE VIEW v_frameworks"));
	});

	test("mysql new table has ON UPDATE and no trigger", () => {
		const path = "sql/mysql/demos/05-frameworks.sql";
		const source = readFileSync(join(REPO_ROOT, path), "utf-8");
		const model = parse_ddl_file(source, path, "mysql");

		const table = make_default_table("tags", "mysql");
		model.statements.push({ gap: "", kind: "create_table", object_name: "tags", text: "", table, is_new: true });

		const output = serialize_studio_file(model);
		expect(output).toContain("updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
		expect(output).not.toContain("tags_updated_at_trigger");
	});
});

describe("default table template", () => {
	test("sqlite template matches 05-frameworks developers style", () => {
		const table = make_default_table("developers", "sqlite");
		const ddl = render_create_table(table, "sqlite");
		expect(ddl).toBe(`CREATE TABLE developers (
    id         INTEGER   PRIMARY KEY,
    name       TEXT      DEFAULT '',
    display    TEXT      GENERATED ALWAYS AS (name) VIRTUAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`);
	});

	test("mysql template matches 05-frameworks developers style", () => {
		const table = make_default_table("developers", "mysql");
		const ddl = render_create_table(table, "mysql");
		expect(ddl).toBe(`CREATE TABLE developers (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(255) NOT NULL DEFAULT '',
    display    VARCHAR(255) GENERATED ALWAYS AS (name) VIRTUAL,
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);`);
	});
});
