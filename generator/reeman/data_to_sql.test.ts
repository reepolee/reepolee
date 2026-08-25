import { describe, expect, test } from "bun:test";

import { build_mysql_sql, build_sqlite_sql, infer_columns, normalize_import_path, normalize_import_rows, sheet_table_name, suggest_table_name, workbook_to_sheets } from "./data_to_sql";

function xlsx_bytes(): Uint8Array {
	const source = `PK\u0003\u0004`;
	return new TextEncoder().encode(source);
}

describe("spreadsheet import", () => {
	test("normalizes manually pasted import paths", () => {
		expect(normalize_import_path("  data/import.json  ")).toBe("data/import.json");
		expect(normalize_import_path('"C:\\Imports\\people data.json"')).toBe("C:\\Imports\\people data.json");
		expect(normalize_import_path("'/tmp/people data.xlsx'")).toBe("/tmp/people data.xlsx");
	});

	test("suggests valid table names from files and sheets", () => {
		expect(suggest_table_name("Customer Orders.xlsx")).toBe("customer_orders");
		expect(suggest_table_name("2026 sales")).toBe("data_2026_sales");
	});

	test("normalizes columns through canonical domain types", () => {
		const schema = infer_columns([
			{ first_name: "Ada", is_active: true, published_at: "2026-01-02", author_id: 7 },
		], "mysql");

		expect(schema.columns.map((column) => column.domain_type)).toEqual([
			"first_name",
			"boolean",
			"timestamp",
			"foreign_key",
		]);
	});

	test("renders dialect-specific canonical SQL types", () => {
		const schema = infer_columns([{ amount: 12.5, is_active: true }], "mysql");
		const options = {
			table: "payments",
			columns: schema.columns,
			pk_from_data: schema.pk_from_data,
			display_column: schema.display_column,
			soft_fk_columns: schema.soft_fk_columns,
			rows: [{ amount: 12.5, is_active: true }],
		};

		expect(build_mysql_sql(options)).toContain("DECIMAL(18,2)");
		expect(build_mysql_sql(options)).toContain("TINYINT(1)");
		expect(build_sqlite_sql(options)).toContain("DECIMAL(18, 2)");
		expect(build_sqlite_sql(options)).toContain("is_active");
	});

	test("renames a non-primary incoming id and adds archive system columns", () => {
		const rows = normalize_import_rows([{ name: "Ada", ID: "legacy-1" }]);
		const schema = infer_columns(rows, "mysql");
		const options = {
			table: "people",
			columns: schema.columns,
			pk_from_data: schema.pk_from_data,
			display_column: schema.display_column,
			soft_fk_columns: schema.soft_fk_columns,
			rows,
		};

		expect(schema.columns.map((column) => column.name)).toEqual(["original_id", "name"]);
		expect(build_mysql_sql(options)).toContain("original_id");
		expect(build_mysql_sql(options)).toContain("archived_by_user_id");
		expect(build_sqlite_sql(options)).toContain("CREATE INDEX people_archived_at");
	});

	test("keeps a unique numeric incoming id as the canonical primary key", () => {
		const rows = normalize_import_rows([{ name: "Ada", ID: "12" }, { name: "Grace", ID: "13" }]);
		const schema = infer_columns(rows, "mysql");

		expect(rows).toEqual([{ name: "Ada", id: 12 }, { name: "Grace", id: 13 }]);
		expect(schema.pk_from_data).toBe(true);
		expect(schema.columns.map((column) => column.name)).toEqual(["name"]);
	});

	test("rejects invalid workbook bytes through the parser boundary", () => {
		expect(() => workbook_to_sheets(xlsx_bytes())).toThrow();
	});

	test("derives separate valid table names from worksheet names", () => {
		expect(sheet_table_name("analitika", "NIKOLI NAREDILI POGODBE", 0)).toBe("analitika_nikoli_naredili_pogodbe");
		expect(sheet_table_name("analitika", "2024", 1)).toBe("analitika_2024");
	});
});
