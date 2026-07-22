export async function post___table.exact___bulk_delete(req: BunRequest): Promise<Response> {
	if (!enable_delete) {
		return Response.json({ error: "Bulk delete is disabled." }, { status: 403 });
	}
	const ctx = await create_ctx(req, import.meta.dir);
	return run_bulk_delete(req, ctx, {
		feature,
		table_name: TABLE_NAME,
		delete_one: (id) => delete_record(id),
	});
}
