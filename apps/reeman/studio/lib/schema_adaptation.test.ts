import { describe, expect, test } from "bun:test";

import { adapt_schema_to_standard, find_dangling_id_columns } from "./schema_adaptation";
import type { StudioColumn, StudioFile, StudioTable } from "./types";

describe("adapt_schema_to_standard", () => {
	test("leaves a table that already matches the standard shape untouched", () => {
		const model: StudioFile = {
			path: "example.sql",
			dialect: "sqlite",
			trailing: "\n",
			statements: [{ gap: "", kind: "create_table", object_name: "authors", text: "", table: table("authors", ["id", "display", "created_at", "updated_at"]) }],
		};
		const summary = adapt_schema_to_standard(model);
		expect(summary.tables_adapted).toEqual([]);
		expect(summary.references_updated).toEqual([]);
	});

	test("adds missing display, created_at, updated_at to a table with an integer id", () => {
		const model: StudioFile = {
			path: "example.sql",
			dialect: "sqlite",
			trailing: "\n",
			statements: [{ gap: "", kind: "create_table", object_name: "authors", text: "", table: table("authors", ["id", "name"]) }],
		};
		const summary = adapt_schema_to_standard(model);
		expect(summary.tables_adapted).toEqual(["authors"]);
		const authors = model.statements[0]!.table!;
		expect(authors.columns.map((column) => column.name)).toEqual(["id", "name", "display", "created_at", "updated_at"]);
		const display = authors.columns.find((column) => column.name === "display")!;
		expect(display.generated_expr).toBe("name");
	});

	test("renames a non-integer primary key to code, adds a new integer id, and repoints referencing FKs", () => {
		const model: StudioFile = {
			path: "example.sql",
			dialect: "sqlite",
			trailing: "\n",
			statements: [
				{ gap: "", kind: "create_table", object_name: "languages", text: "", table: varchar_pk_table("languages", "iso_code", ["name"]) },
				{
					gap: "\n\n",
					kind: "create_table",
					object_name: "books",
					text: "",
					table: {
						name: "books",
						table_foreign_keys: [],
						table_unique_keys: [],
						table_suffix_raw: "",
						columns: [
							column_of("id", "INTEGER", { is_primary_key: true }),
							column_of("language_iso_code", "TEXT", { references: { table: "languages", column: "iso_code" } }),
							column_of("display", "TEXT", { is_generated: true, generated_expr: "id" }),
							column_of("created_at", "TIMESTAMP", {}),
							column_of("updated_at", "TIMESTAMP", {}),
						],
					},
				},
			],
		};

		const summary = adapt_schema_to_standard(model);
		expect(summary.tables_adapted).toEqual(["languages"]);
		expect(summary.references_updated).toEqual(["books.language_iso_code -> languages.id"]);

		const languages = model.statements[0]!.table!;
		expect(languages.columns.map((column) => column.name)).toEqual(["id", "code", "name", "display", "created_at", "updated_at"]);
		const code_column = languages.columns.find((column) => column.name === "code")!;
		expect(code_column.is_primary_key).toBe(false);
		expect(code_column.is_unique).toBe(true);
		const id_column = languages.columns.find((column) => column.name === "id")!;
		expect(id_column.is_primary_key).toBe(true);

		const books = model.statements[1]!.table!;
		const fk_column = books.columns.find((column) => column.name === "language_iso_code")!;
		expect(fk_column.references).toEqual({ table: "languages", column: "id" });
	});

	test("leaves a view without a display column untouched", () => {
		// Views are never rewritten - display columns are optional and the
		// generator works off natural string columns when they are absent.
		const text = [
			"CREATE VIEW v_judging_points AS",
			"SELECT",
			"    t.id,",
			"    t.title,",
			"    p.category_id,",
			"    p.rank,",
			"    p.points",
			"FROM points p",
			"    LEFT JOIN teams t",
			"        ON t.id = p.team_id",
			"ORDER BY p.category_id ASC, p.rank ASC;",
		].join("\n");
		const model = view_model(text, "v_judging_points");

		const summary = adapt_schema_to_standard(model);
		expect(summary.views_adapted).toEqual([]);
		expect(model.statements[0]!.text).toBe(text);
	});

	test("leaves a v_<table> companion view untouched", () => {
		// Companion views are no longer regenerated to force <stem>_display
		// columns - display columns are optional and used only when present.
		const model: StudioFile = {
			path: "example.sql",
			dialect: "sqlite",
			trailing: "\n",
			statements: [
				{ gap: "", kind: "create_table", object_name: "teams", text: "", table: table("teams", ["id", "title"]) },
				{
					gap: "\n\n",
					kind: "create_table",
					object_name: "schedule",
					text: "",
					table: {
						name: "schedule",
						table_foreign_keys: [],
						table_unique_keys: [],
						table_suffix_raw: "",
						columns: [
							column_of("id", "INTEGER", { is_primary_key: true }),
							column_of("team_1_id", "INTEGER", { references: { table: "teams", column: "id" } }),
						],
					},
				},
				{ gap: "\n\n", kind: "create_view", object_name: "v_schedule", text: "CREATE VIEW v_schedule AS\nSELECT s.*\nFROM schedule s;" },
			],
		};

		const summary = adapt_schema_to_standard(model);
		expect(summary.views_adapted).toEqual([]);
		expect(model.statements[2]!.text).toBe("CREATE VIEW v_schedule AS\nSELECT s.*\nFROM schedule s;");
	});

	test("leaves a view that already projects display untouched", () => {
		const text = "CREATE VIEW v_teams AS\nSELECT t.id, t.display\nFROM teams t;";
		const model = view_model(text, "v_teams");

		const summary = adapt_schema_to_standard(model);
		expect(summary.views_adapted).toEqual([]);
		expect(model.statements[0]!.text).toBe(text);
	});

	test("leaves a view with an aliased column untouched", () => {
		const text = "CREATE VIEW v_last_entry AS\nSELECT t.id, MAX(g.ts) AS name\nFROM teams t;";
		const model = view_model(text, "v_last_entry");

		const summary = adapt_schema_to_standard(model);
		expect(summary.views_adapted).toEqual([]);
		expect(model.statements[0]!.text).toBe(text);
	});

	test("leaves an aggregate-only view untouched", () => {
		const text = [
			"CREATE VIEW v_judging_points_for_display AS",
			"SELECT",
			"    id,",
			"    MAX(CASE WHEN category_id = 'cv' THEN points END) AS cv_points",
			"FROM v_judging_points",
			"GROUP BY id;",
		].join("\n");
		const model = view_model(text, "v_judging_points_for_display");

		const summary = adapt_schema_to_standard(model);
		expect(summary.views_adapted).toEqual([]);
		expect(model.statements[0]!.text).toBe(text);
	});

	test("skips a view whose select list exposes no usable display source", () => {
		const text = "CREATE VIEW v_counts AS\nSELECT s.*\nFROM schedule s;";
		const model = view_model(text, "v_counts");

		const summary = adapt_schema_to_standard(model);
		expect(summary.views_adapted).toEqual([]);
		expect(model.statements[0]!.text).toBe(text);
	});

	test("leaves a view with function calls in its select list untouched", () => {
		const text = "CREATE VIEW v_results AS\nSELECT p.team_id, ROUND(AVG(p.points), 3) AS mean, t.title\nFROM points p;";
		const model = view_model(text, "v_results");

		const summary = adapt_schema_to_standard(model);
		expect(summary.views_adapted).toEqual([]);
		expect(model.statements[0]!.text).toBe(text);
	});
});

function view_model(text: string, object_name: string): StudioFile {
	return {
		path: "example.sql",
		dialect: "sqlite",
		trailing: "\n",
		statements: [{ gap: "", kind: "create_view", object_name, text }],
	};
}

describe("find_dangling_id_columns", () => {
	test("flags an *_id column whose pluralized table does not exist", () => {
		const model = tables_model([
			{ name: "games", columns: [column_of("id", "INTEGER", { is_primary_key: true }), column_of("round_id", "INTEGER", {})] },
		]);
		const dangling = find_dangling_id_columns(model);
		expect(dangling).toHaveLength(1);
		expect(dangling[0]!.column).toBe("round_id");
		expect(dangling[0]!.expected_table).toBe("rounds");
		expect(dangling[0]!.is_integer).toBe(true);
	});

	test("accepts an *_id column whose pluralized table exists", () => {
		const model = tables_model([
			{ name: "teams", columns: [column_of("id", "INTEGER", { is_primary_key: true })] },
			{ name: "games", columns: [column_of("id", "INTEGER", { is_primary_key: true }), column_of("team_id", "INTEGER", {})] },
		]);
		expect(find_dangling_id_columns(model)).toEqual([]);
	});

	test("accepts numbered fk columns like team_1_id", () => {
		const model = tables_model([
			{ name: "teams", columns: [column_of("id", "INTEGER", { is_primary_key: true })] },
			{ name: "tables", columns: [column_of("id", "INTEGER", { is_primary_key: true })] },
			{
				name: "schedule",
				columns: [
					column_of("id", "INTEGER", { is_primary_key: true }),
					column_of("team_1_id", "INTEGER", {}),
					column_of("team_2_id", "INTEGER", {}),
					column_of("table_1_id", "INTEGER", {}),
				],
			},
		]);
		expect(find_dangling_id_columns(model)).toEqual([]);
	});

	test("marks a string *_id column as non-integer so a _code rename can be suggested", () => {
		const model = tables_model([
			{ name: "points", columns: [column_of("id", "INTEGER", { is_primary_key: true }), column_of("category_id", "TEXT", {})] },
		]);
		const dangling = find_dangling_id_columns(model);
		expect(dangling).toHaveLength(1);
		expect(dangling[0]!.expected_table).toBe("categories");
		expect(dangling[0]!.is_integer).toBe(false);
	});

	test("ignores a column with an explicit REFERENCES clause", () => {
		const model = tables_model([
			{
				name: "games",
				columns: [
					column_of("id", "INTEGER", { is_primary_key: true }),
					column_of("round_id", "INTEGER", { references: { table: "some_rounds", column: "id" } }),
				],
			},
		]);
		expect(find_dangling_id_columns(model)).toEqual([]);
	});

	test("ignores the primary key column itself", () => {
		const model = tables_model([
			{ name: "games", columns: [column_of("id", "INTEGER", { is_primary_key: true })] },
		]);
		expect(find_dangling_id_columns(model)).toEqual([]);
	});
});

function tables_model(specs: { name: string; columns: StudioColumn[]; }[]): StudioFile {
	return {
		path: "example.sql",
		dialect: "sqlite",
		trailing: "\n",
		statements: specs.map((spec) => ({
			gap: "",
			kind: "create_table" as const,
			object_name: spec.name,
			text: "",
			table: { name: spec.name, columns: spec.columns, table_foreign_keys: [], table_unique_keys: [], table_suffix_raw: "" },
		})),
	};
}

function column_of(name: string, type_string: string, overrides: Partial<StudioColumn>): StudioColumn {
	return {
		name,
		type_string,
		nullability: "unspecified",
		default_value: null,
		is_primary_key: false,
		is_auto_increment: false,
		is_unique: false,
		is_generated: false,
		on_update_current_timestamp: false,
		modifier_order: [],
		...overrides,
	};
}

function varchar_pk_table(name: string, pk_name: string, extra_columns: string[]): StudioTable {
	return {
		name,
		table_foreign_keys: [],
		table_unique_keys: [],
		table_suffix_raw: "",
		columns: [
			column_of(pk_name, "VARCHAR(10)", { is_primary_key: true }),
			...extra_columns.map((column_name) => column_of(column_name, "TEXT", {})),
		],
	};
}

function table(name: string, names: string[]): StudioTable {
	return {
		name,
		table_foreign_keys: [],
		table_unique_keys: [],
		table_suffix_raw: "",
		columns: names.map((column_name) => ({
			name: column_name,
			type_string: "INTEGER",
			nullability: "unspecified",
			default_value: null,
			is_primary_key: column_name === "id",
			is_auto_increment: false,
			is_unique: false,
			is_generated: false,
			on_update_current_timestamp: false,
			modifier_order: [],
		})),
	};
}
