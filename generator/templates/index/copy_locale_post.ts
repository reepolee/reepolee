/**
 * Copy one locale's values into another for a single record.
 *
 * Reached via formaction from the locale editor, so the whole edit form is
 * submitted. The record is saved first and the copy runs against the freshly
 * saved values - otherwise copying would silently discard unsaved edits, or
 * copy a source the editor is no longer showing.
 *
 * Copies are one-time by design: later edits to the source do not follow.
 * Each copied row records where it came from and a hash of the source at copy
 * time, so the editor can flag it once the original moves on.
 */
export async function post___table.exact___copy_locale(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	__edit.post_lookup__
	const body = await req.text();
	const _locale = get_locale_from_request(req) || default_locale;
	const params = new URLSearchParams(body);

	const copy_request = parse_copy_request(params);
	if (!copy_request) { return Response.redirect(localized_url(entity_path(__route_param__), _locale), 303); }

	const data = {
		__update.params__
	};

	const [errors, valid_data] = validate(data, ctx.translations.errors);
	if (Object.keys(errors).length > 0 || !valid_data) {
		// The record itself is invalid, so there is nothing safe to copy from.
		return Response.redirect(localized_url(entity_path(__route_param__), _locale), 303);
	}

	const localized_inputs = parse_localized_form(params, LOCALIZED_FIELDS);
	await update_record(id, valid_data, _locale);
	await save_locale_values(TABLE_NAME, Number(id), localized_inputs);

	const copy_field_names = copy_request.field_name
		? LOCALIZED_FIELD_NAMES.filter((field_name) => field_name === copy_request.field_name)
		: LOCALIZED_FIELD_NAMES;

	await copy_localized_values(TABLE_NAME, Number(id), copy_field_names, copy_request.from_locale, copy_request.to_locale);
	await invalidate_all_locales(TABLE_NAME);
	sql_log({ s: "CopyLocale", t: `${feature}`, r: { id, from: copy_request.from_locale, to: copy_request.to_locale, field: copy_request.field_name } }, ctx.user?.username);

	const cookie = create_toast_cookie({
		record_id: Number(id),
		feature,
		message: ctx.translations.messages.record_updated,
		type: "green",
		user: ctx.user?.display_name,
	});

	const headers = new Headers({ Location: localized_url(entity_path(__route_param__), _locale) });
	headers.append("Set-Cookie", cookie.toString());
	return new Response(null, { status: 303, headers });
}
