/**
 * Editor helpers - extracted from editor_server.ts for file-size compliance.
 */

import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log_error, log_warn } from "$lib/logger";
import { uuid_v7 } from "$lib/uuid";

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

/**
 * Workaround for Bun native string mutation bug - creates a new string via
 * encode/decode cycle to break any internal reference sharing.
 * TODO: Remove once the Bun bug is fixed.
 */
export function hard_clone(s: string): string { return new TextDecoder().decode(new TextEncoder().encode(String(s))); }

/**
 * Normalize a user-supplied filename - guards against Bun internal metadata
 * strings being passed as filenames (ISO timestamps, stream reader names, etc.).
 */
export function normalize_filename(raw: string): string {
	const s = raw.trim();

	log_warn("editor", "normalize_filename: input", { raw, trimmed: s, length: s.length });

	if (!s) {
		const generated = `upload_${uuid_v7().slice(0, 8)}`;
		log_warn("editor", "normalize_filename: empty filename", { generated });
		return generated;
	}

	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
		const generated = `upload_${uuid_v7().slice(0, 8)}`;
		log_warn("editor", "normalize_filename: timestamp filename rejected", { input: s, generated });
		return generated;
	}

	if (["releaseLock", "Stream reader", "cancelled via"].some((p) => s.includes(p))) {
		const generated = `upload_${uuid_v7().slice(0, 8)}`;
		log_warn("editor", "normalize_filename: bun corruption detected", { input: s, generated });
		return generated;
	}

	if (s.length > 500) {
		const generated = `upload_${uuid_v7().slice(0, 8)}`;
		log_warn("editor", "normalize_filename: too long", { length: s.length, generated });
		return generated;
	}

	log_warn("editor", "normalize_filename: accepted", { output: s });
	return s;
}

// ---------------------------------------------------------------------------
// File extension helpers
// ---------------------------------------------------------------------------

/**
 * Extract file extension from a filename. Returns empty string for invalid or
 * suspicious filenames. Includes Bun runtime bug workaround for internal stream
 * metadata strings (ISO timestamps, "releaseLock", "Stream reader").
 */
export function ext_of(filename: string): string {
	const clean = filename.trim().toLowerCase();

	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(clean) || clean.includes("releaselock") || clean.includes("stream reader")) {
		log_warn("editor", "ext_of: suspicious filename rejected", { filename });
		return "";
	}

	const i = clean.lastIndexOf(".");
	if (i <= 0 || i === clean.length - 1) return "";

	const ext = clean.slice(i);
	if (!/^\.[a-z0-9]{1,8}$/.test(ext)) {
		log_warn("editor", "ext_of: invalid extension rejected", { filename, ext });
		return "";
	}
	return ext;
}

// Map MIME type to file extension.
export function mime_to_ext(mime: string): string {
	return mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : mime === "image/gif" ? ".gif" : ".bin";
}

// ---------------------------------------------------------------------------
// Form parsing helpers
// ---------------------------------------------------------------------------

// Parse an integer from a FormData field. Returns 0 on parse failure.
export function form_int(form_data: FormData, key: string): number {
	const val = form_data.get(key) as string | null;
	const n = parseInt(val ?? "", 10);
	log_warn("editor", "form_int", { key, raw: val, parsed: n });
	return Number.isFinite(n) ? n : 0;
}

// Parse crop coordinates from form data.
export function parse_crop(form_data: FormData): { left: number; top: number; width: number; height: number; } {
	const crop = {
		left: form_int(form_data, "crop_left"),
		top: form_int(form_data, "crop_top"),
		width: form_int(form_data, "crop_width"),
		height: form_int(form_data, "crop_height"),
	};
	log_warn("editor", "parse_crop", crop);
	return crop;
}

// Parse resize dimensions from form data (capped at 5000px).
export function parse_resize(form_data: FormData): { width: number; height: number; } {
	const resize = {
		width: Math.min(form_int(form_data, "resize_width"), 5000),
		height: Math.min(form_int(form_data, "resize_height"), 5000),
	};
	log_warn("editor", "parse_resize", resize);
	return resize;
}

// ---------------------------------------------------------------------------
// Upload handling
// ---------------------------------------------------------------------------

export interface Upload {
	temp_path: string;
	original_name: string;
}

/**
 * Save the uploaded file from the form to a temporary location.
 * Validates file type and size before saving.
 */
export async function save_upload_to_temp(form_data: FormData): Promise<Upload> {
	log_warn("editor", "save_upload_to_temp:start");

	const file = form_data.get("image") as File | null;
	log_warn("editor", "save_upload_to_temp:file raw", {
		exists: !!file,
		name: file?.name,
		type: file?.type,
		size: file?.size,
	});

	if (!file || file.size === 0) throw new Error("No image uploaded");
	if (file.size > MAX_UPLOAD_SIZE) { throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 50 MB)`); }
	if (!file.type.startsWith("image/")) throw new Error("Only image files are allowed");

	const client_name = (form_data.get("original_filename") as string | null)?.trim() || "";
	log_warn("editor", "save_upload_to_temp:client filename", { client_name, file_name_before_normalize: file.name });

	const original_name = normalize_filename(client_name || file.name);
	log_warn("editor", "save_upload_to_temp:normalized", { client_name, file_name_after_normalize: file.name, original_name });

	const temp_dir = join(tmpdir(), "reepolee-editor");
	await mkdir(temp_dir, { recursive: true });

	const extension = ext_of(original_name) || mime_to_ext(file.type);
	const temp_path = join(temp_dir, `upload_${uuid_v7()}${extension}`);

	log_warn("editor", "save_upload_to_temp:temp path", { temp_path, file_name: file.name, original_name });

	await Bun.write(temp_path, file);

	log_warn("editor", "save_upload_to_temp:after write", { file_name: file.name, original_name, temp_path });

	const upload = Object.freeze({
		temp_path: hard_clone(temp_path),
		original_name: hard_clone(original_name),
	});

	log_warn("editor", "save_upload_to_temp:return", {
		upload_original_name: upload.original_name,
		upload_temp_path: upload.temp_path,
	});

	return upload;
}

// ---------------------------------------------------------------------------
// Temp file cleanup
// ---------------------------------------------------------------------------

// Clean up temp files in parallel, swallowing individual errors.
export async function cleanup(...paths) {
	log_warn("editor", "cleanup:start", { paths });

	await Promise.all(paths.filter(Boolean).map(async (p) => {
		try {
			log_warn("editor", "cleanup:delete", { path: p });
			await delete_temp_file(p!);
			log_warn("editor", "cleanup:deleted", { path: p });
		} catch (err) {
			log_error("editor", "cleanup:failed", err instanceof Error ? err : new Error(String(err)));
		}
	}));

	log_warn("editor", "cleanup:done");
}

async function delete_temp_file(p: string): Promise<void> {
	// Using a simple approach since image_processor's delete_temp_file may be overkill
	const { unlink } = await import("node:fs/promises");
	await unlink(p);
}
