/**
 * Image editor - original-copy persistence support.
 *
 * db_insert_image() is the one INSERT the editor uses; save_original_copy()
 * uploads the untouched source file (plus a 100px thumbnail) to S3 and
 * records it, used when "keep original" is checked on a fresh upload.
 * Split from editor_server.ts to keep both near the ~300-line convention.
 */

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "$config/db";
import { generate_thumbnail, get_image_dims } from "$lib/image_processor";
import { log_error, log_warn } from "$lib/logger";
import { save_to_s3 } from "$lib/s3";
import { uuid_v7 } from "$lib/uuid";

import { ext_of, hard_clone, mime_to_ext } from "./editor_helpers";

const IMAGE_BUCKET = Bun.env.S3_IMAGE_BUCKET || "images";

export async function db_insert_image(
	folder: string,
	filename: string,
	s3_key: string,
	original_name: string,
	title: string,
	description: string,
	tags: string,
	mime: string,
	width: number,
	height: number,
	file_size: number,
): Promise<number> {
	log_warn("editor", "db_insert_image:input", {
		folder,
		filename,
		s3_key,
		original_name,
		typeof_original_name: typeof original_name,
		length: original_name?.length,
		json: JSON.stringify(original_name),
	});

	const rows = await db`
		INSERT INTO images (
			folder,
			filename,
			s3_key,
			original_filename,
			title,
			description,
			tags,
			mime_type,
			width,
			height,
			file_size
		)
		VALUES (
			${folder},
			${filename},
			${s3_key},
			${original_name},
			${title},
			${description},
			${tags},
			${mime},
			${width},
			${height},
			${file_size}
		)
		RETURNING id
	`;

	log_warn("editor", "db_insert_image:complete", { rows, original_name_after_query: original_name });

	return rows[0]?.id ?? 0;
}

export interface SaveOriginalOptions {
	temp_path: string;
	original_name: string;
	folder: string;
	title: string;
	description: string;
	tags: string;
}

/**
 * Persist the untouched uploaded file alongside the processed one.
 * Returns the new DB row id, or 0 when saving failed (non-fatal - the
 * processed image is already stored).
 */
export async function save_original_copy(opts: SaveOriginalOptions): Promise<number> {
	const { temp_path, original_name, folder, title, description, tags } = opts;

	try {
		const orig_file = Bun.file(temp_path);

		const orig_size = orig_file.size;

		const orig_mime = hard_clone(`${orig_file.type || "application/octet-stream"}`);

		const orig_ext = ext_of(original_name) || mime_to_ext(orig_mime);

		const orig_filename = hard_clone(`${uuid_v7()}${orig_ext}`);

		const orig_s3_key = !folder ? orig_filename : hard_clone(`${folder}/${orig_filename}`);

		const orig_original_name = hard_clone(original_name);

		log_warn("editor", "POST /images/save:before save_to_s3", { orig_ext, orig_filename, orig_s3_key, orig_original_name });

		await save_to_s3(IMAGE_BUCKET, orig_s3_key, orig_file, { type: orig_mime });

		log_warn("editor", "POST /images/save:after save_to_s3", { orig_s3_key, orig_original_name });

		// Generate 100×100 thumbnail for the original
		const thumb_ext = mime_to_ext(orig_mime);

		const thumb_s3_key = hard_clone(orig_s3_key.replace(/[^/]+$/, (match) => `tn_${match}`));

		const thumb_output = join(tmpdir(), "reepolee-editor", `tn_${uuid_v7()}${thumb_ext}`);

		try {
			await generate_thumbnail(temp_path, thumb_output, 100);

			await save_to_s3(IMAGE_BUCKET, thumb_s3_key, Bun.file(thumb_output), { type: orig_mime });

			log_warn("editor", "POST /images/save:original thumbnail saved", { thumb_s3_key });
		} catch (err) {
			log_error("editor", "POST /images/save:original thumbnail failed", err instanceof Error ? err : new Error(String(err)));
		} finally {
			try {
				await unlink(thumb_output);
			} catch {
				// ignore cleanup errors
			}
		}

		const { width: orig_width, height: orig_height } = await get_image_dims(temp_path);

		const original_db_id = await db_insert_image(
			folder,
			orig_filename,
			orig_s3_key,
			orig_original_name,
			title,
			description,
			tags,
			orig_mime,
			orig_width,
			orig_height,
			orig_size
		);

		log_warn("editor", "POST /images/save:original saved", { orig_s3_key, original_db_id, orig_original_name });
		return original_db_id;
	} catch (err) {
		log_error("editor", "POST /images/save:original save failed", err instanceof Error ? err : new Error(String(err)));
		return 0;
	}
}
