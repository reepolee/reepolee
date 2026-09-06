/**
 * Derive an image's variant set from its stored primary.
 *
 * Runs in the queue worker as the `image_variants` job (registered in
 * worker.ts), so an upload returns as soon as the primary is stored and the
 * derivation work - re-encoding + extra S3 writes - never touches the request
 * path. Failures surface as retried/dead-lettered jobs instead of the silent
 * inline best-effort the thumbnail used to be.
 *
 * Variant keys are deterministic siblings of the primary key, so consumers
 * can address them by convention once the primary URL is known:
 *
 *   folder/name.webp         primary (already stored)
 *   folder/tn_name.webp      100×100 thumbnail, same format as the primary
 *   folder/name_400w.webp    400px-wide WebP re-encode (skipped when smaller)
 *   folder/name_1200w.webp   1200px-wide WebP re-encode (skipped when smaller)
 */

import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { BunFile } from "bun";

import { get_local_storage_dir } from "$lib/local_storage";
import { is_s3_configured, save_to_s3 } from "$lib/s3";
import { s3_file } from "$lib/s3/core";
import { normalize_storage_key, resolve_local_storage_path } from "$lib/storage_keys";
import { uuid_v7 } from "$lib/uuid";

import { ensure_temp_dir, format_to_ext, format_to_mime } from "./helpers";
import { generate_thumbnail, process_image } from "./processing";
import { IMAGE_BUCKET } from "./types";

const responsive_widths = [400, 1200] as const;
const responsive_quality = 82;

async function rm_quiet(file_path: string): Promise<void> {
	try { await unlink(file_path); } catch { /* best-effort cleanup */ }
}

async function read_stored_bytes(key: string): Promise<Uint8Array> {
	if (is_s3_configured()) {
		const file = s3_file(IMAGE_BUCKET, key);
		const buffer = await file.arrayBuffer();
		return new Uint8Array(buffer);
	}
	const local_storage = get_local_storage_dir();
	if (!local_storage) throw new Error(`No storage backend configured - cannot derive variants for ${key}`);
	const path = resolve_local_storage_path(local_storage, IMAGE_BUCKET, key);
	return new Uint8Array(await Bun.file(path).arrayBuffer());
}

async function write_stored_file(key: string, data: BunFile, mime: string): Promise<void> {
	if (is_s3_configured()) {
		await save_to_s3(IMAGE_BUCKET, key, data, { type: mime });
		return;
	}
	const local_storage = get_local_storage_dir();
	if (!local_storage) throw new Error(`No storage backend configured - cannot store variant ${key}`);
	const path = resolve_local_storage_path(local_storage, IMAGE_BUCKET, key);
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, data);
}

/**
 * Derive and store every variant for a stored primary image.
 *
 * @param storage_key    Key of the stored primary (folder/name.ext).
 * @param format         The primary's format ("webp", "png", ...) - the
 *                       thumbnail keeps it; responsive re-encodes are WebP.
 * @param source_width   Primary width in pixels, so a variant wider than the
 *                       source is skipped instead of upscaled. Optional.
 * @returns              The stored variant keys.
 */
export async function derive_image_variants(storage_key: string, format: string = "webp", source_width?: number): Promise<string[]> {
	const key = normalize_storage_key(storage_key);
	const ext = format_to_ext(format);
	const mime = format_to_mime(format);
	const temp_dir = await ensure_temp_dir();
	const source_path = join(temp_dir, `variant_src_${uuid_v7()}${ext}`);
	const stored: string[] = [];

	try {
		const bytes = await read_stored_bytes(key);
		await Bun.write(source_path, bytes);

		// 100×100 thumbnail - deterministic tn_<name> sibling of the primary.
		const thumb_key = key.replace(/[^/]+$/, (match) => `tn_${match}`);
		const thumb_output = join(temp_dir, `tn_${uuid_v7()}${ext}`);
		try {
			await generate_thumbnail(source_path, thumb_output, 100);
			await write_stored_file(thumb_key, Bun.file(thumb_output), mime);
			stored.push(thumb_key);
		} finally {
			await rm_quiet(thumb_output);
		}

		// Responsive WebP re-encodes - <name>_<width>w.webp siblings.
		for (const width of responsive_widths) {
			if (source_width !== undefined && width >= source_width) continue;
			const variant_key = key.replace(/[^/]+$/, (name) => {
				const stem = name.replace(/\.[^.]+$/, "");
				return `${stem}_${width}w.webp`;
			});
			// height: 0 means "keep aspect ratio" (processing.ts falls back to the
			// source height when the target height is falsy).
			const result = await process_image(source_path, { resize: { width, height: 0 }, format: "webp", quality: responsive_quality });
			try {
				await write_stored_file(variant_key, Bun.file(result.output_path), format_to_mime("webp"));
				stored.push(variant_key);
			} finally {
				await rm_quiet(result.output_path);
			}
		}

		return stored;
	} finally {
		await rm_quiet(source_path);
	}
}
