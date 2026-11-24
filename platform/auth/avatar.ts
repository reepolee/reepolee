import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { get_local_storage_dir } from "$lib/local_storage";
import { log_info } from "$lib/logger";
import { is_s3_configured, s3_exists, save_to_s3 } from "$lib/s3";
import { uuid_v7 } from "$lib/uuid";

// S3 bucket for avatar uploads - defaulting to the "users" table name.
const AVATAR_BUCKET = "users";
// S3 key prefix for avatar files.
const AVATAR_PREFIX = "avatars";

/**
 * Returns the local avatar directory path, or null if LOCAL_STORAGE_DIR is not configured.
 * Computed fresh each call to avoid Bun's module-level const caching with --hot.
 */
function get_avatar_dir(): string | null {
	const ls = get_local_storage_dir();
	return ls ? join(ls, "avatars") : null;
}

/**
 * Ensure the local avatar directory exists (no-op when storage is not configured).
 */
export async function ensure_avatar_dir(): Promise<void> {
	const dir = get_avatar_dir();
	if (dir) { await mkdir(dir, { recursive: true }); }
}

/**
 * Resize the uploaded avatar to a sharp 64×64 WebP using a three-stage vips pipeline:
 *
 * 1. thumbnail -> 128px with centre crop (fills square, pre-sharpened)
 * 2. sharpen   -> aggressive unsharp mask for edge contrast
 * 3. resize    -> downscale to 64px with Lanczos3 kernel (sharpest interpolation)
 * 4. webpsave  -> encode as WebP at quality 85
 *
 * The original file is not stored - only the final 64px WebP is kept.
 * Returns the clean filename (e.g. `uuid.webp`).
 */

export async function resize_avatar(file: File, stored_name: string): Promise<string> {
	const base_name = stored_name.replace(/\.[^.]+$/, "");
	const resized_name = `${base_name}.webp`;
	const resized_key = `${AVATAR_PREFIX}/${resized_name}`;

	// Write uploaded bytes to a temp file so vips can read it
	const file_bytes = await file.bytes();
	const temp_dir = join(tmpdir(), "reepolee-avatars");
	await mkdir(temp_dir, { recursive: true });

	const temp_input = join(temp_dir, stored_name);
	const temp_thumb = join(temp_dir, `${base_name}_thumb.png`);
	const temp_sharp = join(temp_dir, `${base_name}_sharp.png`);
	const temp_final = join(temp_dir, `${base_name}_final.png`);
	const temp_output = join(temp_dir, resized_name);

	await Bun.write(temp_input, file_bytes);

	async function spawn_vips(args: string[], label: string): Promise<void> {
		const proc = Bun.spawn(args, { windowsHide: true });
		const exit_code = await proc.exited;
		if (exit_code !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`vips ${label} failed (exit ${exit_code}): ${stderr}`);
		}
	}

	try {
		// Step 1: Thumbnail to 384px with centre crop (fills square, pre-sharpened)
		await spawn_vips(["vips", "thumbnail", temp_input, temp_thumb, "384", "--crop", "centre"], "thumbnail");

		// Step 2: Aggressive unsharp mask for maximum crispness at small size
		await spawn_vips([
			"vips",
			"sharpen",
			temp_thumb,
			temp_sharp,
			"--sigma",
			"0.45",
			"--x1",
			"0.5",
			"--y2",
			"12",
			"--y3",
			"20",
			"--m1",
			"4",
			"--m2",
			"8",
		], "sharpen");

		// Step 3: Downscale to 192px with Lanczos3 kernel (sharpest interpolation)
		await spawn_vips(["vips", "resize", temp_sharp, temp_final, "0.5", "--kernel", "lanczos3"], "resize");

		// Step 4: Convert to WebP at quality 95
		await spawn_vips(["vips", "webpsave", temp_final, temp_output, "--Q", "90"], "webpsave");

		// Read the final output
		const webp_bytes = await Bun.file(temp_output).bytes();

		if (is_s3_configured()) {
			await save_to_s3(AVATAR_BUCKET, resized_key, webp_bytes, {
				type: "image/webp",
				acl: "public-read",
			});
			log_info("avatar", "saved to S3", {
				bucket: AVATAR_BUCKET,
				key: resized_key,
				filename: resized_name,
			});
		} else {
			const avatar_dir = get_avatar_dir();
			if (!avatar_dir) { throw new Error("AVATAR_DIR is null - LOCAL_STORAGE_DIR not configured"); }
			await ensure_avatar_dir();
			const dest = join(avatar_dir, resized_name);
			await Bun.write(dest, webp_bytes);
			log_info("avatar", "saved locally", { path: dest, filename: resized_name });
		}

		return resized_name;
	} finally {
		// Clean up all temp files
		for (const f of [temp_input, temp_thumb, temp_sharp, temp_final, temp_output]) {
			try {
				await unlink(f);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Save an uploaded avatar File directly as a 64×64 WebP.
 * The original file is not stored - only the resized version is kept.
 * Returns the resized filename (e.g. `uuid.webp`).
 */
export async function save_avatar_upload(file: File): Promise<string> {
	const ext = file.name.includes(".") ? `.${file.name.split(".").pop()?.toLowerCase()}` : "";
	const stored_name = `${uuid_v7()}${ext}`;

	return resize_avatar(file, stored_name);
}

/**
 * Check whether an avatar exists (S3 or local fallback).
 */
export async function avatar_exists(filename: string): Promise<boolean> {
	if (is_s3_configured()) {
		const key = `${AVATAR_PREFIX}/${filename}`;
		return s3_exists(AVATAR_BUCKET, key);
	}
	const avatar_dir = get_avatar_dir();
	if (!avatar_dir) return false;
	const dest = join(avatar_dir, filename);
	return Bun.file(dest).exists();
}

/**
 * Build the S3 key for a given avatar filename.
 */
export function s3_avatar_key(filename: string): string { return `${AVATAR_PREFIX}/${filename}`; }
