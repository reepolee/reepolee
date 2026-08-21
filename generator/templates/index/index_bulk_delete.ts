export async function post___table.exact___bulk___archive.action_value__(req: BunRequest): Promise<Response> {
	if (!enable_archive) {
		return Response.json({ error: "__archive.bulk_disabled_error__" }, { status: 403 });
	}
	const ctx = await create_ctx(req, import.meta.dir);
	return run_bulk_remove(req, ctx, {
		feature,
		table_name: TABLE_NAME,
		remove_one: (id) => __archive.record_fn__(Number(id)__archive.delete_arg__),__archive.bulk_mode__
	});
}
