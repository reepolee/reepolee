export async function post___table.exact___index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const _lang = get_locale_from_request(req) || default_locale;
	const params = new URLSearchParams(body);

	const data = {
		__create.params__
	};

	__parent.fk_init__

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0 || !valid_data) {
		__new.get_foreign_key_options__
		__new.get_tags_options__
		return render("form", {
			data:{
				record: data,
				errors,
				form_errors: null,
				action: base_path(),
				__new.post_localization_data__
				__new.foreign_key_options__
				__new.tags_options__
				enable_archive,
			},
			ctx,
		});
	}

	try {
		const created_record = await create_record(valid_data);
		await cache.invalidate(TABLE_NAME);
		sql_log({s:"Create", "t":`${feature}`, r:{...created_record}}, ctx.user?.username)
		notify_updates({ route: base_path(), action: "inserted", column: "id", value: String(created_record.id), description: `${ctx.user?.display_name || ctx.user?.username || "Someone"} added the record` });

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

		__new.get_foreign_key_options__
		__new.get_tags_options__
		return render("form", {
			data: {
				save_label: "Shrani zapis",
				title: "New record",
				record: data,
				errors,
				form_errors: error_message,
				action: base_path(),
				__new.post_localization_data__
				__new.foreign_key_options__
				__new.tags_options__
				enable_archive,
			},
			ctx,
		});
	}

}
