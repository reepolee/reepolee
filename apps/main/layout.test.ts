import { beforeAll, describe, expect, test } from "bun:test";

import { dev_app_links } from "$config/apps";
import { MAIN_APP_POSIX } from "$config/paths";
import { RequestContext } from "$lib/request_context";
import { initialize_render, render_to_string } from "$lib/render";
import TemplateEngine from "$lib/template_engine";
import { create_template_helpers } from "$lib/template_helpers";
import { build_route_maps } from "$lib/route_map";
import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";

const engine = new TemplateEngine({ views: process.cwd(), cache: false, ext: ".ree", helper_names: DEFAULT_HELPER_NAMES });

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
	},
];

function render_layout_with_nav(nav_groups: any[]): Promise<string> {
	return engine.render(`${MAIN_APP_POSIX}/layout`, { ...render_data, nav_groups, helpers: create_template_helpers(render_data) });
}

function render_layout(): Promise<string> {
	return engine.render(`${MAIN_APP_POSIX}/layout`, { ...render_data, helpers: create_template_helpers(render_data) });
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

	test("keeps bootstrap development app links in the render pipeline", async () => {
		const captured_data: { value: Record<string, any> | null } = { value: null };
		initialize_render(
			{
				render: async (_name: string, data: Record<string, any> = {}) => {
					captured_data.value = data;
					return "ok";
				},
			},
			{ is_dev: true, dev_apps: dev_app_links("reeqa", {}) },
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
			app_name: "main",
			dev_apps: dev_app_links("main", {}),
			user: { modules_tags: "system" },
			translations: {
				ui: { title: "Izdelki", app_switcher: "Apps", apps: { main: "Main", reeman: "Reeman", reeqa: "ReeQA" } },
				nav: {},
			},
		};
		const html = await engine.render(`${MAIN_APP_POSIX}/layout`, { ...switcher_data, helpers: create_template_helpers(switcher_data) });

		expect(html).toContain('aria-label="Apps"');
		expect(html).toContain('aria-current="page"');
		expect(html).toContain('href="http://localhost:2339/"');
		expect(html).toContain('href="http://localhost:2340/"');
		expect(html).toContain('data-dev-app-switcher hidden class="ml-auto flex items-center gap-1"');
		expect(html).toContain("new AbortController()");
		expect(html).toContain('mode: "no-cors"');
		// LAN access: localhost links are rewritten to the host the page was served from
		expect(html).toContain('app_link.href.startsWith("http://localhost:")');
		expect(html).toContain('app_link.href.replace("http://localhost:", `http://${server_host}:`)');
		expect(html).toContain('class="flex items-center justify-between gap-2 px-4 mb-4"');
		expect(html).toContain('class="w-24"');
		expect(html).toContain('class="flex items-center gap-2 font-semibold pl-2"');
		expect(html.indexOf('aria-label="Apps"')).toBeLessThan(html.indexOf('class="bottom flex flex-col'));
		expect(html).toContain('class="cursor-pointer px-2 py-1 text-xs rounded border border-transparent no-underline hover:border-neutral-300 hover:bg-neutral-100');
		expect(html).toContain('<svg class="size-4 text-brand" viewBox="0 0 24 24"');
		expect(html).not.toContain("<details");
		expect(html.match(/<svg/g)!.length).toBe(3);
	});

	test("hides module-gated app links from anonymous users", async () => {
		const switcher_data = {
			...render_data,
			is_dev: true,
			app_name: "main",
			dev_apps: dev_app_links("main", {}),
			translations: {
				ui: { title: "Izdelki", app_switcher: "Apps", apps: { main: "Main", reeman: "Reeman", reeqa: "ReeQA" } },
				nav: {},
			},
		};
		const html = await engine.render(`${MAIN_APP_POSIX}/layout`, { ...switcher_data, helpers: create_template_helpers(switcher_data) });

		expect(html).toContain('aria-label="Apps"');
		expect(html).not.toContain('href="http://localhost:2339/"');
		expect(html).not.toContain('href="http://localhost:2340/"');
	});

	test("does not render the app switcher in production", async () => {
		const html = await render_layout();

		expect(html).not.toContain('aria-label="Apps"');
		expect(html).not.toContain('href="http://localhost:2339/"');
	});

	test("locale switcher shows short codes on links", async () => {
		const html = await render_layout();
		const switcher = html.slice(html.indexOf('aria-label="Language"'), html.indexOf('</div>', html.indexOf('aria-label="Language"')));
		// Active locale: font-bold only - no bg, border, or text color
		expect(switcher).toContain('<span aria-current="true" class="text-xs px-2 py-1 font-bold"');
		expect(switcher).not.toContain('bg-brand');
		expect(switcher).not.toContain('border-brand');
		expect(switcher).not.toContain('text-white');
		// Both locales render as their uppercase short codes, full name in tooltip
		expect(switcher).toContain('>SL</span>');
		expect(switcher).toContain('>EN</a>');
		expect(switcher).toContain('title="English"');
		expect(switcher).toContain('title="Slovenščina"');
	});
});
