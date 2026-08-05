import { beforeAll, describe, expect, test } from "bun:test";

import TemplateEngine from "$lib/template_engine";
import { create_template_helpers } from "$lib/template_helpers";
import { build_route_maps } from "$lib/route_map";

const engine = new TemplateEngine({ views: process.cwd(), cache: false, ext: ".ree" });

// The current page is the localized Slovenian spelling of /products, served
// on a per-request origin - exactly the input the hreflang/og block consumes.
const render_data = {
	locale: "sl-si",
	request_url: "/izdelki?page=2",
	request_origin: "https://example.com",
	default_locale: "en-us",
	active_locales: ["sl-si", "en-us"],
	locale_names: { "en-us": "EN", "sl-si": "SL" },
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

function render_layout(): Promise<string> {
	return engine.render("routes/layout", { ...render_data, helpers: create_template_helpers(render_data) });
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
});
