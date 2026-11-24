/**
 * URL pattern matching - one implementation for ":param" route patterns.
 *
 * A pattern like "/orders/:order_id/items/:id" matches an actual path with the
 * same number of segments; ":name" segments capture the actual segment value.
 * Used by the dev-mode route table, the localized route maps, and language
 * detection - previously four hand-rolled copies of the same loop.
 */

/**
 * Match an actual URL path against a ":param" pattern.
 * Returns the captured params ({} when the pattern has none), or null when
 * the path does not match.
 */
export function match_pattern(pattern: string, actual: string): Record<string, string> | null {
	const pattern_parts = pattern.split("/").filter(Boolean);
	const actual_parts = actual.split("/").filter(Boolean);
	if (pattern_parts.length !== actual_parts.length) return null;

	const params: Record<string, string> = {};
	for (let i = 0; i < pattern_parts.length; i++) {
		const pattern_part = pattern_parts[i]!;
		if (pattern_part.startsWith(":")) {
			params[pattern_part.slice(1)] = actual_parts[i]!;
		} else if (pattern_part !== actual_parts[i]) {
			return null;
		}
	}
	return params;
}
