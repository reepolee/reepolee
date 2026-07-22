export async function post___table.exact___index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const _lang = get_lang_from_request(req) || default_language;
	const params = new URLSearchParams(body);

	const data = {
		__create.params__
	};

	__parent.fk_init__

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) {
		return render("form", {
			data:{
				record: data,
				errors,
				action: base_path(),
				enable_delete,
			},
			ctx,
		});
	}

	try {
		const created_record = await create_record(valid_data);
		await cache.invalidate(TABLE_NAME);
		sql_log({s:"Create", "t":`${feature}`, r:{...created_record}}, ctx.user?.username)

		const save_action = params.get("_save_action");
		if (save_action === "stay") {
			// Save: go to edit page for new record
			const route_param_value = created_record.__route_param__ || created_record.id;
			return Response.redirect(localized_url(entity_path(route_param_value), _lang), 303);
		}
		return Response.redirect(localized_url(base_path(), _lang), 303);

	} catch (error) {
		const error_key =
			error instanceof Error && error.message.toLowerCase().includes("duplicate entry")
				? "duplicate_key"
				: "error_creating_record";

		const error_message = ctx.translations.errors[error_key];

		return render("form", {
			data: {
				save_label: "Shrani zapis",
				title: "New record",
				record: data,
				errors,
				form_errors: error_message,
				action: base_path(),
				enable_delete,
			},
			ctx,
		});
	}

}
