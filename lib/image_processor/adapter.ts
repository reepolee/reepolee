/**
 * Table-agnostic image process/save adapters.
 *
 * M2 of PLAN_image_file_manager_extraction.md: these expose the generic
 * image pipeline (parse form -> save temp -> process -> upload to S3) with
 * NO `images` table write. reeman's `editor_server.ts` uses them and then
 * does its own `images` row write on top; regular app routes can mount
 * them for per-field image upload/edit without touching reeman's admin CRUD.
 */

import { process_image } from "./processing";
import { process_and_save_to_s3 } from "./storage";
import { form_int, parse_crop, parse_resize, save_upload_to_temp, type Upload } from "./upload_helpers";
import type { ProcessResult } from "./types";

// ---------------------------------------------------------------------------
// Process-only (preview) adapter
// ---------------------------------------------------------------------------

export interface ImageProcessUploadResult {
	/** vips processing result (output_path on disk, no S3 upload). */
	result: ProcessResult;
	/** Temp upload info - caller must clean up `temp_path` / `result.output_path`. */
	upload: Upload;
	format: string;
	quality: number;
}

/**
 * Process an uploaded image (crop/resize/format/quality) without persisting
 * anything. Caller is responsible for cleanup of `upload.temp_path` and
 * `result.output_path`.
 */
export async function process_image_upload(form_data: FormData): Promise<ImageProcessUploadResult> {
	const upload = await save_upload_to_temp(form_data);

	const format = (form_data.get("format") as string) || "webp";
	const quality = form_int(form_data, "quality") || 85;

	const result = await process_image(upload.temp_path, {
		crop: parse_crop(form_data),
		resize: parse_resize(form_data),
		format,
		quality,
	});

	return { result, upload, format, quality };
}

// ---------------------------------------------------------------------------
// Process + S3 save adapter (no table write)
// ---------------------------------------------------------------------------

export interface ImageSaveUploadOptions {
	/** Storage folder (e.g. "logos"). Pass `s3_key` instead to target an explicit key. */
	folder: string;
	/** Explicit target S3 key - overrides folder-based key generation (edit mode). */
	s3_key?: string;
}

export interface ImageSaveUploadResult {
	/** Processing + storage result (includes s3_key / s3_url when stored). */
	result: ProcessResult;
	/** Temp upload info - caller must clean up `upload.temp_path`. */
	upload: Upload;
	format: string;
	quality: number;
	folder: string;
}

/**
 * Process an uploaded image and store the result to S3 (or local disk
 * fallback). Returns the URL + metadata for a form field's hidden input -
 * does NOT write any DB row. Caller must clean up `upload.temp_path`.
 */
export async function save_image_upload(form_data: FormData, options: ImageSaveUploadOptions): Promise<ImageSaveUploadResult> {
	const upload = await save_upload_to_temp(form_data);

	const format = (form_data.get("format") as string) || "webp";
	const quality = form_int(form_data, "quality") || 85;

	const result = await process_and_save_to_s3(upload.temp_path, {
		crop: parse_crop(form_data),
		resize: parse_resize(form_data),
		format,
		quality,
		s3_key: options.s3_key || undefined,
		folder: options.s3_key ? undefined : options.folder,
	});

	return { result, upload, format, quality, folder: options.folder };
}
