/**
 * Assembling the props the locale editor renders from.
 *
 * Generated CRUD handlers call build_localization_props() and pass the result
 * straight to render() as `localization`. Keeping this here (rather than
 * emitting it into every generated index.ts) means the editor's data contract
 * can change without regenerating a single CRUD.
 *
 * Storage is one full row per locale (D3/D7): the base table holds the default
 * locale, `<table>_<locale>` holds the rest. A value cloned from the default
 * locale is stored and rendered as a normal value - there is no "inheriting"
 * state, so no `present` map and no "use original" checkbox.
 */

import { default_locale, locale_names, locales } from "$config/supported_locales";

/** A localized field plus the bits the panel component needs to render it. */
export interface LocalizedFormField {
	field_name: string;
	label: string;
	input_type: string;
	upload_folder?: string;
}

export interface LocalizationProps {
	/** Every supported locale, including inactive locales being prepared. */
	active_locales: string[];
	default_locale: string;
	locale_names: Record<string, string>;
	fields: Array<{ name: string; label: string; type: string; upload_folder?: string; }>;
	record: Record<string, any>;
	values: Record<string, string | number | boolean>;
	errors: Record<string, string>;
	stale: Record<string, string>;
	copy_action: string;
	generate_action: string;
	/** Which tab (if any) each field's CSS-only switcher should pre-select,
	 *  read from the "preferred_locale" cookie. Falls back to default_locale
	 *  when absent or not a configured locale. */
	preferred_locale?: string;
}

export interface BuildLocalizationOptions {
	fields: readonly LocalizedFormField[];
	/** The default locale's row (the base table). */
	record: Record<string, any>;
	/** locale code -> that locale's row, for every non-default locale. */
	locale_rows?: Record<string, Record<string, any>>;
	/** Overrides the resolved values, e.g. when re-rendering after a failed save. */
	values?: Record<string, string | number | boolean>;
	errors?: Record<string, string>;
	notices?: readonly unknown[];
	copy_action: string;
	/** Defaults to copy_action with its last segment swapped, since every
	 *  generated route follows the same `.../copy-locale` convention. */
	generate_action?: string;
	/** Value of the "preferred_locale" cookie, if the caller read one. */
	preferred_locale?: string;
}

export function localized_value_key(field_name: string, locale_code: string): string {
	return `${field_name}|${locale_code}`;
}

export function localized_input_name(field_name: string, locale_code: string): string {
	return `_lv[${field_name}][${locale_code}]`;
}

/**
 * Every locale's value for every localized field, keyed for the panel.
 *
 * The default locale reads from the base record; other locales read from their
 * own row. A locale with no row yet (a clone created after the record) falls
 * back to the base value, which is what the syncer would have backfilled.
 */
export function resolve_localized_values(
	fields: readonly LocalizedFormField[],
	record: Record<string, any>,
	locale_rows: Record<string, Record<string, any>>,
): Record<string, string | number | boolean> {
	const values: Record<string, string | number | boolean> = {};

	for (const field of fields) {
		for (const locale_code of locales as readonly string[]) {
			const source = locale_code === default_locale ? record : locale_rows[locale_code] ?? record;
			const value = source?.[field.field_name];
			if (value === null || value === undefined) continue;
			const key = localized_value_key(field.field_name, locale_code);
			values[key] = typeof value === "object" ? JSON.stringify(value, null, 2) : value;
		}
	}

	return values;
}

export function build_localization_props(options: BuildLocalizationOptions): LocalizationProps {
	const { fields, record, locale_rows = {}, errors = {}, notices = [], copy_action } = options;
	const generate_action = options.generate_action ?? copy_action.replace(/\/copy-locale$/, "/generate-locale");

	const resolved_values = resolve_localized_values(fields, record, locale_rows);
	const values = { ...resolved_values, ...(options.values ?? {}) };
	const stale: Record<string, string> = {};

	// The panel component wants presentation names, not storage ones.
	const panel_fields = fields.map((field) => ({
		name: field.field_name,
		label: field.label,
		type: field.input_type,
		upload_folder: field.upload_folder,
	}));

	// The default locale is the "Original" tab and always leads, regardless of
	// the order it happens to sit in locales.
	const ordered_locales = [default_locale, ...locales.filter((locale) => locale !== default_locale)];
	const preferred_locale = options.preferred_locale && (ordered_locales as readonly string[]).includes(options.preferred_locale)
		? options.preferred_locale
		: undefined;

	return {
		active_locales: ordered_locales,
		default_locale,
		locale_names,
		fields: panel_fields,
		record,
		values,
		errors,
		stale,
		copy_action,
		generate_action,
		preferred_locale,
	};
}

/**
 * Per-locale values submitted by the editor, keyed by locale then field.
 *
 * The default locale's values arrive as ordinary form fields (they are the
 * record's own columns), so only non-default locales appear here.
 */
export function parse_localized_form(params: URLSearchParams, fields: readonly LocalizedFormField[]): Record<string, Record<string, string>> {
	const by_locale: Record<string, Record<string, string>> = {};
	const allowed = new Set((locales as readonly string[]).filter((locale) => locale !== default_locale));

	for (const field of fields) {
		for (const locale_code of allowed) {
			const input_name = localized_input_name(field.field_name, locale_code);
			const raw_value = params.get(input_name);
			if (raw_value === null) continue;
			by_locale[locale_code] ??= {};
			by_locale[locale_code]![field.field_name] = raw_value;
		}
	}

	return by_locale;
}

/**
 * Validate every submitted translation against the same per-field Zod rule the
 * source field uses, so a translation can never bypass a constraint enforced
 * on the original.
 */
export function validate_localized_inputs(
	by_locale: Record<string, Record<string, string>>,
	schema: { shape: Record<string, { safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ message: string; }>; }; }; }>; },
	messages?: Record<string, string>,
): Record<string, string> {
	const errors: Record<string, string> = {};

	for (const [locale_code, field_values] of Object.entries(by_locale)) {
		for (const [field_name, value] of Object.entries(field_values)) {
			const field_schema = schema.shape[field_name];
			if (!field_schema) continue;
			const result = field_schema.safeParse(value);
			if (result.success) continue;
			const message = result.error?.issues[0]?.message ?? "invalid";
			errors[localized_value_key(field_name, locale_code)] = messages?.[message] ?? message;
		}
	}

	return errors;
}

/** Values keyed for the form, so a failed save re-renders what was typed. */
export function localized_input_form_state(by_locale: Record<string, Record<string, string>>): Record<string, string> {
	const values: Record<string, string> = {};
	for (const [locale_code, field_values] of Object.entries(by_locale)) {
		for (const [field_name, value] of Object.entries(field_values)) {
			values[localized_value_key(field_name, locale_code)] = value;
		}
	}
	return values;
}

/**
 * Which locale a copy submission targets and where it reads from.
 *
 * Two shapes are accepted, matching the two buttons in the editor:
 * `_copy_locale` copies every localized field, `_copy_field` copies one.
 * Both read their source from `_copy_from[<target>]`.
 */
export interface CopyRequest {
	from_locale: string;
	to_locale: string;
	field_name: string | null;
}

export function parse_copy_request(params: URLSearchParams): CopyRequest | null {
	const copy_locale = params.get("_copy_locale");
	const copy_field = params.get("_copy_field");

	let to_locale = "";
	let field_name: string | null = null;

	if (copy_locale) {
		to_locale = copy_locale;
	} else if (copy_field) {
		const separator = copy_field.lastIndexOf("|");
		if (separator < 1) return null;
		field_name = copy_field.slice(0, separator);
		to_locale = copy_field.slice(separator + 1);
	} else {
		return null;
	}

	const from_locale = params.get(`_copy_from[${to_locale}]`) ?? "";
	if (!from_locale || !to_locale || from_locale === to_locale) return null;

	const allowed = locales as readonly string[];
	if (!allowed.includes(from_locale) || !allowed.includes(to_locale)) return null;

	return { from_locale, to_locale, field_name };
}

/**
 * Which locale an AI-generate submission targets and where it reads from.
 * Shares the copy bar's `_copy_from[<target>]` source select - "generate"
 * is offered right next to "copy" for the same target locale.
 */
export interface GenerateRequest {
	from_locale: string;
	to_locale: string;
}

export function parse_generate_request(params: URLSearchParams): GenerateRequest | null {
	const to_locale = params.get("_generate_locale");
	if (!to_locale) return null;

	const from_locale = params.get(`_copy_from[${to_locale}]`) ?? "";
	if (!from_locale || from_locale === to_locale) return null;

	const allowed = locales as readonly string[];
	if (!allowed.includes(from_locale) || !allowed.includes(to_locale)) return null;

	return { from_locale, to_locale };
}
