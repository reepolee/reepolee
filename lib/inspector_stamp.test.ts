import { describe, expect, test } from "bun:test";

import { stamp_inspector_component_output, stamp_ree_i18n, stamp_ree_source } from "$lib/inspector_stamp";

describe("stamp_ree_source", () => {
	test("stamps ReeTags so their rendered components can open the invoking source", () => {
		const source = [
			'<input-text name="name"></input-text>',
			'<input-foreign-key name="developer_id"></input-foreign-key>',
			'<select-options name="status"></select-options>',
		].join("\n");

		const stamped = stamp_ree_source(source, "routes/example/form.ree");

		expect(stamped).toContain('<input-text data-ree="routes/example/form.ree:1" name="name">');
		expect(stamped).toContain('<input-foreign-key data-ree="routes/example/form.ree:2" name="developer_id">');
		expect(stamped).toContain('<select-options data-ree="routes/example/form.ree:3" name="status">');
	});

	test("continues to stamp native form elements", () => {
		const source = '<input name="name" />\n<select name="status"></select>';
		const stamped = stamp_ree_source(source, "routes/example/form.ree");

		expect(stamped).toContain('<input data-ree="routes/example/form.ree:1" name="name" />');
		expect(stamped).toContain('<select data-ree="routes/example/form.ree:2" name="status">');
	});

	test("marks a ReeTag label translation for inspector-only output stamping", () => {
		const source = '<input-foreign-key label="{_ labels.sensor_code}"></input-foreign-key>';
		const stamped = stamp_ree_i18n(source, "apps/main/metrics/form.ree");

		expect(stamped).toContain('data-ree-i18n="labels.sensor_code"');
		expect(stamped).toContain('data-ree-i18n-file="apps/main/metrics/form.ree"');
		expect(stamped).toContain('data-ree-i18n-target="label"');
	});

	test("maps a child section translation to its child namespace", () => {
		const source = '<h2>{_ children.metric_enum_values.parent_label}</h2>\n<input-text label="{_ children.metric_enum_values.child_fields.label}"></input-text>';
		const stamped = stamp_ree_i18n(source, "apps/main/metrics/form.ree");

		expect(stamped).toContain('data-ree-i18n="parent_label"');
		expect(stamped).toContain('data-ree-i18n="child_fields.label"');
		expect(stamped).toContain('data-ree-i18n-file="apps/main/metrics/metric_enum_values/index.ree"');
		expect(stamped).not.toContain('data-ree-i18n="children.metric_enum_values');
	});

	test("stamps a rendered component label without component support", () => {
		const rendered = '<field-wrapper><div><label class="px-3">Sensor code</label><select></select></div></field-wrapper>';
		const props = {
			locale: "sl-si",
			attributes: {
				"data-ree-i18n": "labels.sensor_code",
				"data-ree-i18n-file": "apps/main/metrics/form.ree",
				"data-ree-i18n-raw": "0",
				"data-ree-i18n-target": "label",
			},
		};

		expect(stamp_inspector_component_output(rendered, props)).toContain('<label data-ree-i18n="labels.sensor_code" data-ree-i18n-file="apps/main/metrics/form.ree" data-ree-i18n-raw="0" data-ree-i18n-locale="sl-si" class="px-3">');
	});
});
