import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ffmpeg_path } from "./visual_store";

import type { Qa_browser } from "./browser";

/**
 * A screencast frame written to disk, in capture order. `timestamp` is CDP's
 * `Network.TimeSinceEpoch` (seconds) - the frame's own clock, since the
 * screencast is change-driven rather than fixed-cadence (a naive fixed-fps
 * encode turned a 3s capture into a 10.5s video - see PLAN_reeqa_webview.md
 * §3). Duration per frame comes from the gap to the next frame's timestamp,
 * never an assumed frame rate.
 */
export type Captured_frame = { path: string; timestamp: number };

function escape_concat_path(path: string): string {
	// ffmpeg's concat demuxer reads `file '<path>'` lines; a literal `'` in the
	// path must be closed, escaped, and reopened.
	return path.replaceAll("'", "'\\''");
}

/**
 * Build an ffmpeg concat-demuxer script with an explicit duration per frame,
 * taken from the gap to the next frame. `frames` must already end with the
 * held-frame duplicate appended by the caller (see `with_held_final_frame`)
 * - ffmpeg's concat demuxer silently drops whatever `duration` is declared
 * for the literal last entry in the list (confirmed empirically: the value
 * is ignored outright, not clamped), so nothing meaningful can ever be timed
 * on that final line. Appending a throwaway duplicate frame first means the
 * dropped duration belongs to that duplicate, not to content that matters.
 */
export function build_concat_script(frames: readonly Captured_frame[]): string {
	if (frames.length === 0) throw new Error("No frames to encode.");
	const lines: string[] = [`file '${escape_concat_path(frames[0]!.path)}'`];
	for (let index = 1; index < frames.length; index += 1) {
		const duration_seconds = frames[index]!.timestamp - frames[index - 1]!.timestamp;
		lines.push(`duration ${Math.max(duration_seconds, 0).toFixed(3)}`);
		lines.push(`file '${escape_concat_path(frames[index]!.path)}'`);
	}
	return `${lines.join("\n")}\n`;
}

/** Append a throwaway duplicate of the last frame so its predecessor's hold duration survives encoding (see build_concat_script). */
export async function with_held_final_frame(frames: readonly Captured_frame[], held_final_frame_seconds: number): Promise<Captured_frame[]> {
	if (frames.length === 0) return [];
	const last = frames[frames.length - 1]!;
	const held_path = last.path.replace(/(\.[^.]+)$/, "-held$1");
	await Bun.write(held_path, Bun.file(last.path));
	return [...frames, { path: held_path, timestamp: last.timestamp + held_final_frame_seconds }];
}

/** Wall-clock length of the encoded video: first frame to last. */
export function total_recording_seconds(frames: readonly Captured_frame[]): number {
	if (frames.length === 0) return 0;
	return frames[frames.length - 1]!.timestamp - frames[0]!.timestamp;
}

export type Record_evidence_options = {
	browser: Qa_browser;
	frames_dir: string;
	output_path: string;
	max_width?: number;
	max_height?: number;
	quality?: number;
	/** How long the final frame holds on screen, in seconds. Default 0.5s. */
	held_final_frame_seconds?: number;
	/**
	 * Stops the recording once aborted. The caller drives the browser
	 * (navigate/click/etc.) and aborts this signal when the sequence is
	 * done - record_evidence itself never decides when a recording ends.
	 */
	signal: AbortSignal;
};

export type Recording = { video_path: string; duration_seconds: number; frame_count: number };

/**
 * Drive `browser.record()` until `options.signal` aborts, writing each frame
 * to `frames_dir`, then encode them into an mp4 at `output_path` via the
 * ffmpeg concat demuxer. Run this concurrently with the caller's own
 * navigate/click steps - see PLAN_reeqa_webview.md §3: frame acks do not
 * collide with driving.
 */
export async function record_evidence(options: Record_evidence_options): Promise<Recording> {
	const held_final_frame_seconds = options.held_final_frame_seconds ?? 0.5;
	mkdirSync(options.frames_dir, { recursive: true });

	const frames: Captured_frame[] = [];
	try {
		let index = 0;
		for await (const frame of options.browser.record({ max_width: options.max_width, max_height: options.max_height, quality: options.quality, signal: options.signal })) {
			const path = join(options.frames_dir, `${String(index).padStart(6, "0")}.jpg`);
			await Bun.write(path, frame.data);
			frames.push({ path, timestamp: frame.timestamp });
			index += 1;
		}

		const held_frames = await with_held_final_frame(frames, held_final_frame_seconds);
		const concat_script = build_concat_script(held_frames);
		const concat_path = join(options.frames_dir, "concat.txt");
		await Bun.write(concat_path, concat_script);

		const proc = Bun.spawn(
			[
				ffmpeg_path(),
				"-y",
				"-f",
				"concat",
				"-safe",
				"0",
				"-i",
				concat_path,
				// No -vsync/-fps_mode: the concat demuxer's explicit per-frame
				// `duration` already dictates timing, and the flag's name/presence
				// has changed across ffmpeg majors (removed in ffmpeg 9).
				// Screencast frame dimensions aren't guaranteed even (e.g. a
				// scrollbar-trimmed viewport), but h264 requires them to be -
				// round down to the nearest even pixel.
				"-vf",
				"scale=trunc(iw/2)*2:trunc(ih/2)*2",
				"-pix_fmt",
				"yuv420p",
				options.output_path,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const exit_code = await proc.exited;
		if (exit_code !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`ffmpeg failed encoding evidence video: ${stderr}`);
		}

		return {
			video_path: options.output_path,
			duration_seconds: total_recording_seconds(held_frames),
			frame_count: frames.length,
		};
	} finally {
		rmSync(options.frames_dir, { recursive: true, force: true });
	}
}
