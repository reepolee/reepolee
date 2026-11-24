import { describe, expect, test } from "bun:test";

import { describe_changed_elements, describe_changed_elements_full, element_label, elements_intersecting } from "./dom_diff";

type Fixture_element = {
	tag: string;
	id?: string;
	class?: string;
	text?: string;
	rect: [number, number, number, number];
};

/**
 * Build a minimal DOMSnapshot.captureSnapshot response in the real CDP shape
 * (verified against live Chrome): a `strings` table plus `documents[0].nodes`
 * with integer indices, and layout rects on the document (not inside nodes).
 */
function make_snapshot(elements: Fixture_element[]): unknown {
	const strings: string[] = ["#document", "HTML", "HEAD", "BODY"];
	const add = (value: string): number => {
		const index = strings.indexOf(value);
		if (index !== -1) return index;
		strings.push(value);
		return strings.length - 1;
	};

	// document(0), html(1), head(2), body(3), then the fixture elements.
	const parent_index = [-1, 0, 1, 1];
	const node_type = [9, 1, 1, 1];
	const node_name = [0, 1, 2, 3];
	const node_value = [-1, -1, -1, -1];
	const attributes: Array<number[]> = [[], [], [], []];
	const layout_node_index: number[] = [];
	const bounds: number[][] = [];

	for (const element of elements) {
		const element_index = node_type.length;
		parent_index.push(3); // child of body
		node_type.push(1);
		node_name.push(add(element.tag.toUpperCase()));
		node_value.push(-1);
		const attrs: number[] = [];
		if (element.id) attrs.push(add("id"), add(element.id));
		if (element.class) attrs.push(add("class"), add(element.class));
		attributes.push(attrs);
		layout_node_index.push(element_index);
		bounds.push(element.rect);

		if (element.text) {
			parent_index.push(element_index);
			node_type.push(3);
			node_name.push(add("#text"));
			node_value.push(add(element.text));
			attributes.push([]);
		}
	}

	return {
		documents: [{ nodes: { parentIndex: parent_index, nodeType: node_type, nodeName: node_name, nodeValue: node_value, attributes }, layout: { nodeIndex: layout_node_index, bounds } }],
		strings,
	};
}

describe("dom_diff", () => {
	test("elements_intersecting returns the innermost element in a diff region", () => {
		const snapshot = make_snapshot([
			{ tag: "button", id: "save", text: "Save", rect: [8, 66, 47, 21] },
			{ tag: "p", text: "Some text", rect: [8, 103, 484, 18] },
		]);
		expect(elements_intersecting(snapshot, { left: 8, top: 60, width: 60, height: 30 }).map(element_label)).toEqual(['<button#save> "Save"']);
	});

	test("element_label builds a selector plus text", () => {
		expect(element_label({ tag: "button", id: "save", text: "Save", reason: "removed" })).toBe('<button#save> "Save"');
		expect(element_label({ tag: "a", class: "link primary", text: "New link", reason: "added" })).toBe('<a.link> "New link"');
	});

	test("describe_changed_elements describes each element in spoken English", () => {
		expect(describe_changed_elements([{ tag: "button", id: "save", text: "Save", reason: "removed" }])).toBe('The button "Save" was removed.');
		expect(describe_changed_elements([{ tag: "a", text: "New link", reason: "added" }])).toBe('A link "New link" was added.');
		expect(describe_changed_elements([{ tag: "h1", text: "Hello", reason: "pixel" }])).toBe('The heading "Hello" changed.');
	});

	test("describe_changed_elements uses the right article before a vowel", () => {
		expect(describe_changed_elements([{ tag: "img", text: "hero", reason: "added" }])).toBe('An image "hero" was added.');
	});

	test("describe_changed_elements speaks only the 'to' value for a changed element, never 'from'", () => {
		expect(describe_changed_elements([{ tag: "h2", text: "New title", reason: "changed", detail: 'text: "Old title" → "New title"', to: "New title" }])).toBe('The heading changed to "New title".');
		expect(describe_changed_elements([{ tag: "div", id: "card", text: "", reason: "changed", detail: 'class: "card" → "card highlighted"', to: "card highlighted" }])).toBe('The div with id "card" changed to "card highlighted".');
	});

	test("describe_changed_elements falls back to a generic sentence for a changed element with no 'to' (e.g. an attribute removed)", () => {
		expect(describe_changed_elements([{ tag: "a", text: "Go", reason: "changed", detail: "-href" }])).toBe('The link "Go" changed.');
	});

	test("describe_changed_elements_full speaks both sides for a changed element", () => {
		expect(describe_changed_elements_full([{ tag: "h2", text: "New title", reason: "changed", detail: 'text: "Old title" → "New title"', to: "New title", from: "Old title" }])).toBe('The heading changed from "Old title" to "New title".');
		expect(describe_changed_elements_full([{ tag: "div", id: "card", text: "", reason: "changed", detail: 'class: "card" → "card highlighted"', to: "card highlighted", from: "card" }])).toBe('The div with id "card" changed from "card" to "card highlighted".');
	});

	test("describe_changed_elements_full says 'nothing' when an attribute was newly added (empty from)", () => {
		expect(describe_changed_elements_full([{ tag: "img", text: "", reason: "changed", detail: '+alt="hero"', to: "hero", from: "" }])).toBe('The image changed from nothing to "hero".');
	});

	test("describe_changed_elements speaks only the first element, then counts the rest - not a full sentence per change", () => {
		// A sentence per changed element used to run several full sentences
		// long, overrunning its evidence-video screen's hold and letting the
		// "Done" card appear while the voice was still talking - so only the
		// first change is spoken out in full.
		const elements: Parameters<typeof describe_changed_elements>[0] = [
			{ tag: "div", text: "", reason: "changed", detail: "class +bg-emerald-600", to: "py-g container mx-auto bg-emerald-600" },
			{ tag: "span", text: "New copy", reason: "changed", detail: 'text: "Old copy" → "New copy"', to: "New copy" },
			{ tag: "div", text: "", reason: "removed" },
		];
		expect(describe_changed_elements(elements)).toBe('The div changed to "py-g container mx-auto bg-emerald-600". And 2 more changes.');
	});

	test("describe_changed_elements says '1 more change', singular, for exactly one extra", () => {
		const elements: Parameters<typeof describe_changed_elements>[0] = [
			{ tag: "div", id: "a", text: "", reason: "removed" },
			{ tag: "div", id: "b", text: "", reason: "removed" },
		];
		expect(describe_changed_elements(elements)).toBe('The div with id "a" was removed. And 1 more change.');
	});
});
