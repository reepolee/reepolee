import { join } from "node:path";

import { IGNORE_INDEX_FIELDS } from "$config/db_structure";

import { capitalize_first } from "../naming";
import { find_v_field } from "./helpers";
import { render_field_cell, render_field_header } from "./render_field_cell";
import { apply_template } from "./template_substitutor";
import type { FieldDef } from "./types";

/**
 * Generate index.ree HTML and optionally index_rows.ree (for streaming).
 * Returns { index_html, rows_html } where rows_html is null when not streaming.
 */
export interface IndexReeOptions {
	table_name: string;
	singular: string;
	fields: FieldDef[];
	v_fields?: FieldDef[] | null;
	columns_override?: Record<string, any> | null;
	route_prefix?: string;
	route_param_value?: string;
	pagination_strategy?: string;
	render_strategy?: string;
	route_name?: string;
}

export async function generate_index_ree(options: IndexReeOptions): Promise<{ index_html: string; rows_html: string | null; }> {
	const { table_name, singular, fields, v_fields = null, columns_override = null, route_prefix = "", route_param_value = "id", pagination_strategy = "cursor", render_strategy = "load", route_name = "" } = options;
	const display_fields = v_fields || fields;

	let filtered: FieldDef[];

	if (columns_override) {
		// columns_override is the source of truth - only render fields listed in it
		// Exclude columns with grid: false (hidden from index, used only for filtering)
		const col_keys = Object.keys(columns_override).filter((k) => columns_override[k]?.grid !== false);
		const field_keys = col_keys.filter((k) => k !== "checkbox" && k !== "id");
		// Look up fields from v_fields first, then fall back to fields (supports columns
		// that exist in the columns config but aren't yet in the view)
		filtered = field_keys.map((k) => {
			let found = v_fields?.find((f) => f.name === k);
			if (!found) found = fields.find((f) => f.name === k);
			return found;
		}).filter((f): f is FieldDef => !!f);
	} else {
		filtered = display_fields.filter((f) => !f.attributes?.omit && f.attributes?.omit_index !== true && !IGNORE_INDEX_FIELDS.includes(f.name));
	}

	// Collect CU fields separately - they'll be rendered as commented-out entries
	const commented = display_fields.filter((f) => !f.attributes?.omit && f.attributes?.omit_index === true && !IGNORE_INDEX_FIELDS.includes(f.name));

	// Per-field header source: use v_fields prefix if field is in v_fields, otherwise fields
	// Headers are wrapped with {#with props} in the template, so labels use bare names.
	const headers = filtered.map((f) => {
		const label = find_v_field(f.name, v_fields) ? `{_ v_labels.${f.name} }` : `{_ labels.${f.name} }`;
		return render_field_header(f, label);
	}).join("\n");
	const cells = filtered.map((f) => render_field_cell(f, "record")).join("\n");

	// Generate commented-out headers/cells for CU fields (easy to re-enable)
	let commented_headers = "";
	let commented_cells = "";
	if (commented.length > 0) {
		commented_headers = `\n\t\t\t\t<!-- CU fields - uncomment to show in index -->\n${commented.map((f) => {
			const label = find_v_field(f.name, v_fields) ? `{_ v_labels.${f.name} }` : `{_ labels.${f.name} }`;
			const rendered = render_field_header(f, label);
			return `\t\t\t\t<!-- ${rendered.trimStart()} -->`;
		}).join("\n")}`;
		commented_cells = `\n\t\t\t\t<!-- CU fields -- uncomment to show in index -->\n${commented.map((f) => render_field_cell(f, "record", "default", "\t\t\t\t")).map((line) => `\t\t\t\t<!-- ${line.trimStart()} -->`).join(
			"\n"
		)}`;
	}

	const template_path = join(process.cwd(), "generator", "templates", "index.ree");
	let html = await Bun.file(template_path).text();
	const effective_route_name = route_name || table_name;
	html = apply_template(html, {
		"table.exact": effective_route_name,
		"table.singular": capitalize_first(singular),
		"table.singular.lowercase": singular.toLowerCase(),
		"table.headers": headers + commented_headers,
		"table.cells": cells,
		route_prefix: route_prefix,
		route_param: route_param_value,
	});

	// Replace pagination center display based on strategy
	const center_display = pagination_strategy === "offset"
		? `<div style="width: {= total.toString().length * 3 + 4 }ch; text-align: center">{= offset + 1 }-{= Math.min(offset + (limit === 'all' ? total : limit), total) } / {= total}</div>`
		: `<div style="width: {= total.toString().length * 2 + 3 }ch; text-align: center">{= records.length } / {= total }</div>`;
	// __stream.pagination_count__ will be replaced per-strategy below
	// Build rows partial HTML (used by streaming, same cells as the index)
	let rows_html: string | null = null;
	if (render_strategy === "stream") {
		rows_html = cells;

		// Remove the {#if (records.length === 0)} / {:else} conditional block
		// because for streaming the DPU markers must always be present in the shell.
		// The streaming handler controls what replaces the DPU area, not the template.
		html = html.replace(/__stream\.if_norecords__[\s\S]*?__stream\.end_if_norecords__/, "");
		// Remove the closing {/if} that ends the records conditional
		html = html.replace(/<\/div>\s*\{\/if\}/, "</div>");

		// Wrap records area in DPU markers
		html = apply_template(html, {
			"stream.records": "<?start name=\"records\">\n\t\t\t<div class=\"col-span-full p-4 text-center\">{_ ui.loading_records }</div>\n\t\t<?end>\n\n\t\t\t",
			"stream.records_end": "",
		});

		// Wrap pagination area in DPU markers (no Loading… at start - it's in pagination_count)
		html = apply_template(html, {
			"stream.pagination_start": "<?start name=\"pagination\">\n\t\t\t<div class=\"pagination-info\">\n\t\t\t\t",
			"stream.pagination_count": "{_ ui.loading_count }",
			"stream.pagination_end": "\n\t\t\t<?end>",
		});
	} else {
		// Non-streaming: inject the full conditional block with center display
		html = apply_template(html, {
			"stream.pagination_count": `{#if total > 0 }\n\t\t\t\t${center_display}\n\t\t\t{:else }\n\t\t\t\t<div style="width: 7ch; text-align: center">0 / 0</div>\n\t\t\t{/if}`,
			"stream.if_norecords": "",
			"stream.end_if_norecords": "",
			"stream.close_norecords": "",
			"stream.records": "",
			"stream.records_end": "",
			"stream.pagination_start": "<div class=\"pagination-info\">\n\t\t\t\t",
			"stream.pagination_end": "",
		});
	}

	return { index_html: html, rows_html };
}
