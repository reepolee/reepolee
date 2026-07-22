export async function get___table.exact___edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	__edit.get_lookup__

	if (!record) {
		return render("notfound", {
			data:{ title: "404 Not Found" },
			status: 404,
			ctx,
		});
	}

	if (req.headers.get("Accept") === "application/json") {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		return Response.json(strip_api_sensitive(record as Record<string, unknown>));
	}

	__edit.get_foreign_key_options__
	__edit.get_tags_options__
	__edit.get_autocomplete_display__
	// crud:child:fetch:start
	// crud:child:fetch:end

	const bp = base_path();
	return render("form", {
		data:{
			title: `Edit ${record.__field.first__}`,
			record,
			back_route: `${bp}?there_should_be_back_params`,
			errors: __empty.errors__,
			action: entity_path(record.__route_param__),
			__edit.foreign_key_options__
			__edit.tags_options__
			__edit.autocomplete_display_options__
			// crud:child:data:start
			// crud:child:data:end
			enable_delete,
		},
		ctx,
	});
}
