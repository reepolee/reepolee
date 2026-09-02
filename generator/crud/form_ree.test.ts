import { expect, test } from "bun:test";

import { generate_field_block } from "./form_ree";
import type { FieldDef } from "./types";

test("read-only fields render a static value without a submitted editor", async () => {
	const field: FieldDef = { name: "code", type: "text", required: true, is_nullable: false };
	const output = await generate_field_block(field, new Map(), "sensors", "", false, null, "tags", new Set(), new Set(["code"]));

	expect(output).not.toContain('name="code"');
	expect(output).toContain('{= props.record.code }');
});

test("read-only overrides localization and replaces the editable flat field", async () => {
	const field: FieldDef = { name: "url", type: "text", required: true, is_nullable: false };
	const output = await generate_field_block(field, new Map(), "history_views", "admin", false, null, "flat", new Set(["url"]), new Set(["url"]));

	expect(output).not.toContain("localized-field-tabs");
	expect(output).not.toContain('name="url"');
	expect(output).toContain('{= props.record.url }');
});
