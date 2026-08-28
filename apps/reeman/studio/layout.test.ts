import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const layout_source = await Bun.file(join(import.meta.dir, "layout.ree")).text();

describe("Studio layout", () => {
	test("passes the file picker and adapt-schema action as sidebar-header children", () => {
		// The studio's selectors/actions live in the header; the shared
		// component stays a pure shell (issue #194).
		const header_open = layout_source.indexOf("<sidebar-header>");
		const header_close = layout_source.indexOf("</sidebar-header>");
		expect(header_open).toBeGreaterThan(-1);
		expect(header_close).toBeGreaterThan(header_open);
		const header_children = layout_source.slice(header_open, header_close);

		expect(header_children).toContain('name="path"');
		expect(header_children).toContain("adapt-schema-dialog");
		expect(header_children).not.toContain("new-table-dialog");
		expect(header_children).not.toContain("props.objects.tables");
	});

	test("passes the tables/views object nav as sidebar-nav children", () => {
		// The model list is navigation, so it renders in the nav region
		// (which replaces props.nav_groups when children are given) rather
		// than in the header with the selectors.
		const nav_open = layout_source.indexOf("<sidebar-nav>");
		const nav_close = layout_source.indexOf("</sidebar-nav>");
		expect(nav_open).toBeGreaterThan(-1);
		expect(nav_close).toBeGreaterThan(nav_open);
		const nav_children = layout_source.slice(nav_open, nav_close);

		expect(nav_children).toContain("new-table-dialog");
		expect(nav_children).toContain("props.objects.tables");
		expect(nav_children).toContain("props.objects.views");
		expect(nav_children).toContain("props.selected_object");
	});

	test("composes the shared sidebar footer", () => {
		expect(layout_source).toContain("<sidebar-footer></sidebar-footer>");
	});

	test("does not render the reeman nav_groups - the studio nav is its object list", () => {
		// nav_groups come from the shared layout's data; the studio layout
		// replaces them with its own children instead.
		expect(layout_source).not.toContain("props.nav_groups");
	});
});
