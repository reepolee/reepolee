import { describe, expect, test } from "bun:test";
import { build_insert_sql, locale_segment, sql_literal, table_locale } from "./dump_db";

describe("database dump helpers", () => {
	test("quotes identifiers and values for each dialect", () => {
		expect(build_insert_sql("order", ["id", "label"], [{ id: 1, label: "O'Reilly" }], "mysql")).toContain("INSERT INTO `order` (`id`, `label`) VALUES\n(1, 'O''Reilly');");
		expect(build_insert_sql("order", ["id", "label"], [{ id: 1, label: "O'Reilly" }], "sqlite")).toContain('INSERT INTO "order" ("id", "label") VALUES\n(1, \'O\'\'Reilly\');');
		expect(sql_literal("line\\break", "mysql")).toBe("CONVERT(X'6c696e655c627265616b' USING utf8mb4)");
		expect(sql_literal(null, "sqlite")).toBe("NULL");
	});

	test("maps only real locale clones to their locale output", () => {
		const tables = new Set(["products", "products_sl_si", "audit_sl_si"]);
		expect(locale_segment("sl-si")).toBe("sl_si");
		expect(table_locale("products", tables, ["en-us", "sl-si"], "en-us")).toBe("en-us");
		expect(table_locale("products_sl_si", tables, ["en-us", "sl-si"], "en-us")).toBe("sl-si");
		expect(table_locale("audit_sl_si", tables, ["en-us", "sl-si"], "en-us")).toBe("en-us");
	});

	test("serializes null, booleans, dates, and binary values", () => {
		expect(sql_literal(false, "mysql")).toBe("0");
		expect(sql_literal(new Date("2026-01-02T03:04:05.000Z"), "sqlite")).toBe("'2026-01-02 03:04:05.000'");
		expect(sql_literal(new Uint8Array([0, 255]), "mysql")).toBe("X'00ff'");
	});

	test("splits large tables into multi-row insert batches", () => {
		const rows = Array.from({ length: 501 }, (_, id) => ({ id }));
		const sql = build_insert_sql("items", ["id"], rows, "sqlite");
		expect((sql.match(/INSERT INTO/g) ?? []).length).toBe(2);
		expect((sql.match(/\),/g) ?? []).length).toBe(499);
	});
});
