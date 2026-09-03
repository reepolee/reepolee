import { expect, test } from "bun:test";

import { smart_merge_fields } from "./helpers";

test("refreshing a tags form as flat replaces tags instead of duplicating fields", () => {
	const old_section = `
<input-text name="code" label="Code" value="{= record.code }"></input-text>
<input-text name="min_value" label="Min value" value="{= record.min_value }"></input-text>`;
	const new_fields = [
		'<field-wrapper class="grid" data-field="code"><input name="code" /></field-wrapper>',
		'<field-wrapper class="grid" data-field="min_value"><input type="number" name="min_value" /></field-wrapper>',
	];

	const merged = smart_merge_fields(old_section, new_fields, "flat");

	expect(merged).not.toContain("<input-text");
	expect(merged.match(/data-field="code"/g)?.length).toBe(1);
	expect(merged.match(/data-field="min_value"/g)?.length).toBe(1);
});

test("refreshing a flat form as tags replaces field wrappers instead of duplicating fields", () => {
	const old_section = `
<field-wrapper class="grid" data-field="code"><input name="code" /></field-wrapper>
<field-wrapper class="grid" data-field="min_value"><input type="number" name="min_value" /></field-wrapper>`;
	const new_fields = [
		'<input-text name="code" label="Code" value="{= record.code }"></input-text>',
		'<input-text name="min_value" label="Min value" value="{= record.min_value }"></input-text>',
	];

	const merged = smart_merge_fields(old_section, new_fields, "tags");

	expect(merged).not.toContain("<field-wrapper");
	expect(merged.match(/name="code"/g)?.length).toBe(1);
	expect(merged.match(/name="min_value"/g)?.length).toBe(1);
});
