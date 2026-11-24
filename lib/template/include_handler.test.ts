import { expect, test } from "bun:test";

import { stamp_inspector_component_output } from "$lib/inspector_stamp";

test("carries a ReeTag inspector stamp to the component root", () => {
	const rendered = '<div class="field"><select name="sensor_code"></select></div>';
	const props = { attributes: { "data-ree": "apps/main/metrics/form.ree:32" } };

	expect(stamp_inspector_component_output(rendered, props)).toBe('<div data-ree="apps/main/metrics/form.ree:32" class="field"><select name="sensor_code"></select></div>');
});

test("does not replace a component's own source stamp", () => {
	const rendered = '<div data-ree="components/field.ree:1"></div>';
	const props = { attributes: { "data-ree": "apps/main/metrics/form.ree:32" } };

	expect(stamp_inspector_component_output(rendered, props)).toBe(rendered);
});
