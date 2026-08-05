import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log_warn } from "$lib/logger";
import { uuid_v7 } from "$lib/uuid";

import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE } from "./types";

/**
 * Workaround for Bun native string mutation bug - creates a new string via
 * encode/decode cycle to break any internal reference sharing.
 */
export function hard_clone(s: string): string { return new TextDecoder().decode(new TextEncoder().encode(String(s))); }

/**
 * Extract file extension (without the dot) from a filename, lowercased.
 * Returns empty string when the filename has no recognizable extension.
 */
export function ext_of(filename: string): string {
	const clean = filename.trim().toLowerCase();
	const i = clean.lastIndexOf(".");
	if (i <= 0 || i === clean.length - 1) return "";
	const ext = clean.slice(i + 1);
	if (!/^[a-z0-9]{1,8}$/.test(ext)) return "";
	return ext;
}

/**
 * Validate a document extension against the allowlist.
 * Throws with a user-facing message when the extension is not allowed.
 */
export function validate_extension(filename: string): { ext: string; mime: string; } {
	const ext = ext_of(filename);
	const entry = ALLOWED_MIME_TYPES[ext];
	if (!entry) { throw new Error(`File type not allowed: .${ext || "unknown"}. Allowed: ${Object.keys(ALLOWED_MIME_TYPES).join(", ")}`); }
	return { ext, mime: entry.mime };
}

export interface Upload {
	temp_path: string;
	original_name: string;
	mime: string;
	ext: string;
	file_size: number;
}

/**
 * Save the uploaded file from the form to a temporary location.
 * Validates extension and size before saving.
 */
export async function save_upload_to_temp(form_data: FormData): Promise<Upload> {
	const file = form_data.get("file") as File | null;

	if (!file || file.size === 0) throw new Error("No file uploaded");
	if (file.size > MAX_FILE_SIZE) { throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`); }

	const client_name = (form_data.get("original_filename") as string | null)?.trim() || file.name || "";
	const original_name = hard_clone(client_name);

	const { ext, mime } = validate_extension(original_name);

	const temp_dir = join(tmpdir(), "reepolee-files");
	await mkdir(temp_dir, { recursive: true });

	const temp_path = join(temp_dir, `upload_${uuid_v7()}.${ext}`);

	log_warn("file_processor", "save_upload_to_temp", { original_name, temp_path, mime, size: file.size });

	await Bun.write(temp_path, file);

	return Object.freeze({
		temp_path: hard_clone(temp_path),
		original_name,
		mime,
		ext,
		file_size: file.size,
	});
}

// Clean up a temp file, swallowing errors.
export async function cleanup(path?: string): Promise<void> {
	if (!path) return;
	try {
		const { unlink } = await import("node:fs/promises");
		await unlink(path);
	} catch {
		// ignore cleanup errors
	}
}
