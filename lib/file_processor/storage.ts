import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { get_local_storage_dir } from "$lib/local_storage";
import { duration_ms, log_info, log_warn } from "$lib/logger";
import { is_s3_configured, save_to_s3 } from "$lib/s3";
import { normalize_storage_folder, normalize_storage_key, resolve_local_storage_path } from "$lib/storage_keys";
import { uuid_v7 } from "$lib/uuid";

import { FILE_BUCKET, FILE_PREFIX, FILE_URL_PREFIX } from "./types";
import type { SaveFileOptions, SaveFileResult } from "./types";

/**
 * Save an uploaded document to S3 (or local disk fallback) without any transform.
 *
 * @param input_path  Path to the uploaded file on disk (temp location).
 * @param ext         File extension (without dot), used to build the storage filename.
 * @param mime        MIME type of the file.
 * @param file_size   Size in bytes.
 * @param options     Storage options (folder, explicit s3_key).
 */
export async function save_file_to_storage(input_path: string, ext: string, mime: string, file_size: number, options: SaveFileOptions = {}): Promise<SaveFileResult> {
	const start = process.hrtime.bigint();
	log_info("file_processor", "save_file_to_storage: starting", { input_path, s3_key: options.s3_key, folder: options.folder });

	const folder = normalize_storage_folder(options.folder);
	const supplied_s3_key = options.s3_key ? normalize_storage_key(options.s3_key) : undefined;
	const filename = `${uuid_v7()}.${ext}`;

	const result: SaveFileResult = { filename, mime, file_size };

	if (is_s3_configured()) {
		const prefix = options.s3_prefix || FILE_PREFIX;
		let s3_key = supplied_s3_key || (prefix ? `${prefix}/${filename}` : filename);

		if (folder && !supplied_s3_key) { s3_key = `${folder}/${s3_key}`; }
		s3_key = normalize_storage_key(s3_key);

		const input_file = Bun.file(input_path);
		await save_to_s3(FILE_BUCKET, s3_key, input_file, { type: mime });

		result.s3_key = s3_key;
		result.s3_url = `${FILE_URL_PREFIX}/${s3_key}`;

		log_info("file_processor", "save_file_to_storage: S3 save complete", { s3_key, s3_url: result.s3_url, duration: duration_ms(start) });
	} else {
		const local_storage = get_local_storage_dir();
		if (local_storage) {
			const prefix = options.s3_prefix || FILE_PREFIX;
			let storage_key = supplied_s3_key || (prefix ? `${prefix}/${filename}` : filename);

			if (folder && !supplied_s3_key) { storage_key = `${folder}/${storage_key}`; }
			storage_key = normalize_storage_key(storage_key);

			const dest_path = resolve_local_storage_path(local_storage, FILE_BUCKET, storage_key);
			await mkdir(dirname(dest_path), { recursive: true });
			await Bun.write(dest_path, Bun.file(input_path));

			result.s3_key = storage_key;
			result.s3_url = `${FILE_URL_PREFIX}/${storage_key}`;

			log_info("file_processor", "save_file_to_storage: saved locally", { storage_key, url: result.s3_url, duration: duration_ms(start) });
		} else {
			log_warn("file_processor", "save_file_to_storage: S3 not configured, skipping upload");
		}
	}

	return result;
}
