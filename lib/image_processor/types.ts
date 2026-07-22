// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMAGE_BUCKET = Bun.env.S3_IMAGE_BUCKET || "images";
const IMAGE_URL_PREFIX = `/${IMAGE_BUCKET}`;
const IMAGE_PREFIX = "";

// Maximum allowed original image dimension (width or height) in pixels.
const MAX_ORIGINAL_DIMENSION = 10000;

// Maximum allowed process target dimension (resize) in pixels.
const MAX_OUTPUT_DIMENSION = 5000;

// Supported output formats and their MIME types.
const FORMAT_MAP: Record<string, { mime: string; ext: string; save_cmd: string; save_args?: string[]; }> = {
	jpeg: { mime: "image/jpeg", ext: ".jpg", save_cmd: "jpegsave" },
	jpg: { mime: "image/jpeg", ext: ".jpg", save_cmd: "jpegsave" },
	png: { mime: "image/png", ext: ".png", save_cmd: "pngsave" },
	webp: { mime: "image/webp", ext: ".webp", save_cmd: "webpsave" },
	avif: {
		mime: "image/avif",
		ext: ".avif",
		save_cmd: "heifsave",
		save_args: ["--compression", "av1"],
	},
};

export { FORMAT_MAP, IMAGE_BUCKET, IMAGE_PREFIX, IMAGE_URL_PREFIX, MAX_ORIGINAL_DIMENSION, MAX_OUTPUT_DIMENSION };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProcessOptions = {
	crop?: { left: number; top: number; width: number; height: number; };
	resize?: { width: number; height: number; };
	format?: string;
	quality?: number;
	delete_original?: boolean;
};

export type ProcessResult = {
	output_path: string;
	mime: string;
	filename: string;
	s3_key?: string;
	s3_url?: string;
	width: number;
	height: number;
	file_size: number;
	thumbnail_s3_key?: string;
	thumbnail_url?: string;
};
