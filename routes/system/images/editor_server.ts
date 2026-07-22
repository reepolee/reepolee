import { db } from "$config/db";
import { cache } from "$lib/cache";
import { process_and_save_to_s3, process_image } from "$lib/image_processor";
import { normalize_storage_folder } from "$lib/storage_keys";
import { duration_ms, log_error, log_info, log_warn } from "$lib/logger";
import { delete_from_local, delete_from_s3 } from "$lib/s3";
import { require_auth, require_module, resolve_session } from "$root/routes/system/auth/middleware";
import type { BunRequest } from "bun";

import { cleanup, form_int, hard_clone, parse_crop, parse_resize, save_upload_to_temp, type Upload } from "./editor_helpers";
import { db_insert_image, save_original_copy } from "./editor_original";

const IMAGE_BUCKET = Bun.env.S3_IMAGE_BUCKET || "images";

// ---------------------------------------------------------------------------
// POST /images/process - Preview
// ---------------------------------------------------------------------------

export async function post_images_process(req: BunRequest): Promise<Response> {
	const start = process.hrtime.bigint();

	log_info("editor", "POST /images/process:start");

	const auth_ctx = await resolve_session(req);
	const guard = require_auth(auth_ctx, req);

	if (guard) { return guard; }

	let upload: Upload | undefined;
	let result: Awaited<ReturnType<typeof process_image>> | undefined;

	try {
		const form_data = await req.formData();

		upload = await save_upload_to_temp(form_data);

		const format = (form_data.get("format") as string) || "webp";
		const quality = form_int(form_data, "quality") || 85;

		result = await process_image(upload.temp_path, {
			crop: parse_crop(form_data),
			resize: parse_resize(form_data),
			format,
			quality,
		});

		const bytes = await Bun.file(result.output_path).bytes();

		log_info("editor", "POST /images/process:done", {
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
		log_error("editor", "POST /images/process:failed", err instanceof Error ? err : new Error(String(err)));

		return new Response(err instanceof Error ? err.message : "Processing failed", { status: 500 });
	} finally {
		await cleanup(upload?.temp_path, result?.output_path);
	}
}

// ---------------------------------------------------------------------------
// POST /images/save - Process + S3 + DB
// ---------------------------------------------------------------------------

export async function post_images_save(req: BunRequest): Promise<Response> {
	const start = process.hrtime.bigint();

	log_info("editor", "POST /images/save:start");

	const auth_ctx = await resolve_session(req);
	const guard = require_auth(auth_ctx, req);

	if (guard) { return guard; }

	let upload: Upload | undefined;
	let result: Awaited<ReturnType<typeof process_and_save_to_s3>> | undefined;

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
			return new Response("Invalid image folder", { status: 400 });
		}

		log_warn("editor", "POST /images/save:form parsed");

		upload = await save_upload_to_temp(form_data);

		log_warn("editor", "POST /images/save:after upload", {
			upload_original_name: upload.original_name,
			upload_temp_path: upload.temp_path,
		});

		// HARD CLONE - avoid Bun native string mutation
		const original_name = hard_clone(upload.original_name);
		const temp_path = hard_clone(upload.temp_path);

		log_warn("editor", "POST /images/save:primitives frozen", { original_name, temp_path, same_ref_upload: Object.is(original_name, upload.original_name) });

		const original_s3_key = hard_clone(`${(form_data.get("s3_key") as string) || ""}`);

		const save_as_copy = form_data.get("save_as_copy") === "1";

		const keep_original = form_data.get("keep_original") === "1";

		const format = hard_clone(`${(form_data.get("format") as string) || "webp"}`);

		const quality = form_int(form_data, "quality") || 85;

		const title = hard_clone(`${(form_data.get("title") as string) || ""}`);

		const description = hard_clone(`${(form_data.get("description") as string) || ""}`);

		const tags = hard_clone(`${(form_data.get("tags") as string) || ""}`);

		// Compute S3 key for edit-mode saves, respecting folder
		let target_s3_key = "";

		if (!save_as_copy && original_s3_key) {
			const base_filename = original_s3_key.split("/").pop() || original_s3_key;
			const key_with_format = base_filename.replace(/\.[^.]+$/, `.${format}`);

			target_s3_key = folder ? `${folder}/${key_with_format}` : key_with_format;
			target_s3_key = hard_clone(target_s3_key);
		}

		log_warn("editor", "POST /images/save:before process_and_save_to_s3", { original_name, temp_path, target_s3_key });

		result = await process_and_save_to_s3(temp_path, {
			crop: parse_crop(form_data),
			resize: parse_resize(form_data),
			format,
			quality,
			s3_key: target_s3_key || undefined,
			folder: target_s3_key ? undefined : folder,
		});

		log_warn("editor", "POST /images/save:after process_and_save_to_s3", {
			original_name,
			temp_path,
			result_filename: result.filename,
			result_s3_key: result.s3_key,
		});

		const final_s3_key = hard_clone(`${result.s3_key || result.filename}`);

		// Derive filename from the actual S3 key so it always matches (extension + UUID)
		const result_filename = hard_clone(final_s3_key.split("/").pop() || final_s3_key);

		const result_mime = hard_clone(`${result.mime}`);

		const result_width = result.width;
		const result_height = result.height;
		const result_file_size = result.file_size;

		const result_s3_url = hard_clone(`${result.s3_url || ""}`);

		let db_id = 0;

		if (!save_as_copy && original_s3_key) {
			await db`
				UPDATE images SET
					mime_type = ${result_mime},
					width = ${result_width},
					height = ${result_height},
					file_size = ${result_file_size},
					filename = ${result_filename},
					title = ${title},
					description = ${description},
					tags = ${tags},
					folder = ${folder},
					s3_key = ${final_s3_key},
					updated_at = CURRENT_TIMESTAMP
				WHERE s3_key = ${original_s3_key}
			`;

			const rows = await db`
				SELECT id FROM images
				WHERE s3_key = ${final_s3_key}
			`;

			db_id = rows[0]?.id ?? 0; // -- Delete old files if the key changed (e.g. folder or format change) --
			if (original_s3_key !== final_s3_key) {
				try {
					// Delete the old image from S3 (skips gracefully if S3 not configured)
					log_info("editor", "POST /images/save: deleting old image", {
						old_key: original_s3_key,
						new_key: final_s3_key,
					});
					await delete_from_s3(IMAGE_BUCKET, original_s3_key);
					// Also delete from local storage (skips gracefully if not available)
					await delete_from_local(IMAGE_BUCKET, original_s3_key);

					// Also delete the old thumbnail (tn_ prefix)
					const old_thumb_key = original_s3_key.replace(/[^/]+$/, (match) => `tn_${match}`);
					if (old_thumb_key !== original_s3_key) {
						log_info("editor", "POST /images/save: deleting old thumbnail", { old_thumb_key });
						await delete_from_s3(IMAGE_BUCKET, old_thumb_key);
						await delete_from_local(IMAGE_BUCKET, old_thumb_key);
					}

					log_info("editor", "POST /images/save: old files deleted");
				} catch (err) {
					// Non-fatal - log and continue
					log_error("editor", "POST /images/save: failed to delete old files", err instanceof Error ? err : new Error(String(err)));
				}
			}
		} else {
			db_id = await db_insert_image(
				folder,
				result_filename,
				final_s3_key,
				hard_clone(original_name),
				title,
				description,
				tags,
				result_mime,
				result_width,
				result_height,
				result_file_size
			);
		}

		await cache.invalidate("images");

		log_warn("editor", "POST /images/save:db complete", { db_id, original_name_after_db: original_name });

		let original_db_id = 0;
		let _original_s3_url = "";

		if (!original_s3_key && keep_original) {
			original_db_id = await save_original_copy({
				temp_path,
				original_name: hard_clone(original_name),
				folder,
				title,
				description,
				tags,
			});
		}

		log_info("editor", "POST /images/save:done", { db_id, original_db_id, duration: duration_ms(start) });

		const json = JSON.stringify({
			db_id,
			s3_url: result_s3_url,
			width: result_width,
			height: result_height,
			format,
			size_kb: result_file_size / 1024,
			filename: result_filename,
			s3_key: final_s3_key,
		});

		return new Response(json, { status: 200, headers: { "Content-Type": "application/json" } });
	} catch (err) {
		log_error("editor", "POST /images/save:failed", err instanceof Error ? err : new Error(String(err)));

		return new Response(err instanceof Error ? err.message : "Save failed", { status: 500 });
	} finally {
		await cleanup(upload?.temp_path, result?.output_path);
	}
}
