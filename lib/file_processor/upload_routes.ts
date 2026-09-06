/**
 * Generic file upload route handler - table-agnostic, no `files` row write.
 *
 * M2/M3 of PLAN_image_file_manager_extraction.md: regular apps mount this
 * endpoint so their CRUD file fields can store a per-field document without
 * touching reeman's admin `files` table. reeman's own
 * `apps/reeman/files/upload_server.ts` keeps its DB-coupled handler.
 */

import { normalize_storage_folder } from "$lib/storage_keys";
import { duration_ms, log_error, log_info } from "$lib/logger";
import { require_auth, require_module, resolve_session } from "$platform/auth/middleware";
import type { BunRequest } from "bun";

import { save_file_upload } from "./adapter";
import { cleanup } from "./helpers";

// ---------------------------------------------------------------------------
// POST /upload/file/save - Validate + store to S3 (no DB row)
// ---------------------------------------------------------------------------

export async function post_file_save_upload(req: BunRequest): Promise<Response> {
	const start = process.hrtime.bigint();
	log_info("file_processor", "POST /upload/file/save:start");

	const auth_ctx = await resolve_session(req);
	const guard = require_auth(auth_ctx, req);
	if (guard) return guard;

	let temp_path: string | undefined;

	try {
		const form_data = await req.formData() as unknown as FormData;

		const required_module = `${(form_data.get("module") as string) || ""}`;
		if (required_module) {
			const module_guard = require_module(auth_ctx, required_module);
			if (module_guard) return module_guard;
		}

		const raw_folder = `${(form_data.get("folder") as string) || ""}`;
		let folder: string;
		try {
			folder = normalize_storage_folder(raw_folder);
		} catch {
			return new Response("Invalid file folder", { status: 400 });
		}

		const { result, upload } = await save_file_upload(form_data, { folder });
		temp_path = upload.temp_path;

		const final_s3_key = `${result.s3_key || result.filename}`;
		const filename = final_s3_key.split("/").pop() || final_s3_key;

		log_info("file_processor", "POST /upload/file/save:done", {
			s3_key: final_s3_key,
			mime: result.mime,
			duration: duration_ms(start),
		});

		const json = JSON.stringify({
			url: result.s3_url || "",
			filename,
			mime_type: result.mime,
			size: result.file_size,
			size_kb: result.file_size / 1024,
			s3_key: final_s3_key,
		});

		return new Response(json, { status: 200, headers: { "Content-Type": "application/json" } });
	} catch (err) {
		log_error("file_processor", "POST /upload/file/save:failed", err instanceof Error ? err : new Error(String(err)));
		return new Response(err instanceof Error ? err.message : "Save failed", { status: 500 });
	} finally {
		await cleanup(temp_path);
	}
}
