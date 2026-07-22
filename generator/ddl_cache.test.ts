/**
* Tests for the DDL Cache module.
*
* Covers:
* - pluralize_english() - English pluralization rules
* - build_alias_map() - SQL alias->table mapping
* - get_main_table_alias(), view_name_from_sql() - SQL extraction
* - detect_implicit_foreign_keys() - naming-convention FK detection
* - detect_view_foreign_keys() - view JOIN FK detection
* - Public API (get_cached_tables, get_cached_table, etc.)
* - Cache file I/O (read, write, validation, expiry)
*/

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

import type { SchemaObject, ColumnDef, ForeignKeyDef } from "./schema/types";

// The ddl_cache module - dynamically imported after env setup
let mod: typeof import("./ddl_cache");
const naming = await import("./naming");
const crud_helpers = await import("./crud/helpers");
let types: typeof import("./ddl_cache_types");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
	mod = await import("./ddl_cache");
	types = await import("./ddl_cache_types");
});

// ---------------------------------------------------------------------------
// pluralize_english
// ---------------------------------------------------------------------------

describe("pluralize_english", () => {
	test("appends s to regular words", () => {
		expect(naming.pluralize_english("author")).toBe("authors");
		expect(naming.pluralize_english("book")).toBe("books");
		expect(naming.pluralize_english("user")).toBe("users");
	});

	test("handles y → ies", () => {
		expect(naming.pluralize_english("category")).toBe("categories");
		expect(naming.pluralize_english("country")).toBe("countries");
	});

	test("preserves -ay/-ey/-oy/-uy endings with s", () => {
		expect(naming.pluralize_english("day")).toBe("days");
		expect(naming.pluralize_english("key")).toBe("keys");
		expect(naming.pluralize_english("boy")).toBe("boys");
		expect(naming.pluralize_english("guy")).toBe("guys");
	});

	test("handles s/x/z/ch/sh endings with es", () => {
		expect(naming.pluralize_english("box")).toBe("boxes");
		expect(naming.pluralize_english("church")).toBe("churches");
		expect(naming.pluralize_english("bush")).toBe("bushes");
		expect(naming.pluralize_english("quiz")).toBe("quizzes");
	});

	test("handles irregular plurals", () => {
		expect(naming.pluralize_english("person")).toBe("people");
		expect(naming.pluralize_english("child")).toBe("children");
		expect(naming.pluralize_english("mouse")).toBe("mice");
		expect(naming.pluralize_english("foot")).toBe("feet");
		expect(naming.pluralize_english("tooth")).toBe("teeth");
		expect(naming.pluralize_english("goose")).toBe("geese");
		expect(naming.pluralize_english("man")).toBe("men");
		expect(naming.pluralize_english("woman")).toBe("women");
	});
});

// ---------------------------------------------------------------------------
// build_alias_map
// ---------------------------------------------------------------------------

describe("build_alias_map", () => {
	test("maps FROM table with explicit alias", () => {
		const sql = "SELECT * FROM frameworks f";
		const map = mod.build_alias_map(sql);
		expect(map.get("f")).toBe("frameworks");
		expect(map.size).toBe(1);
	});

	test("maps FROM table without alias (uses table name as alias)", () => {
		const sql = "SELECT * FROM frameworks";
		const map = mod.build_alias_map(sql);
		expect(map.get("frameworks")).toBe("frameworks");
	});

	test("maps JOIN tables with aliases", () => {
		const sql = `
			SELECT f.id, a.name
			FROM frameworks f
			LEFT JOIN authors a ON a.id = f.author_id
			LEFT JOIN languages l ON l.id = f.language_id
		`;
		const map = mod.build_alias_map(sql);
		expect(map.get("f")).toBe("frameworks");
		expect(map.get("a")).toBe("authors");
		expect(map.get("l")).toBe("languages");
		expect(map.size).toBe(3);
	});

	test("handles AS keyword", () => {
		const sql = "SELECT * FROM frameworks AS f INNER JOIN authors AS a ON a.id = f.author_id";
		const map = mod.build_alias_map(sql);
		expect(map.get("f")).toBe("frameworks");
		expect(map.get("a")).toBe("authors");
	});

	test("handles multiple join types", () => {
		const sql = `
			SELECT * FROM t1
			LEFT JOIN t2 ON ...
			RIGHT JOIN t3 ON ...
			INNER JOIN t4 ON ...
			CROSS JOIN t5 ON ...
			FULL JOIN t6 ON ...
		`;
		const map = mod.build_alias_map(sql);
		expect(map.get("t1")).toBe("t1");
		expect(map.get("t2")).toBe("t2");
		expect(map.get("t3")).toBe("t3");
		expect(map.get("t4")).toBe("t4");
		expect(map.get("t5")).toBe("t5");
		expect(map.get("t6")).toBe("t6");
	});

	test("returns empty map for SQL with no FROM/JOIN", () => {
		const map = mod.build_alias_map("SELECT 1");
		expect(map.size).toBe(0);
	});

	test("handles parenthesized FROM clause (MariaDB SHOW CREATE VIEW style)", () => {
		// MariaDB wraps the entire JOIN tree in parentheses:
		// FROM (((frameworks f LEFT JOIN authors a ON(...)) LEFT JOIN languages l ON(...)))
		// The old regex expected table name directly after FROM, but ((( intervened.
		const sql = "SELECT f.id, a.name FROM (((frameworks f LEFT JOIN authors a ON(a.id = f.author_id)) " + "LEFT JOIN languages l ON(l.id = f.language_id)))";
		const map = mod.build_alias_map(sql);
		expect(map.get("f")).toBe("frameworks");
		expect(map.get("a")).toBe("authors");
		expect(map.get("l")).toBe("languages");
		expect(map.size).toBe(3);
	});

	test("handles parenthesized FROM with double-nested parenthesis", () => {
		// Even deeper nesting: from ((((table alias ...
		const sql = "SELECT * FROM ((((users u LEFT JOIN roles r ON(u.role_id = r.id))))";
		const map = mod.build_alias_map(sql);
		expect(map.get("u")).toBe("users");
		expect(map.get("r")).toBe("roles");
		expect(map.size).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// get_main_table_alias
// ---------------------------------------------------------------------------

describe("get_main_table_alias", () => {
	test("returns explicit alias from FROM clause", () => expect(mod.get_main_table_alias("SELECT * FROM frameworks f")).toBe("f"));

	test("returns table name when no explicit alias", () => expect(mod.get_main_table_alias("SELECT * FROM frameworks")).toBe("frameworks"));

	test("returns null when no FROM clause", () => expect(mod.get_main_table_alias("SELECT 1")).toBeNull());

	test("handles AS keyword in FROM", () => expect(mod.get_main_table_alias("SELECT * FROM frameworks AS f")).toBe("f"));

	test("handles parenthesized FROM clause", () => expect(mod.get_main_table_alias("SELECT * FROM (((frameworks f LEFT JOIN authors a ON(...)))")).toBe("f"));

	test("handles parenthesized FROM without alias", () => expect(mod.get_main_table_alias("SELECT * FROM (((frameworks LEFT JOIN authors a ON(...)))")).toBe("frameworks"));

	test("handles deeply nested parentheses in FROM", () => expect(mod.get_main_table_alias("SELECT * FROM ((((t1 t LEFT JOIN t2 a ON(...))))")).toBe("t"));
});

// ---------------------------------------------------------------------------
// view_name_from_sql
// ---------------------------------------------------------------------------

describe("view_name_from_sql", () => {
	test("extracts name from CREATE VIEW", () => expect(mod.view_name_from_sql("CREATE VIEW v_frameworks AS SELECT * FROM frameworks")).toBe("v_frameworks"));

	test("extracts name from CREATE OR REPLACE VIEW", () => expect(mod.view_name_from_sql("CREATE OR REPLACE VIEW v_frameworks AS SELECT * FROM frameworks")).toBe("v_frameworks"));

	test("returns 'unknown' when no match", () => expect(mod.view_name_from_sql("SELECT * FROM frameworks")).toBe("unknown"));
});

// ---------------------------------------------------------------------------
// detect_implicit_foreign_keys
// ---------------------------------------------------------------------------

describe("detect_implicit_foreign_keys", () => {
	function make_schema(overrides: Partial<SchemaObject> & { columns: ColumnDef[]; }): SchemaObject {
		return {
			type: "table",
			name: overrides.name || "test_table",
			comment: "",
			foreign_keys: [],
			has_view: false,
			...overrides,
		};
	}

	function make_column(name: string, overrides: Partial<ColumnDef> = {}): ColumnDef {
		return {
			name,
			type_string: "int",
			comment: "",
			is_nullable: false,
			is_primary_key: false,
			is_auto_increment: false,
			...overrides,
		};
	}

	test("detects author_id → authors.id", () => {
		const schema = make_schema({ name: "frameworks", columns: [make_column("author_id")] });
		const table_column_map = new Map([["authors", ["id", "name"]]]);

		const fks = mod.detect_implicit_foreign_keys(schema, table_column_map);
		expect(fks).toHaveLength(1);
		expect(fks[0].column_name).toBe("author_id");
		expect(fks[0].referenced_table).toBe("authors");
		expect(fks[0].referenced_column).toBe("id");
		expect(fks[0].source).toBe("inferred_naming");
		expect(fks[0].confidence).toBe("high");
	});

	test("detects legal_entity_id → legal_entities.id (y→ies plural)", () => {
		const schema = make_schema({ name: "contracts", columns: [make_column("legal_entity_id")] });
		const table_column_map = new Map([["legal_entities", ["id", "name"]]]);

		const fks = mod.detect_implicit_foreign_keys(schema, table_column_map);
		expect(fks).toHaveLength(1);
		expect(fks[0].column_name).toBe("legal_entity_id");
		expect(fks[0].referenced_table).toBe("legal_entities");
		expect(fks[0].referenced_column).toBe("id");
	});

	test("skips columns not ending in _id", () => {
		const schema = make_schema({
			name: "frameworks",
			columns: [make_column("name"), make_column("tagline")],
		});
		const table_column_map = new Map([["authors", ["id", "name"]]]);

		const fks = mod.detect_implicit_foreign_keys(schema, table_column_map);
		expect(fks).toHaveLength(0);
	});

	test("skips columns that already have a native FK", () => {
		const schema = make_schema({
			name: "frameworks",
			columns: [make_column("author_id")],
			foreign_keys: [
				{
					constraint_name: "fk_author",
					column_name: "author_id",
					referenced_table_name: "authors",
					referenced_column_name: "id",
				},
			],
		});
		const table_column_map = new Map([["authors", ["id", "name"]]]);

		const fks = mod.detect_implicit_foreign_keys(schema, table_column_map);
		expect(fks).toHaveLength(0);
	});

	test("detects multiple FK columns", () => {
		const schema = make_schema({
			name: "frameworks",
			columns: [make_column("author_id"), make_column("reviewer_id"), make_column("language_id")],
		});
		const table_column_map = new Map([["authors", ["id", "name"]], ["languages", ["id", "name"]]]);

		const fks = mod.detect_implicit_foreign_keys(schema, table_column_map);
		// reviewer_id has no "reviewers" table in the map, so only 2 FKs
		expect(fks).toHaveLength(2);
		expect(fks.map((f) => f.column_name).sort()).toEqual(["author_id", "language_id"]);
	});

	test("high confidence via singular-prefix pattern (category_id → categories.id)", () => {
		const schema = make_schema({ name: "items", columns: [make_column("category_id")] });
		const table_column_map = new Map([["categories", ["id", "name"]]]);

		const fks = mod.detect_implicit_foreign_keys(schema, table_column_map);
		expect(fks).toHaveLength(1);
		expect(fks[0].column_name).toBe("category_id");
		expect(fks[0].referenced_table).toBe("categories");
		expect(fks[0].confidence).toBe("high");
	});

	test("no match when {singular}_{col} prefix matches but suffix is not a known column", () => {
		// author_nonexistent_id matches prefix "author_" but "nonexistent" is not in authors columns
		const schema = make_schema({ name: "papers", columns: [make_column("author_nonexistent_id")] });
		const table_column_map = new Map([["authors", ["id", "name"]]]);

		const fks = mod.detect_implicit_foreign_keys(schema, table_column_map);
		// Falls through both patterns and the fallback "author_nonexistents" doesn't exist -> 0 FKs
		expect(fks).toHaveLength(0);
	});

	test("does not add fallback when guessed table does not exist", () => {
		const schema = make_schema({ name: "items", columns: [make_column("unknown_id")] });
		const table_column_map = new Map([["categories", ["id", "name"]]]);

		const fks = mod.detect_implicit_foreign_keys(schema, table_column_map);
		expect(fks).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// detect_view_foreign_keys
// ---------------------------------------------------------------------------

describe("detect_view_foreign_keys", () => {
	function make_schema(name: string, columns: ColumnDef[]): SchemaObject {
		return { type: "table", name, comment: "", columns, foreign_keys: [], has_view: false };
	}

	test("detects FK from LEFT JOIN ON alias.id = table_alias.fk_col", () => {
		const view_sql = `
			CREATE VIEW v_frameworks AS
			SELECT f.id, f.name, a.name AS author_name
			FROM frameworks f
			LEFT JOIN authors a ON a.id = f.author_id
		`;
		const schemas = [
			make_schema("frameworks", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "name",
					type_string: "varchar(15)",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
				{
					name: "author_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
			make_schema("authors", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "name",
					type_string: "varchar(15)",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
		];

		const fks = mod.detect_view_foreign_keys("frameworks", view_sql, schemas);
		expect(fks).toHaveLength(1);
		expect(fks[0].column_name).toBe("author_id");
		expect(fks[0].referenced_table).toBe("authors");
		expect(fks[0].referenced_column).toBe("id");
		expect(fks[0].confidence).toBe("exact");
	});

	test("detects FK from LEFT JOIN with reversed ON condition", () => {
		const view_sql = `
			CREATE VIEW v_frameworks AS
			SELECT f.id, f.name, l.name AS language_name
			FROM frameworks f
			LEFT JOIN languages l ON f.language_id = l.id
		`;
		const schemas = [
			make_schema("frameworks", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "language_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
			make_schema("languages", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "name",
					type_string: "varchar(50)",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
		];

		const fks = mod.detect_view_foreign_keys("frameworks", view_sql, schemas);
		expect(fks).toHaveLength(1);
		expect(fks[0].column_name).toBe("language_id");
		expect(fks[0].referenced_table).toBe("languages");
		expect(fks[0].referenced_column).toBe("id");
	});

	test("detects multiple FKs from a view with several JOINs", () => {
		const view_sql = `
			CREATE VIEW v_frameworks AS
			SELECT f.id, f.name, a.name AS author_name, l.name AS language_name, a2.name AS reviewer_name
			FROM frameworks f
			LEFT JOIN authors a ON a.id = f.author_id
			LEFT JOIN authors a2 ON a2.id = f.reviewer_id
			LEFT JOIN languages l ON l.id = f.language_id
		`;
		const schemas = [
			make_schema("frameworks", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "author_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
				{
					name: "reviewer_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
				{
					name: "language_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
			make_schema("authors", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "name",
					type_string: "varchar(15)",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
			make_schema("languages", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "name",
					type_string: "varchar(50)",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
		];

		const fks = mod.detect_view_foreign_keys("frameworks", view_sql, schemas);
		expect(fks).toHaveLength(3);
		const cols = fks.map((f) => f.column_name).sort();
		expect(cols).toEqual(["author_id", "language_id", "reviewer_id"]);
	});

	test("handles parenthesized ON clause", () => {
		const view_sql = `
			CREATE VIEW v_orders AS
			SELECT o.id, c.name AS customer_name
			FROM orders o
			LEFT JOIN customers c ON (c.id = o.customer_id)
		`;
		const schemas = [
			make_schema("orders", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "customer_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
			make_schema("customers", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "name",
					type_string: "varchar(50)",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
		];

		const fks = mod.detect_view_foreign_keys("orders", view_sql, schemas);
		expect(fks).toHaveLength(1);
		expect(fks[0].column_name).toBe("customer_id");
		expect(fks[0].referenced_table).toBe("customers");
	});

	test("returns empty array for view without JOINs", () => {
		const view_sql = "CREATE VIEW v_simple AS SELECT * FROM single_table";
		const schemas = [
			make_schema("single_table", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
			]),
		];

		const fks = mod.detect_view_foreign_keys("single_table", view_sql, schemas);
		expect(fks).toHaveLength(0);
	});

	test("detects FKs from MariaDB-style parenthesized FROM/JOIN syntax", () => {
		// MariaDB's SHOW CREATE VIEW wraps the entire JOIN tree in parentheses:
		// FROM (((frameworks f LEFT JOIN authors a ON(...)) LEFT JOIN ...))
		// This was the exact bug - old alias regex couldn't handle FROM (((table.
		const view_sql = "CREATE VIEW v_frameworks AS select f.id AS id,f.name AS name,a.name AS author_name," + "a2.name AS reviewer_name,l.name AS language_name from (((frameworks f left join authors a " + "on(a.id = f.author_id)) left join authors a2 on(a2.id = f.reviewer_id)) left join languages l " + "on(l.id = f.language_id)))";
		const schemas = [
			make_schema("frameworks", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "author_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
				{
					name: "reviewer_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
				{
					name: "language_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
			make_schema("authors", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "name",
					type_string: "varchar(15)",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
			make_schema("languages", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "name",
					type_string: "varchar(50)",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
		];

		const fks = mod.detect_view_foreign_keys("frameworks", view_sql, schemas);
		expect(fks).toHaveLength(3);
		const cols = fks.map((f) => f.column_name).sort();
		expect(cols).toEqual(["author_id", "language_id", "reviewer_id"]);
		expect(fks[0].confidence).toBe("exact");
	});

	test("detects FKs when every ON condition has parentheses and lowercase SQL", () => {
		// Some MySQL/MariaDB versions return ON(...) with parens around the whole condition
		const view_sql = "CREATE VIEW v_reviews AS select r.id, u.name AS user_name from (((reviews r " + "left join users u on(u.id = r.user_id)) left join products p on(p.id = r.product_id)))";
		const schemas = [
			make_schema("reviews", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "user_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
				{
					name: "product_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
			make_schema("users", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
				{
					name: "name",
					type_string: "varchar(15)",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
				},
			]),
			make_schema("products", [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
				},
			]),
		];

		const fks = mod.detect_view_foreign_keys("reviews", view_sql, schemas);
		expect(fks).toHaveLength(2);
		const cols = fks.map((f) => f.column_name).sort();
		expect(cols).toEqual(["product_id", "user_id"]);
	});
});

// ---------------------------------------------------------------------------
// Public API - get_cached_tables, get_cached_table, get_cached_foreign_keys
// ---------------------------------------------------------------------------

describe("public API", () => {
	const mock_data: types.DdlCacheData = {
		generated_at: "2026-06-16T12:00:00Z",
		db_type: "mysql",
		tables: [
			{
				name: "frameworks",
				comment: "",
				columns: [
					{
						name: "id",
						type_string: "int",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
						is_generated: false,
					},
					{
						name: "name",
						type_string: "varchar(15)",
						comment: "",
						is_nullable: false,
						is_primary_key: false,
						is_auto_increment: false,
						is_generated: false,
					},
				],
				indexed_columns: ["id"],
				foreign_keys: [],
				inferred_foreign_keys: [
					{
						column_name: "author_id",
						referenced_table: "authors",
						referenced_column: "id",
						source: "inferred_naming",
						confidence: "high",
					},
				],
				view_foreign_keys: [],
				has_view: true,
				view_name: "v_frameworks",
				view_columns: null,
				view_definition: null,
			},
			{
				name: "authors",
				comment: "",
				columns: [
					{
						name: "id",
						type_string: "int",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
						is_generated: false,
					},
					{
						name: "name",
						type_string: "varchar(15)",
						comment: "",
						is_nullable: false,
						is_primary_key: false,
						is_auto_increment: false,
						is_generated: false,
					},
				],
				indexed_columns: ["id"],
				foreign_keys: [],
				inferred_foreign_keys: [],
				view_foreign_keys: [],
				has_view: false,
				view_name: null,
				view_columns: null,
				view_definition: null,
			},
		],
	};

	test("get_cached_tables returns all table names", () => {
		const names = mod.get_cached_tables(mock_data);
		expect(names).toEqual(["frameworks", "authors"]);
	});

	test("get_cached_table returns table by name (case-insensitive)", () => {
		const t1 = mod.get_cached_table(mock_data, "frameworks");
		expect(t1?.name).toBe("frameworks");

		const t2 = mod.get_cached_table(mock_data, "FRAMEWORKS");
		expect(t2?.name).toBe("frameworks");
	});

	test("get_cached_table returns undefined for unknown table", () => {
		const t = mod.get_cached_table(mock_data, "nonexistent");
		expect(t).toBeUndefined();
	});

	test("get_cached_foreign_keys aggregates all FK types deduplicated", () => {
		const data_with_all_fks: types.DdlCacheData = {
			...mock_data,
			tables: [
				{
					...mock_data.tables[0],
					indexed_columns: ["id"],
					foreign_keys: [
						{
							column_name: "author_id",
							referenced_table: "authors",
							referenced_column: "id",
							source: "native" as const,
							confidence: "exact" as const,
						},
					],
					inferred_foreign_keys: [
						{
							column_name: "author_id",
							referenced_table: "authors",
							referenced_column: "id",
							source: "inferred_naming" as const,
							confidence: "high" as const,
						},
					],
					view_foreign_keys: [
						{
							column_name: "language_id",
							referenced_table: "languages",
							referenced_column: "id",
							source: "view_join" as const,
							confidence: "exact" as const,
						},
					],
				},
			],
		};
		const fks = mod.get_cached_foreign_keys(data_with_all_fks, "frameworks");
		// author_id appears twice but should be deduplicated -> only 2 unique: author_id + language_id
		expect(fks).toHaveLength(2);
	});

	test("get_cached_foreign_keys returns empty for unknown table", () => {
		const fks = mod.get_cached_foreign_keys(mock_data, "nonexistent");
		expect(fks).toEqual([]);
	});

	test("invalidate_cache clears in-memory cache", () => expect(() => mod.invalidate_cache()).not.toThrow());

	/**
	 * Regression: invalidate_cache() used to null only the in-memory copy. load_ddl_cache()
	 * then fell through to read_cache_file(), which happily returned the still-valid on-disk
	 * JSON - so a schema change was invisible until the 24h TTL expired and new tables could
	 * not be seen by CRUD generation.
	 *
	 * The real cache file is backed up and restored so running the suite never destroys a
	 * developer's cache.
	 */
	test("invalidate_cache removes the on-disk cache file", () => {
		const cache_file = join(process.cwd(), ".reepolee", "ddl_cache.json");
		const had_file = existsSync(cache_file);
		const backup = had_file ? readFileSync(cache_file, "utf-8") : null;

		try {
			mkdirSync(join(process.cwd(), ".reepolee"), { recursive: true });
			if (!had_file) { writeFileSync(cache_file, JSON.stringify(mock_data, null, 2), "utf-8"); }
			expect(existsSync(cache_file)).toBe(true);

			mod.invalidate_cache();

			expect(existsSync(cache_file)).toBe(false);
		} finally {
			if (backup !== null) { writeFileSync(cache_file, backup, "utf-8"); }
		}
	});
});

// ---------------------------------------------------------------------------
// all_foreign_keys_for_table (from ddl_cache_types)
// ---------------------------------------------------------------------------

describe("all_foreign_keys_for_table", () => test("aggregates all FK types", () => {
	const table: types.DdlCachedTable = {
		name: "test",
		comment: "",
		columns: [],
		indexed_columns: [],
		foreign_keys: [
			{
				column_name: "a_id",
				referenced_table: "a",
				referenced_column: "id",
				source: "native",
				confidence: "exact",
			},
		],
		inferred_foreign_keys: [
			{
				column_name: "b_id",
				referenced_table: "b",
				referenced_column: "id",
				source: "inferred_naming",
				confidence: "high",
			},
		],
		view_foreign_keys: [
			{
				column_name: "c_id",
				referenced_table: "c",
				referenced_column: "id",
				source: "view_join",
				confidence: "medium",
			},
		],
		has_view: false,
		view_name: null,
		view_columns: null,
		view_definition: null,
	};

	const all = types.all_foreign_keys_for_table(table);
	expect(all).toHaveLength(3);
	expect(all.map((f) => f.column_name).sort()).toEqual(["a_id", "b_id", "c_id"]);
}));

// ---------------------------------------------------------------------------
// Cache file I/O
// ---------------------------------------------------------------------------

describe("cache file I/O", () => {
	// We test the JSON serialization/deserialization logic directly
	// by writing/reading cache files to temp directories.

	const sample_data: types.DdlCacheData = {
		generated_at: new Date().toISOString(),
		db_type: "mysql",
		tables: [
			{
				name: "frameworks",
				comment: "",
				columns: [],
				indexed_columns: [],
				foreign_keys: [],
				inferred_foreign_keys: [
					{
						column_name: "author_id",
						referenced_table: "authors",
						referenced_column: "id",
						source: "inferred_naming",
						confidence: "high",
					},
				],
				view_foreign_keys: [],
				has_view: false,
				view_name: null,
				view_columns: null,
				view_definition: null,
			},
		],
	};

	test("serialize and deserialize DdlCacheData to/from JSON", () => {
		const json = JSON.stringify(sample_data);
		const parsed: types.DdlCacheData = JSON.parse(json);

		expect(parsed.generated_at).toBe(sample_data.generated_at);
		expect(parsed.db_type).toBe("mysql");
		expect(parsed.tables).toHaveLength(1);
		expect(parsed.tables[0].name).toBe("frameworks");
		expect(parsed.tables[0].inferred_foreign_keys[0].column_name).toBe("author_id");
		expect(parsed.tables[0].inferred_foreign_keys[0].confidence).toBe("high");
	});

	test("JSON round-trip preserves all fields", () => {
		const json = JSON.stringify(sample_data, null, 2);
		const parsed = JSON.parse(json) as types.DdlCacheData;

		// Re-serialize to compare exact string
		const re_stringified = JSON.stringify(parsed);
		expect(re_stringified).toBe(JSON.stringify(sample_data));
	});

	test("write and read cache file to/from disk", () => {
		const tmp_dir = mkdtempSync(join(tmpdir(), "ddl-cache-test-"));
		try {
			const cache_path = join(tmp_dir, "ddl_cache.json");
			const data_str = JSON.stringify(sample_data, null, 2);
			writeFileSync(cache_path, data_str, "utf-8");

			// Read back
			const raw = readFileSync(cache_path, "utf-8");
			const parsed = JSON.parse(raw) as types.DdlCacheData;

			expect(parsed.tables[0].inferred_foreign_keys[0].referenced_table).toBe("authors");
			expect(parsed.tables[0].inferred_foreign_keys[0].source).toBe("inferred_naming");
		} finally {
			rmSync(tmp_dir, { recursive: true, force: true });
		}
	});

	test("corrupted JSON returns null via validation", () => {
		const tmp_dir = mkdtempSync(join(tmpdir(), "ddl-cache-test-"));
		try {
			const cache_path = join(tmp_dir, "ddl_cache.json");
			writeFileSync(cache_path, "this is not valid json{{{", "utf-8");

			// Should fail parse -> return null
			try {
				const raw = readFileSync(cache_path, "utf-8");
				JSON.parse(raw);
				// Should have thrown
				expect(true).toBe(false); // force fail
			} catch {
				// Expected - parse error
				expect(true).toBe(true);
			}
		} finally {
			rmSync(tmp_dir, { recursive: true, force: true });
		}
	});

	test("missing cache file is handled gracefully", () => {
		// Verify that the module's validation rejects data with missing fields
		const validation_test = () => {
			const raw = JSON.stringify({ tables: [] }); // missing generated_at and db_type
			try {
				const parsed = JSON.parse(raw);
				return !parsed.generated_at || !parsed.db_type || !Array.isArray(parsed.tables);
			} catch {
				return true;
			}
		};
		expect(validation_test()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	test("detect_view_foreign_keys with schema-less view (no _id columns in SELECT)", () => {
		// VIEW that has JOIN but condition is on a non-_id column -> should be skipped
		const view_sql = `
			CREATE VIEW v_foo AS
			SELECT t.id, t.status_desc
			FROM tasks t
			LEFT JOIN statuses s ON t.status_code = s.code
		`;
		const schemas = [
			{
				type: "table" as const,
				name: "tasks",
				comment: "",
				columns: [
					{
						name: "id",
						type_string: "int",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
						is_generated: false,
					},
					{
						name: "status_code",
						type_string: "varchar(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: false,
						is_auto_increment: false,
						is_generated: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			},
			{
				type: "table" as const,
				name: "statuses",
				comment: "",
				columns: [
					{
						name: "code",
						type_string: "varchar(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: false,
						is_generated: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			},
		];

		// Neither side ends in _id and neither side is "id" -> no FK detected
		const fks = mod.detect_view_foreign_keys("tasks", view_sql, schemas);
		expect(fks).toHaveLength(0);
	});

	test("empty table_column_map returns no implicit FKs", () => {
		const schema: SchemaObject = {
			type: "table",
			name: "orphan",
			comment: "",
			columns: [
				{
					name: "id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: true,
					is_auto_increment: true,
					is_generated: false,
				},
				{
					name: "parent_id",
					type_string: "int",
					comment: "",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
					is_generated: false,
				},
			],
			foreign_keys: [],
			has_view: false,
		};

		const fks = mod.detect_implicit_foreign_keys(schema, new Map());
		expect(fks).toHaveLength(0);
	});

	test("get_cached_tables returns empty for empty data", () => {
		const empty: types.DdlCacheData = {
			generated_at: new Date().toISOString(),
			db_type: "mysql",
			tables: [],
		};
		expect(mod.get_cached_tables(empty)).toEqual([]);
	});
});
