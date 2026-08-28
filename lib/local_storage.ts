import { unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { get_storage_mode, require_env, sanitize_env_value } from "$lib/env";
import { log_info, log_warn } from "$lib/logger";
import { resolve_local_storage_path } from "$lib/storage_keys";

/**
 * Returns the resolved local storage directory, respecting the `STORAGE` env var.
 * - `STORAGE=local` -> requires LOCAL_STORAGE_DIR, returns it
 * - `STORAGE=s3`    -> returns null (local storage not available)
 * - unset           -> auto-detects from LOCAL_STORAGE_DIR (backwards compatible)
 *
 * Computed fresh each call - avoids Bun's module-level const caching issues
 * with --hot or cached bytecode.
 */
export function get_local_storage_dir(): string | null {
	const mode = get_storage_mode();
	if (mode === "s3") return null;
	if (mode === "local") return resolve(require_env("LOCAL_STORAGE_DIR"));
	// Auto-detect (backwards compatible)
	const dir = Bun.env.LOCAL_STORAGE_DIR;
	if (!dir) return null;
	return resolve(sanitize_env_value(dir));
}

/**
 * Delete a local file from the storage directory.
 * Constructs the path as `{local_storage_dir}/{bucket}/{key}`.
 * Silently skips if local storage is not configured (S3 mode).
 */
export async function delete_local_file(bucket: string, key: string): Promise<void> {
	const base = get_local_storage_dir();
	if (!base) {
		log_info("local_storage", "delete_local_file: local storage not available, skipping", { bucket, key });
		return;
	}
	let file_path: string;
	try {
		file_path = resolve_local_storage_path(base, bucket, key);
	} catch (err) {
		log_warn("local_storage", "delete_local_file: rejected invalid storage key", {
			bucket,
			key,
			error: String(err),
		});
		return;
	}
	try {
		await unlink(file_path);
		log_info("local_storage", "delete_local_file: deleted", { bucket, key, path: file_path });
	} catch (err) {
		log_warn("local_storage", "delete_local_file: failed", {
			bucket,
			key,
			path: file_path,
			error: String(err),
		});
	}
}
