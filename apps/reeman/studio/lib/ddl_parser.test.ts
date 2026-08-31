import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse_column, parse_ddl_file, split_statements } from "./ddl_parser";
import { serialize_studio_file } from "./ddl_writer";
import type { Dialect } from "./types";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

const SAMPLE_FILES: { path: string; dialect: Dialect; }[] = [
	{ path: "sql/sqlite/demos/05-frameworks.sql", dialect: "sqlite" },
	{ path: "sql/mysql/demos/05-frameworks.sql", dialect: "mysql" },
	{ path: "sql/sqlite/demos/06-init-books.sql", dialect: "sqlite" },
	{ path: "sql/mysql/demos/06-init-books.sql", dialect: "mysql" },
];

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
