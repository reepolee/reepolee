/**
 * Generic image upload route handlers - table-agnostic, no `images` row write.
 *
 * M2/M3 of PLAN_image_file_manager_extraction.md: regular apps mount these
 * endpoints so their CRUD image fields can process + store a per-field image
 * without touching reeman's admin `images` table. reeman's own
 * `apps/reeman/images/editor_server.ts` keeps its DB-coupled handlers.
 */

import { normalize_storage_folder } from "$lib/storage_keys";
import { duration_ms, log_error, log_info } from "$lib/logger";
import { require_auth, require_module, resolve_session } from "$platform/auth/middleware";
import type { BunRequest } from "bun";

import { process_image_upload, save_image_upload } from "./adapter";
import { cleanup } from "./upload_helpers";

// ---------------------------------------------------------------------------
// POST /upload/image/process - Preview (no storage, no DB)
// ---------------------------------------------------------------------------

export async function post_image_process_upload(req: BunRequest): Promise<Response> {
	const start = process.hrtime.bigint();
	log_info("image_processor", "POST /upload/image/process:start");

	const auth_ctx = await resolve_session(req);
	const guard = require_auth(auth_ctx, req);
	if (guard) return guard;

	let upload: Awaited<ReturnType<typeof process_image_upload>>["upload"] | undefined;

	try {
		const form_data = await req.formData() as unknown as FormData;

		const { result, upload: upload_info, format } = await process_image_upload(form_data);
		upload = upload_info;

		const bytes = await Bun.file(result.output_path).bytes();

		log_info("image_processor", "POST /upload/image/process:done", {
			width: result.width,
			height: result.height,
			duration: duration_ms(start),
		});

		return new Response(bytes, {
			status: 200,
			headers: {
				"Content-Type": result.mime,
				"X-Image-Width": String(result.width),
				"X-Image-Height": String(result.height),
				"X-Image-Format": format,
			},
		});
	} catch (err) {
		log_error("image_processor", "POST /upload/image/process:failed", err instanceof Error ? err : new Error(String(err)));
		return new Response(err instanceof Error ? err.message : "Processing failed", { status: 500 });
	} finally {
		await cleanup(upload?.temp_path);
	}
}

// ---------------------------------------------------------------------------
// POST /upload/image/save - Process + store to S3 (no DB row)
// ---------------------------------------------------------------------------

export async function post_image_save_upload(req: BunRequest): Promise<Response> {
	const start = process.hrtime.bigint();
	log_info("image_processor", "POST /upload/image/save:start");

	const auth_ctx = await resolve_session(req);
	const guard = require_auth(auth_ctx, req);
	if (guard) return guard;

	let upload: Awaited<ReturnType<typeof save_image_upload>>["upload"] | undefined;

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
			return new Response("Invalid image folder", { status: 400 });
		}

		const { result, upload: upload_info, format } = await save_image_upload(form_data, { folder });
		upload = upload_info;

		const final_s3_key = `${result.s3_key || result.filename}`;
		const filename = final_s3_key.split("/").pop() || final_s3_key;

		log_info("image_processor", "POST /upload/image/save:done", {
			s3_key: final_s3_key,
			width: result.width,
			height: result.height,
			duration: duration_ms(start),
		});

		const json = JSON.stringify({
			url: result.s3_url || "",
			width: result.width,
			height: result.height,
			format,
			size_kb: result.file_size / 1024,
			filename,
			s3_key: final_s3_key,
		});

		return new Response(json, { status: 200, headers: { "Content-Type": "application/json" } });
	} catch (err) {
		log_error("image_processor", "POST /upload/image/save:failed", err instanceof Error ? err : new Error(String(err)));
		return new Response(err instanceof Error ? err.message : "Save failed", { status: 500 });
	} finally {
		await cleanup(upload?.temp_path);
	}
}
