import { expect, test } from "bun:test";
import { join } from "node:path";

import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";
import { create_template_helpers } from "$lib/template_helpers";
import { MAIN_APP } from "$config/paths";

const TE = (await import("$lib/template_engine")).default;

test("kitchen_sink page renders <star-rating> from its route subfolder", async () => {
	// The real project layout + kitchen-sink page, rendered with the
	// minimal props layout.test.ts proves works. star-rating lives in
	// <main app>/examples/kitchen_sink/, so this exercises the routes-tree
	// ReeTag fallback end-to-end (components/ has no star-rating.ree).
	const routes_dir = join(process.cwd(), MAIN_APP);
	const engine = new TE({ views: routes_dir, cache: false, ext: ".ree", helper_names: DEFAULT_HELPER_NAMES });
	const props = {
		locale: "en-us",
		is_dev: false,
		version: "test",
		site_name: "Test",
		year: 2026,
		nav_groups: [],
		active_locales: [],
		locale_names: {},
		user: null,
		toasts: [],
		collapsed_nav_modules: [],
		path_locale: null,
		locale_preferred: null,
		dark_mode: false,
		theme_class: "",
		translations: {
			ui: { title: "Kitchen Sink", description: "All the widgets" },
			nav_auth: { login: "Login" },
			errors: {},
			labels: {},
			descriptions: {},
			messages: {},
		},
	};
	const rendered = await engine.render("examples/kitchen_sink/kitchen_sink", { ...props, helpers: create_template_helpers(props) });
	const html = rendered.replace(/ data-ree="[^"]*"/g, "");
	// The star-rating widget output (moved component, resolved via the routes tree):
	expect(html).toContain('<input type="hidden" name="rating" data-rating-hidden value="0" />');
	expect(html).toContain("data-rating-star=\"1\"");
	expect(html).toContain("★");
	// And the layout still renders around it:
	expect(html).toContain('<html lang="en-US"');
});
