import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { MAIN_APP } from "$config/paths";
import { render_icon } from "$lib/ree_icon";
import TemplateEngine from "$lib/template_engine";

const engine = new TemplateEngine({ views: join(process.cwd(), MAIN_APP), project_root: process.cwd(), cache: false, ext: ".ree", helper_names: ["render_icon"] });
const helpers = { render_icon };

describe("ree-icon", () => {
	test("renders the shared icon with the component class", async () => {
		const html = await engine.render_string('<ree-icon name="search" class="size-5"></ree-icon>', { helpers });

		expect(html).toContain('class="size-5"');
		expect(html).toContain('stroke-linejoin="round"');
	});

	test("renders no markup for an unknown icon", async () => {
		const html = await engine.render_string('<ree-icon name="unknown"></ree-icon>', { helpers });

		expect(html.trim()).toBe("");
	});
});
