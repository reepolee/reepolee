import { describe, expect, test } from "bun:test";

import { column_reference_value, parse_table_form, validate_table_references } from "./form_data";
import { get_domain_types, resolve_column_domain, suggest_column_name } from "./domain_types";
import type { StudioTable } from "./types";

const source: StudioTable = {
	name: "authors",
	table_foreign_keys: [],
	table_suffix_raw: "",
	columns: [{
		name: "author_id",
		type_string: "INTEGER",
		nullability: "not_null",
		default_value: null,
		is_primary_key: false,
		is_auto_increment: false,
		is_unique: false,
		is_generated: false,
		on_update_current_timestamp: false,
		references: { table: "authors", column: "id", on_update: "CASCADE" },
		modifier_order: ["nullability", "references"],
	}],
};

describe("parse_table_form", () => {
	test("overlays validated fields and preserves reference actions", () => {
		const params = column_params();
		const table = parse_table_form(params, source, "sqlite");
		expect(table.columns[0]!.name).toBe("author_id");
		expect(table.columns[0]!.references?.on_update).toBe("CASCADE");
	});

	test("rejects duplicate column names", () => {
		const params = column_params();
		for (const [key, value] of [...params.entries()]) params.append(key, value);
		params.delete("column_source");
		params.append("column_source", "0");
		params.append("column_source", "new");
		expect(() => parse_table_form(params, source, "sqlite")).toThrow("unique");
	});

	test("normalizes canonical primary-key domain modifiers", () => {
		const params = column_params();
		params.set("column_domain", "pk_id");
		params.set("column_reference", "");
		const table = parse_table_form(params, source, "sqlite");
		expect(table.columns[0]!.type_string).toBe("INTEGER");
		expect(table.columns[0]!.is_primary_key).toBe(true);
	});

	test("derives MySQL primary-key status from the pk_id domain", () => {
		const params = column_params();
		params.set("column_domain", "pk_id");
		params.set("column_reference", "");
		const table = parse_table_form(params, source, "mysql");
		expect(table.columns[0]!.type_string).toBe("INT UNSIGNED");
		expect(table.columns[0]!.is_primary_key).toBe(true);
		expect(table.columns[0]!.is_auto_increment).toBe(true);
	});

	test("rejects more than one pk_id domain", () => {
		const params = column_params();
		for (const [key, value] of [...params.entries()]) params.append(key, value);
		params.delete("column_source");
		params.append("column_source", "0");
		params.append("column_source", "new");
		params.delete("column_name");
		params.append("column_name", "id");
		params.append("column_name", "other_id");
		params.delete("column_domain");
		params.append("column_domain", "pk_id");
		params.append("column_domain", "pk_id");
		params.delete("column_reference");
		params.append("column_reference", "");
		params.append("column_reference", "");
		expect(() => parse_table_form(params, source, "sqlite")).toThrow("only one pk_id");
	});

	test("rejects missing foreign-key targets", () => {
		const params = column_params();
		params.set("column_reference", "missing.id");
		const table = parse_table_form(params, source, "sqlite");
		const model = { path: "example.sql", dialect: "sqlite" as const, trailing: "", statements: [{ gap: "", kind: "create_table" as const, object_name: "authors", text: "", table: source }] };
		expect(() => validate_table_references(table, model)).toThrow("not found");
	});

	test("drops a reference left over from a domain that is no longer foreign_key", () => {
		// The client clears the FK select whenever the domain moves away from
		// foreign_key, but the two form fields update independently in the DOM,
		// so a stale reference must not hard-fail the whole submit - it's dropped.
		const params = column_params();
		params.set("column_domain", "integer");
		const table = parse_table_form(params, source, "sqlite");
		expect(table.columns[0]!.references).toBeUndefined();
	});

	test("preserves a nonstandard SQL type assigned to its semantic domain", () => {
		const custom_source = structuredClone(source);
		custom_source.columns[0]!.name = "first_name";
		custom_source.columns[0]!.type_string = "VARCHAR(30)";
		custom_source.columns[0]!.domain_type = "first_name";
		const params = column_params();
		params.set("column_name", "first_name");
		params.set("column_domain", "first_name");
		params.set("column_preserve_type", "1");
		params.set("column_reference", "");
		const table = parse_table_form(params, custom_source, "mysql");
		expect(table.columns[0]!.type_string).toBe("VARCHAR(30)");
		expect(table.columns[0]!.domain_type).toBe("first_name");
	});

	test("canonicalizes a nonstandard type when its domain selection changes", () => {
		const custom_source = structuredClone(source);
		custom_source.columns[0]!.type_string = "VARCHAR(30)";
		custom_source.columns[0]!.domain_type = "phone_number";
		const params = column_params();
		params.set("column_domain", "first_name");
		params.set("column_reference", "");
		const table = parse_table_form(params, custom_source, "mysql");
		expect(table.columns[0]!.type_string).toBe("VARCHAR(100)");
	});
});

describe("domain naming", () => {
	test("recognizes conventional and duration column names", () => {
		expect(resolve_column_domain("id", "INTEGER", "sqlite")).toBe("pk_id");
		expect(resolve_column_domain("cook_time_minutes", "INTEGER", "sqlite")).toBe("minutes");
		expect(resolve_column_domain("first_name", "VARCHAR(30)", "mysql")).toBe("first_name");
		expect(resolve_column_domain("display", "VARCHAR(61)", "mysql")).toBe("varchar");
		expect(suggest_column_name("minutes", "cook_time")).toBe("cook_time_minutes");
	});

	test("includes dialect-aware basic SQL types in the domain palette", () => {
		const sqlite = get_domain_types("sqlite");
		const mysql = get_domain_types("mysql");
		expect(sqlite.find((item) => item.name === "integer")?.type_string).toBe("INTEGER");
		expect(sqlite.find((item) => item.name === "decimal")?.type_string).toBe("DECIMAL(18, 2)");
		expect(mysql.find((item) => item.name === "integer")?.type_string).toBe("INT");
		expect(mysql.find((item) => item.name === "decimal")?.type_string).toBe("DECIMAL(10, 2)");
	});
});

describe("table-level foreign keys", () => {
	const table_source: StudioTable = {
		...structuredClone(source),
		name: "recipes_ingredients",
		columns: [{ ...structuredClone(source.columns[0]!), name: "ingredient_id", references: undefined }],
		table_foreign_keys: [{ column: "ingredient_id", ref_table: "ingredients", ref_column: "id", on_update: "CASCADE" }],
	};

	test("shows and preserves an unchanged table-level reference", () => {
		expect(column_reference_value(table_source, table_source.columns[0]!)).toBe("ingredients.id");
		const params = column_params();
		params.set("column_name", "ingredient_id");
		params.set("column_reference", "ingredients.id");
		const table = parse_table_form(params, table_source, "sqlite");
		expect(table.columns[0]!.references).toBeUndefined();
		expect(table.table_foreign_keys[0]).toEqual({ column: "ingredient_id", ref_table: "ingredients", ref_column: "id", on_update: "CASCADE" });
	});

	test("moves an edited table-level reference inline without duplication", () => {
		const params = column_params();
		params.set("column_name", "ingredient_id");
		params.set("column_reference", "products.id");
		const table = parse_table_form(params, table_source, "sqlite");
		expect(table.columns[0]!.references).toEqual({ table: "products", column: "id" });
		expect(table.table_foreign_keys).toEqual([]);
	});
});

function column_params(): URLSearchParams {
	return new URLSearchParams({
		column_source: "0",
		column_name: "author_id",
		column_domain: "foreign_key",
		column_preserve_type: "0",
		column_type: "INTEGER",
		column_nullability: "not_null",
		column_default: "",
		column_auto_increment: "0",
		column_unique: "0",
		column_generated: "0",
		column_generated_expr: "",
		column_reference: "authors.id",
	});
}
