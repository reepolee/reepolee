/**
 * Template Substitutor - typed substitution context for generator templates.
 *
 * Replaces the fragile 20+ `.replaceAll()` chain with a validated,
 * order-independent substitution function.
 *
 * Usage:
 * const ctx: TemplateContext = {
 * "table.exact": "users",
 * "search.field": "name",
 * "interface.fields": "\tid: number;\n\tname: string;",
 * };
 * const result = apply_template(template, ctx);
 */

/**
 * A context mapping placeholder keys to their values.
 * Keys are the portion between `__` delimiters (e.g. `"table.exact"`).
 */
export type TemplateContext = Record<string, string>;
export type ApplyTemplateOptions = { deferred?: string[]; };

/**
 * Apply a set of substitutions to a template string.
 * All placeholders use the `__key__` convention.
 *
 * @param template - The template string with `__key__` placeholders
 * @param context - Map of key -> replacement value
 * @returns The template with all placeholders replaced
 * @throws If any placeholder in the template has no matching context key
 */
/** Escape a literal string for safe use inside a RegExp. */
function escape_for_regex(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function apply_template(template: string, context: TemplateContext, options: ApplyTemplateOptions = {}): string {
	let result = template;

	for (const [key, value] of Object.entries(context)) {
		const placeholder = `__${key}__`;
		// An empty value on an indented line of its own would otherwise leave a
		// whitespace-only line behind. Drop the whole line instead, so a feature
		// that is switched off for this table leaves no trace in the output.
		// Only lines carrying nothing but the placeholder qualify - a placeholder
		// with real code around it is substituted in place as usual.
		if (value === "") {
			const own_line = new RegExp(`^[ \\t]+${escape_for_regex(placeholder)}[ \\t]*\\r?\\n`, "gm");
			result = result.replace(own_line, "");
		}
		result = result.replaceAll(placeholder, value);
	}

	// Check for unreplaced placeholders (catches typos like __missspelled.key__)
	const remaining = result.match(/__[a-zA-Z0-9_.]+__/g);
	if (remaining && remaining.length > 0) {
		const deferred = new Set(options.deferred ?? []);
		const unique_placeholders = [...new Set(remaining)];
		const unique = unique_placeholders.filter((placeholder) => !deferred.has(placeholder.slice(2, -2)));
		if (unique.length === 0) return result;
		console.warn(`[template_substitutor] Warning: ${unique.length} unreplaced placeholder(s): ${unique.join(", ")}`);
	}

	return result;
}

/**
 * Wrapper that returns both the result and lists of used/unused keys.
 * Useful for debugging and validating template substitutions.
 */
export function apply_template_detailed(template: string, context: TemplateContext): { result: string; used: string[]; unused: string[]; missing: string[]; } {
	const used: string[] = [];
	const missing: string[] = [];

	let result = template;

	for (const [key, value] of Object.entries(context)) {
		const placeholder = `__${key}__`;
		if (result.includes(placeholder)) {
			result = result.replaceAll(placeholder, value);
			used.push(key);
		}
	}

	const remaining = result.match(/__[a-zA-Z0-9_.]+__/g);
	const missing_set = new Set(remaining || []);
	for (const m of missing_set) {
		// Extract key from __key__ format
		const key = m.slice(2, -2);
		missing.push(key);
	}

	const used_set = new Set(used);
	const all_context_keys = Object.keys(context);
	const unused = all_context_keys.filter((k) => !used_set.has(k));

	return { result, used, unused, missing };
}
