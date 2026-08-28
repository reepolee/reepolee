import { describe, expect, test } from "bun:test";

import { generate_index_ts } from "./index_ts";
import type { FieldDef } from "./types";

const fields: FieldDef[] = [
	{ name: "id", type: "number", required: true, is_nullable: false },
	{ name: "name", type: "text", required: true, is_nullable: false },
];

describe("generate_index_ts localized save", () => {
	test("passes the submitted locale to update_record and preserves locale save plumbing", async () => {
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

		expect(source).toContain("record = await update_record(id, changed_data, ctx.locale);");
		expect(source).toContain("const original_data = {");
		expect(source).toContain("UPDATE_COLUMNS.includes(field_name)");
		expect(source).toContain("const current_record = await get_record_by_id(id);");
		expect(source).toContain('id: String(current_record.id ?? ""),');
		expect(source).toContain("await save_locale_values(TABLE_NAME, Number(id), localized_inputs, LOCALE_PROTECTED_COLUMNS);");
		expect(source).toContain('const LOCALIZED_FIELDS = [{"field_name":"name"');
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
