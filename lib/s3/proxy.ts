/**
 * S3 HTTP proxy - image transformation via URL query params and mount-based request serving.
 * Extracted from lib/s3.ts.
 */

import { display_endpoint, is_s3_configured, s3_file, save_to_s3 } from "./core";

// ---------------------------------------------------------------------------
// Image transformation via URL query params
// ---------------------------------------------------------------------------

export type ImageTransforms = { width: number; height: number; longest: number; format: string | null; };

const MAX_TRANSFORM_DIM = 4096;

/**
 * Parse image transformation query params from URL.
 * Returns null if none of the recognised params are present or values are invalid.
 */
function parse_image_transforms(url: URL): ImageTransforms | null {
	const raw_width = url.searchParams.get("width");
	const raw_height = url.searchParams.get("height");
	const raw_longest = url.searchParams.get("longest");
	const raw_format = url.searchParams.get("format");

	if (!raw_width && !raw_height && !raw_longest && !raw_format) return null;

	const width = raw_width ? parseInt(raw_width, 10) : 0;
	const height = raw_height ? parseInt(raw_height, 10) : 0;
	const longest = raw_longest ? parseInt(raw_longest, 10) : 0;

	if ((raw_width && (width < 1 || width > MAX_TRANSFORM_DIM || Number.isNaN(width))) || (raw_height && (height < 1 || height > MAX_TRANSFORM_DIM || Number.isNaN(height))) || (raw_longest && (longest < 1 || longest > MAX_TRANSFORM_DIM || Number.isNaN(
		longest
	)))) { return null; }

	return { width, height, longest, format: raw_format?.toLowerCase() || null };
}

// Build a deterministic cache S3 key for a transformed image (co-located with the original).
function cache_key_for_transform(original_s3_key: string, transforms: ImageTransforms): string {
	const base = original_s3_key.replace(/\.[^.]+$/, "");
	const parts: string[] = [];
	if (transforms.width > 0) parts.push(`w${transforms.width}`);
	if (transforms.height > 0) parts.push(`h${transforms.height}`);
	if (transforms.longest > 0) parts.push(`l${transforms.longest}`);
	const ext = transforms.format ? `.${transforms.format}` : (original_s3_key.match(/\.[^.]+$/)?.[0] ?? "");
	const suffix = parts.length > 0 ? `__${parts.join("_")}${ext}` : ext;
	return `${base}${suffix}`;
}

function w_string(t: ImageTransforms): string {
	const parts: string[] = [];
	if (t.width > 0) parts.push(`${t.width}w`);
	if (t.height > 0) parts.push(`${t.height}h`);
	if (t.longest > 0) parts.push(`${t.longest}l`);
	return parts.join("×") || "original-size";
}

// Map a Content-Type to a Bun.Image encode format name.
function mime_to_encode_format(mime: string): string {
	switch (mime) {
		case "image/jpeg":
			return "jpeg";
		case "image/png":
			return "png";
		case "image/webp":
			return "webp";
		case "image/avif":
			return "avif";
		default:
			return "";
	}
}

// Map an encode format name to a Content-Type string.
function encode_format_to_mime(format: string): string {
	switch (format) {
		case "jpeg":
		case "jpg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "webp":
			return "image/webp";
		case "avif":
			return "image/avif";
		default:
			return "application/octet-stream";
	}
}

/**
 * Apply image transforms using Bun's native image pipeline.
 * Returns the encoded bytes and MIME type, or null on failure.
 */
async function transform_image(buffer: ArrayBuffer, transforms: ImageTransforms, original_mime: string): Promise<{ data: Uint8Array; mime: string; } | null> {
	try {
		const output_format = transforms.format || mime_to_encode_format(original_mime);
		if (!output_format) return null;

		const img = new Bun.Image(buffer);
		let resized: any;

		if (transforms.longest > 0) {
			resized = img.resize(transforms.longest, transforms.longest, { fit: "inside" });
		} else if (transforms.width > 0 || transforms.height > 0) {
			const w = transforms.width > 0 ? transforms.width : 100000;
			const h = transforms.height > 0 ? transforms.height : 100000;
			resized = img.resize(w, h, { fit: "inside" });
		} else {
			resized = img;
		}

		let encoded: any;
		switch (output_format) {
			case "jpeg":
			case "jpg":
				encoded = resized.jpeg({ quality: 85 });
				break;
			case "png":
				encoded = resized.png();
				break;
			case "webp":
				encoded = resized.webp({ quality: 85 });
				break;
			case "avif":
				encoded = resized.avif({ quality: 80 });
				break;
			default:
				return null;
		}

		const data = await encoded.bytes();
		const mime = encode_format_to_mime(output_format);
		console.log(`🖼️  Transformed image: ${output_format} ${w_string(transforms)} (${data.length} bytes)`);
		return { data, mime };
	} catch (err) {
		console.error("❌ Image transform failed:", err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Reusable S3 HTTP proxy registry
// ---------------------------------------------------------------------------

export type S3Mount = { url_prefix: string; bucket: string; key_prefix?: string; immutable?: boolean; };

const s3_mounts: S3Mount[] = [];

// Derive Cache-Control header value from mount config.
function mount_cache_control(mount: S3Mount): string { return mount.immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600"; }

/**
 * Register a URL prefix to be served from S3.
 * Call this at module level before the server starts.
 */
export function register_s3_mount(mount: S3Mount): void { s3_mounts.push(mount); }

/**
 * Return all registered S3 mounts. Used by the static file server to
 * serve from LOCAL_STORAGE_DIR when S3 is not configured.
 */
export function get_s3_mounts(): readonly S3Mount[] { return s3_mounts; }

/**
 * Match an incoming request URL against all registered S3 mounts.
 * Returns a Response (fetched from S3 with proper headers) or `null` if no match.
 *
 * Supports image transformation via URL query params:
 * ?width=128       – resize to fit 128px wide (maintaining aspect ratio)
 * ?height=96       – resize to fit 96px tall (maintaining aspect ratio)
 * ?longest=400     – resize so the longest side is 400px
 * ?format=webp     – convert to webp (also: jpeg, png, avif)
 * ?width=128&format=webp – combine resize + format conversion
 *
 * Transformed results are saved back to S3 under a deterministic cache key.
 */
export async function handle_s3_request(url: URL): Promise<Response | null> {
	if (!is_s3_configured()) return null;

	const pathname = url.pathname;
	const sorted = [...s3_mounts].sort((a, b) => b.url_prefix.length - a.url_prefix.length);

	for (const mount of sorted) {
		if (!pathname.startsWith(mount.url_prefix)) continue;

		const filename = decodeURIComponent(pathname.slice(mount.url_prefix.length));
		if (!filename || filename.includes("..") || filename.includes("\\\\")) continue;

		const key_prefix = mount.key_prefix ?? mount.url_prefix.replace(
			/^\//,
			""
		);
		const base = key_prefix.replace(/\/+$/, "");
		const file = filename.replace(
			/^\//,
			""
		);
		const original_s3_key = base ? `${base}/${file}` : file;

		const transforms = parse_image_transforms(url);

		if (transforms) {
			const cache_s3_key = cache_key_for_transform(original_s3_key, transforms);
			const cache_file = s3_file(mount.bucket, cache_s3_key);
			const cache_url = cache_file.presign();
			const cache_resp = await fetch(cache_url);

			if (cache_resp.ok) {
				const buffer = await cache_resp.arrayBuffer();
				console.log(`💾 S3 cache hit: ${display_endpoint()}/${mount.bucket}/${cache_s3_key}`);
				return new Response(buffer, {
					headers: {
						"Content-Type": cache_resp.headers.get("Content-Type") || "application/octet-stream",
						"Cache-Control": mount_cache_control(mount),
					},
				});
			}

			const s3file = s3_file(mount.bucket, original_s3_key);
			const presigned_url = s3file.presign();
			const s3_response = await fetch(presigned_url);

			if (s3_response.ok) {
				const buffer = await s3_response.arrayBuffer();
				const mime = s3_response.headers.get("Content-Type") || "application/octet-stream";

				if (mime.startsWith("image/")) {
					const result = await transform_image(buffer, transforms, mime);
					if (result) {
						await save_to_s3(mount.bucket, cache_s3_key, result.data, { type: result.mime });
						return new Response(result.data, {
							headers: {
								"Content-Type": result.mime,
								"Cache-Control": mount_cache_control(mount),
							},
						});
					}
				}

				return new Response(buffer, {
					headers: { "Content-Type": mime, "Cache-Control": mount_cache_control(mount) },
				});
			}

			continue;
		}

		// No transforms - serve original
		const s3file = s3_file(mount.bucket, original_s3_key);
		const presigned_url = s3file.presign();
		const s3_response = await fetch(presigned_url);

		if (!s3_response.ok) continue;

		const buffer = await s3_response.arrayBuffer();
		return new Response(buffer, {
			headers: {
				"Content-Type": s3_response.headers.get("Content-Type") || "application/octet-stream",
				"Cache-Control": mount_cache_control(mount),
			},
		});
	}

	return null;
}
