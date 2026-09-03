import { describe, expect, test } from "bun:test";

import { assert_import_size_bytes, assert_sheet_within_bounds, build_mysql_sql, build_sqlite_sql, extract_rows, infer_columns, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, normalize_import_path, normalize_import_rows, sheet_table_name, suggest_table_name, transliterate_column_key, transliterate_row_keys, validate_column_key, workbook_to_sheets } from "./data_to_sql";

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
		expect(build_sqlite_sql(options)).toContain('CREATE INDEX "people_archived_at" ON "people"("archived_at");');
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

	test("rejects import data with SQL-bearing column keys", () => {
		const hostile_key = "foo) VALUES (1); DROP TABLE users; --";
		expect(() => validate_column_key(hostile_key)).toThrow(/Invalid column name/);
		expect(() => infer_columns([{ [hostile_key]: 1 }], "mysql")).toThrow(/Invalid column name/);
	});

	test("validates clean column keys and rejects symbols, spaces, and separators", () => {
		expect(validate_column_key("first_name")).toBe("first_name");
		expect(validate_column_key("_private")).toBe("_private");
		expect(() => validate_column_key("First Name")).toThrow(/Invalid column name/);
		expect(() => validate_column_key("a.b")).toThrow(/Invalid column name/);
		expect(() => validate_column_key("a-b")).toThrow(/Invalid column name/);
		expect(() => validate_column_key("9starts_with_digit")).toThrow(/Invalid column name/);
	});

	test("quotes identifiers so reserved words render as valid SQL", () => {
		const schema = infer_columns([{ order: "desc", id: 1 }], "mysql");
		const options = {
			table: "sortings",
			columns: schema.columns,
			pk_from_data: schema.pk_from_data,
			display_column: schema.display_column,
			soft_fk_columns: schema.soft_fk_columns,
			rows: [{ order: "desc", id: 1 }],
		};

		expect(build_mysql_sql(options)).toContain("`order`");
		expect(build_mysql_sql(options)).toContain("INSERT IGNORE INTO `sortings` (`id`, `order`) VALUES");
		expect(build_sqlite_sql(options)).toContain('INSERT OR IGNORE INTO "sortings" ("id", "order") VALUES');
	});

	test("caps the row count of JSON imports", () => {
		const too_many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ({ a: 1 }));
		expect(() => extract_rows(too_many)).toThrow(/the limit is/);
	});

	test("caps the raw file size before parsing or decompression", () => {
		expect(() => assert_import_size_bytes(MAX_IMPORT_FILE_BYTES + 1, "JSON file")).toThrow(/import limit/);
		expect(() => assert_import_size_bytes(1_000_000, "JSON file")).not.toThrow();
		// workbook_to_sheets rejects oversized input before XLSX.read even runs
		// (the bytes never get near a parser).
		expect(() => workbook_to_sheets(new Uint8Array(MAX_IMPORT_FILE_BYTES + 1))).toThrow(/import limit/);
	});

	test("rejects sheets without a declared !ref range instead of dropping them", () => {
		expect(() => assert_sheet_within_bounds("empty", {})).toThrow(/no declared cell range/);
		expect(() => assert_sheet_within_bounds("empty", { A1: { t: "s", v: "x" } })).toThrow(/no declared cell range/);
	});

	test("bounds sheet dimensions from the !ref range", () => {
		expect(() => assert_sheet_within_bounds("s", { "!ref": "A1:C50001" })).toThrow(/rows/);
		expect(() => assert_sheet_within_bounds("s", { "!ref": "A1:IV50000" })).toThrow(/cells/);
		expect(() => assert_sheet_within_bounds("s", { "!ref": "A1:C10" })).not.toThrow();
	});

	test("transliterates non-ASCII column headers to ASCII identifiers", () => {
		expect(transliterate_column_key("Šifra")).toBe("Sifra");
		expect(transliterate_column_key("Datum vpisa")).toBe("Datum_vpisa");
		expect(transliterate_column_key("Cena z DDV")).toBe("Cena_z_DDV");
		expect(transliterate_column_key("2024 Revenue")).toBe("_2024_Revenue");
		expect(transliterate_column_key("Mesto_Šifra")).toBe("Mesto_Sifra");
		// Already-valid headers pass through unchanged.
		expect(transliterate_column_key("first_name")).toBe("first_name");
		expect(transliterate_column_key("UserId")).toBe("UserId");
	});

	test("transliterated headers validate and keep row data in sync", () => {
		const rows = transliterate_row_keys([
			{ "Šifra": 1, "Cena z DDV": 5 },
			{ "Šifra": 2, "Cena z DDV": 8 },
		]);
		expect(rows[0]).toEqual({ Sifra: 1, Cena_z_DDV: 5 });

		const schema = infer_columns(rows, "sqlite");
		expect(schema.columns.map((column) => column.name)).toEqual(["Sifra", "Cena_z_DDV"]);

		const sql = build_sqlite_sql({
			table: "items",
			columns: schema.columns,
			pk_from_data: schema.pk_from_data,
			display_column: schema.display_column,
			soft_fk_columns: schema.soft_fk_columns,
			rows,
		});
		expect(sql).toContain('"Sifra"');
		// Values followed the renamed keys (would be NULLs without the rewrite).
		expect(sql).toContain("(1,5),");
	});

	test("names non-Latin-script headers column_N instead of failing", () => {
		// Issue #402: headers like σ (with trailing whitespace) must not fail
		// validation. No alphabet-specific mapping - anything NFD cannot turn
		// into a clean ASCII slug (Greek, Cyrillic, CJK, ...) becomes column_N.
		expect(transliterate_column_key("σ")).toBe("");
		expect(transliterate_column_key("σ   ")).toBe("");
		expect(transliterate_column_key("Δ")).toBe("");
		expect(transliterate_column_key("Привет")).toBe("");
		expect(transliterate_column_key("数据")).toBe("");

		const rows = transliterate_row_keys([
			{ "σ   ": 1.5, "Δείκτης": 10, "Θέση": 2, "Σκορ": 90 },
			{ "σ   ": 2.0, "Δείκτης": 12, "Θέση": 1, "Σκορ": 95 },
		]);
		expect(rows[0]).toEqual({ column_1: 1.5, column_2: 10, column_3: 2, column_4: 90 });
		expect(rows[1]).toEqual({ column_1: 2.0, column_2: 12, column_3: 1, column_4: 95 });

		const schema = infer_columns(rows, "mysql");
		expect(schema.columns.map((column) => column.name)).toEqual(["column_1", "column_2", "column_3", "column_4"]);
	});

	test("column_N fallback still dedupes against transliterated headers", () => {
		// A literal "column_2" header next to a Greek header must not collide.
		const rows = transliterate_row_keys([{ "σ": 1, "column_2": 2 }]);
		expect(rows[0]).toEqual({ column_1: 1, column_2: 2 });
	});

	test("deduplicates transliteration collisions with a numeric suffix", () => {
		const rows = transliterate_row_keys([{ Name: "a", Näme: "b", "Näme 2": "c" }]);
		expect(rows[0]).toEqual({ Name: "a", Name_2: "b", Name_2_2: "c" });
	});

	test("leaves already-valid ASCII row keys untouched", () => {
		const rows = transliterate_row_keys([{ first_name: 1, user_id: 2 }]);
		expect(rows).toEqual([{ first_name: 1, user_id: 2 }]);
	});

	test("derives separate valid table names from worksheet names", () => {
		expect(sheet_table_name("analitika", "NIKOLI NAREDILI POGODBE", 0)).toBe("analitika_nikoli_naredili_pogodbe");
		expect(sheet_table_name("analitika", "2024", 1)).toBe("analitika_2024");
	});
});
