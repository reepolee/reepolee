type Svg_attributes = Record<string, string>;

type Svg_node = { tag: "path" | "circle" | "text"; attributes: Svg_attributes; text?: string; };
type Icon_definition = { view_box: string; attributes?: Svg_attributes; nodes: readonly Svg_node[]; };

export const icon_definitions = {
	notifications_are_on: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "M12 22q-.825 0-1.412-.587T10 20h4q0 .825-.587 1.413T12 22m-8-3v-2h2v-7q0-2.075 1.25-3.687T10.5 4.2v-.7q0-.625.438-1.062T12 2t1.063.438T13.5 3.5v.7q.725.175 1.338.513t1.137.787L14.55 6.925q-.525-.425-1.175-.675T12 6q-1.65 0-2.825 1.175T8 10v7h12v2zm12.4-5.475L15 12.1q.25-.25.375-.6t.125-.8t-.125-.813T15 9.275l1.4-1.4q.525.525.813 1.25T17.5 10.7t-.288 1.575t-.812 1.25m1.075 1.075q.725-.725 1.125-1.75t.4-2.15t-.4-2.15t-1.125-1.75L18.9 5.4q1.025 1.025 1.563 2.387T21 10.7t-.537 2.913T18.9 16z" } }] },
	notifications_are_off: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "M4 19v-2h2v-7q0-.825.213-1.625T6.85 6.85l1.5 1.5q-.175.4-.262.813T8 10v7h6.2L1.4 4.2l1.4-1.4l18.4 18.4l-1.4 1.4l-3.65-3.6zm14-3.85l-2-2V10q0-1.65-1.175-2.825T12 6q-.65 0-1.25.2t-1.1.6L8.2 5.35q.5-.4 1.075-.7T10.5 4.2v-.7q0-.625.437-1.062T12 2t1.063.438T13.5 3.5v.7q2 .5 3.25 2.113T18 10zM12 22q-.825 0-1.412-.587T10 20h4q0 .825-.587 1.413T12 22m.825-12.025" } }] },
	chevrons_left: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "M12 17.308L6.692 12L12 6.692l.708.708l-4.6 4.6l4.6 4.6z" } }, { tag: "path", attributes: { fill: "currentColor", d: "M17.692 17.308L12.384 12l5.308-5.308l.708.708l-4.6 4.6l4.6 4.6z" } }] },
	chevron_left: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "M14 17.308L8.692 12L14 6.692l.708.708l-4.6 4.6l4.6 4.6z" } }] },
	chevron_right: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "m13.292 12l-4.6-4.6l.708-.708L14.708 12L9.4 17.308l-.708-.708z" } }] },
	chevrons_right: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "m11.292 12l-4.6-4.6l.708-.708L12.708 12L7.4 17.308l-.708-.708z" } }, { tag: "path", attributes: { fill: "currentColor", d: "m17 12l-4.6-4.6l.708-.708L18.408 12l-5.308 5.308l-.708-.708z" } }] },
	x: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z" } }] },
	grip: { view_box: "0 0 15 15", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "M5.5 10.375a1.125 1.125 0 1 1 0 2.25a1.125 1.125 0 0 1 0-2.25m4 0a1.125 1.125 0 1 1 0 2.25a1.125 1.125 0 0 1 0-2.25m-4-4a1.125 1.125 0 1 1 0 2.25a1.125 1.125 0 0 1 0-2.25m4 0a1.125 1.125 0 1 1 0 2.25a1.125 1.125 0 0 1 0-2.25m-4-4a1.125 1.125 0 1 1 0 2.25a1.125 1.125 0 0 1 0-2.25m4 0a1.125 1.125 0 1 1 0 2.25a1.125 1.125 0 0 1 0-2.25" } }] },
	dashboard: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z" } }] },
	settings: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "m19.43 12.98.04-.98-.04-.98 2.11-1.65-2-3.46-2.49 1a7.5 7.5 0 0 0-1.69-.98L15 3h-4l-.36 2.93c-.6.25-1.17.58-1.69.98l-2.49-1-2 3.46 2.11 1.65-.04.98.04.98-2.11 1.65 2 3.46 2.49-1c.52.4 1.09.73 1.69.98L11 21h4l.36-2.93c.6-.25 1.17-.58 1.69-.98l2.49 1 2-3.46zM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5" } }] },
	push_pin: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", "fill-rule": "evenodd", d: "M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1 0 .55.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3" } }] },
	pin_off: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "m9 9 7 7h-3v4l-1 3-1-3v-4H6v-3l3-3zm8-7v2l-2 1v5l3 3v2.461L12.27 9.73 9 6.46V5L7 4V2z" } }, { tag: "path", attributes: { fill: "currentColor", d: "M2.27 2.27 1 3.54 20.46 23l1.27-1.27L11 11z" } }] },
	qa: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "currentColor", d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m-2 15-5-5 1.4-1.4L10 14.2l7.6-7.6L19 8z" } }] },
	search: { view_box: "0 0 24 24", attributes: { fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }, nodes: [{ tag: "circle", attributes: { cx: "11", cy: "11", r: "8" } }, { tag: "path", attributes: { d: "m21 21-4.3-4.3" } }] },
	eye: { view_box: "0 0 24 24", attributes: { fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }, nodes: [{ tag: "path", attributes: { d: "M2 12s3.5-6 10-6s10 6 10 6s-3.5 6-10 6S2 12 2 12Z" } }, { tag: "circle", attributes: { cx: "12", cy: "12", r: "2.5" } }] },
	eye_off: { view_box: "0 0 24 24", attributes: { fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }, nodes: [{ tag: "path", attributes: { d: "m3 3 18 18" } }, { tag: "path", attributes: { d: "M10.6 10.6a2.5 2.5 0 0 0 3.5 3.5" } }, { tag: "path", attributes: { d: "M9.9 5.3A11.7 11.7 0 0 1 12 5c6.5 0 10 7 10 7a19.3 19.3 0 0 1-3.2 4.1M6.1 6.1C3.4 8.1 2 12 2 12s3.5 7 10 7a10.7 10.7 0 0 0 3.1-.5" } }] },
	spinner: { view_box: "0 0 24 24", attributes: { fill: "none" }, nodes: [{ tag: "circle", attributes: { class: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", "stroke-width": "4" } }, { tag: "path", attributes: { class: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" } }] },
	file: { view_box: "0 0 24 24", attributes: { fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }, nodes: [{ tag: "path", attributes: { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" } }, { tag: "path", attributes: { d: "M14 2v6h6" } }] },
	file_pdf: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "#e2574c", d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" } }, { tag: "path", attributes: { fill: "#f8b5b0", d: "M14 2v6h6z" } }, { tag: "text", attributes: { x: "12", y: "18", "font-size": "7", "font-family": "Arial, sans-serif", "font-weight": "bold", fill: "#ffffff", "text-anchor": "middle" }, text: "PDF" }] },
	file_word: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "#2b579a", d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" } }, { tag: "path", attributes: { fill: "#a9c2e8", d: "M14 2v6h6z" } }, { tag: "text", attributes: { x: "12", y: "18", "font-size": "6.5", "font-family": "Arial, sans-serif", "font-weight": "bold", fill: "#ffffff", "text-anchor": "middle" }, text: "DOC" }] },
	file_excel: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "#21a366", d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" } }, { tag: "path", attributes: { fill: "#a8e6c1", d: "M14 2v6h6z" } }, { tag: "text", attributes: { x: "12", y: "18", "font-size": "6.5", "font-family": "Arial, sans-serif", "font-weight": "bold", fill: "#ffffff", "text-anchor": "middle" }, text: "XLS" }] },
	file_powerpoint: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "#d24726", d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" } }, { tag: "path", attributes: { fill: "#f4b8a5", d: "M14 2v6h6z" } }, { tag: "text", attributes: { x: "12", y: "18", "font-size": "6.5", "font-family": "Arial, sans-serif", "font-weight": "bold", fill: "#ffffff", "text-anchor": "middle" }, text: "PPT" }] },
	file_zip: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "#8a8a8a", d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" } }, { tag: "path", attributes: { fill: "#d4d4d4", d: "M14 2v6h6z" } }, { tag: "text", attributes: { x: "12", y: "18", "font-size": "6.5", "font-family": "Arial, sans-serif", "font-weight": "bold", fill: "#ffffff", "text-anchor": "middle" }, text: "ZIP" }] },
	file_text: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "#6b7280", d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" } }, { tag: "path", attributes: { fill: "#d1d5db", d: "M14 2v6h6z" } }, { tag: "text", attributes: { x: "12", y: "18", "font-size": "6.5", "font-family": "Arial, sans-serif", "font-weight": "bold", fill: "#ffffff", "text-anchor": "middle" }, text: "TXT" }] },
	file_csv: { view_box: "0 0 24 24", nodes: [{ tag: "path", attributes: { fill: "#21a366", d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" } }, { tag: "path", attributes: { fill: "#a8e6c1", d: "M14 2v6h6z" } }, { tag: "text", attributes: { x: "12", y: "18", "font-size": "6.5", "font-family": "Arial, sans-serif", "font-weight": "bold", fill: "#ffffff", "text-anchor": "middle" }, text: "CSV" }] },
} satisfies Record<string, Icon_definition>;

export type Icon_name = keyof typeof icon_definitions;

const ROOT_ATTRIBUTE_NAMES = new Set(["class", "aria-hidden", "aria-label", "role", "focusable"]);

function escape_attribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function render_attributes(attributes: Svg_attributes): string {
	return Object.entries(attributes).map(([name, value]) => ` ${name}="${escape_attribute(value)}"`).join("");
}

function render_node(node: Svg_node): string {
	const attributes = render_attributes(node.attributes);
	return node.text == null ? `<${node.tag}${attributes}/>` : `<${node.tag}${attributes}>${node.text}</${node.tag}>`;
}

export function render_icon(name: string, input_attributes: Record<string, unknown> = {}): string {
	const icon = icon_definitions[name as Icon_name];
	if (!icon) return "";

	const root_attributes: Svg_attributes = { viewBox: icon.view_box, ...icon.attributes, xmlns: "http://www.w3.org/2000/svg" };
	for (const [attribute_name, value] of Object.entries(input_attributes)) {
		if (!ROOT_ATTRIBUTE_NAMES.has(attribute_name) || typeof value !== "string") continue;
		root_attributes[attribute_name] = value;
	}

	const content = icon.nodes.map(render_node).join("");
	return `<svg${render_attributes(root_attributes)}>${content}</svg>`;
}
