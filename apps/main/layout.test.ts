import { join } from "node:path";

import { beforeAll, describe, expect, test } from "bun:test";

import { dev_app_links } from "$config/apps";
import { APPS_DIR } from "$config/paths";
import { RequestContext } from "$lib/request_context";
import { initialize_render, render_to_string } from "$lib/render";
import TemplateEngine from "$lib/template_engine";
import { create_template_helpers } from "$lib/template_helpers";
import { build_route_maps } from "$lib/route_map";
import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";

const engine = new TemplateEngine({ views: process.cwd(), cache: false, ext: ".ree", helper_names: DEFAULT_HELPER_NAMES });
const shared_layout_template = join(APPS_DIR, "layout");

// The current page is the localized Slovenian spelling of /products, served
// on a per-request origin - exactly the input the hreflang/og block consumes.
const render_data = {
	locale: "sl-si",
	request_url: "/izdelki?page=2",
	request_origin: "https://example.com",
	default_locale: "en-us",
	active_locales: ["sl-si", "en-us"],
	locale_names: { "en-us": "English", "sl-si": "Slovenščina" },
	theme_class: "",
	is_dev: false,
	version: "1",
	site_name: "Test",
	translations: { ui: { title: "Izdelki" }, nav: {} },
	toasts: [],
	user: null,
	nav_groups: [],
	collapsed_nav_modules: [],
	collapsed_nav_sections: [],
	manual_nav_modules: [],
	manual_nav_sections: [],
	nav_final_links: [],
	path_locale: null,
	locale_preferred: null,
	dark_mode: false,
	// helpers: injected via render data like render_to_string() does
};

// Flat (unlabeled) nav group with a flagged entry - mirrors the reeman app
// nav. required_module: null so user_has_module grants it to the anonymous
// test user.
const rule_nav_groups = [
	{
		label: "",
		items: [
			{ url: "/tables", nav_title_key: "tables", module: null, required_module: null, is_menu_entry: true, nav_rule_after: true },
			{ url: "/files", nav_title_key: "files", module: null, required_module: null, is_menu_entry: true },
		],
		sections: [],
	},
];

function render_layout_with_nav(nav_groups: any[]): Promise<string> {
	return engine.render(shared_layout_template, { ...render_data, nav_groups, helpers: create_template_helpers(render_data) });
}

function render_layout(): Promise<string> {
	return engine.render(shared_layout_template, { ...render_data, helpers: create_template_helpers(render_data) });
}

describe("layout presentation-boundary metadata", () => {
	beforeAll(() => {
		build_route_maps(
			{ "en-us": {}, "sl-si": { products: { route_name: "izdelki" } } },
			{ "/": {}, "/products": {} } as any,
			["en-us", "sl-si"] as any,
		);
	});

	test("html lang uses conventional BCP 47 casing", async () => {
		const html = await render_layout();
		expect(html).toContain('<html lang="sl-SI"');
	});

	test("renders an hreflang alternate for every active locale plus x-default", async () => {
		const html = await render_layout();
		expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://example.com/products?page=2" />');
		// The current page's own spelling, conventional-cased
		expect(html).toContain('<link rel="alternate" hreflang="sl-SI" href="https://example.com/izdelki?page=2" />');
		// The other locale's spelling of the same page
		expect(html).toContain('<link rel="alternate" hreflang="en-US" href="https://example.com/products?page=2" />');
	});

	test("renders og:locale and og:locale:alternate in underscore form", async () => {
		const html = await render_layout();
		expect(html).toContain('<meta property="og:locale" content="sl_SI" />');
		expect(html).toContain('<meta property="og:locale:alternate" content="en_US" />');
	});

	test("keeps the query string on every alternate URL", async () => {
		const html = await render_layout();
		expect(html).toContain("?page=2");
	});

	test("renders a horizontal rule after a nav_rule_after entry", async () => {
		const html = await render_layout_with_nav(rule_nav_groups);
		const flagged = html.indexOf('href="/tables"');
		const hr = html.indexOf("<hr");
		const files = html.indexOf('href="/files"');
		expect(flagged).toBeGreaterThan(-1);
		expect(hr).toBeGreaterThan(flagged);
		expect(files).toBeGreaterThan(hr);
		expect(html.match(/<hr/g)!.length).toBe(1);
	});

	test("does not render a rule when no entry is flagged", async () => {
		const html = await render_layout();
		expect(html).not.toContain("<hr");
	});

	test("renders a localized, independently collapsible section", async () => {
		const nav_groups = [{ label: "", items: [], sections: [{ key: "reeman.nav.data", title_key: "reeman.nav.data", order: 10, items: [{ url: "/tables", nav_title_key: "reeman.tables", required_module: null, is_menu_entry: true }] }] }];
		const section_data = { ...render_data, translations: { ui: { title: "Test" }, nav: { reeman: { nav: { data: "Data" }, tables: "Tables" } } } };
		const html = await engine.render(shared_layout_template, { ...section_data, nav_groups, helpers: create_template_helpers(section_data) });
		expect(html).toContain('data-nav-section="root:reeman.nav.data"');
		expect(html).toContain("Data");
		expect(html).toContain('href="/tables"');
	});

	test("opens the current section despite its collapsed cookie", async () => {
		const nav_groups = [{ label: "", items: [], sections: [{ key: "reeman.nav.data", title_key: "reeman.nav.data", order: 10, items: [{ url: "/tables", nav_title_key: "reeman.tables", required_module: null, is_menu_entry: true }] }] }];
		const section_data = { ...render_data, request_url: "/tables", collapsed_nav_sections: ["root:reeman.nav.data"], translations: { ui: { title: "Test", nav_group_auto: "Auto", nav_group_manual: "Manual" }, nav: { reeman: { nav: { data: "Data" }, tables: "Tables" } } } };
		const html = await engine.render(shared_layout_template, { ...section_data, nav_groups, helpers: create_template_helpers(section_data) });
		expect(html).toContain('data-nav-section="root:reeman.nav.data" data-nav-manual="false" open');
	});

	test("keeps manual sections closed and auto sections open for the current route", async () => {
		const nav_groups = [{ label: "", items: [], sections: [{ key: "reeman.nav.data", title_key: "reeman.nav.data", order: 10, items: [{ url: "/tables", nav_title_key: "reeman.tables", required_module: null, is_menu_entry: true }] }] }];
		const base_section_data = { ...render_data, request_url: "/tables", collapsed_nav_sections: ["root:reeman.nav.data"], translations: { ui: { title: "Test", nav_group_auto: "Auto", nav_group_manual: "Manual" }, nav: { reeman: { nav: { data: "Data" }, tables: "Tables" } } } };
		const auto_html = await engine.render(shared_layout_template, { ...base_section_data, nav_groups, helpers: create_template_helpers(base_section_data) });
		expect(auto_html).toContain('data-nav-section="root:reeman.nav.data" data-nav-manual="false" open');
		const manual_data = { ...base_section_data, manual_nav_sections: ["root:reeman.nav.data"] };
		const manual_html = await engine.render(shared_layout_template, { ...manual_data, nav_groups, helpers: create_template_helpers(manual_data) });
		expect(manual_html).toContain('data-nav-section="root:reeman.nav.data" data-nav-manual="true"');
		expect(manual_html).not.toContain('data-nav-section="root:reeman.nav.data" data-nav-manual="true" open');
		expect(manual_html).toContain('data-nav-section-mode-toggle');
	});

	test("keeps manual groups closed and auto groups open for the current route", async () => {
		const nav_groups = [{ label: "admin", items: [{ url: "/tables", nav_title_key: "tables", required_module: "admin", is_menu_entry: true }], sections: [] }];
		const base_group_data = { ...render_data, request_url: "/tables", user: { modules_tags: "admin" }, collapsed_nav_modules: ["admin"], translations: { ui: { title: "Test", nav_group_auto: "Auto", nav_group_manual: "Manual" }, nav: { tables: "Tables" }, nav_prefix_title: { admin: "Admin" } } };
		const auto_html = await engine.render(shared_layout_template, { ...base_group_data, nav_groups, helpers: create_template_helpers(base_group_data) });
		expect(auto_html).toContain('data-nav-module="admin" data-nav-manual="false" open');
		const manual_data = { ...base_group_data, manual_nav_modules: ["admin"] };
		const manual_html = await engine.render(shared_layout_template, { ...manual_data, nav_groups, helpers: create_template_helpers(manual_data) });
		expect(manual_html).toContain('data-nav-module="admin" data-nav-manual="true"');
		expect(manual_html).not.toContain('data-nav-module="admin" data-nav-manual="true" open');
		expect(manual_html).toContain('data-nav-mode-toggle');
	});

	test("keeps sidebar mode buttons outside navigation summaries", async () => {
		const nav_groups = [{ label: "admin", items: [], sections: [{ key: "admin.data", title_key: "admin.data", order: 10, items: [{ url: "/tables", nav_title_key: "tables", required_module: "admin", is_menu_entry: true }] }] }];
		const sidebar_data = { ...render_data, user: { modules_tags: "admin" }, translations: { ui: { title: "Test", nav_group_auto: "Auto", nav_group_manual: "Manual" }, nav: { tables: "Tables" }, nav_prefix_title: { admin: "Admin" } } };
		const html = await engine.render(shared_layout_template, { ...sidebar_data, nav_groups, helpers: create_template_helpers(sidebar_data) });
		const summaries = html.match(/<summary\b[\s\S]*?<\/summary>/g) ?? [];
		const section_start = html.indexOf('data-nav-section="admin:admin.data"');
		const section_end = html.indexOf("</details>", section_start);
		const section_button = html.indexOf("data-nav-section-mode-toggle");
		const group_end = html.indexOf("</details>", html.indexOf('data-nav-module="admin"'));
		const group_button = html.indexOf("data-nav-mode-toggle");

		expect(summaries).toHaveLength(3);
		expect(summaries.every((summary) => !summary.includes("<button"))).toBe(true);
		expect(section_button).toBeGreaterThan(section_end);
		expect(group_button).toBeGreaterThan(group_end);
	});

	test("keeps bootstrap development app links in the render pipeline", async () => {
		const captured_data: { value: Record<string, any> | null } = { value: null };
		initialize_render(
			{
				render: async (_name: string, data: Record<string, any> = {}) => {
					captured_data.value = data;
					return "ok";
				},
			},
			{ is_dev: true, dev_apps: dev_app_links("reeqa", { REEQA_PORT: "2340" }) },
		);

		const req = { url: "http://localhost/", headers: { get: () => null } } as any;
		const ctx = new RequestContext(req);
		ctx.request_url = "/";
		ctx.locale = "en-us";
		ctx.translations = { ui: { title: "Test" }, nav: {} };
		ctx.user = { modules_tags: "system" };

		await render_to_string("layout", { ctx, is_partial: true });

		expect(captured_data.value?.dev_apps.map((app: { name: string }) => app.name)).toEqual(["main", "reeman", "reeqa"]);
		expect(captured_data.value?.dev_apps.find((app: { name: string; current?: boolean }) => app.current)?.name).toBe("reeqa");
	});

	test("renders the development app switcher with module-gated links", async () => {
		const switcher_data = {
			...render_data,
			is_dev: true,
			show_app_switcher: true,
			app_name: "main",
			dev_apps: dev_app_links("main", { REEQA_PORT: "2340" }),
			user: { modules_tags: "system" },
			translations: {
				ui: { title: "Izdelki", app_switcher: "Apps", apps: { main: "Main", reeman: "Reeman", reeqa: "ReeQA" } },
				nav: {},
			},
		};
		const html = await engine.render(shared_layout_template, { ...switcher_data, helpers: create_template_helpers(switcher_data) });

		expect(html).toContain('aria-label="Apps"');
		expect(html).toContain('aria-current="page"');
		expect(html).toContain('href="http://localhost:2339/"');
		expect(html).toContain('href="http://localhost:2340/"');
		expect(html).toContain('class="ml-auto flex items-center gap-1" aria-label="Apps"');
		expect(html).not.toContain('data-dev-app-switcher');
		expect(html).not.toContain("new AbortController()");
		expect(html).toContain('class="flex items-center justify-between gap-2 px-4 py-4"');
		expect(html).toContain('class="w-24"');
		expect(html).toContain('<summary class="cursor-pointer list-none font-semibold pl-2">');
		expect(html.indexOf('aria-label="Apps"')).toBeLessThan(html.indexOf('<footer class="bottom px-4 py-4">'));
		expect(html).toContain('<aside class="flex flex-col bg-neutral-200  border-r border-r-neutral-300 h-screen sticky top-0 max-xl:hidden">');
		expect(html).toContain('<header class="top flex flex-col">');
		expect(html).toContain('<nav class="flex flex-col min-h-0 flex-1 overflow-y-auto">');
		expect(html).toContain('<footer class="bottom px-4 py-4">');
		expect(html).toContain('class="as-icon text-xs hover:border-neutral-300 hover:bg-neutral-100');
		expect(html).toContain('<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="size-4 text-brand"');
		expect(html).toContain("<details");
		expect(html.match(/<svg/g)!.length).toBe(3);
	});

	test("hides module-gated app links from anonymous users", async () => {
		const switcher_data = {
			...render_data,
			is_dev: true,
			show_app_switcher: true,
			app_name: "main",
			dev_apps: dev_app_links("main", { REEQA_PORT: "2340" }),
			translations: {
				ui: { title: "Izdelki", app_switcher: "Apps", apps: { main: "Main", reeman: "Reeman", reeqa: "ReeQA" } },
				nav: {},
			},
		};
		const html = await engine.render(shared_layout_template, { ...switcher_data, helpers: create_template_helpers(switcher_data) });

		expect(html).toContain('aria-label="Apps"');
		expect(html).not.toContain('href="http://localhost:2339/"');
		expect(html).not.toContain('href="http://localhost:2340/"');
	});

	test("does not render the app switcher for a single development app", async () => {
		const switcher_data = {
			...render_data,
			is_dev: true,
			show_app_switcher: false,
			dev_apps: dev_app_links("main", { REEQA_PORT: "2340" }),
			user: { modules_tags: "system" },
			translations: {
				ui: { title: "Izdelki", app_switcher: "Apps", apps: { main: "Main", reeman: "Reeman", reeqa: "ReeQA" } },
				nav: {},
			},
		};
		const html = await engine.render(shared_layout_template, { ...switcher_data, helpers: create_template_helpers(switcher_data) });

		expect(html).not.toContain('aria-label="Apps"');
	});

	test("does not render the app switcher in production", async () => {
		const html = await render_layout();

		expect(html).not.toContain('aria-label="Apps"');
		expect(html).not.toContain('href="http://localhost:2339/"');
	});

	test("locale switcher shows full locale names in the preferences panel", async () => {
		const html = await render_layout();
		const switcher = html.slice(html.indexOf('aria-label="Language"'), html.indexOf('</nav>', html.indexOf('aria-label="Language"')));
		expect(switcher).toContain('>Slovenščina</span>');
		expect(switcher).toContain('>English</a>');
	});

	test("uses base text in sidebar dropdowns", async () => {
		const sidebar_data = {
			...render_data,
			active_locales: ["sl-si", "en-us", "de-de", "fr-fr", "it-it", "hr-hr"],
			locale_names: {
				"en-us": "English",
				"sl-si": "Slovenščina",
				"de-de": "Deutsch",
				"fr-fr": "Français",
				"it-it": "Italiano",
				"hr-hr": "Hrvatski",
			},
			csrf_token: "test-token",
		};
		const html = await engine.render(shared_layout_template, { ...sidebar_data, helpers: create_template_helpers(sidebar_data) });

		expect(html).toContain('aria-label="Language" class="w-full grid gap-1"');
	});

	test("dropup shows the profile link for a signed-in user", async () => {
		const footer_data = {
			...render_data,
			user: { display_name: "Jane Doe", modules_tags: "system" },
			nav_final_links: [
				{ key: "profile", url: "/profile", nav_title_key: "nav_auth.profile", nav_final_order: 10, requires_user: true },
				{ key: "login", url: "/login", nav_title_key: "nav_auth.login", nav_final_order: 20, requires_user: false },
			],
			translations: { ui: { title: "Izdelki" }, nav: {}, nav_auth: { login: "Login", profile: "Profile" } },
		};
		const html = await engine.render(shared_layout_template, { ...footer_data, helpers: create_template_helpers(footer_data) });

		// The signed-in profile action uses the stable localized caption.
		expect(html).toMatch(/href="\/profile"[^>]*>\s*Profile\s*<\/a>/);
		// The login link is for anonymous users only.
		expect(html).not.toMatch(/>\s*Login\s*<\/a>/);
	});

	test("dropup shows the login link for anonymous users", async () => {
		const footer_data = {
			...render_data,
			nav_final_links: [
				{ key: "profile", url: "/profile", nav_title_key: "nav_auth.profile", nav_final_order: 10, requires_user: true },
				{ key: "login", url: "/login", nav_title_key: "nav_auth.login", nav_final_order: 20, requires_user: false },
			],
			translations: { ui: { title: "Izdelki" }, nav: {}, nav_auth: { login: "Login" } },
		};
		const html = await engine.render(shared_layout_template, { ...footer_data, helpers: create_template_helpers(footer_data) });

		expect(html).toMatch(/href="\/login"[^>]*>\s*Login\s*<\/a>/);
		expect(html).not.toContain('href="/profile"');
	});

	test("shared layout stays a pure shell - no app-specific sidebar sections", async () => {
		const html = await render_layout();

		// The shared layout composes the sidebar tags only; app content lives
		// in each app's own layout as sidebar-header children (reeqa selectors,
		// the studio file picker), never here.
		expect(html).toContain('<aside class="flex flex-col bg-neutral-200  border-r border-r-neutral-300 h-screen sticky top-0 max-xl:hidden">');
		// The ReeTag markers resolve to the component files, so the rendered
		// output carries each component's inner markup.
		expect(html).toContain('<header class="top flex flex-col">');
		expect(html).toContain('<nav class="flex flex-col min-h-0 flex-1 overflow-y-auto">');
		expect(html).toContain('<footer class="bottom px-4 py-4">');

		expect(html).not.toContain('name="project_id"');
		expect(html).not.toContain('name="page_set_id"');
		expect(html).not.toContain('name="path"');
		expect(html).not.toContain('commandfor="adapt-schema-dialog"');
		expect(html).not.toContain("v_frameworks");
	});
});
