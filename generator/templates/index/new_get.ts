export async function get___table.exact___new(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	__new.get_foreign_key_options__
	__new.get_tags_options__
	__new.get_autocomplete_display__

	return render("form", {
		data:{
			page_title: ctx.translations.ui?.new_title,
			record: __empty.record__,
			errors: __empty.errors__,
			action: base_path(),
			__new.localization_data__
			__new.foreign_key_options__
			__new.tags_options__
			__new.autocomplete_display_options__
			enable_archive,
		},
		ctx,
	});
}
