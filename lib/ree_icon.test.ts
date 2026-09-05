import { describe, expect, test } from "bun:test";

import { icon_definitions, render_icon } from "./ree_icon";

describe("render_icon", () => {
	test("renders registry SVG content with supported root attributes", () => {
		const icon = render_icon("search", { class: "size-5", "aria-hidden": "true" });

		expect(icon).toContain('<svg viewBox="0 0 24 24"');
		expect(icon).toContain('class="size-5"');
		expect(icon).toContain('aria-hidden="true"');
		expect(icon).toContain('stroke-linejoin="round"');
	});

	test("preserves file colors and labels", () => {
		const icon = render_icon("file_pdf");

		expect(icon).toContain('fill="#e2574c"');
		expect(icon).toContain(">PDF</text>");
	});

	test("escapes dynamic root attributes and ignores unknown attributes", () => {
		const icon = render_icon("x", { class: 'size-4" onload="bad', onclick: "bad" });

		expect(icon).toContain('class="size-4&quot; onload=&quot;bad"');
		expect(icon).not.toContain("onclick");
	});

	test("returns an empty string for unknown names", () => {
		expect(render_icon("unknown")).toBe("");
	});

	test("contains every icon used by file helpers and component call sites", () => {
		expect(icon_definitions).toHaveProperty("file");
		expect(icon_definitions).toHaveProperty("file_csv");
		expect(icon_definitions).toHaveProperty("notifications_are_on");
		expect(icon_definitions).toHaveProperty("notifications_are_off");
	});
});
