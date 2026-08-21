import { describe, expect, test } from "bun:test";

import { stamp_ree_source } from "$lib/inspector_stamp";

describe("stamp_ree_source", () => {
	test("does not stamp ReeTags whose names start with native tag names", () => {
		const source = [
			'<input-text name="name"></input-text>',
			'<input-foreign-key name="developer_id"></input-foreign-key>',
			'<select-options name="status"></select-options>',
		].join("\n");

		const stamped = stamp_ree_source(source, "routes/example/form.ree");

		expect(stamped).toBe(source);
	});

	test("continues to stamp native form elements", () => {
		const source = '<input name="name" />\n<select name="status"></select>';
		const stamped = stamp_ree_source(source, "routes/example/form.ree");

		expect(stamped).toContain('<input data-ree="routes/example/form.ree:1" name="name" />');
		expect(stamped).toContain('<select data-ree="routes/example/form.ree:2" name="status">');
	});
});
