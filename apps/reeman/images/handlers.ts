import { run_bulk_remove } from "$lib/crud_routes";
import { create_ctx } from "$lib/request_context";
import { delete_from_local, delete_from_s3 } from "$lib/s3";
import type { BunRequest } from "bun";

import { validate_touched } from "./schema/validation_server";
import { archive_record, get_record_by_id } from "./sql";

const TABLE_NAME = "images";

// ---------------------------------------------------------------------------
// POST /images/validate
// ---------------------------------------------------------------------------

export async function post_images_validate(req: BunRequest): Promise<Response> {
	const [body, ctx] = await Promise.all([req.json() as Promise<Record<string, any>>, create_ctx(req, import.meta.dir)]);
	const touched: string[] = body.touched || [];

	const data = {
		folder: body.folder || "",
		filename: body.filename || "",
		s3_key: body.s3_key || "",
		original_filename: body.original_filename || "",
		title: body.title || "",
		description: body.description || "",
		tags: body.tags || "",
		mime_type: body.mime_type || "",
		width: body.width || "",
		height: body.height || "",
		file_size: body.file_size || "",
	};

	const [errors] = validate_touched(data, touched, ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}

// ---------------------------------------------------------------------------
// POST /images/bulk-archive
// ---------------------------------------------------------------------------

export async function post_images_bulk_archive(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	// The stored object and its thumbnail are deliberately left in place.
	// Archiving is reversible, and restoring a row whose blob has been deleted
	// would hand the user back a broken record. Reclaiming storage belongs to a
	// purge step that removes the archived rows for real, not here.
	return run_bulk_remove(req, ctx, {
		feature: "images",
		table_name: TABLE_NAME,
		label: "image",
		mode: "archive",
		remove_one: async (id) => {
			const record = await get_record_by_id(Number(id));
			if (!record) return false;

			return !!(await archive_record(Number(id), ctx.user?.id ?? null));
		},
	});
}
