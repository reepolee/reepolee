import { describe, expect, test } from "bun:test";

import { element_label } from "./dom_diff";
import { diff_html } from "./html_diff";

describe("html_diff", () => {
	test("detects an added element", async () => {
		const baseline = "<body><p>Some text</p></body>";
		const current = "<body><p>Some text</p><a>New link</a></body>";
		const diff = await diff_html(baseline, current);
		expect(diff.map(element_label)).toEqual(['<a> "New link"']);
		expect(diff[0]!.reason).toBe("added");
	});

	test("detects a removed element", async () => {
		const baseline = "<body><button id=\"save\">Save</button><p>Some text</p></body>";
		const current = "<body><p>Some text</p></body>";
		const diff = await diff_html(baseline, current);
		expect(diff.map(element_label)).toEqual(['<button#save> "Save"']);
		expect(diff[0]!.reason).toBe("removed");
	});

	test("detects a text change on an element with a stable id - the gap structural_diff had", async () => {
		const baseline = "<body><div id=\"card\">A</div></body>";
		const current = "<body><div id=\"card\">B</div></body>";
		const diff = await diff_html(baseline, current);
		expect(diff).toHaveLength(1);
		expect(diff[0]!.reason).toBe("changed");
		expect(diff[0]!.detail).toContain('"A" → "B"');
	});

	test("detects an attribute change (href) - invisible to the old signature-based diff", async () => {
		const baseline = "<body><a id=\"cta\" href=\"/old\">Go</a></body>";
		const current = "<body><a id=\"cta\" href=\"/new\">Go</a></body>";
		const diff = await diff_html(baseline, current);
		expect(diff).toHaveLength(1);
		expect(diff[0]!.reason).toBe("changed");
		expect(diff[0]!.detail).toBe('href: "/old" → "/new"');
	});

	test("detects an attribute change on an anonymous element (no id or class) - skipped entirely by the old diff", async () => {
		const baseline = "<body><img src=\"a.png\"></body>";
		const current = "<body><img src=\"b.png\"></body>";
		const diff = await diff_html(baseline, current);
		expect(diff).toHaveLength(1);
		expect(diff[0]!.tag).toBe("img");
		expect(diff[0]!.detail).toBe('src: "a.png" → "b.png"');
	});

	test("matches elements by id even when their position/order changes", async () => {
		const baseline = "<body><div id=\"a\">A</div><div id=\"b\">B</div></body>";
		const current = "<body><div id=\"b\">B</div><div id=\"a\">A changed</div></body>";
		const diff = await diff_html(baseline, current);
		expect(diff).toHaveLength(1);
		expect(diff[0]!.id).toBe("a");
		expect(diff[0]!.detail).toContain('"A" → "A changed"');
	});

	test("a class-only change is reported as one changed element, not remove+add", async () => {
		// Regression: same_element() used to require class equality too, so a
		// class edit made the matcher treat it as two unrelated elements -
		// remove the old div, add a new one - and since remove/add never
		// recurse, the div's own unrelated-but-nested content (a heading, a
		// paragraph) fell back to the vague pixel-region guess instead of
		// being correctly recognized as unchanged.
		const baseline = "<body><div class=\"card\"><h2>Title</h2><p>Body text</p></div></body>";
		const current = "<body><div class=\"card highlighted\"><h2>Title</h2><p>Body text</p></div></body>";
		const diff = await diff_html(baseline, current);
		expect(diff).toHaveLength(1);
		expect(diff[0]!.tag).toBe("div");
		expect(diff[0]!.reason).toBe("changed");
		expect(diff[0]!.detail).toBe("class +highlighted");
	});

	test("class change reports only the added/removed tokens, not the whole before/after string", async () => {
		const baseline = "<body><div class=\"py-g container mx-auto\">x</div></body>";
		const current = "<body><div class=\"py-g container mx-auto bg-emerald-600\">x</div></body>";
		const diff = await diff_html(baseline, current);
		expect(diff).toHaveLength(1);
		expect(diff[0]!.detail).toBe("class +bg-emerald-600");
	});

	test("class change reports a removed token", async () => {
		const baseline = "<body><div class=\"a b c\">x</div></body>";
		const current = "<body><div class=\"a c\">x</div></body>";
		const diff = await diff_html(baseline, current);
		expect(diff[0]!.detail).toBe("class -b");
	});

	test("class change reports both added and removed tokens together", async () => {
		const baseline = "<body><div class=\"a b\">x</div></body>";
		const current = "<body><div class=\"a c\">x</div></body>";
		const diff = await diff_html(baseline, current);
		expect(diff[0]!.detail).toBe("class +c -b");
	});

	test("a class list edited only by reordering is called out as a reorder, not silently ignored", async () => {
		const baseline = "<body><div class=\"a b c\">x</div></body>";
		const current = "<body><div class=\"c a b\">x</div></body>";
		const diff = await diff_html(baseline, current);
		expect(diff).toHaveLength(1);
		expect(diff[0]!.detail).toBe("class reordered");
	});

	test("reports no diff for identical documents", async () => {
		const html = "<body><header class=\"top\"><a id=\"home\" href=\"/\">Home</a></header><p>Text</p></body>";
		expect(await diff_html(html, html)).toEqual([]);
	});

	test("ignores script/style content changes", async () => {
		const baseline = "<body><script>var x = 1;</script><style>.a{color:red}</style><p>Text</p></body>";
		const current = "<body><script>var x = 2;</script><style>.a{color:blue}</style><p>Text</p></body>";
		expect(await diff_html(baseline, current)).toEqual([]);
	});

	test("still detects changes after a skipped subtree closes (head, then body)", async () => {
		// Regression: skipping a non-void SKIP_TAGS element (head) must
		// restore skip_depth to 0 once its end tag fires, or every sibling
		// after it (here, all of <body>) is silently treated as skipped too.
		const baseline = "<html><head><title>T</title></head><body><p>Old</p></body></html>";
		const current = "<html><head><title>T</title></head><body><p>New</p></body></html>";
		const diff = await diff_html(baseline, current);
		expect(diff).toHaveLength(1);
		expect(diff[0]!.tag).toBe("p");
		expect(diff[0]!.detail).toContain('"Old" → "New"');
	});

	test("recurses into unchanged wrapper elements to find a nested change", async () => {
		const baseline = "<body><section><div class=\"row\"><span>Old</span></div></section></body>";
		const current = "<body><section><div class=\"row\"><span>New</span></div></section></body>";
		const diff = await diff_html(baseline, current);
		expect(diff).toHaveLength(1);
		expect(diff[0]!.tag).toBe("span");
		expect(diff[0]!.detail).toContain('"Old" → "New"');
	});
});
