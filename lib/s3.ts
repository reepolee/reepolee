import { delete_local_file } from "$lib/local_storage";
import { duration_ms, log_info } from "$lib/logger";

import { display_endpoint, is_s3_configured, s3_file } from "./s3/core";

// ---------------------------------------------------------------------------
// S3 operations: delete, exists
// ---------------------------------------------------------------------------

/**
 * Delete a file from S3.
 * Gracefully skips when S3 is not configured (e.g. local storage mode).
 */
export async function delete_from_s3(bucket: string, key: string): Promise<void> {
	if (!is_s3_configured()) {
		log_info("s3", "delete_from_s3: S3 not configured, skipping", { bucket, key });
		return;
	}
	const start = process.hrtime.bigint();
	log_info("s3", "delete_from_s3: starting", { bucket, key, endpoint: display_endpoint() });
	const file = s3_file(bucket, key);
	await file.delete();
	log_info("s3", "delete_from_s3: complete", { bucket, key, duration: duration_ms(start) });
}

/**
 * Shorthand for local file deletion.
 * Delegates to `delete_local_file()` from `$lib/local_storage` so callers
 * only need to import from `$lib/s3` for all storage-related operations.
 */
export async function delete_from_local(bucket: string, key: string): Promise<void> { return delete_local_file(bucket, key); }

/**
 * Check if a file exists in S3.
 */
export async function s3_exists(bucket: string, key: string): Promise<boolean> {
	const start = process.hrtime.bigint();
	log_info("s3", "s3_exists: checking", { bucket, key, endpoint: display_endpoint() });
	const file = s3_file(bucket, key);
	const exists = await file.exists();
	log_info("s3", "s3_exists: result", { bucket, key, exists, duration: duration_ms(start) });
	return exists;
}

// ---------------------------------------------------------------------------
// S3 HTTP proxy - image transforms and request serving
// ---------------------------------------------------------------------------

export { get_s3_mounts, handle_s3_request, register_s3_mount } from "./s3/proxy";
export type { ImageTransforms, S3Mount } from "./s3/proxy";

// Re-export core functions so consumers can import everything from $lib/s3.
export { is_s3_configured, save_to_s3 } from "./s3/core";
