import { run_bulk_delete } from "$lib/crud_routes";
import { create_ctx } from "$lib/request_context";
import { delete_from_local, delete_from_s3 } from "$lib/s3";
import type { BunRequest } from "bun";

import { validate_touched } from "./schema/validation_server";
import { delete_record, get_record_by_id } from "./sql";

const TABLE_NAME = "files";

// ---------------------------------------------------------------------------
// POST /files/validate
// ---------------------------------------------------------------------------

export async function post_files_validate(req: BunRequest): Promise<Response> {
	const [body, ctx] = await Promise.all([req.json(), create_ctx(req, import.meta.dir)]);
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
		file_type: body.file_type || "",
		file_size: body.file_size || "",
	};

	const [errors] = validate_touched(data, touched, ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}

// ---------------------------------------------------------------------------
// POST /files/bulk-delete
// ---------------------------------------------------------------------------

export async function post_files_bulk_delete(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const bucket = Bun.env.S3_FILE_BUCKET || "files";

	return run_bulk_delete(req, ctx, {
		feature: "files",
		table_name: TABLE_NAME,
		label: "file",
		delete_one: async (id) => {
			const record = await get_record_by_id(Number(id));
			if (!record) return false;

			if (record.s3_key) {
				try {
					await delete_from_s3(bucket, record.s3_key);
					await delete_from_local(bucket, record.s3_key);
				} catch (err) {
					console.error("Failed to delete file:", err);
				}
			}

			return !!(await delete_record(Number(id)));
		},
	});
}
