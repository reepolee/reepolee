import { existsSync, rmSync, writeFileSync } from "node:fs";

import { qa_project_root } from "./config";
import { elements_intersecting, type Changed_element } from "./dom_diff";
import { diff_html } from "./html_diff";

function vips_path(): string {
	const configured_path = Bun.env.REEQA_VIPS_PATH;
	if (configured_path && existsSync(configured_path)) return configured_path;
	const found = Bun.which("vips");
	if (found) return found;
	throw new Error("libvips is required for comparison diffs. Set REEQA_VIPS_PATH to its executable.");
}

function vipsheader_path(): string {
	const configured_path = Bun.env.REEQA_VIPSHEADER_PATH;
	if (configured_path && existsSync(configured_path)) return configured_path;
	const found = Bun.which("vipsheader");
	if (found) return found;
	throw new Error("libvips vipsheader is required. Set REEQA_VIPSHEADER_PATH to its executable.");
}

function run_vips(arguments_list: string[]): string {
	const executable = vips_path();
	const result = Bun.spawnSync([executable, ...arguments_list], {
		cwd: qa_project_root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const error_output = result.stderr.toString();
		const error_message = error_output.trim();
		throw new Error(`libvips operation failed: ${error_message}`);
	}
	const output = result.stdout.toString();
	return output.trim();
}

function image_dimension(image_path: string, field: "width" | "height"): number {
	const executable = vipsheader_path();
	const result = Bun.spawnSync([executable, "-f", field, image_path], {
		cwd: qa_project_root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const error_output = result.stderr.toString();
		const error_message = error_output.trim();
		throw new Error(`libvips header read failed: ${error_message}`);
	}
	const output = result.stdout.toString();
	const raw_value = output.trim();
	const value = Number(raw_value);
	if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid image ${field}: ${raw_value}`);
	return value;
}

export type Image_region = { left: number; top: number; width: number; height: number };

/**
 * The bounding box of a differing region, padded and expanded to a minimum
 * size so a one-line text change doesn't zoom into an unreadable sliver,
 * then clamped back onto the canvas. `vips find_trim` on the (mostly white)
 * diff mask gives the tight bounding box; everything else here is padding.
 */
function pad_region(region: Image_region, canvas_width: number, canvas_height: number): Image_region {
	const padding = 60;
	const min_size = 480;
	const center_x = region.left + region.width / 2;
	const center_y = region.top + region.height / 2;
	const width = Math.max(region.width + padding * 2, min_size);
	const height = Math.max(region.height + padding * 2, min_size);
	const left = Math.min(Math.max(Math.round(center_x - width / 2), 0), Math.max(canvas_width - width, 0));
	const top = Math.min(Math.max(Math.round(center_y - height / 2), 0), Math.max(canvas_height - height, 0));
	return {
		left,
		top,
		width: Math.min(width, canvas_width),
		height: Math.min(height, canvas_height),
	};
}

/**
 * `region` is computed against the padded canvas (max of baseline/current
 * dimensions - see image_difference()), but baseline_path/current_path are
 * the raw, unpadded captures, and one is often shorter than the other (a
 * page that grew or shrank a row). Clamp to this specific image's own
 * dimensions or `vips crop` throws "bad extract area" the moment the region
 * runs past whichever of the two images is the shorter one.
 */
export function crop_image(source_path: string, destination_path: string, region: Image_region): void {
	const source_width = image_dimension(source_path, "width");
	const source_height = image_dimension(source_path, "height");
	const left = Math.min(region.left, Math.max(source_width - 1, 0));
	const top = Math.min(region.top, Math.max(source_height - 1, 0));
	const width = Math.min(region.width, source_width - left);
	const height = Math.min(region.height, source_height - top);
	run_vips(["crop", source_path, destination_path, String(left), String(top), String(width), String(height)]);
}

export type Image_difference_result = {
	difference_pixels: number;
	/** Padded crop region for the zoom images - always at least min_size, for a viewable image. */
	region: Image_region;
	/** The tight, unpadded bounding box of what actually changed - what a page's "17,460 px differ" should really report as ("485x36px", not a big scary raw count). */
	bounds: Image_region;
};

/** A 3×3 all-ones structuring element, as `matrixload` text. Opening the pixel
 * mask with it (erode then dilate) removes 1-2px thin lines and isolated
 * speckles, so a stray pixel far from the real change can't stretch the
 * bounding box across the whole page (see image_difference). */
const OPENING_STRUCTURING_ELEMENT = "3 3\n255 255 255\n255 255 255\n255 255 255\n";

/**
 * Computes the pixel diff mask + count (unchanged), and additionally the
 * padded bounding box of where it actually differs - the "diff-pixel zoom"
 * from the old POC (PLAN_reeqa_webview.md §5), reintroduced here so both the
 * report page and the evidence video's diff card can crop to it instead of
 * showing a whole (often much taller than viewport) page.
 */
export function image_difference(baseline_path: string, current_path: string, diff_path: string): Image_difference_result {
	const baseline_width = image_dimension(baseline_path, "width");
	const baseline_height = image_dimension(baseline_path, "height");
	const current_width = image_dimension(current_path, "width");
	const current_height = image_dimension(current_path, "height");
	const canvas_width = Math.max(baseline_width, current_width);
	const canvas_height = Math.max(baseline_height, current_height);
	const temp_prefix = `${diff_path}.${crypto.randomUUID()}`;
	const baseline_flat_path = `${temp_prefix}-baseline-flat.v`;
	const current_flat_path = `${temp_prefix}-current-flat.v`;
	const baseline_canvas_path = `${temp_prefix}-baseline-canvas.v`;
	const current_canvas_path = `${temp_prefix}-current-canvas.v`;
	const channel_mask_path = `${temp_prefix}-channel-mask.v`;
	const pixel_mask_path = `${temp_prefix}-pixel-mask.v`;
	const histogram_path = `${temp_prefix}-histogram.v`;
	const opening_se_matrix_path = `${temp_prefix}-opening-se.txt`;
	const opening_se_path = `${temp_prefix}-opening-se.v`;
	const eroded_mask_path = `${temp_prefix}-eroded.v`;
	const opened_mask_path = `${temp_prefix}-opened.v`;
	const temp_paths = [
		baseline_flat_path,
		current_flat_path,
		baseline_canvas_path,
		current_canvas_path,
		channel_mask_path,
		pixel_mask_path,
		histogram_path,
		opening_se_matrix_path,
		opening_se_path,
		eroded_mask_path,
		opened_mask_path,
	];
	try {
		run_vips(["flatten", baseline_path, baseline_flat_path, "--background", "255"]);
		run_vips(["flatten", current_path, current_flat_path, "--background", "255"]);
		run_vips(["embed", baseline_flat_path, baseline_canvas_path, "0", "0", String(canvas_width), String(canvas_height), "--extend", "white"]);
		run_vips(["embed", current_flat_path, current_canvas_path, "0", "0", String(canvas_width), String(canvas_height), "--extend", "white"]);
		run_vips(["relational", baseline_canvas_path, current_canvas_path, channel_mask_path, "noteq"]);
		run_vips(["bandbool", channel_mask_path, pixel_mask_path, "or"]);
		run_vips(["hist_find", pixel_mask_path, histogram_path]);
		const difference_output = run_vips(["getpoint", histogram_path, "255", "0"]);
		const difference_pixels = Number(difference_output);
		if (!Number.isInteger(difference_pixels) || difference_pixels < 1) {
			throw new Error(`Invalid libvips difference metric: ${difference_output}`);
		}
		run_vips(["linear", pixel_mask_path, diff_path, "0,-1,-1", "255,255,255", "--uchar"]);

		// The raw mask's bounding box gets stretched across the whole page by
		// a few stray 1-2px lines far from the real change (e.g. a footer
		// line added while a couple of antialiasing lines shifted up near the
		// header), which makes the zoom crop and "W×H px changed" caption
		// point at nothing. Open the mask (erode then dilate with a 3×3
		// square) to drop those thin/isolated pixels, then measure the box on
		// the surviving thick change; when the whole change is thin enough
		// that opening removes it, fall back to the raw mask's own box rather
		// than the full canvas.
		writeFileSync(opening_se_matrix_path, OPENING_STRUCTURING_ELEMENT);
		run_vips(["matrixload", opening_se_matrix_path, opening_se_path]);
		run_vips(["morph", pixel_mask_path, eroded_mask_path, opening_se_path, "erode"]);
		run_vips(["morph", eroded_mask_path, opened_mask_path, opening_se_path, "dilate"]);

		// `--background 0` makes find_trim search for the 255 (differing)
		// pixels on the single-band mask; an empty opened mask reports
		// width/height 0, which is how the fallback is detected.
		const opened_trim = run_vips(["find_trim", opened_mask_path, "--background", "0"]).split("\n").map(Number);
		const opened_is_valid = opened_trim.length === 4 && opened_trim.every(Number.isFinite) && opened_trim[2]! > 0 && opened_trim[3]! > 0;
		const raw_trim = run_vips(["find_trim", pixel_mask_path, "--background", "0"]).split("\n").map(Number);
		const trim = opened_is_valid ? opened_trim : raw_trim;
		const [trim_left, trim_top, trim_width, trim_height] = trim;
		const has_valid_trim = trim.length === 4 && trim.every(Number.isFinite) && trim_width! > 0 && trim_height! > 0;
		const bounds = has_valid_trim
			? { left: trim_left!, top: trim_top!, width: trim_width!, height: trim_height! }
			: { left: 0, top: 0, width: canvas_width, height: canvas_height };
		const region = pad_region(bounds, canvas_width, canvas_height);
		return { difference_pixels, region, bounds };
	} finally {
		for (const temp_path of temp_paths) {
			if (existsSync(temp_path)) rmSync(temp_path);
		}
	}
}

type Stored_dom_snapshot = {
	document: unknown;
	inner_width: number;
	inner_height: number;
	device_pixel_ratio: number;
};

async function read_dom_snapshot(snapshot_path: string): Promise<Stored_dom_snapshot | undefined> {
	const file = Bun.file(snapshot_path);
	if (!(await file.exists())) return undefined;
	try {
		return (await file.json()) as Stored_dom_snapshot;
	} catch {
		return undefined;
	}
}

async function html_diff_for_page(baseline_html_path: string | undefined, current_html_path: string | undefined): Promise<Changed_element[]> {
	if (!baseline_html_path || !current_html_path) return [];
	const baseline_file = Bun.file(baseline_html_path);
	const current_file = Bun.file(current_html_path);
	if (!(await baseline_file.exists()) || !(await current_file.exists())) return [];
	const [baseline_html, current_html] = await Promise.all([baseline_file.text(), current_file.text()]);
	return diff_html(baseline_html, current_html);
}

/**
 * Combines two independent signals into one report list, per
 * IN_PROGRESS_reeqa_qa_procedure.md §3/§5: the HTML diff (ground truth -
 * exactly which element/attribute/text changed in markup) and the elements
 * physically under the pixel-diff region (a guess).
 *
 * The pixel-region guess only runs when the HTML diff found *nothing* for
 * this page - a pure CSS/stylesheet-driven visual change with no markup
 * edit at all. Once the HTML diff has any explanation, it's authoritative:
 * an ancestor's changed `class`/attribute already accounts for its
 * unchanged children looking different on screen, so listing those
 * children again via the pixel guess would just be restating the same
 * region's cause as if it were a separate, unexplained change.
 */
export async function changed_elements_for_page(baseline_snapshot_path: string, current_snapshot_path: string, current_image_path: string, bounds: Image_region, baseline_html_path?: string, current_html_path?: string): Promise<Changed_element[]> {
	const current = await read_dom_snapshot(current_snapshot_path);
	if (!current || !current.inner_width) return [];
	const html_diff_elements = await html_diff_for_page(baseline_html_path, current_html_path);
	if (html_diff_elements.length > 0) return html_diff_elements.slice(0, 20);
	const scale = image_dimension(current_image_path, "width") / current.inner_width;
	const css_bounds = { left: bounds.left / scale, top: bounds.top / scale, width: bounds.width / scale, height: bounds.height / scale };
	return elements_intersecting(current.document, css_bounds).slice(0, 20);
}
