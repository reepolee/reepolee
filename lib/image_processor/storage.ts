import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { enqueue } from "$queue/index";
import { get_local_storage_dir } from "$lib/local_storage";
import { duration_ms, log_info, log_warn } from "$lib/logger";
import { is_s3_configured, save_to_s3 } from "$lib/s3";
import { normalize_storage_folder, normalize_storage_key, resolve_local_storage_path } from "$lib/storage_keys";

import { process_image } from "./processing";
import { IMAGE_BUCKET, IMAGE_PREFIX, IMAGE_URL_PREFIX } from "./types";
import type { ProcessOptions, ProcessResult } from "./types";

/**
 * Process an image and save the result to S3.
 *
 * @param input_path  Path to the original image file on disk.
 * @param options     Processing options.
 * @returns           ProcessResult with S3 URL.
 */
export async function process_and_save_to_s3(input_path: string, options: ProcessOptions & { s3_prefix?: string; s3_key?: string; folder?: string; }): Promise<ProcessResult> {
	const start = process.hrtime.bigint();
	log_info("image_processor", "process_and_save_to_s3: starting", {
		input_path,
		s3_key: options.s3_key,
		folder: options.folder,
		s3_prefix: options.s3_prefix,
	});

	const folder = normalize_storage_folder(options.folder);
	const supplied_s3_key = options.s3_key ? normalize_storage_key(options.s3_key) : undefined;
	const result = await process_image(input_path, options);
	const format = options.format?.toLowerCase() || "webp";

	if (is_s3_configured()) {
		const prefix = options.s3_prefix || IMAGE_PREFIX;
		let s3_key = supplied_s3_key || (prefix ? `${prefix}/${result.filename}` : result.filename);

		// Prepend folder path so S3 mirrors the folder structure
		if (folder && !supplied_s3_key) { s3_key = `${folder}/${s3_key}`; }
		s3_key = normalize_storage_key(s3_key);

		log_info("image_processor", "process_and_save_to_s3: saving to S3", {
			bucket: IMAGE_BUCKET,
			s3_key,
			mime: result.mime,
			file_size: result.file_size,
		});

		const output_file = Bun.file(result.output_path);
		await save_to_s3(IMAGE_BUCKET, s3_key, output_file, { type: result.mime });

		result.s3_key = s3_key;
		result.s3_url = `${IMAGE_URL_PREFIX}/${s3_key}`;

		log_info("image_processor", "process_and_save_to_s3: S3 save complete", {
			s3_key,
			s3_url: result.s3_url,
			duration: duration_ms(start),
		});
	} else {
		const local_storage = get_local_storage_dir();
		if (local_storage) {
			const prefix = options.s3_prefix || IMAGE_PREFIX;
			let storage_key = supplied_s3_key || (prefix ? `${prefix}/${result.filename}` : result.filename);

			if (folder && !supplied_s3_key) { storage_key = `${folder}/${storage_key}`; }
			storage_key = normalize_storage_key(storage_key);

			const dest_path = resolve_local_storage_path(local_storage, IMAGE_BUCKET, storage_key);
			await mkdir(dirname(dest_path), { recursive: true });
			await Bun.write(dest_path, Bun.file(result.output_path));

			result.s3_key = storage_key;
			result.s3_url = `${IMAGE_URL_PREFIX}/${storage_key}`;

			log_info("image_processor", "process_and_save_to_s3: saved locally", {
				storage_key,
				url: result.s3_url,
				duration: duration_ms(start),
			});
		} else {
			log_warn("image_processor", "process_and_save_to_s3: S3 not configured, skipping upload");
		}
	}

	// Derive the variant set (thumbnail + responsive re-encodes) off the
	// request path: the image_variants worker re-fetches the stored primary and
	// writes tn_<name> / <name>_<width>w siblings. Best-effort - a queue miss
	// just skips variants (the primary is already stored). Only enqueued when a
	// backend actually stored the image.
	if (result.s3_key) {
		try {
			await enqueue({ type: "image_variants", payload: { storage_key: result.s3_key, format, source_width: result.width } });
		} catch (error) {
			console.warn(`[image] Queue unavailable - skipping variants for ${result.s3_key}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	log_info("image_processor", "process_and_save_to_s3: complete", {
		filename: result.filename,
		width: result.width,
		height: result.height,
		file_size: result.file_size,
		s3_key: result.s3_key,
		s3_url: result.s3_url,
		total_duration: duration_ms(start),
	});

	return result;
}
