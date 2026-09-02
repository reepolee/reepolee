import { describe, expect, test } from "bun:test";

import { generate_index_ts } from "./index_ts";
import type { FieldDef } from "./types";

const fields: FieldDef[] = [
	{ name: "id", type: "number", required: true, is_nullable: false },
	{ name: "name", type: "text", required: true, is_nullable: false },
];

describe("generate_index_ts localized save", () => {
	test("updates the default row and preserves locale save plumbing", async () => {
		const source = await generate_index_ts({
			table_name: "metrics",
			fields,
			column_names: ["id", "name"],
			view_column_names: [],
			sort_options: "[]",
			view_name: "v_metrics",
			has_view: false,
			first_field: "name",
			foreign_keys: new Map(),
			localization_enabled: true,
			localized_fields: [{ field_name: "name", label: "name", input_type: "text" }],
			readonly_fields: new Set(["id"]),
		});

		expect(source).toContain("record = await update_record(id, changed_data);");
		expect(source).toContain("const original_data = {");
		expect(source).toContain("UPDATE_COLUMNS.includes(field_name)");
		expect(source).toContain("const current_record = await get_record_by_id(id);");
		expect(source).toContain('id: String(current_record.id ?? ""),');
		expect(source).toContain("await save_locale_values(TABLE_NAME, Number(id), localized_inputs, LOCALE_PROTECTED_COLUMNS);");
		expect(source).toContain("const has_localized_changes = Object.keys(localized_inputs).length > 0;");
		expect(source).toContain("const has_base_changes = Object.keys(changed_data).length > 0;");
		expect(source).toContain("if (has_base_changes) record = await update_record(id, changed_data);");
		expect(source).toContain("if (has_changes) {");
		expect(source).toContain('r:{ id: record.id, changes: changed_data, locales: localized_inputs }');
		expect(source).toContain('const LOCALIZED_FIELDS = [{"field_name":"name"');
		expect(source).toContain("parse_changed_localized_form");
		expect(source).toContain("parse_localized_form");

		const new_handler = source.slice(source.indexOf("export async function get_metrics_new"));
		expect(new_handler).toContain("localization: build_localization_props({ fields: LOCALIZED_FIELDS");
		expect(new_handler).toContain('copy_action: ""');
	});

	test("wires per-field blur validation for translation inputs into the validate handler", async () => {
		const source = await generate_index_ts({
			table_name: "metrics",
			fields,
			column_names: ["id", "name"],
			view_column_names: [],
			sort_options: "[]",
			view_name: "v_metrics",
			has_view: false,
			first_field: "name",
			foreign_keys: new Map(),
			localization_enabled: true,
			localized_fields: [{ field_name: "name", label: "name", input_type: "text" }],
		});

		expect(source).toContain(
			"const localized_errors = validate_touched_localized_inputs(body, touched, LOCALIZED_FIELDS, schema, ctx.translations.errors);",
		);
		expect(source).toContain("Object.assign(errors, localized_errors);");
		expect(source).toContain("validate_touched_localized_inputs } from \"$lib/localized_form\";");
	});

	test("keeps the validate handler localization-free for a non-localized route", async () => {
		const source = await generate_index_ts({
			table_name: "sensors",
			fields,
			column_names: ["id", "code", "name"],
			view_column_names: [],
			sort_options: "[]",
			view_name: "v_sensors",
			has_view: false,
			first_field: "name",
			foreign_keys: new Map(),
			route_param_value: "code",
		});

		expect(source).not.toContain("validate_touched_localized_inputs");
		expect(source).toContain("const has_localized_changes = false;");
		expect(source).toContain('r:{ id: record.id, changes: changed_data }');
	});
});

test("uses a configured route parameter for the save-and-stay redirect", async () => {
	const source = await generate_index_ts({
		table_name: "sensors",
		fields,
		column_names: ["id", "code", "name"],
		view_column_names: [],
		sort_options: "[]",
		view_name: "v_sensors",
		has_view: false,
		first_field: "name",
		foreign_keys: new Map(),
		route_param_value: "code",
	});

	expect(source).toContain("redirect_url = localized_url(entity_path(code), _lang);");
	expect(source).not.toContain("redirect_url = localized_url(entity_path(id), _lang);");
});

test("reads navigation settings from config.ts", async () => {
	const source = await generate_index_ts({
		table_name: "sensors",
		fields,
		column_names: ["id", "code", "name"],
		view_column_names: [],
		sort_options: "[]",
		view_name: "v_sensors",
		has_view: false,
		first_field: "name",
		foreign_keys: new Map(),
	});

	expect(source).toContain('import { navigation } from "./config";');
	expect(source).toContain("nav_section_key: navigation.section_key");
	expect(source).toContain("nav_group_order: navigation.group_order");
});

test("passes locale as the only argument for localized FK option loaders", async () => {
	const foreign_key_field: FieldDef = {
		name: "metric_id",
		type: "foreign_key",
		required: true,
		is_nullable: false,
		attributes: { foreign_key: { table: "metrics", column: "id" } },
	};
	const source = await generate_index_ts({
		table_name: "reading_ranges",
		fields: [foreign_key_field, ...fields],
		column_names: ["id", "metric_id", "name"],
		view_column_names: [],
		sort_options: "[]",
		view_name: "v_reading_ranges",
		has_view: false,
		first_field: "metric_id",
		foreign_keys: new Map([["metric_id", { table: "metrics", column: "id", localized: true }]]),
		columns: { metric_id: { filter: true } },
	});

	expect(source).toContain("const metrics_options_by_id = await get_metrics_options_by_id(ctx.locale);");
	expect(source).toContain("const filter_metric_id_options = await get_metrics_options_by_id(ctx.locale);");
	expect(source).not.toContain("get_metrics_options_by_id(, ctx.locale)");
});

test("does not add an empty argument to non-localized FK option loaders", async () => {
	const foreign_key_field: FieldDef = {
		name: "sensor_code",
		type: "foreign_key",
		required: true,
		is_nullable: false,
		attributes: { foreign_key: { table: "sensors", column: "code" } },
	};
	const source = await generate_index_ts({
		table_name: "metrics",
		fields: [foreign_key_field, ...fields],
		column_names: ["id", "sensor_code", "name"],
		view_column_names: [],
		sort_options: "[]",
		view_name: "v_metrics",
		has_view: false,
		first_field: "sensor_code",
		foreign_keys: new Map([["sensor_code", { table: "sensors", column: "code" }]]),
		columns: { sensor_code: { filter: true } },
	});

	expect(source).toContain("const sensors_options_by_code = await get_sensors_options_by_code();");
	expect(source).toContain("const filter_sensor_code_options = await get_sensors_options_by_code();");
	expect(source).not.toContain("get_sensors_options_by_code(,");
});
