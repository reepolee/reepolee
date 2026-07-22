export async function post___table.exact___edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const parent_id = req.params.__parent.route_param__;
	const child_id = req.params.__route_param__ || "";
	const lookup_record = await get_record_by_id_and_parent(child_id, parent_id);
	const id = lookup_record?.id || "";
	if (!lookup_record) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	const body = await req.text();
	const params = new URLSearchParams(body);
	const action = params.get("_action");

	if (action === "delete") {
		try {
			const deleted = await __nested.delete_call__;

			if (deleted) {
				await cache.invalidate(TABLE_NAME);
				await cache.invalidate("__parent.table__");
				sql_log({s:"Delete", t:`${feature}`, id: child_id}, ctx.user?.username)
				return Response.json({ success: true });
			}

			return Response.json({ error: "Not found" }, { status: 404 });
		} catch (error) {
			const error_message = error instanceof Error && error.message.includes("foreign key")
				? "Cannot delete this record because it's referenced by other records."
				: "Error deleting record.";

			return Response.json({ error: error_message }, { status: 400 });
		}
	}

	const data = {
		__update.params__
	};

	// Preserve parent FK before validation (required by Zod schema)
	data.__parent.fk_column__ = parent_id;

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) {
		return Response.json({ success: false, errors }, { status: 422 });
	}

	let record;
	try {
		record = await update_record(id, valid_data);
		await cache.invalidate(TABLE_NAME);
		await cache.invalidate("__parent.table__");
		sql_log({s:"Update", t:`${feature}`, r:{...record}}, ctx.user?.username)
	} catch (error) {
		const error_key =
			error instanceof Error && error.message.toLowerCase().includes("duplicate entry")
				? "duplicate_key"
				: "error_creating_record";

		const error_message = ctx.translations.errors[error_key];

		return Response.json({ success: false, form_errors: error_message, errors }, { status: 422 });
	}

	if (!record) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	return Response.json({ success: true, record });
}
