/**
 * Custom element pre-processor - extracted from TemplateEngine.compile().
 *
 * Handles two pre-processing steps that run before the main compiler pass:
 * 1. HTML comment stripping:  <!-- ... --> is removed so directives inside comments are NOT compiled
 * 2. Custom HTML element shorthand:  <tag-name attr="val">SLOT</tag-name> -> \u0000R\u0000 marker (resolved by compile_to_code)
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { build_translation_resolve_expr } from "./translation_path";
import type { CompiledFn } from "./types";

/**
 * Parse HTML attributes string into a JS object literal fragment.
 * Extracted from the inner function in TemplateEngine.compile().
 *
 * Supports three kinds of attribute tokens:
 * 1. Standard key="val" / key='val' / boolean attributes
 * 2. Interpolated attrs: key="{= expr }" / key="{~ expr }" (strips braces, emits raw expr)
 * 3. Translation lookups: key="{_ path }" / key="{- path }" (safe dotted-path resolution)
 * 4. Spread shorthand: ...identifier - emits a JS spread operator in the object literal,
 *    e.g. <my-h1 ...p class="foo"> → attributes: { ...p, "class": "foo" }
 */
export function parse_attributes(attr_str: string): string {
	if (!attr_str?.trim()) return "";
	const parts: string[] = [];

	// First, extract spread tokens (e.g. ...p, ...rest).
	// These become JS spread operators in the generated object literal,
	// placed before explicit attrs so literal attrs override spread properties
	// (matching HTML's last-wins attribute semantics).
	//
	// We emit ...(identifier) with parentheses to prevent step 3's spread
	// shorthand conversion (which matches bare ...identifier -> {~ key_values(id)})
	// from matching inside the NUL-bounded ReeTag marker payload.
	// ...(identifier) is valid JS - the parens are just an expression wrapper.
	const spread_regex = /\.\.\.([A-Za-z_$][\w$]*)/g;
	let sm: RegExpExecArray | null;
	while ((sm = spread_regex.exec(attr_str)) !== null) {
		parts.push(`...(${sm[1]})`);
	}

	// Remove spread tokens before parsing regular attributes
	const cleaned_attr_str = attr_str.replace(spread_regex, "").trim();

	const attr_regex = /([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
	let m: RegExpExecArray | null;
	while ((m = attr_regex.exec(cleaned_attr_str)) !== null) {
		const name = m[1];
		const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : true;
		if (value === true) {
			parts.push(`"${name}": true`);
		} else if (typeof value === "string" && /^\{[=~]\s+/.test(value) && value.endsWith("}")) {
			// Template expression inside attr - strip {= } / {~ } and emit as raw JS expression
			// e.g. title="{= ui.reset_btn }" -> "title": ui.reset_btn (evaluated at render time)
			const expr = value.slice(2, -1).trim();
			parts.push(`"${name}": ${expr}`);
		} else if (typeof value === "string" && /^\{[_-]\s+/.test(value) && value.endsWith("}")) {
			// Translation lookup inside attr - {_ ui.reset_btn } / {- ui.reset_btn }
			// e.g. title="{_ ui.reset_btn }" -> "title": (props.translations?.ui?.reset_btn ?? "{reset_btn}")
			const path = value.slice(2, -1).trim();
			parts.push(`"${name}": ${build_translation_resolve_expr(path, `Invalid {_ ${path}} / {- ${path}} syntax in attribute`)}`);
		} else {
			parts.push(`"${name}": ${JSON.stringify(value)}`);
		}
	}
	return parts.join(", ");
}

export type PreprocessResult = { template: string; slot_fns: CompiledFn[]; };

export function preprocess_template(template: string, views_dir: string, ext: string, compile_slot: (content: string) => CompiledFn): PreprocessResult {
	// Step 1: Strip HTML comments
	// Remove <!-- ... --> before any directive processing, so that
	// {= }, {~ }, {#if}, etc. inside comments are NOT evaluated.
	// This allows generators to emit commented-out CU fields without
	// crashing on missing columns/fields at render time.
	template = template.replace(/<!--[\s\S]*?-->/g, "");

	const slot_fns: CompiledFn[] = [];

	// Step 2: Process custom HTML elements
	// <tag-name attr1="val1">SLOT</tag-name>
	// -> \u0000R\u0000<tag-name>\u0000<slot_id>\u0000<props_obj>\u0000
	// (resolved by compile_to_code into a __rtInclude call)
	//
	// If the tag has a matching component file under components/, it becomes a
	// component call. If not, it's passed through as a native HTML element.
	const cust_elem_regex = /<([a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9-]*)(?:\s([^>]*?))?\s*>([\s\S]*?)<\/\1>/g;
	let processed_template = template;

	while (true) {
		cust_elem_regex.lastIndex = 0;
		const match = cust_elem_regex.exec(processed_template);
		if (!match) break;

		const tag_name = match[1];
		const attr_str = match[2] ?? "";
		const slot_content = match[3];

		// Check if a matching component file exists under components/
		const project_root = dirname(views_dir);
		const component_file_path = join(project_root, "components", tag_name + ext);
		const component_exists = existsSync(component_file_path);

		if (component_exists) {
			// Component found -> emit a NUL-bounded ReeTag marker that
			// compile_to_code resolves to a direct __rtInclude call. We use a
			// NUL marker instead of {#include(...)} because the directive
			// regex can't parse balanced-brace data expressions.
			// Format: \u0000R\u0000<tag_name>\u0000<slot_id>\u0000<props_obj>\u0000
			const slot_id = slot_fns.length;

			// Recursively compile the slot content as a standalone template
			const slot_compiled_fn = compile_slot(slot_content);
			slot_fns.push(slot_compiled_fn);

			const attrs = parse_attributes(attr_str);
			const children_expr = `children: await __run_slot(${slot_id}, props, __escape, __include, __rtInclude, __currentName)`;
			const props_obj = attrs ? `{${children_expr}, attributes: {${attrs}}}` : `{${children_expr}}`;

			const marker = `\u0000R\u0000${tag_name}\u0000${slot_id}\u0000${props_obj}\u0000`;
			processed_template = processed_template.slice(0, match.index) + marker + processed_template.slice(match.index + match[0].length);
		} else {
			// No component file - pass through as a native HTML element.
			const tag_name_json = JSON.stringify(tag_name);

			// Handle spread tokens (e.g. ...p, ...rest) in the attribute string.
			// Extract them and generate key_values() calls in the output so the
			// object's properties become HTML attributes at render time.
			const spread_regex = /\.\.\.([A-Za-z_$][\w$]*)/g;
			const spread_ids: string[] = [];
			const cleaned_attr_str = attr_str.replace(spread_regex, (_match: string, id: string) => {
				spread_ids.push(id);
				return "";
			}).trim();

			// Build the attribute output: key_values() calls for each spread,
			// then literal attrs. Spreads come first (matching component case ordering).
			const attr_parts: string[] = [];
			for (const id of spread_ids) {
				attr_parts.push(`" " + key_values(${id})`);
			}
			if (cleaned_attr_str) { attr_parts.push(JSON.stringify(` ${cleaned_attr_str}`)); }
			const attr_output = attr_parts.length > 0 ? attr_parts.join(" + ") : JSON.stringify("");

			const replacement = `{{ __output += "<" + ${tag_name_json} + ${attr_output} + ">"; }}${slot_content}{{ __output += "</" + ${tag_name_json} + ">"; }}`;
			processed_template = processed_template.slice(0, match.index) + replacement + processed_template.slice(match.index + match[0].length);
		}
	}

	return { template: processed_template, slot_fns };
}
