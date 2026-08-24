export async function post___table.exact___index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const params = new URLSearchParams(body);

	const data = {
		__create.params__
	};

	// Preserve parent FK before validation (required by Zod schema)
	data.__parent.fk_column__ = req.params.__parent.route_param__ || "";

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0 || !valid_data) {
		return Response.json({ success: false, errors }, { status: 422 });
	}

	try {
		const created_record = await create_record(valid_data);
		sql_log({s:"Create", t:`${feature}`, r:{...created_record}}, ctx.user?.username)
		notify_updates({ route: base_path(req.params.__parent.route_param__), action: "inserted", column: "id", value: String(created_record.id), description: `${ctx.user?.display_name || ctx.user?.username || "Someone"} added the record` });

		return Response.json({ success: true, record: created_record });

	} catch (error) {
		const error_key =
			error instanceof Error && error.message.toLowerCase().includes("duplicate entry")
				? "duplicate_key"
				: "error_creating_record";

		const error_message = ctx.translations.errors[error_key];

		return Response.json({ success: false, form_errors: error_message, errors }, { status: 422 });
	}

}
