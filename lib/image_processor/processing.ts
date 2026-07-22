import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { duration_ms, log_error, log_info, log_warn } from "$lib/logger";
import { uuid_v7 } from "$lib/uuid";

import { ensure_temp_dir, format_to_ext, format_to_mime, format_to_save_cmd, normalize_path } from "./helpers";
import { FORMAT_MAP, MAX_ORIGINAL_DIMENSION, MAX_OUTPUT_DIMENSION } from "./types";
import type { ProcessOptions, ProcessResult } from "./types";

// ---------------------------------------------------------------------------
// Image dimension detection
// ---------------------------------------------------------------------------

// Get image dimensions using vipsheader (single call for both width/height).
export async function get_image_dims(file_path: string): Promise<{ width: number; height: number; }> {
	const start = process.hrtime.bigint();
	const safe_path = normalize_path(file_path);
	log_info("image_processor", "get_image_dims: reading dimensions", { file_path: safe_path });

	const proc = Bun.spawn(["vipsheader", safe_path], { windowsHide: true });

	const [exit_code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

	if (exit_code !== 0) {
		log_error("image_processor", "get_image_dims: vipsheader failed", null, { file_path: safe_path, exit_code, stderr, stdout });
		throw new Error(`vipsheader failed (exit ${exit_code}): ${stderr || stdout || "unknown error"}`);
	}

	// Parse "file.jpg: 4032x3024 uchar 3-band srgb" -> {4032, 3024}
	const match = stdout.match(/(\d+)x(\d+)/);
	if (!match) {
		log_error("image_processor", "get_image_dims: could not parse dimensions", null, { file_path: safe_path, stdout });
		throw new Error(`Could not parse dimensions from vipsheader output: ${stdout}`);
	}

	const width = parseInt(match[1], 10);
	const height = parseInt(match[2], 10);

	log_info("image_processor", "get_image_dims: complete", {
		file_path: safe_path,
		width,
		height,
		duration: duration_ms(start),
	});
	return { width, height };
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

/**
 * Process an image using vips CLI.
 *
 * @param input_path  Path to the original image file on disk.
 * @param options     Processing options (crop, resize, format, quality).
 * @returns           ProcessResult with the output data and metadata.
 */
export async function process_image(input_path: string, options: ProcessOptions): Promise<ProcessResult> {
	const proc_start = process.hrtime.bigint();
	log_info("image_processor", "process_image: starting", {
		input_path,
		crop: options.crop,
		resize: options.resize,
		format: options.format,
		quality: options.quality,
	});

	const temp_dir = await ensure_temp_dir();
	const base_name = uuid_v7();
	const format = options.format?.toLowerCase() || "webp";

	if (!FORMAT_MAP[format]) {
		log_error("image_processor", "process_image: unsupported format", null, { format, supported: Object.keys(FORMAT_MAP) });
		throw new Error(`Unsupported output format: ${format}. Supported: ${Object.keys(FORMAT_MAP).join(", ")}`);
	}

	const { width: orig_width, height: orig_height } = await get_image_dims(input_path);
	log_info("image_processor", "process_image: original dimensions", { orig_width, orig_height });

	if (orig_width > MAX_ORIGINAL_DIMENSION || orig_height > MAX_ORIGINAL_DIMENSION) {
		log_error("image_processor", "process_image: dimensions exceed max", null, { orig_width, orig_height, max: MAX_ORIGINAL_DIMENSION });
		throw new Error(`Image dimensions (${orig_width}×${orig_height}) exceed maximum allowed ` + `${MAX_ORIGINAL_DIMENSION}×${MAX_ORIGINAL_DIMENSION} pixels`);
	}

	if (options.resize) {
		if ((options.resize.width || 0) > MAX_OUTPUT_DIMENSION || (options.resize.height || 0) > MAX_OUTPUT_DIMENSION) {
			log_error("image_processor", "process_image: resize dimensions exceed max", null, {
				resize_w: options.resize.width,
				resize_h: options.resize.height,
				max: MAX_OUTPUT_DIMENSION,
			});
			throw new Error(`Resize dimensions exceed maximum allowed ${MAX_OUTPUT_DIMENSION}×${MAX_OUTPUT_DIMENSION} pixels`);
		}
	}

	let current_input = input_path;
	const temp_files: string[] = [];

	try {
		// Step 1: Crop (if coords provided)
		if (options.crop && options.crop.width > 0 && options.crop.height > 0) {
			const crop_start = process.hrtime.bigint();
			const { left, top, width, height } = options.crop;
			const cropped_path = join(temp_dir, `${base_name}_crop.png`);
			temp_files.push(cropped_path);

			log_info("image_processor", "process_image: cropping", {
				input: current_input,
				output: cropped_path,
				region: `${left},${top},${width},${height}`,
			});

			const crop_proc = Bun.spawn([
				"vips",
				"extract_area",
				normalize_path(current_input),
				normalize_path(cropped_path),
				String(Math.round(left)),
				String(Math.round(top)),
				String(Math.round(width)),
				String(Math.round(height)),
			], { windowsHide: true });

			const crop_exit = await crop_proc.exited;
			if (crop_exit !== 0) {
				const stderr = await new Response(crop_proc.stderr).text();
				log_error("image_processor", "process_image: crop failed", new Error(stderr), { exit_code: crop_exit, stderr });
				throw new Error(`vips extract_area failed (exit ${crop_exit}): ${stderr}`);
			}

			// Get cropped dimensions
			const { width: crop_w, height: crop_h } = await get_image_dims(cropped_path);
			log_info("image_processor", "process_image: crop complete", {
				cropped_path,
				dimensions: `${crop_w}×${crop_h}`,
				duration: duration_ms(crop_start),
			});

			current_input = cropped_path;
		}

		// Step 2: Resize (if target dimensions provided)
		let final_width = orig_width;
		let final_height = orig_height;

		if (options.resize && (options.resize.width > 0 || options.resize.height > 0)) {
			const resize_start = process.hrtime.bigint();
			// Get current dimensions (may have changed after crop)
			const { width: cur_width, height: cur_height } = await get_image_dims(current_input);

			const target_w = options.resize.width || cur_width;
			const target_h = options.resize.height || cur_height;

			// Calculate scale factor - use the larger constraint to fit inside
			const scale_w = target_w / cur_width;
			const scale_h = target_h / cur_height;
			const scale = Math.min(scale_w, scale_h);

			const resized_path = join(temp_dir, `${base_name}_resized.png`);
			temp_files.push(resized_path);

			log_info("image_processor", "process_image: resizing", {
				input: current_input,
				output: resized_path,
				current_dims: `${cur_width}×${cur_height}`,
				target: `${target_w}×${target_h}`,
				scale: scale.toFixed(6),
			});

			const resize_proc = Bun.spawn([
				"vips",
				"resize",
				normalize_path(current_input),
				normalize_path(resized_path),
				String(scale),
			], { windowsHide: true });

			const resize_exit = await resize_proc.exited;
			if (resize_exit !== 0) {
				const stderr = await new Response(resize_proc.stderr).text();
				log_error("image_processor", "process_image: resize failed", new Error(stderr), { exit_code: resize_exit, stderr });
				throw new Error(`vips resize failed (exit ${resize_exit}): ${stderr}`);
			}

			current_input = resized_path;

			// Calculate final dimensions
			final_width = Math.round(cur_width * scale);
			final_height = Math.round(cur_height * scale);

			log_info("image_processor", "process_image: resize complete", {
				resized_path,
				final_dims: `${final_width}×${final_height}`,
				duration: duration_ms(resize_start),
			});
		}

		// Step 3: Format conversion and output

		const output_ext = format_to_ext(format);
		const output_path = join(temp_dir, `${base_name}${output_ext}`);

		const save_cmd = format_to_save_cmd(format);
		const quality = options.quality ?? 85;

		const args = ["vips", save_cmd, current_input, output_path];
		if (format === "jpeg" || format === "jpg") {
			args.push("--Q", String(quality));
		} else if (format === "webp") {
			args.push("--Q", String(quality));
		} else if (format === "avif") {
			args.push("--Q", String(quality));
		}

		// Add format-specific extra args (e.g., --compression av1 for AVIF)
		const format_info = FORMAT_MAP[format];
		if (format_info?.save_args) { args.push(...format_info.save_args); }

		// Normalize paths in args (replace indices 2 and 3: input and output paths)
		if (args.length >= 4) {
			args[2] = normalize_path(args[2]);
			args[3] = normalize_path(args[3]);
		}

		log_info("image_processor", "process_image: format conversion", {
			input: current_input,
			output: output_path,
			format,
			quality,
			command: args.join(" "),
		});

		const save_proc = Bun.spawn(args, { windowsHide: true });
		const save_exit = await save_proc.exited;

		if (save_exit !== 0) {
			const stderr = await new Response(save_proc.stderr).text();
			log_error("image_processor", "process_image: conversion failed", new Error(stderr), {
				exit_code: save_exit,
				stderr,
				command: args.join(" "),
			});
			throw new Error(`vips ${save_cmd} failed (exit ${save_exit}): ${stderr}`);
		}

		// Don't buffer output - caller streams from disk
		const output_file = Bun.file(output_path);
		const file_size = output_file.size;
		const mime = format_to_mime(format);

		const filename = `${base_name}${output_ext}`;

		log_info("image_processor", "process_image: complete", {
			output_path,
			filename,
			width: final_width,
			height: final_height,
			file_size,
			mime,
			format,
			duration: duration_ms(proc_start),
		});

		return { output_path, mime, filename, width: final_width, height: final_height, file_size };
	} catch (err) {
		log_error("image_processor", "process_image: failed", err, { input_path, duration: duration_ms(proc_start) });
		throw err;
	} finally {
		// Clean up intermediate temp files (caller cleans up output_path)
		for (const file_path of temp_files) {
			try {
				await unlink(file_path);
				log_info("image_processor", "process_image: cleaned up intermediate file", { file_path });
			} catch {
				log_warn("image_processor", "process_image: failed to clean up intermediate file", { file_path });
			}
		}
	}
}

/**
 * Generate a thumbnail from a source image using vips thumbnail.
 * The thumbnail fits inside the given size, preserving aspect ratio.
 *
 * @param input_path  Path to the source image.
 * @param output_path  Path where the thumbnail should be written.
 * @param size        Target size in pixels - longest side (default 100).
 * @returns           The dimensions of the generated thumbnail.
 */
export async function generate_thumbnail(input_path: string, output_path: string, size: number = 100): Promise<{ width: number; height: number; }> {
	const start = process.hrtime.bigint();
	log_info("image_processor", "generate_thumbnail: starting", { input_path, output_path, size });

	const proc = Bun.spawn([
		"vips",
		"thumbnail_image",
		normalize_path(input_path),
		normalize_path(output_path),
		String(size),
	], { windowsHide: true });

	const exit_code = await proc.exited;
	if (exit_code !== 0) {
		const stderr = await new Response(proc.stderr).text();
		log_error("image_processor", "generate_thumbnail: failed", new Error(stderr), { exit_code, stderr, input_path, output_path });
		throw new Error(`vips thumbnail_image failed (exit ${exit_code}): ${stderr}`);
	}

	const { width, height } = await get_image_dims(output_path);
	log_info("image_processor", "generate_thumbnail: complete", { output_path, width, height, duration: duration_ms(start) });
	return { width, height };
}
