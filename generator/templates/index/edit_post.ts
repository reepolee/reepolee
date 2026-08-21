export async function post___table.exact___edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	__edit.post_lookup__
	const body = await req.text();
	const _lang = get_locale_from_request(req) || default_locale;
	const params = new URLSearchParams(body);
	const action = params.get("_action");
	const return_url_from_form = params.get("_return_url");
	const save_action = params.get("_save_action");

	__edit.get_foreign_key_options__
	__edit.get_tags_options__

	const bp = base_path();
	let redirect_url = localized_url(bp, _lang);
	if (save_action === "stay") {
		// Save: stay on edit page - id is always available from the lookup above
		redirect_url = localized_url(entity_path(id), _lang);
	} else if (is_list_return_url(return_url_from_form, bp)) {
		redirect_url = return_url_from_form!;
	} else {
		const redirect_from_referer = get_redirect_from_referer(req);
		if (redirect_from_referer) redirect_url = redirect_from_referer;
	}		if (action === "__archive.action_value__") {
		if (!enable_archive) {
			return Response.json({ error: "__archive.disabled_error__" }, { status: 403 });
		}
		try {
			const removed = __edit.post_delete_call__;

			if (removed) {
				await cache.invalidate(TABLE_NAME);
				sql_log({s:"__archive.log_verb__", "t":`${feature}`, id}, ctx.user?.username)
				return Response.redirect(redirect_url, 303);
			}

			return render("notfound", {
				data: { title: "404 Not Found" },
				status: 404,
				ctx,
			});
		} catch (error) {
			const existing_record = __edit.post_delete_catch_lookup__;
			if (!existing_record) {
				return render("notfound", {
					data: { title: "404 Not Found" },
					status: 404,
					ctx,
				});
			}

			const error_message = error instanceof Error && error.message.includes("foreign key")
				? "__archive.fk_error__"
				: "__archive.record_error__";

			return render("form", {
				data: {
					title: `Edit ${existing_record.__field.first__}`,
					record: existing_record,
					form_errors: error_message,
					errors: {},
				action: entity_path(__route_param__),
				__edit.foreign_key_options__
				__edit.tags_options__
				enable_archive,
			},
			ctx,
		});
		}
	}

	__archive.restore_branch__

	const data = {
		__update.params__
	};

	__edit.parse_localization__

	const [errors, valid_data] = validate(data, ctx.translations.errors);
	__edit.validate_localization__

	if (Object.keys(errors).length > 0 || !valid_data__edit.localization_errors_check__) {
		const existing_record = await get_record_by_id(id__sql.read_locale_arg__);
		if (!existing_record) {
			return render("notfound", {
				data:{ title: "404 Not Found" },
				status: 404,
				ctx,
			});
		}
		// GEN:CHILD:FETCH:START
		// GEN:CHILD:FETCH:END
		return render("form", {
			data:{
				title: `Edit ${existing_record.__field.first__}`,
				record: { ...existing_record, ...data },
				errors,
				form_errors: null,
				__edit.localization_error_data__
				action: entity_path(__route_param__),
				__edit.foreign_key_options__
				__edit.tags_options__
				// GEN:CHILD:DATA:START
				// GEN:CHILD:DATA:END
				enable_archive,
			},
			ctx,
		});
	}


	let record;
	try {
		record = await update_record(id, valid_data__sql.edit_locale_arg__);
		__edit.save_localization__
		await cache.invalidate(TABLE_NAME);
		sql_log({s:"Update", "t":`${feature}`, r:{...record}}, ctx.user?.username)
	} catch (error) {
		const error_key =
			error instanceof Error && error.message.toLowerCase().includes("duplicate entry")
				? "duplicate_key"
				: "error_creating_record";

		const error_message = ctx.translations.errors[error_key];
		__edit.catch_existing_record__
		return render("form", {
			data: {
				__edit.catch_title_data__
				__edit.catch_record_data__
				errors,
				form_errors: error_message,__edit.catch_localization_data__
				action: entity_path(__route_param__),
				__edit.foreign_key_options__
				__edit.tags_options__
				enable_archive,
			},
			ctx,
		});
	}


	if (!record) {
		return render("notfound", {
			data:{ title: "404 Not Found" },
			status: 404,
			ctx,
		});
	}

	const cookie = create_toast_cookie({
		record_id: record.id,
		feature,
		message: ctx.translations.messages.record_updated,
		type: "green",
		user: ctx.user?.display_name,
	});

	const headers = new Headers({
		Location: redirect_url,
	});

	headers.append("Set-Cookie", cookie.toString());

	return new Response(null, {
		status: 303,
		headers,
	});
}
