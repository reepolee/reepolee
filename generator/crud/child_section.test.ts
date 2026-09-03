import { expect, test } from "bun:test";

import { generate_child_section_html } from "./child_section";

test("child sections use a table-specific translation namespace", async () => {
	const first_child = await generate_child_section_html(
		"metric_enum_values",
		{ table: "metrics", fk_column: "metrics_id", route_param: "id", label: "Metric" },
		[{ name: "label", type: "text", required: true, is_nullable: false }],
		null,
		{ label: { width: "auto", class: "", localized: true } },
		new Map(),
		"",
	);

	const second_child = await generate_child_section_html(
		"metric_details",
		{ table: "metrics", fk_column: "metrics_id", route_param: "id", label: "Metric" },
		[{ name: "name", type: "text", required: true, is_nullable: false }],
		null,
		{ name: { width: "auto", class: "", localized: true } },
		new Map(),
		"",
	);

	expect(first_child.child_section).toContain("{_ children.metric_enum_values.parent_label}");
	expect(first_child.child_section).toContain("{_ children.metric_enum_values.child_ui.new_button}");
	expect(first_child.child_section).toContain("{_ children.metric_enum_values.child_fields.label}");
	expect(first_child.child_section).toContain("{_ children.metric_enum_values.actions.save}");
	expect(first_child.child_section).not.toContain("{_ child_ui.");
	expect(second_child.child_section).toContain("{_ children.metric_details.parent_label}");
	expect(second_child.child_section).toContain("{_ children.metric_details.child_fields.name}");
	expect(second_child.child_section).not.toContain("metric_enum_values");
});
