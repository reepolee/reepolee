import { expect, test } from "bun:test";

import { form_fields_previous_comment, preserve_previous_form_fields, sync_details_container } from "./refresh_fields";

test("fields refresh enables the generated details slot when configured", () => {
	const form = '<aside class="col-span-full gap-4 hidden" data-form-details></aside>';
	const refreshed = sync_details_container(form, true);

	expect(refreshed).toBe('<aside class="col-span-full gap-4 grid empty:hidden lg:col-start-3 lg:self-start" data-form-details></aside>');
});

test("fields refresh hides the generated details slot when disabled", () => {
	const form = '<aside class="col-span-full gap-4 grid empty:hidden lg:col-start-3 lg:self-start" data-form-details></aside>';
	const refreshed = sync_details_container(form, false);

	expect(refreshed).toBe('<aside class="col-span-full gap-4 hidden" data-form-details></aside>');
});

test("manual field refresh comments only the changed previous field under its replacement", () => {
	const proposal = form_fields_previous_comment(
		'<input-text name="title"></input-text>\n<input-text name="school"></input-text>',
		'<display-readonly name="title"></display-readonly>\n<input-text name="school"></input-text>',
	);

	expect(proposal).toContain('<display-readonly name="title"></display-readonly>\n<!-- GEN:FIELDS:PREVIOUS:title:START -->');
	expect(proposal).toContain('<!-- <input-text name="title"></input-text> -->');
	expect(proposal).not.toContain('<!-- <input-text name="school"></input-text> -->');
});

test("manual field refresh keeps reordered tags in their previous positions", () => {
	const proposal = form_fields_previous_comment(
		'<div class="left"><input-text name="school"></input-text></div>\n<div class="right"><input-text name="title"></input-text></div>',
		'<input-text name="title" label="Title"></input-text>\n<input-text name="school"></input-text>\n<input-text name="city"></input-text>',
	);

	expect(proposal.indexOf('name="school"')).toBeLessThan(proposal.indexOf('name="title"'));
	expect(proposal).toContain('<div class="left"><input-text name="school"></input-text></div>');
	expect(proposal).toContain('<input-text name="city"></input-text>');
});

test("manual field refresh keeps reordered flat wrappers in their previous positions", () => {
	const proposal = form_fields_previous_comment(
		'<field-wrapper data-field="school"><input name="school" /></field-wrapper>\n<field-wrapper data-field="title"><input name="title" /></field-wrapper>',
		'<field-wrapper data-field="title"><input name="title" class="fresh" /></field-wrapper>\n<field-wrapper data-field="school"><input name="school" /></field-wrapper>',
	);

	expect(proposal.indexOf('data-field="school"')).toBeLessThan(proposal.indexOf('data-field="title"'));
	expect(proposal).toContain('class="fresh"');
});

test("manual field refresh puts removed previous fields at the end", () => {
	const proposal = form_fields_previous_comment(
		'<input-text name="title"></input-text>\n<input-text name="school"></input-text>',
		'<input-text name="title"></input-text>',
	);

	expect(proposal.endsWith("<!-- GEN:FIELDS:PREVIOUS:school:END -->")).toBe(true);
	expect(proposal).toContain('<!-- <input-text name="school"></input-text> -->');
	expect(proposal).toContain("<!-- Removed field from the previous rendering: school -->");
});

test("full regeneration keeps manual fields as comments beneath fresh fields", () => {
	const existing = `<!-- GEN:FIELDS:START:sha256:0000000000000000000000000000000000000000000000000000000000000000 -->\n<input-text name="title"></input-text>\n<!-- GEN:FIELDS:END -->`;
	const fresh = `<!-- GEN:FIELDS:START -->\n<display-readonly name="title"></display-readonly>\n<!-- GEN:FIELDS:END -->`;
	const regenerated = preserve_previous_form_fields(fresh, existing);

	expect(regenerated).toContain('<display-readonly name="title"></display-readonly>');
	expect(regenerated).toContain('<!-- <input-text name="title"></input-text> -->');
});
