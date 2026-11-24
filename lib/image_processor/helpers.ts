import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { duration_ms, log_info, log_warn } from "$lib/logger";

import { FORMAT_MAP } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Normalize Windows paths to forward slashes for CLI compatibility.
export function normalize_path(p: string): string { return p.replace(/\\\\/g, "/"); }

// Determine MIME from format key.
export function format_to_mime(format: string): string { return FORMAT_MAP[format]?.mime ?? "application/octet-stream"; }

// Determine file extension from format key.
export function format_to_ext(format: string): string { return FORMAT_MAP[format]?.ext ?? ".bin"; }

// Determine the vips save command for a format.
export function format_to_save_cmd(format: string): string { return FORMAT_MAP[format]?.save_cmd ?? "webpsave"; }

// Ensure temp directory exists.
export async function ensure_temp_dir(): Promise<string> {
	const dir = join(tmpdir(), "reepolee-editor");
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Delete a temp file with logging.
 */
export async function delete_temp_file(file_path: string): Promise<void> {
	const start = process.hrtime.bigint();
	try {
		await unlink(file_path);
		log_info("image_processor", "delete_temp_file: deleted", { file_path, duration: duration_ms(start) });
	} catch {
		log_warn("image_processor", "delete_temp_file: failed to delete", { file_path, duration: duration_ms(start) });
	}
}
