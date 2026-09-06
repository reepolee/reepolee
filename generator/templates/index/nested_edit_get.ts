export async function get___table.exact___edit(req: BunRequest): Promise<Response> {
	const parent_id = Number(req.params.__parent.route_param__ || 0);
	const child_id = Number(req.params.__route_param__ || 0);
	const record = await get_record_by_id_and_parent(child_id, parent_id);

	if (!record) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	__edit.load_nested_localization__

	return Response.json({ record__edit.nested_localization_data__ });
}
