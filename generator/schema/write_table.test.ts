import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse_crud_flags } from "../reeman/cli_crud";
import { next_navigation_item_order, update_table_file_settings, write_table_file } from "./write_table";
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
	test("adds ten to the highest sibling navigation item order", () => {
		expect(next_navigation_item_order([])).toBe(10);
		expect(next_navigation_item_order([10, 40, 20])).toBe(50);
	});

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
		const generated = await Bun.file(join(temp_dir, "config.ts")).text();
		expect(generated).toContain('"name": { width: "auto", class: "", localized: true }');
		expect(generated).toContain('"code": { width: "auto", class: "", domain: "code" }');
		expect(generated).not.toContain('"code": { width: "auto", class: "", domain: "code", localized: true }');
	});

	test("honors an explicit localized choice when creating a route", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-table-localization-choice-"));
		const schema: SchemaObject = {
			type: "table",
			name: "metrics",
			columns: [
				{ name: "id", type_string: "int", comment: "", is_nullable: false, is_primary_key: true, is_auto_increment: true },
				{ name: "name", type_string: "varchar(255)", comment: "", is_nullable: true, is_primary_key: false, is_auto_increment: false },
			],
			foreign_keys: [],
			has_view: false,
		};

		await write_table_file({
			dir: temp_dir,
			schema_obj: schema,
			type_mapper: text_mapper,
			localize_content: true,
			grid_column_definitions: [{ name: "name", width: "auto", class_name: "", filter: false, localized: false }],
		});
		const generated = await Bun.file(join(temp_dir, "config.ts")).text();
		expect(generated).not.toContain('"name": { width: "auto", class: "", localized: true }');
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
			foreign_keys: [{ constraint_name: "fk_metrics_sensor_code", column_name: "sensor_code", referenced_table_name: "sensors", referenced_column_name: "code" }],
			has_view: false,
		};

		await write_table_file({ dir: temp_dir, schema_obj: schema, type_mapper: text_mapper, all_schemas: [schema, child_schema] });
		const generated = await Bun.file(join(temp_dir, "config.ts")).text();
		expect(generated).toContain('const route_param = "id";');
		expect(generated).not.toContain('const route_param = "code";');
	});

	test("writes concrete navigation settings in new route configs", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-navigation-config-"));
		const schema: SchemaObject = {
			type: "table",
			name: "reports",
			columns: [{ name: "id", type_string: "int", comment: "", is_nullable: false, is_primary_key: true, is_auto_increment: true }],
			foreign_keys: [],
			has_view: false,
		};

		await write_table_file({ dir: temp_dir, schema_obj: schema, type_mapper: text_mapper });
		const generated = await Bun.file(join(temp_dir, "config.ts")).text();
		expect(generated).toContain("const navigation = {");
		expect(generated).toContain("// Section heading translation key; null keeps this route directly in its module group.");
		expect(generated).toContain("// Reserved final-sidebar-link order; currently unused by generated routes.");
		expect(generated).toContain("item_order: 10,");
		expect(generated).toContain("section_key: null,");
		expect(generated).toContain("section_order: null,");
		expect(generated).toContain("group_order: null,");
		expect(generated).toContain("final_order: null,");
		expect(generated).toContain("template_tags, form_hints, form_details, navigation");
	});

	test("preserves navigation settings when refreshing an existing route config", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-navigation-refresh-"));
		const schema: SchemaObject = {
			type: "table",
			name: "reports",
			columns: [{ name: "id", type_string: "int", comment: "", is_nullable: false, is_primary_key: true, is_auto_increment: true }],
			foreign_keys: [],
			has_view: false,
		};
		const config_path = join(temp_dir, "config.ts");
		await Bun.write(config_path, `const columns: Record<string, { width: string; class: string }> = {};
const navigation = {
	section_key: "reeman.nav.generator",
	item_order: 40,
	section_order: 10,
	group_order: null,
	final_order: null,
};
export { columns, navigation };
`);

		await write_table_file({ dir: temp_dir, schema_obj: schema, type_mapper: text_mapper });
		const generated = await Bun.file(config_path).text();
		expect(generated).toContain('section_key: "reeman.nav.generator",');
		expect(generated).toContain("item_order: 40,");
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
const form_hints = false;
const form_details = false;
`;
		await Bun.write(table_path, source);

		await update_table_file_settings(table_path, {
			pagination_strategy: "cursor",
			render_strategy: "stream",
			template_tags: "tags",
			form_hints: true,
			form_details: true,
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
		expect(updated).toContain("const form_hints = true;");
		expect(updated).toContain("const form_details = true;");
	});

	test("updates a column's explicit localized setting", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-table-localized-setting-"));
		const table_path = join(temp_dir, "table.ts");
		const source = `const columns = {
\t"name": { width: "auto", class: "", localized: true },
\t"label": { width: "auto", class: "" },
}
`;
		await Bun.write(table_path, source);

		await update_table_file_settings(table_path, {
			grid_column_definitions: [
				{ name: "name", width: "auto", class_name: "", filter: false, localized: false },
				{ name: "label", width: "auto", class_name: "", filter: false, localized: true },
			],
		});

		const updated = await Bun.file(table_path).text();
		expect(updated).toContain('"name": { width: "auto", class: "" }');
		expect(updated).toContain('"label": { width: "auto", class: "", localized: true }');
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

	test("writes the per-column form setting and preserves false", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-table-form-setting-"));
		const table_path = join(temp_dir, "table.ts");
		const source = `const columns: Record<string, { width: string; class: string; localized?: boolean }> = {
	"name": { width: "auto", class: "" },
}
`;
		await Bun.write(table_path, source);

		await update_table_file_settings(table_path, {
			grid_column_definitions: [{ name: "name", width: "auto", class_name: "", filter: false, form: false }],
		});

		let updated = await Bun.file(table_path).text();
		expect(updated).toContain("localized?: boolean; form?: boolean");
		expect(updated).toContain('"name": { width: "auto", class: "", form: false }');

		await update_table_file_settings(table_path, {
			grid_column_definitions: [{ name: "name", width: "auto", class_name: "", filter: false, form: true }],
		});
		updated = await Bun.file(table_path).text();
		expect(updated).toContain('"name": { width: "auto", class: "", form: true }');
	});
});
