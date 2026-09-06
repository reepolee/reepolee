import { expect, test } from "bun:test";

import { generate_field_block, generate_form_ree, generate_input_field } from "./form_ree";
import type { FieldDef } from "./types";

test("read-only fields render a static value without a submitted editor", async () => {
	const field: FieldDef = { name: "code", type: "text", required: true, is_nullable: false };
	const output = await generate_field_block(field, new Map(), "sensors", "", false, null, "tags", new Set(), new Set(["code"]));

	expect(output).toContain('<display-readonly name="code"');
	expect(output).not.toContain("<input");
	expect(output).toContain('{= props.record.code }');
});

test("read-only overrides localization and replaces the editable flat field", async () => {
	const field: FieldDef = { name: "url", type: "text", required: true, is_nullable: false };
	const output = await generate_field_block(field, new Map(), "history_views", "admin", false, null, "flat", new Set(["url"]), new Set(["url"]));

	expect(output).not.toContain("localized-field-tabs");
	expect(output).toContain('<display-readonly name="url"');
	expect(output).not.toContain("<input");
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

test("textarea fields render textarea controls in both generator modes", async () => {
	const field: FieldDef = { name: "short_description", type: "textarea", required: false, is_nullable: true };

	const flat_output = await generate_input_field(field, new Map());
	const tags_output = await generate_input_field(field, new Map(), "articles", "", false, null, "tags");

	expect(flat_output).toContain('<textarea id="short_description" name="short_description">');
	expect(tags_output).toContain('<input-textarea name="short_description"');
});

test("generated flat field labels are semibold", async () => {
	const field: FieldDef = { name: "title", type: "text", required: true, is_nullable: false };
	const output = await generate_input_field(field, new Map());

	expect(output).toContain('class="px-3 font-semibold"');
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

	expect(output).toContain('class="grid w-full gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(22rem,1fr)] lg:gap-x-6"');
	expect(output).toContain('class="col-span-full grid gap-4 lg:col-span-2 lg:grid-cols-subgrid" data-localized-form id="entry-form"');
	expect(output).toContain('class="col-span-full grid gap-4 lg:col-span-full lg:grid-cols-subgrid"');
	expect(output).toContain('class="col-span-full gap-4 grid empty:hidden lg:col-start-3 lg:self-start"');
	expect(output).toContain("data-localized-form");
	expect(output).toContain('{#layout("layout") }');
	expect(output).toContain("{#if record.id}{_ ui.edit_title }{:else}{_ ui.new_title }{/if}");
	expect(output).not.toContain("class=\"form-layout");
	expect(output).not.toContain("class=\"localized-form");
});

test("splits more than ten editable fields into two initial columns when a track is unused", async () => {
	const fields: FieldDef[] = Array.from({ length: 11 }, (_, index) => ({
		name: `field_${index + 1}`,
		type: "text",
		required: false,
		is_nullable: true,
	}));
	const output = await generate_form_ree({ table_name: "sensors", fields, foreign_keys: new Map() });

	expect(output).toContain('class="generated-form-field-column grid gap-4"');
	expect(output).toContain('name="field_11"');
	const first_column = output.indexOf('class="generated-form-field-column grid gap-4"');
	const second_column = output.indexOf('class="generated-form-field-column grid gap-4"', first_column + 1);
	expect(output.indexOf('name="field_10"')).toBeLessThan(second_column);
	expect(output.indexOf('name="field_11"')).toBeGreaterThan(second_column);
});

test("keeps a long form in one field column when hints and details occupy both other tracks", async () => {
	const fields: FieldDef[] = Array.from({ length: 11 }, (_, index) => ({
		name: `field_${index + 1}`,
		type: "text",
		required: false,
		is_nullable: true,
	}));
	const output = await generate_form_ree({ table_name: "sensors", fields, foreign_keys: new Map(), form_hints: true, form_details: true });

	expect(output).not.toContain("generated-form-field-column");
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

test("renders selected view fields as readonly displays", async () => {
	const output = await generate_form_ree({
		table_name: "teams",
		fields: [{ name: "title", type: "text", required: true, is_nullable: false }],
		v_fields: [{ name: "total_amount", type: "number", required: false, is_nullable: true }],
		foreign_keys: new Map(),
		form_columns: { total_amount: { form: true, readonly: true } },
	});

	expect(output).toContain('<display-readonly name="total_amount"');
	expect(output).toContain('{_ v_labels.total_amount}');
	expect(output).toContain('{= props.record.total_amount }');
	expect(output).not.toContain('<input-text name="total_amount"');
});
