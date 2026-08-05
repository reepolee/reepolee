import { afterAll, describe, expect, mock, test } from "bun:test";

import { mock_db } from "$root/test_helpers";

mock.module("$config/db", mock_db);
mock.module("$lib/bundle_cache", () => ({
	get_or_bundle: async () => "/bundles/should-not-be-called.js",
	invalidate_cache: () => {},
}));

const _restore_group_js = process.env.GROUP_JS;
process.env.GROUP_JS = "false";

const { move_styles_and_scripts_to_head } = await import("./render");

afterAll(() => {
	if (_restore_group_js === undefined) delete process.env.GROUP_JS;
	else process.env.GROUP_JS = _restore_group_js;
});

describe("move_styles_and_scripts_to_head with GROUP_JS=false", () => {
	test("relocates scripts to head without bundling them", async () => {
		const html = `<html><head></head><body><script src="a.js"></script><script src="b.js" defer></script></body></html>`;
		const result = await move_styles_and_scripts_to_head(html);
		expect(result).toContain('<script src="a.js"></script>');
		expect(result).toContain('<script src="b.js" defer></script>');
		expect(result).not.toContain("/bundles/");
	});
});
