import { expect, test } from "bun:test";

import { generate_field_block } from "./form_ree";
import type { FieldDef } from "./types";

test("read-only fields render a static value without a submitted editor", async () => {
	const field: FieldDef = { name: "code", type: "text", required: true, is_nullable: false };
	const output = await generate_field_block(field, new Map(), "sensors", "", false, null, "tags", new Set(), new Set(["code"]));

	expect(output).not.toContain('name="code"');
	expect(output).toContain('{= props.record.code }');
});
