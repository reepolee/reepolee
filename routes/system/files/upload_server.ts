import { db } from "$config/db";
import { cache } from "$lib/cache";
import { cleanup, hard_clone, save_file_to_storage, save_upload_to_temp } from "$lib/file_processor";
import { normalize_storage_folder } from "$lib/storage_keys";
import { duration_ms, log_error, log_info } from "$lib/logger";
import { require_auth, require_module, resolve_session } from "$root/routes/system/auth/middleware";
import type { BunRequest } from "bun";

// ---------------------------------------------------------------------------
// POST /files/save - Upload + storage + DB insert (no processing)
// ---------------------------------------------------------------------------

export async function post_files_save(req: BunRequest): Promise<Response> {
	const start = process.hrtime.bigint();

	log_info("files", "POST /files/save:start");

	const auth_ctx = await resolve_session(req);
	const guard = require_auth(auth_ctx, req);

	if (guard) { return guard; }

	let temp_path: string | undefined;

	try {
		const form_data = await req.formData();

		const required_module = `${(form_data.get("module") as string) || ""}`;
		if (required_module) {
			const module_guard = require_module(auth_ctx, required_module);
			if (module_guard) return module_guard;
		}

		const raw_folder = `${(form_data.get("folder") as string) || ""}`;
		let folder: string;
		try {
			folder = hard_clone(normalize_storage_folder(raw_folder));
		} catch {
			return new Response("Invalid file folder", { status: 400 });
		}

		const upload = await save_upload_to_temp(form_data);
		temp_path = upload.temp_path;

		const original_name = hard_clone(upload.original_name);
		const title = hard_clone(`${(form_data.get("title") as string) || ""}`);
		const description = hard_clone(`${(form_data.get("description") as string) || ""}`);
		const tags = hard_clone(`${(form_data.get("tags") as string) || ""}`);

		const result = await save_file_to_storage(upload.temp_path, upload.ext, upload.mime, upload.file_size, { folder });

		const final_s3_key = hard_clone(`${result.s3_key || result.filename}`);
		const result_filename = hard_clone(final_s3_key.split("/").pop() || final_s3_key);
		const file_type = hard_clone(upload.ext);

		const rows = await db`
			INSERT INTO files (
				folder, filename, s3_key, original_filename, title, description, tags, mime_type, file_type, file_size
			)
			VALUES (
				${folder}, ${result_filename}, ${final_s3_key}, ${original_name}, ${title}, ${description}, ${tags}, ${result.mime}, ${file_type}, ${result.file_size}
			)
			RETURNING id
		`;

		const db_id = rows[0]?.id ?? 0;

		await cache.invalidate("files");

		log_info("files", "POST /files/save:done", { db_id, duration: duration_ms(start) });

		const json = JSON.stringify({
			db_id,
			s3_url: result.s3_url || "",
			size_kb: result.file_size / 1024,
			filename: result_filename,
			s3_key: final_s3_key,
			original_filename: original_name,
		});

		return new Response(json, { status: 200, headers: { "Content-Type": "application/json" } });
	} catch (err) {
		log_error("files", "POST /files/save:failed", err instanceof Error ? err : new Error(String(err)));

		return new Response(err instanceof Error ? err.message : "Save failed", { status: 500 });
	} finally {
		await cleanup(temp_path);
	}
}
