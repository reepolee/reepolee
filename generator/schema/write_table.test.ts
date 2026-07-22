import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { write_table_generated_file, write_table_file } from "./write_table";
import type { SchemaObject } from "./types";
import type { TypeMapper } from "./type_mapper";

// Create temp dir for each test
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

// Mock type mapper
const mock_type_mapper: TypeMapper = {
	to_typescript: (db_type: string) => {
		if (db_type.includes("INT")) return "number";
		if (db_type.includes("DATETIME") || db_type.includes("TIMESTAMP")) return "string";
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

// Mock schema object
const mock_schema: SchemaObject = {
	type: "table",
	name: "users",
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
			name: "email",
			type_string: "VARCHAR(255)",
			is_nullable: false,
			is_primary_key: false,
			is_auto_increment: false,
			default_value: null,
			comment: "",
		},
		{
			name: "name",
			type_string: "VARCHAR(255)",
			is_nullable: true,
			is_primary_key: false,
			is_auto_increment: false,
			default_value: null,
			comment: "",
		},
	],
	foreign_keys: [],
	has_view: false,
};

describe("write_table.write_table_generated_file", () => {
	test("creates table.generated.ts file with correct structure", async () => {
		const temp_dir = make_temp_dir();

		await write_table_generated_file(temp_dir, mock_schema, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/table.generated.ts`);
		const exists = await file.exists();
		expect(exists).toBe(true);

		const content = await file.text();
		expect(content).toContain("// This file is auto-generated");
		expect(content).toContain(`type users_type`);
		expect(content).toContain("export const fields");
		expect(content).toContain("export const indexed_columns");
	});

	test("generates correct TypeScript types from schema columns", async () => {
		const temp_dir = make_temp_dir();

		await write_table_generated_file(temp_dir, mock_schema, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/table.generated.ts`);
		const content = await file.text();

		expect(content).toContain("id?: number");
		expect(content).toContain("email?: string");
		expect(content).toContain("name?: string | null | undefined");
	});

	test("sets correct nullable flags in type definitions", async () => {
		const temp_dir = make_temp_dir();

		await write_table_generated_file(temp_dir, mock_schema, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/table.generated.ts`);
		const content = await file.text();

		// Non-nullable columns should not have "| null | undefined"
		expect(content).toMatch(/id\?: number[;\n]/);
		expect(content).toMatch(/email\?: string[;\n]/);

		// Nullable columns should have "| null | undefined"
		expect(content).toContain("name?: string | null | undefined");
	});

	test("includes indexed_columns in output", async () => {
		const temp_dir = make_temp_dir();
		const indexes = new Map([["users", new Set(["id", "email"])]]);

		await write_table_generated_file(temp_dir, mock_schema, mock_type_mapper, undefined, indexes);

		const file = Bun.file(`${temp_dir}/schema/table.generated.ts`);
		const content = await file.text();

		expect(content).toContain("indexed_columns");
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
			],
		};

		await write_table_generated_file(temp_dir, schema_with_view, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/table.generated.ts`);
		const content = await file.text();

		expect(content).toContain("v_fields");
		expect(content).not.toContain("v_fields: null");
	});

	test("sets v_fields to null when no view columns", async () => {
		const temp_dir = make_temp_dir();

		await write_table_generated_file(temp_dir, mock_schema, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/table.generated.ts`);
		const content = await file.text();

		expect(content).toContain("v_fields: Record<string, FormFieldDef> | null = null");
	});

	test("includes parent relationship when present", async () => {
		const temp_dir = make_temp_dir();
		const schema_with_parent = { ...mock_schema, parent: { table: "groups", column: "group_id" } };

		await write_table_generated_file(temp_dir, schema_with_parent, mock_type_mapper);

		const file = Bun.file(`${temp_dir}/schema/table.generated.ts`);
		const content = await file.text();

		expect(content).toContain("parent");
		expect(content).toContain("groups");
	});
});

describe("write_table.write_table_file", () => {
	test("creates table.ts file when it does not exist", async () => {
		const temp_dir = make_temp_dir();

		await write_table_file({ dir: temp_dir, schema_obj: mock_schema, type_mapper: mock_type_mapper });

		const file = Bun.file(`${temp_dir}/schema/table.ts`);
		const exists = await file.exists();
		expect(exists).toBe(true);
	});

	test("skips creation if table.ts already exists", async () => {
		const temp_dir = make_temp_dir();

		// Create a table.ts file
		await Bun.write(`${temp_dir}/schema/table.ts`, "// existing content");

		await write_table_file({ dir: temp_dir, schema_obj: mock_schema, type_mapper: mock_type_mapper });

		const content = await Bun.file(`${temp_dir}/schema/table.ts`).text();
		expect(content).toBe("// existing content");
	});

	test("respects pagination_strategy parameter", async () => {
		const temp_dir = make_temp_dir();

		await write_table_file({
			dir: temp_dir,
			schema_obj: mock_schema,
			type_mapper: mock_type_mapper,
			pagination_strategy: "cursor",
		});

		const file = Bun.file(`${temp_dir}/schema/table.ts`);
		const exists = await file.exists();
		expect(exists).toBe(true);
	});

	test("respects render_strategy parameter", async () => {
		const temp_dir = make_temp_dir();

		await write_table_file({
			dir: temp_dir,
			schema_obj: mock_schema,
			type_mapper: mock_type_mapper,
			render_strategy: "stream",
		});

		const file = Bun.file(`${temp_dir}/schema/table.ts`);
		const exists = await file.exists();
		expect(exists).toBe(true);
	});
});
