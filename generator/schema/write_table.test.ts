import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse_crud_flags } from "../reeman/cli_crud";
import { update_table_file_settings, write_table_file } from "./write_table";
import type { TypeMapper } from "./type_mapper";
import type { SchemaObject } from "./types";

let temp_dir = "";

afterEach(async () => {
	if (temp_dir) await rm(temp_dir, { recursive: true, force: true });
	temp_dir = "";
});

const text_mapper: TypeMapper = {
	to_html_input: () => "text",
	to_typescript: () => "string",
};

describe("write_table_file", () => {
	test("does not localize the code identifier", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-table-localization-"));
		const schema: SchemaObject = {
			type: "table",
			name: "metrics",
			columns: [
				{ name: "id", type_string: "int", comment: "", is_nullable: false, is_primary_key: true, is_auto_increment: true },
				{ name: "code", type_string: "varchar(255)", comment: "", is_nullable: false, is_primary_key: false, is_auto_increment: false, is_unique: true },
				{ name: "name", type_string: "varchar(255)", comment: "", is_nullable: true, is_primary_key: false, is_auto_increment: false },
			],
			foreign_keys: [],
			has_view: false,
		};

		await write_table_file({ dir: temp_dir, schema_obj: schema, type_mapper: text_mapper, localize_content: true });
		const generated = await Bun.file(join(temp_dir, "schema", "table.ts")).text();
		expect(generated).toContain('"name": { width: "auto", class: "", localized: true }');
		expect(generated).toContain('"code": { width: "auto", class: "", domain: "code" }');
		expect(generated).not.toContain('"code": { width: "auto", class: "", domain: "code", localized: true }');
	});

	test("uses id for routes even when a child foreign key targets code", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-route-param-"));
		const schema: SchemaObject = {
			type: "table",
			name: "sensors",
			columns: [
				{ name: "id", type_string: "int", comment: "", is_nullable: false, is_primary_key: true, is_auto_increment: true },
				{ name: "code", type_string: "varchar(255)", comment: "", is_nullable: false, is_primary_key: false, is_auto_increment: false, is_unique: true },
			],
			foreign_keys: [],
			has_view: false,
		};
		const child_schema: SchemaObject = {
			type: "table",
			name: "metrics",
			columns: [],
			foreign_keys: [{ column_name: "sensor_code", referenced_table_name: "sensors", referenced_column_name: "code" }],
			has_view: false,
		};

		await write_table_file({ dir: temp_dir, schema_obj: schema, type_mapper: text_mapper, all_schemas: [schema, child_schema] });
		const generated = await Bun.file(join(temp_dir, "schema", "table.ts")).text();
		expect(generated).toContain('const route_param = "id";');
		expect(generated).not.toContain('const route_param = "code";');
	});
});

describe("update_table_file_settings", () => {
	test("preserves a read-only grid definition passed through the CRUD CLI", () => {
		const definitions = encodeURIComponent(JSON.stringify([
			{ name: "code", width: "10ch", class_name: "", filter: false, readonly: true },
		]));

		const flags = parse_crud_flags(["sensors", "--grid-column-definitions", definitions]);

		expect(flags.grid_column_definitions).toEqual([
			{ name: "code", width: "10ch", class_name: "", filter: false, readonly: true },
		]);
	});

	test("updates editable grid and strategy values without removing other properties", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-table-settings-"));
		const table_path = join(temp_dir, "table.ts");
		const source = `const columns = {
\t"name": { width: "auto", class: "", domain: "string", localized: true },
\t"email": { width: "20ch", class: "text-right", filter: true, grid: false },
}
const pagination_strategy: "cursor" | "offset" = "offset";
const render_strategy: "stream" | "load" = "load";
const template_tags: "flat" | "tags" = "flat";
`;
		await Bun.write(table_path, source);

		await update_table_file_settings(table_path, {
			pagination_strategy: "cursor",
			render_strategy: "stream",
			template_tags: "tags",
			grid_columns: ["email"],
			grid_column_definitions: [
				{ name: "name", width: "18ch", class_name: "font-semibold", filter: true },
				{ name: "email", width: "auto", class_name: "", filter: false },
			],
		});

		const updated = await Bun.file(table_path).text();
		expect(updated).toContain('"name": { width: "18ch", class: "font-semibold", domain: "string", filter: true, grid: false, localized: true }');
		expect(updated).toContain('"email": { width: "auto", class: "" }');
		expect(updated).toContain('const pagination_strategy: "cursor" | "offset" = "cursor";');
		expect(updated).toContain('const render_strategy: "stream" | "load" = "stream";');
		expect(updated).toContain('const template_tags: "flat" | "tags" = "tags";');
	});

	test("writes and clears the per-column template helper", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-table-helper-"));
		const table_path = join(temp_dir, "table.ts");
		const source = `const columns = {
\t"observed_at": { width: "auto", class: "" },
}
`;
		await Bun.write(table_path, source);

		await update_table_file_settings(table_path, {
			grid_column_definitions: [
				{ name: "observed_at", width: "auto", class_name: "", filter: false, helper: "js_datetime_to_locale_string" },
			],
		});

		let updated = await Bun.file(table_path).text();
		expect(updated).toContain('"observed_at": { width: "auto", class: "", helper: "js_datetime_to_locale_string"');

		// Clearing the helper (empty string) removes the property again.
		await update_table_file_settings(table_path, {
			grid_column_definitions: [
				{ name: "observed_at", width: "auto", class_name: "", filter: false, helper: "" },
			],
		});
		updated = await Bun.file(table_path).text();
		expect(updated).not.toContain("helper");
		expect(updated).toContain('"observed_at":');
	});
});
