import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const layout_source = await Bun.file(join(import.meta.dir, "layout.ree")).text();

describe("Studio layout", () => {
	test("uses the standard logo width", () => {
		expect(layout_source).toContain('<img class="w-24" src="{= props.dark_mode ? \'/logo-light.svg\' : \'/logo-dark.svg\' }" alt="Reepolee logo" />');
	});

	test("uses base text for sidebar dropdowns", () => {
		expect(layout_source).toContain('<select name="path" class="text-base w-full"');
		expect(layout_source).toContain('class="text-base w-36 px-2 py-1"');
	});
});
