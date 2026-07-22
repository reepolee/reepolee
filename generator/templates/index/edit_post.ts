export async function post___table.exact___edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	__edit.post_lookup__
	const body = await req.text();
	const _lang = get_lang_from_request(req) || default_language;
	const params = new URLSearchParams(body);
	const action = params.get("_action");
	const return_url_from_form = params.get("_return_url");
	const save_action = params.get("_save_action");

	const bp = base_path();
	let redirect_url = localized_url(bp, _lang);
	if (save_action === "stay") {
		// Save: stay on edit page - id is always available from the lookup above
		redirect_url = localized_url(entity_path(id), _lang);
	} else if (return_url_from_form?.includes(bp)) {
		redirect_url = return_url_from_form;
	} else {
		const redirect_from_referer = get_redirect_from_referer(req);
		if (redirect_from_referer) redirect_url = redirect_from_referer;
	}		if (action === "delete") {
		if (!enable_delete) {
			return Response.json({ error: "Delete is disabled." }, { status: 403 });
		}
		try {
			const deleted = __edit.post_delete_call__;

			if (deleted) {
				await cache.invalidate(TABLE_NAME);
				sql_log({s:"Delete", "t":`${feature}`, id}, ctx.user?.username)
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
				? "Cannot delete this record because it's referenced by other records."
				: "Error deleting record.";

			return render("form", {
				data: {
					title: `Edit ${existing_record.name}`,
					record: existing_record,
					form_errors: error_message,
					errors: {},
				action: entity_path(__route_param__),
				enable_delete,
			},
			ctx,
		});
		}
	}


	const data = {
		__update.params__
	};

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) {
		const existing_record = await get_record_by_id(id);
		if (!existing_record) {
			return render("notfound", {
				data:{ title: "404 Not Found" },
				status: 404,
				ctx,
			});
		}
		// crud:child:fetch:start
		// crud:child:fetch:end
		return render("form", {
			data:{
				title: `Edit ${existing_record.__field.first__}`,
				record: { ...existing_record, ...data },
				errors,
				action: entity_path(__route_param__),
				// crud:child:data:start
				// crud:child:data:end
				enable_delete,
			},
			ctx,
		});
	}


	let record;
	try {
		record = await update_record(id, valid_data);
		await cache.invalidate(TABLE_NAME);
		sql_log({s:"Update", "t":`${feature}`, r:{...record}}, ctx.user?.username)
	} catch (error) {
		const error_key =
			error instanceof Error && error.message.toLowerCase().includes("duplicate entry")
				? "duplicate_key"
				: "error_creating_record";

		const error_message = ctx.translations.errors[error_key];

		return render("form", {
			data: {
				record: data,
				errors,
				form_errors: error_message,
				action: entity_path(__route_param__),
				enable_delete,
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
