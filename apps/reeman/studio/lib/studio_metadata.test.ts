import { describe, expect, test } from "bun:test";

import { append_studio_metadata, apply_studio_metadata, extract_studio_metadata } from "./studio_metadata";
import type { StudioStatement } from "./types";

describe("embedded Studio metadata", () => {
	test("round-trips domain types without changing SQL", () => {
		const sql = "CREATE TABLE people (id INTEGER PRIMARY KEY);\n";
		const statements = example_statements();
		const output = append_studio_metadata(sql, statements);
		const extracted = extract_studio_metadata(output);

		expect(extracted.sql).toBe(sql);
		expect(extracted.metadata?.domain_map.people?.id).toBe("pk_id");
		expect(output).toContain("-- reepolee-studio:begin v1");
		expect(output).toContain("-- reepolee-studio:end");
	});

	test("invalid metadata is removed from the SQL model and treated as absent", () => {
		const source = "SELECT 1;\n-- reepolee-studio:begin v1\n-- not json\n-- reepolee-studio:end\n";
		const extracted = extract_studio_metadata(source);
		expect(extracted.sql).toBe("SELECT 1;\n");
		expect(extracted.metadata).toBeNull();
	});

	test("a malformed non-comment line is also non-fatal", () => {
		const source = "SELECT 1;\n-- reepolee-studio:begin v1\nnot a comment\n";
		const extracted = extract_studio_metadata(source);
		expect(extracted.sql).toBe("SELECT 1;\n");
		expect(extracted.metadata).toBeNull();
	});

	test("applies an embedded domain map to parsed columns", () => {
		const statements = example_statements();
		statements[0]!.table!.columns[0]!.domain_type = null;
		apply_studio_metadata(statements, { version: 1, domain_map: { people: { id: "pk_id" } } });
		expect(String(statements[0]!.table!.columns[0]!.domain_type)).toBe("pk_id");
	});
});

function example_statements(): StudioStatement[] {
	return [{
		gap: "",
		kind: "create_table",
		object_name: "people",
		text: "CREATE TABLE people (id INTEGER PRIMARY KEY);",
		table: {
			name: "people",
			table_foreign_keys: [],
			table_suffix_raw: "",
			columns: [{
				name: "id",
				type_string: "INTEGER",
				domain_type: "pk_id",
				nullability: "unspecified",
				default_value: null,
				is_primary_key: true,
				is_auto_increment: false,
				is_unique: false,
				is_generated: false,
				on_update_current_timestamp: false,
				modifier_order: ["primary_key"],
			}],
		},
	}];
}
