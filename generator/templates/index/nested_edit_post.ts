export async function post___table.exact___edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const parent_id = Number(req.params.__parent.route_param__ || 0);
	const child_id = Number(req.params.__route_param__ || 0);
	const lookup_record = await get_record_by_id_and_parent(child_id, parent_id);
	const id = lookup_record?.id || 0;
	if (!lookup_record) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	const body = await req.text();
	const params = new URLSearchParams(body);
	const action = params.get("_action");

	if (action === "__archive.action_value__") {
		try {
			const removed = await __nested.delete_call__;

			if (removed) {
				await cache.invalidate(TABLE_NAME);
				await cache.invalidate("__parent.table__");
				sql_log({s:"__archive.log_verb__", t:`${feature}`, id: child_id}, ctx.user?.username)
				notify_updates({ route: base_path(parent_id), action: "deleted", column: "id", value: String(child_id), description: `${ctx.user?.display_name || ctx.user?.username || "Someone"} deleted the record` });
				return Response.json({ success: true });
			}

			return Response.json({ error: "Not found" }, { status: 404 });
		} catch (error) {
			const error_message = error instanceof Error && error.message.includes("foreign key")
				? "__archive.fk_error__"
				: "__archive.record_error__";

			return Response.json({ error: error_message }, { status: 400 });
		}
	}

	const data = {
		__update.params__
	};

	// Preserve parent FK before validation (required by Zod schema)
	data.__parent.fk_column__ = String(parent_id);
	__edit.parse_localization__
	__edit.localization_change_check__

	const [errors, valid_data] = validate(data, ctx.translations.errors);
	__edit.validate_localization__

	if (Object.keys(errors).length > 0 || !valid_data__edit.localization_errors_check__) {
		return Response.json({ success: false, errors }, { status: 422 });
	}

	let record;
	try {
		record = await update_record(id, valid_data);
		__edit.save_localization__
		await cache.invalidate(TABLE_NAME);
		await cache.invalidate("__parent.table__");
		sql_log({s:"Update", t:`${feature}`, r:{...record}}, ctx.user?.username)
		notify_updates({ route: base_path(parent_id), action: "updated", column: "id", value: String(id), description: `${ctx.user?.display_name || ctx.user?.username || "Someone"} edited the record` });
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
