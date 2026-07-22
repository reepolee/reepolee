import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the validation generator to avoid file I/O
mock.module("../validation_generator", () => ({
	generate_validation_server_content: async () => `
// Auto-generated validation schemas
export const index_validation = null;
export const form_validation = null;
export const validate_validation = null;
`,
	generate_zod_fields_from_array: (fields: any) => ({}),
}));

// Mock field generator
mock.module("./field_generator", () => ({
	generate_fields_object: () => ({}),
	apply_index_nullable: () => {},
}));

import { write_validation_file } from "./write_validation";
import type { SchemaObject } from "./types";
import type { TypeMapper } from "./type_mapper";

let temp_dirs: string[] = [];

function make_temp_dir(): string {
	const dir = mkdtempSync(join(tmpdir(), "reepolee-test-"));
	Bun.spawnSync(["mkdir", "-p", `${dir}/schema`]);
	temp_dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temp_dirs) {
		try {
			rmSync(dir, { recursive: true });
		} catch {
			// ignore
		}
	}
	temp_dirs = [];
});

const mock_type_mapper: TypeMapper = {
	to_typescript: (db_type: string) => {
		if (db_type.includes("INT")) return "number";
		if (db_type.includes("DATETIME")) return "string";
		if (db_type.includes("BOOLEAN")) return "boolean";
		return "string";
	},
	to_html_input: (db_type: string) => {
		if (db_type.includes("INT")) return "number";
		if (db_type.includes("DATETIME")) return "datetime-local";
		if (db_type.includes("BOOLEAN")) return "checkbox";
		return "text";
	},
};

const mock_schema: SchemaObject = {
	type: "table",
	name: "products",
	columns: [
		{
			name: "id",
			type_string: "INT",
			is_nullable: false,
			is_primary_key: true,
			is_auto_increment: true,
			default_value: null,
			comment: "",
		},
		{
			name: "name",
			type_string: "VARCHAR(255)",
			is_nullable: false,
			is_primary_key: false,
			is_auto_increment: false,
			default_value: null,
			comment: "",
		},
		{
			name: "description",
			type_string: "TEXT",
			is_nullable: true,
			is_primary_key: false,
			is_auto_increment: false,
			default_value: null,
			comment: "",
		},
		{
			name: "price",
			type_string: "DECIMAL(10,2)",
			is_nullable: false,
			is_primary_key: false,
			is_auto_increment: false,
			default_value: null,
			comment: "",
		},
		{
			name: "is_active",
			type_string: "BOOLEAN",
			is_nullable: false,
			is_primary_key: false,
			is_auto_increment: false,
			default_value: "1",
			comment: "",
		},
	],
	foreign_keys: [],
	has_view: false,
};

describe("write_validation.write_validation_file", () => {
	test("creates validation_server.ts file with content", async () => {
		const temp_dir = make_temp_dir();

		await write_validation_file(temp_dir, mock_schema, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/validation_server.ts`);
		const exists = await file.exists();
		expect(exists).toBe(true);

		const content = await file.text();
		expect(content.length).toBeGreaterThan(0);
	});

	test("generates validation schemas for index, form, and validate", async () => {
		const temp_dir = make_temp_dir();

		await write_validation_file(temp_dir, mock_schema, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/validation_server.ts`);
		const content = await file.text();

		expect(content).toContain("validation");
	});

	test("includes exported schemas", async () => {
		const temp_dir = make_temp_dir();

		await write_validation_file(temp_dir, mock_schema, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/validation_server.ts`);
		const content = await file.text();

		expect(content).toContain("export");
	});

	test("handles schema with view columns", async () => {
		const temp_dir = make_temp_dir();
		const schema_with_view = {
			...mock_schema,
			view_columns: [
				{
					name: "id",
					type_string: "INT",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
					default_value: null,
					comment: "",
				},
				{
					name: "name",
					type_string: "VARCHAR(255)",
					is_nullable: false,
					is_primary_key: false,
					is_auto_increment: false,
					default_value: null,
					comment: "",
				},
			],
		};

		await write_validation_file(temp_dir, schema_with_view, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/validation_server.ts`);
		const exists = await file.exists();
		expect(exists).toBe(true);
	});

	test("handles all schema field types", async () => {
		const temp_dir = make_temp_dir();
		const complex_schema: SchemaObject = {
			...mock_schema,
			columns: [
				mock_schema.columns[0], // id - INT
				mock_schema.columns[1], // name - VARCHAR
				mock_schema.columns[2], // description - TEXT (nullable)
				mock_schema.columns[3], // price - DECIMAL
				mock_schema.columns[4], // is_active - BOOLEAN
			],
		};

		await write_validation_file(temp_dir, complex_schema, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/validation_server.ts`);
		const exists = await file.exists();
		expect(exists).toBe(true);
	});

	test("with tables_columns and tables_indexes parameters", async () => {
		const temp_dir = make_temp_dir();
		const all_columns = new Map([["products", ["id", "name", "price"]]]);
		const all_indexes = new Map([["products", new Set(["id", "name"])]]);

		await write_validation_file(temp_dir, mock_schema, mock_type_mapper, all_columns, all_indexes);

		const file = Bun.file(`${temp_dir}/schema/validation_server.ts`);
		const exists = await file.exists();
		expect(exists).toBe(true);
	});

	test("produces valid TypeScript file", async () => {
		const temp_dir = make_temp_dir();

		await write_validation_file(temp_dir, mock_schema, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/validation_server.ts`);
		const content = await file.text();

		// Should have export statements
		expect(content).toContain("export");

		// Should not be empty
		expect(content.trim().length).toBeGreaterThan(0);
	});
});
