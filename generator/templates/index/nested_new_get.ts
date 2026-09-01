export async function get___table.exact___new(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const parent_id = req.params.__parent.route_param__;

	__new.get_foreign_key_options__
	__new.get_tags_options__
	__new.get_autocomplete_display__

	return Response.json({
		record: {
			...__empty.record__,
			__parent.fk_column__: parent_id,
		},
		__new.foreign_key_options__
		__new.tags_options__
	});
}
