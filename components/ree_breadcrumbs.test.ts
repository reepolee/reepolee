import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import TemplateEngine from "$lib/template_engine";
import { MAIN_APP } from "$config/paths";

const engine = new TemplateEngine({ views: join(process.cwd(), MAIN_APP), project_root: process.cwd(), cache: false, ext: ".ree", helper_names: ["localized_path"] });
const helpers = { localized_path: (path: string) => `/localized${path}` };

async function render_breadcrumbs(items: { label: string; href?: string; }[]): Promise<string> {
	const template = `<ree-breadcrumbs items="{= props.items }"></ree-breadcrumbs>`;
	return engine.render_string(template, { items, helpers });
}

describe("ree-breadcrumbs", () => {
	test("renders linked ancestors and marks the final item as current", async () => {
		const html = await render_breadcrumbs([
			{ label: "Translations", href: "/translations" },
			{ label: "database" },
			{ label: "hints" },
		]);

		expect(html).toContain('aria-label="Breadcrumb"');
		expect(html).toContain('href="/localized/translations"');
		expect(html).toContain(">Translations</a>");
		expect(html).toContain(">hints</span>");
		expect(html.match(/aria-current="page"/g)?.length).toBe(1);
		expect(html.match(/size-5 shrink-0/g)?.length).toBe(2);
	});

	test("renders nothing when there are no items", async () => {
		const html = await render_breadcrumbs([]);

		expect(html.trim()).toBe("");
	});
});
