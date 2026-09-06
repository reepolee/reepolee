import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";
import TemplateEngine from "$lib/template_engine";
import { create_template_helpers } from "$lib/template_helpers";

const module_root = join(import.meta.dir, "..", "..", "..", "apps", "reeqa", "dashboard");
const engine = new TemplateEngine({
	views: process.cwd(),
	cache: false,
	ext: ".ree",
	helper_names: DEFAULT_HELPER_NAMES,
	route_module_mounts: [{ module_code: "dashboard", module_root }],
});

const render_data = {
	locale: "en-us",
	default_locale: "en-us",
	active_locales: ["en-us"],
	locale_names: { "en-us": "English" },
	theme_class: "",
	is_dev: false,
	version: "1",
	site_name: "ReeQA",
	translations: { ui: { title: "ReeQA" }, nav: {} },
	toasts: [],
	user: null,
	nav_groups: [],
	collapsed_nav_modules: [],
	path_locale: null,
	locale_preferred: null,
	dark_mode: false,
	busy_poller: true,
};

describe("ReeQA layout", () => {
	test("passes the project and page set selectors as sidebar-header children", async () => {
		const data = {
			...render_data,
			csrf_token: "test-token",
			reeqa_project_selector: {
				action: "/projects/active",
				next: "/",
				label: "Project",
				active_project_id: "1",
				projects: [{ id: "1", name: "Demo" }],
			},
			reeqa_page_set_selector: {
				action: "/page-sets/active",
				next: "/",
				label: "Page set",
				active_page_set_id: "1",
				page_sets: [{ id: "1", name: "Default", page_count: 1, capture_width: 1280 }],
			},
		};
		const html = await engine.render("dashboard/layout", { ...data, helpers: create_template_helpers(data) });

		expect(html).toContain('<select name="project_id" class="text-base w-full"');
		expect(html).toContain('<select name="page_set_id" class="text-base w-full"');
		expect(html).toContain("Default (1) · 1280px");
		// The ReeTag markers resolve to the component files, so the rendered
		// output carries each component's inner markup.
		expect(html).toContain('<nav class="flex flex-col min-h-0 flex-1 overflow-y-auto">');
		expect(html).toContain('<footer class="bottom flex flex-col gap-2 px-4 py-4">');
		// busy-poller is itself a ReeTag - it renders its component content.
		expect(html).toContain('id="translating-strip"');
	});

	test("renders no selectors when no project exists", async () => {
		const html = await engine.render("dashboard/layout", { ...render_data, helpers: create_template_helpers(render_data) });

		expect(html).not.toContain('name="project_id"');
		expect(html).not.toContain('name="page_set_id"');
		expect(html).toContain('<header class="top flex flex-col">');
	});
});
