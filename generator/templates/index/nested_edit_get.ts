export async function get___table.exact___edit(req: BunRequest): Promise<Response> {
	const parent_id = req.params.__parent.route_param__;
	const child_id = req.params.__route_param__ || "";
	const record = await get_record_by_id_and_parent(child_id, parent_id);

	if (!record) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	return Response.json({ record });
}
