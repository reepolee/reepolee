import { describe, expect, test } from "bun:test";

import TemplateEngine from "$lib/template_engine";
import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";

// Direct component renders (render("components/ree-filters", ...)) resolve names
// relative to views_dir, so this one points at the project root - the same
// pattern as components/localized_components.test.ts.
const engine = new TemplateEngine({ views: process.cwd(), cache: false, ext: ".ree", helper_names: DEFAULT_HELPER_NAMES });
// ree-filters calls localized_path() in its inline script.
const helpers = { localized_path: (p: string) => p };

// The merged route translations shape: route namespaces fall back to the root
// locale tree, so a route without its own "search" namespace still gets the
// generic search_term (e.g. "Iskanje ...").
const TRANSLATIONS = {
	search: { search_term: "Iskanje ...", submit: "Išči" },
	ui: {
		labels: "Filtri",
		records: "zapis(ov)",
		clear_all: "Počisti vse",
		filter_not: "Ne",
		show_more: "Pokaži več",
		show_less: "Pokaži manj",
		apply_filters: "Uporabi filtre",
	},
};

function render(props: Record<string, any> = {}): Promise<string> {
	return engine.render("components/ree-filters", { translations: TRANSLATIONS, helpers, ...props });
}

// A minimal enriched filter definition that renders the expandable group
// (has_more) and the apply/clear footer of the filter panel.
const FILTER_DEFS = [
	{ key: "status", type: "fk", display_label: "Status", is_not: false, has_more: true, visible_options: [], hidden_options: [] },
];

describe("ree-filters", () => {
	test("translates the search placeholder from props.translations", async () => {
		const html = await render();
		expect(html).toContain('placeholder="Iskanje ..."');
	});

	test("renders the {search_term} miss-marker when no translation exists", async () => {
		const html = await engine.render("components/ree-filters", { helpers });
		expect(html).toContain('placeholder="{search_term}"');
	});

	test("translates the filter panel from props.translations when no ui prop is passed", async () => {
		const html = await render({ filter_definitions: FILTER_DEFS, active_filter_count: 1 });
		expect(html).toContain("Uporabi filtre");
		expect(html).toContain("Počisti vse");
		expect(html).toContain('data-show-more="Pokaži več"');
		expect(html).toContain('data-show-less="Pokaži manj"');
	});

	test("missing ui translations render the {key} miss-marker, not a hardcoded fallback", async () => {
		const html = await engine.render("components/ree-filters", { helpers, filter_definitions: FILTER_DEFS });
		expect(html).toContain("{clear_all}");
		expect(html).toContain("{labels}");
		expect(html).toContain("{apply_filters}");
		expect(html).toContain("{filter_not}");
	});
});
