/**
 * Table-agnostic file save adapter.
 *
 * M2 of PLAN_image_file_manager_extraction.md: exposes the generic document
 * upload pipeline (validate -> save temp -> store to S3) with NO `files`
 * table write. reeman's `upload_server.ts` uses it and then does its own
 * `files` row write on top; regular app routes can mount it for per-field
 * file upload without touching reeman's admin CRUD.
 */

import { save_upload_to_temp, type Upload } from "./helpers";
import { save_file_to_storage } from "./storage";
import type { SaveFileResult } from "./types";

export interface FileSaveUploadOptions {
	/** Storage folder (e.g. "contracts"). */
	folder: string;
}

export interface FileSaveUploadResult {
	/** Storage result (includes s3_key / s3_url when stored). */
	result: SaveFileResult;
	/** Temp upload info - caller must clean up `temp_path`. */
	upload: Upload;
	folder: string;
}

/**
 * Validate an uploaded document and store it to S3 (or local disk fallback).
 * Returns the URL + metadata for a form field's hidden input - does NOT
 * write any DB row. Caller must clean up `upload.temp_path`.
 */
export async function save_file_upload(form_data: FormData, options: FileSaveUploadOptions): Promise<FileSaveUploadResult> {
	const upload = await save_upload_to_temp(form_data);

	const result = await save_file_to_storage(upload.temp_path, upload.ext, upload.mime, upload.file_size, {
		folder: options.folder,
	});

	return { result, upload, folder: options.folder };
}
