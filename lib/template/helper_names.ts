/**
 * Names of the built-in template helpers injected as bare identifiers into
 * compiled templates.
 *
 * Lives in its own dependency-free module so the compiler can embed the list
 * at compile time without importing template_helpers (whose import chain
 * reaches $config/db). template_helpers.test.ts asserts this list matches
 * Object.keys(create_default_helpers()) so the two cannot drift.
 *
 * Custom helpers beyond this list are still reachable in templates via
 * `helpers.<name>` - only the built-ins get bare-identifier bindings.
 */
export const DEFAULT_HELPER_NAMES = [
	"url",
	"localized_path",
	"nav_label",
	"is_current",
	"is_checked",
	"js_date_to_locale_string",
	"js_time_to_locale_string",
	"js_datetime_to_locale_string",
	"js_timestamp_to_locale_string",
	"js_date_to_iso_string",
	"js_datetime_to_iso_string",
	"js_timestamp_to_iso_string",
	"display_currency",
	"display_percent",
	"urlencode",
	"urldecode",
	"pill",
	"tags",
	"yes_no",
	"human_bytes",
	"key_values",
	"image_thumbnail",
] as const;
