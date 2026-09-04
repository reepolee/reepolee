import { expect, test } from "bun:test";

import { generate_field_block, generate_form_ree } from "./form_ree";
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

test("generates the standalone localized text input", async () => {
	const field: FieldDef = { name: "title", type: "text", required: true, is_nullable: false };
	const output = await generate_field_block(field, new Map(), "articles", "", false, null, "flat", new Set(["title"]));

	expect(output).toBe('<localized-input-text name="title" label="{_ labels.title}" localization="{= props.localization }"></localized-input-text>');
});

test("tags fields read dynamic labels from form translations", async () => {
	const field: FieldDef = { name: "modules_tags", type: "tags", required: false, is_nullable: true };
	const output = await generate_field_block(field, new Map(), "users", "admin", false, null, "flat", new Set());

	expect(output).toContain("props.translations.modules_tags?.[tag.tag_key]");
	expect(output).not.toContain("{= modules_tags?.[tag.tag_key]");
});

test("generated form layout uses two field tracks and a third details track", async () => {
	const output = await generate_form_ree({
		table_name: "sensors",
		fields: [{ name: "code", type: "text", required: true, is_nullable: false }],
		foreign_keys: new Map(),
		localization_enabled: true,
		form_hints: true,
		form_details: true,
	});

	expect(output).toContain('class="grid w-full gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(22rem,2fr)] lg:gap-x-6"');
	expect(output).toContain('class="col-span-full grid gap-4 lg:col-span-2 lg:grid-cols-subgrid" data-localized-form id="entry-form"');
	expect(output).toContain('class="col-span-full grid gap-4 lg:col-span-2 lg:grid-cols-subgrid"');
	expect(output).toContain('class="col-span-full gap-4 grid empty:hidden lg:col-start-3 lg:self-start"');
	expect(output).toContain("data-localized-form");
	expect(output).toContain('{#layout("layout") }');
	expect(output).toContain("{#if record.id}{_ ui.edit_title }{:else}{_ ui.new_title }{/if}");
	expect(output).not.toContain("class=\"form-layout");
	expect(output).not.toContain("class=\"localized-form");
});

test("omits columns disabled by the config form flag", async () => {
	const output = await generate_form_ree({
		table_name: "sensors",
		fields: [
			{ name: "code", type: "text", required: true, is_nullable: false },
			{ name: "secret", type: "text", required: false, is_nullable: true },
			{ name: "protected", type: "text", required: false, is_nullable: true },
		],
		foreign_keys: new Map(),
		form_columns: { code: { form: true }, secret: { form: false } },
	});

	expect(output).toContain('name="code"');
	expect(output).not.toContain('name="secret"');
	expect(output).not.toContain('name="protected"');
});
