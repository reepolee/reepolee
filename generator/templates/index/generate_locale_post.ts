/**
 * AI-generate a first-draft translation of one record's localized fields.
 *
 * Reached via formaction from the locale editor, so the whole edit form is
 * submitted. The record is saved first and the generation runs against the
 * freshly saved values - otherwise it would silently discard unsaved edits,
 * or translate a source the editor is no longer showing.
 *
 * The AI call runs in the queue worker (`translate_record` handler), so the
 * request returns immediately; when the queue is unavailable the call runs
 * inline as a fallback. Generated values carry the same provenance as a
 * manual copy (source locale + value hash), so the stale-copy notice fires
 * if the source changes afterward - a generated value is just a copy whose
 * text passed through a translator on the way in.
 */
export async function post___table.exact___generate_locale(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	__edit.post_lookup__
	const body = await req.text();
	const _locale = get_locale_from_request(req) || default_locale;
	const params = new URLSearchParams(body);

	const generate_request = parse_generate_request(params);
	if (!generate_request) { return Response.redirect(localized_url(entity_path(__route_param__), _locale), 303); }

	const data = {
		__update.params__
	};

	const [errors, valid_data] = validate(data, ctx.translations.errors);
	if (Object.keys(errors).length > 0 || !valid_data) {
		// The record itself is invalid, so there is nothing safe to translate from.
		return Response.redirect(localized_url(entity_path(__route_param__), _locale), 303);
	}

	const localized_inputs = parse_localized_form(params, LOCALIZED_FIELDS);
	await update_record(id, valid_data, _locale);
	await save_locale_values(TABLE_NAME, Number(id), localized_inputs);

	try {
		await enqueue({
			type: "translate_record",
			payload: {
				table_name: TABLE_NAME,
				record_id: Number(id),
				field_names: LOCALIZED_FIELD_NAMES,
				from_locale: generate_request.from_locale,
				to_locale: generate_request.to_locale,
			},
		});
	} catch (error) {
		// Queue unavailable - generate inline so the editor still fills in.
		await generate_localized_values(TABLE_NAME, Number(id), LOCALIZED_FIELD_NAMES, generate_request.from_locale, generate_request.to_locale);
		await invalidate_all_locales(TABLE_NAME);
	}
	sql_log({ s: "GenerateLocale", t: `${feature}`, r: { id, from: generate_request.from_locale, to: generate_request.to_locale } }, ctx.user?.username);

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
