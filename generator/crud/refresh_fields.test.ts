import { expect, test } from "bun:test";

import { sync_details_container } from "./refresh_fields";

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
