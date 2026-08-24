import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ffmpeg_path, ffprobe_path, say_path } from "./visual_store";

import type { Qa_browser } from "./browser";

// ---------------------------------------------------------------------------
// Step timeline (pure)
// ---------------------------------------------------------------------------

/** One narrated step's own hold, before pacing against its voiceover clip. */
export type Timeline_step_input = {
	/** How long the step holds if it has no narration (or narration shorter than this). */
	min_seconds: number;
	/** Measured duration of the step's voiceover clip, 0 if the step is silent. */
	audio_seconds: number;
	/** Quiet screen time held after this step's voice finishes - defaults to VOICE_TAIL_SECONDS. Pass 0 for a step nothing follows (e.g. the recording's last screen), where there's no next transition to protect. */
	tail_seconds?: number;
};

export type Timeline_step = {
	/** Seconds from the recording's start when this step begins. */
	start_seconds: number;
	/** How long this step holds on screen - the video's pacing is driven by this, not the other way round. */
	hold_seconds: number;
};

/**
 * A pause held after the voiceover clip finishes, before the step's hold
 * ends - so a screen never cuts away the instant the voice stops talking.
 * `min_seconds` alone doesn't guarantee this: it only pads a step whose
 * audio is *shorter* than the minimum. A step whose audio runs *longer*
 * than the minimum (a long diff description, say) used to hold for exactly
 * `audio_seconds` with zero trailing pause - the bug this constant fixes.
 */
const VOICE_TAIL_SECONDS = 2;

/**
 * Pace a recording to its narration: each step holds for
 * `max(audio_seconds + tail_seconds, min_seconds)`, never a fixed guess - a
 * step with a longer voice line gets more time on screen rather than
 * truncating the audio (PLAN_reeqa_webview.md §6, Phase 4), and (by default)
 * keeps VOICE_TAIL_SECONDS of quiet screen time after the voice stops, for
 * every step except one whose caller passed `tail_seconds: 0`.
 */
export function compute_step_timeline(steps: readonly Timeline_step_input[]): { steps: Timeline_step[]; total_seconds: number } {
	let cursor_seconds = 0;
	const computed: Timeline_step[] = steps.map((step) => {
		const tail_seconds = step.tail_seconds ?? VOICE_TAIL_SECONDS;
		const hold_seconds = Math.max(step.audio_seconds + tail_seconds, step.min_seconds);
		const timed_step = { start_seconds: cursor_seconds, hold_seconds };
		cursor_seconds += hold_seconds;
		return timed_step;
	});
	return { steps: computed, total_seconds: cursor_seconds };
}

// ---------------------------------------------------------------------------
// Voiceover mux (pure filter-graph construction; ffmpeg execution below)
// ---------------------------------------------------------------------------

export type Voice_clip = { audio_path: string; start_seconds: number };

/**
 * ffmpeg `-filter_complex` mixing a full-length silence base (input 1) with
 * each narration clip (inputs 2..) delayed to its own start offset. The
 * silence base - not `amix`'s own "longest"/"first" input duration - is what
 * pins the output to the video's length: `amix duration=first` takes input
 * 1's duration, and input 1 is given `-t <video_seconds>` at spawn time, so
 * the mix is exactly as long as the video regardless of how the narration
 * clips land inside it.
 */
export function build_voiceover_filter_complex(clips: readonly Voice_clip[]): string {
	const delayed = clips.map((clip, index) => {
		const delay_ms = Math.max(Math.round(clip.start_seconds * 1000), 0);
		return `[${index + 2}:a]adelay=${delay_ms}|${delay_ms}[a${index}]`;
	});
	const mix_inputs = ["[1:a]", ...clips.map((_, index) => `[a${index}]`)].join("");
	return `${delayed.length > 0 ? `${delayed.join(";")};` : ""}${mix_inputs}amix=inputs=${clips.length + 1}:duration=first:normalize=0[aout]`;
}

/**
 * A caption burned onto the video during mux instead of being drawn in the
 * recording browser. `start_seconds` is the same timestamp its voice clip is
 * placed at, so the caption and the voice are anchored to one clock by
 * construction - the in-browser caption can't do that (see
 * record_page_evidence_video's step caption).
 */
export type Caption_overlay = {
	/** PNG to overlay; rendered ahead of time by the recording browser (see __reeqa_render_caption). */
	image_path: string;
	/** Video seconds when the caption appears - the voice clip's start_seconds. */
	start_seconds: number;
	/** Video seconds when the caption disappears (the next caption's start). */
	end_seconds: number;
};

/**
 * ffmpeg filter graph chaining one overlay per caption onto the video stream.
 * Each caption image is a looped ffmpeg input (indices starting at
 * `first_caption_input_index`); `enable='between(t,S,E)'` gates it to its own
 * window on the same video-time clock the voice clips are placed on. The
 * caption sits bottom-center, 10% up from the bottom edge - the spot the
 * recording overlay's pill occupied.
 */
export function build_caption_overlay_filter_complex(captions: readonly Caption_overlay[], first_caption_input_index: number): { graph: string; map: string } {
	let graph = "";
	let previous = "[0:v]";
	for (const [index, caption] of captions.entries()) {
		const input_index = first_caption_input_index + index;
		const label = index === captions.length - 1 ? "[vout]" : `[vcap${index}]`;
		graph += `${previous}[${input_index}:v]overlay=x=(W-w)/2:y=H*0.9-h:enable='between(t,${caption.start_seconds.toFixed(3)},${caption.end_seconds.toFixed(3)})'${label};`;
		previous = label;
	}
	return { graph, map: "[vout]" };
}

export type Mux_narration_options = {
	/** Silent video from evidence.ts's record_evidence(). */
	video_path: string;
	video_seconds: number;
	clips: readonly Voice_clip[];
	/** Captions to burn onto the video at their voice clips' timestamps (see Caption_overlay). */
	captions?: readonly Caption_overlay[];
	output_path: string;
};

/** Mix the narration clips (and any burned captions) onto the silent video in one ffmpeg call. */
export async function mux_narration(options: Mux_narration_options): Promise<void> {
	const captions = options.captions ?? [];
	const video_filter = build_caption_overlay_filter_complex(captions, 2 + options.clips.length);
	const has_captions = captions.length > 0;
	const args = [
		ffmpeg_path(),
		"-y",
		"-i",
		options.video_path,
		"-f",
		"lavfi",
		"-t",
		options.video_seconds.toFixed(3),
		"-i",
		"anullsrc=channel_layout=mono:sample_rate=44100",
		...options.clips.flatMap((clip) => ["-i", clip.audio_path]),
		// Each caption image loops for the whole video; the overlay's enable
		// window decides when it actually shows.
		...captions.flatMap((caption) => ["-loop", "1", "-t", options.video_seconds.toFixed(3), "-i", caption.image_path]),
		"-filter_complex",
		`${video_filter.graph}${build_voiceover_filter_complex(options.clips)}`,
		"-map",
		has_captions ? video_filter.map : "0:v",
		"-map",
		"[aout]",
		"-c:v",
		...(has_captions ? ["libx264", "-preset", "veryfast", "-crf", "18"] : ["copy"]),
		"-c:a",
		"aac",
		options.output_path,
	];
	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const exit_code = await proc.exited;
	if (exit_code !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ffmpeg failed muxing narration: ${stderr}`);
	}
}

// ---------------------------------------------------------------------------
// Text-to-speech
// ---------------------------------------------------------------------------

/** Render one narration line to an AIFF clip via macOS `say`, then measure its real duration with ffprobe. */
export async function synthesize_narration_clip(text: string, output_path: string): Promise<number> {
	const args = [say_path(), "-o", output_path];
	const voice = Bun.env.REEQA_TTS_VOICE;
	if (voice) args.push("-v", voice);
	const rate = Bun.env.REEQA_TTS_RATE;
	if (rate) args.push("-r", rate);
	args.push(text);

	const say_proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const say_exit_code = await say_proc.exited;
	if (say_exit_code !== 0) {
		const stderr = await new Response(say_proc.stderr).text();
		throw new Error(`say failed synthesizing narration clip: ${stderr}`);
	}

	const probe_proc = Bun.spawn(
		[ffprobe_path(), "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", output_path],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const probe_exit_code = await probe_proc.exited;
	if (probe_exit_code !== 0) {
		const stderr = await new Response(probe_proc.stderr).text();
		throw new Error(`ffprobe failed measuring narration clip duration: ${stderr}`);
	}
	const duration_seconds = Number.parseFloat(await new Response(probe_proc.stdout).text());
	if (!Number.isFinite(duration_seconds)) throw new Error(`ffprobe returned a non-numeric duration for ${output_path}`);
	return duration_seconds;
}

export type Narration_line = { id: string; text: string; min_seconds?: number; tail_seconds?: number };

export type Synthesized_narration = {
	timeline: { id: string; start_seconds: number; hold_seconds: number }[];
	clips: Voice_clip[];
	total_seconds: number;
};

/** Synthesize every line, then pace the timeline against the measured clip durations. Silent lines (empty text) just hold for min_seconds. */
export async function synthesize_narration(lines: readonly Narration_line[], clips_dir: string): Promise<Synthesized_narration> {
	mkdirSync(clips_dir, { recursive: true });
	const inputs: (Timeline_step_input & { id: string; audio_path: string | null })[] = [];
	for (const [index, line] of lines.entries()) {
		const min_seconds = line.min_seconds ?? 2;
		const tail_seconds = line.tail_seconds;
		if (!line.text.trim()) {
			inputs.push({ id: line.id, min_seconds, tail_seconds, audio_seconds: 0, audio_path: null });
			continue;
		}
		const audio_path = join(clips_dir, `${String(index).padStart(3, "0")}-${line.id}.aiff`);
		const audio_seconds = await synthesize_narration_clip(line.text, audio_path);
		inputs.push({ id: line.id, min_seconds, tail_seconds, audio_seconds, audio_path });
	}

	const { steps, total_seconds } = compute_step_timeline(inputs);
	const timeline = inputs.map((input, index) => ({ id: input.id, start_seconds: steps[index]!.start_seconds, hold_seconds: steps[index]!.hold_seconds }));
	const clips: Voice_clip[] = inputs
		.map((input, index) => (input.audio_path ? { audio_path: input.audio_path, start_seconds: steps[index]!.start_seconds } : null))
		.filter((clip): clip is Voice_clip => clip !== null);

	return { timeline, clips, total_seconds };
}

export function cleanup_narration_clips(clips_dir: string): void {
	rmSync(clips_dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Overlay (DOM, installed via install_on_new_document)
// ---------------------------------------------------------------------------

/**
 * Cursor, click ripple, bottom panel and intro/outro/diff cards, all as
 * plain fixed-position DOM under a single root - installed once per page
 * load, driven afterwards by evaluate()-ing window.__reeqa_narrate(state).
 * The cursor and ripple need no driving: CDP's Input.dispatchMouseEvent
 * fires real mousemove/mousedown/mouseup, which the overlay listens for
 * directly, so glide_and_click() below never has to also push cursor state
 * through evaluate().
 */
export function narration_overlay_script(): string {
	return `
		(() => {
			if (window.__reeqa_narrate) return;

			const root_id = "__reeqa_overlay_root";
			let root;

			const style = document.createElement("style");
			style.textContent = \`
				#\${root_id} { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: -apple-system, sans-serif; }
				#\${root_id} .reeqa-cursor { position: fixed; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: rgba(255,255,255,0.95); border: 2px solid #1d4ed8; box-shadow: 0 2px 8px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.4); display: none; }
				#\${root_id} .reeqa-ripple { position: fixed; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 2px solid #1d4ed8; animation: reeqa-ripple 500ms ease-out forwards; }
				@keyframes reeqa-ripple { from { transform: scale(1); opacity: 0.8; } to { transform: scale(3.2); opacity: 0; } }
				#\${root_id} .reeqa-target { position: fixed; border: 3px solid #f59e0b; border-radius: 6px; background: rgba(245, 158, 11, 0.16); box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.35), 0 0 18px rgba(245, 158, 11, 0.55); display: none; animation: reeqa-target-pulse 800ms ease-in-out infinite; }
				@keyframes reeqa-target-pulse { 0%, 100% { box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.35), 0 0 18px rgba(245, 158, 11, 0.55); } 50% { box-shadow: 0 0 0 5px rgba(245, 158, 11, 0.5), 0 0 26px rgba(245, 158, 11, 0.85); } }
				#\${root_id} .reeqa-panel { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 16px; background: rgba(15,23,42,0.86); color: #f8fafc; display: none; align-items: baseline; gap: 12px; font-size: 14px; }
				#\${root_id} .reeqa-panel .reeqa-title { font-weight: 600; }
				#\${root_id} .reeqa-panel .reeqa-step { opacity: 0.85; }
				#\${root_id} .reeqa-panel .reeqa-counter { margin-left: auto; opacity: 0.7; font-variant-numeric: tabular-nums; }
				#\${root_id} .reeqa-panel .reeqa-url { opacity: 0.6; font-size: 12px; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				#\${root_id} .reeqa-card { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 8px; background: #000; color: #f8fafc; text-align: center; padding: 24px; }
				#\${root_id} .reeqa-card .reeqa-card-title { font-size: 28px; font-weight: 700; }
				#\${root_id} .reeqa-card .reeqa-card-subtitle { font-size: 16px; opacity: 0.8; }
				#\${root_id} .reeqa-card .reeqa-card-icon { width: 96px; height: 96px; margin-bottom: 12px; object-fit: contain; }
				#\${root_id} .reeqa-diff { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 12px; background: rgba(15,23,42,0.92); padding: 24px; }
				#\${root_id} .reeqa-diff img { max-width: 90%; max-height: 78%; box-shadow: 0 4px 24px rgba(0,0,0,0.5); }
				#\${root_id} .reeqa-diff .reeqa-diff-caption { color: #f8fafc; font-size: 15px; }
				#\${root_id} .reeqa-caption { position: fixed; bottom: 10vh; left: 50%; transform: translateX(-50%); padding: 10px 18px; border-radius: 10px; background: #f59e0b; color: #0f172a; font-size: 16px; font-weight: 700; line-height: 1.4; box-shadow: 0 4px 16px rgba(0,0,0,0.35), 0 0 0 2px rgba(255,255,255,0.25); display: none; max-width: 80%; text-align: center; }
				#\${root_id} .reeqa-action { position: fixed; bottom: 10vh; left: 50%; transform: translateX(-50%); padding: 10px 18px; border-radius: 10px; background: #f59e0b; color: #0f172a; font-size: 16px; font-weight: 700; box-shadow: 0 4px 16px rgba(0,0,0,0.35), 0 0 0 2px rgba(255,255,255,0.25); display: none; max-width: 80%; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			\`;

			function ensure_root() {
				if (root && root.isConnected) return root;
				root = document.createElement("div");
				root.id = root_id;
				root.innerHTML = \`
					<div class="reeqa-cursor"></div>
					<div class="reeqa-target"></div>
					<div class="reeqa-panel">
						<span class="reeqa-title"></span>
						<span class="reeqa-step"></span>
						<span class="reeqa-url"></span>
						<span class="reeqa-counter"></span>
					</div>
					<div class="reeqa-card">
						<img class="reeqa-card-icon" alt="" />
						<div class="reeqa-card-title"></div>
						<div class="reeqa-card-subtitle"></div>
					</div>
					<div class="reeqa-diff">
						<img />
						<div class="reeqa-diff-caption"></div>
					</div>
					<div class="reeqa-caption"></div>
					<div class="reeqa-action"></div>
				\`;
				document.documentElement.append(style.cloneNode(true), root);
				return root;
			}

			function on_ready(fn) {
				if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
				else fn();
			}

			on_ready(() => {
				ensure_root();
				document.addEventListener("mousemove", (event) => {
					const cursor = root.querySelector(".reeqa-cursor");
					cursor.style.display = "block";
					cursor.style.left = event.clientX + "px";
					cursor.style.top = event.clientY + "px";
				});
				document.addEventListener("mousedown", (event) => {
					const ripple = document.createElement("div");
					ripple.className = "reeqa-ripple";
					ripple.style.left = event.clientX + "px";
					ripple.style.top = event.clientY + "px";
					root.append(ripple);
					ripple.addEventListener("animationend", () => ripple.remove());
				});
			});

			window.__reeqa_highlight = (rect) => {
				const el = ensure_root();
				const target = el.querySelector(".reeqa-target");
				target.style.display = "block";
				target.style.left = rect.left + "px";
				target.style.top = rect.top + "px";
				target.style.width = rect.width + "px";
				target.style.height = rect.height + "px";
			};
			window.__reeqa_clear_highlight = () => {
				const el = ensure_root();
				const target = el.querySelector(".reeqa-target");
				target.style.display = "none";
			};

			window.__reeqa_annotate = (text) => {
				const el = ensure_root();
				const action = el.querySelector(".reeqa-action");
				if (text) {
					action.style.display = "block";
					action.textContent = text;
				} else {
					action.style.display = "none";
					action.textContent = "";
				}
			};

			window.__reeqa_render_caption = (text) => {
				const canvas = document.createElement("canvas");
				const ctx = canvas.getContext("2d");
				// Mirrors the .reeqa-caption pill's CSS (700 16px, line-height
				// 1.4, padding 10px 18px, radius 10px, amber on dark text) so a
				// caption burned onto the video looks like the overlay pill it
				// replaces. Returns a PNG data URL for visual_store to save and
				// overlay at the voice clip's timestamp.
				const font = "700 16px -apple-system, sans-serif";
				const padding_x = 18;
				const padding_y = 10;
				const radius = 10;
				const line_height = 22.4;
				ctx.font = font;
				const text_width = ctx.measureText(text).width;
				canvas.width = Math.ceil(text_width + padding_x * 2);
				canvas.height = Math.ceil(line_height + padding_y * 2);
				ctx.font = font;
				ctx.shadowColor = "rgba(0,0,0,0.35)";
				ctx.shadowBlur = 16;
				ctx.shadowOffsetY = 4;
				ctx.beginPath();
				ctx.moveTo(canvas.width - radius, 0);
				ctx.arcTo(canvas.width, 0, canvas.width, radius, radius);
				ctx.arcTo(canvas.width, canvas.height, canvas.width - radius, canvas.height, radius);
				ctx.arcTo(0, canvas.height, 0, canvas.height - radius, radius);
				ctx.arcTo(0, 0, radius, 0, radius);
				ctx.closePath();
				ctx.fillStyle = "#f59e0b";
				ctx.fill();
				ctx.shadowColor = "transparent";
				ctx.shadowBlur = 0;
				ctx.shadowOffsetY = 0;
				ctx.fillStyle = "#0f172a";
				ctx.textBaseline = "middle";
				ctx.textAlign = "left";
				ctx.fillText(text, padding_x, canvas.height / 2 + 1);
				return canvas.toDataURL("image/png");
			};

			window.__reeqa_narrate = (state) => {
				const el = ensure_root();
				const panel = el.querySelector(".reeqa-panel");
				const card = el.querySelector(".reeqa-card");
				const diff = el.querySelector(".reeqa-diff");
				const caption = el.querySelector(".reeqa-caption");
				panel.style.display = "none";
				card.style.display = "none";
				diff.style.display = "none";
				caption.style.display = state.caption ? "block" : "none";
				caption.textContent = state.caption || "";

				if (state.type === "step") {
					panel.style.display = "flex";
					panel.querySelector(".reeqa-title").textContent = state.title || "";
					panel.querySelector(".reeqa-step").textContent = state.step_label || "";
					panel.querySelector(".reeqa-url").textContent = state.url || "";
					panel.querySelector(".reeqa-counter").textContent = state.step_count ? (state.step_index + 1) + " / " + state.step_count : "";
				} else if (state.type === "intro" || state.type === "outro") {
					card.style.display = "flex";
					const icon = card.querySelector(".reeqa-card-icon");
					icon.style.display = state.icon_data_url ? "block" : "none";
					icon.src = state.icon_data_url || "";
					card.querySelector(".reeqa-card-title").textContent = state.title || "";
					card.querySelector(".reeqa-card-subtitle").textContent = state.subtitle || "";
				} else if (state.type === "diff") {
					diff.style.display = "flex";
					diff.querySelector("img").src = state.image_data_url || "";
					diff.querySelector(".reeqa-diff-caption").textContent = state.diff_caption || "";
				}
				// state.type === "clear" falls through: everything above is already hidden.
			};
		})();
	`;
}

// ---------------------------------------------------------------------------
// Pointer glide
// ---------------------------------------------------------------------------

export type Point = { x: number; y: number };

/**
 * Glide the pointer from `from` to `to` over `steps` real CDP mouse-move
 * events, then click. Trusted synthetic events (Input.dispatchMouseEvent
 * fires real DOM mousemove/mousedown/mouseup), so the overlay's own
 * listeners pick up the cursor position and ripple with no extra plumbing.
 * `on_press` runs between press and release - the moment a click "happens",
 * for timestamping the click for an audible sound.
 *
 * The glide is deliberately slow (~1.5s over many small moves) and the press
 * is held before release: the screencast is change-driven, so an instant
 * glide leaves no frames of the cursor, and a link click's mouseReleased
 * navigates immediately - without the hold, the click ripple is torn down
 * before any frame captures it.
 */
export async function glide_and_click(browser: Qa_browser, from: Point, to: Point, steps = 32, on_press?: () => void, step_delay_ms = 50, press_hold_ms = 300): Promise<void> {
	// Show the cursor at the starting point before gliding, so it doesn't pop
	// in mid-path at the first interpolated position.
	await browser.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
	await Bun.sleep(step_delay_ms);
	for (let step = 1; step <= steps; step += 1) {
		const t = step / steps;
		await browser.cdp("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: from.x + (to.x - from.x) * t,
			y: from.y + (to.y - from.y) * t,
		});
		await Bun.sleep(step_delay_ms);
	}
	// Hold on the target for a beat so the final cursor position is captured
	// before the press - the change-driven screencast needs a still frame to
	// show the pointer arrived.
	await Bun.sleep(150);
	await browser.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: to.x, y: to.y, button: "left", clickCount: 1 });
	on_press?.();
	await Bun.sleep(press_hold_ms);
	await browser.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
}

// ---------------------------------------------------------------------------
// Click sound
// ---------------------------------------------------------------------------

/** Build a 16-bit mono PCM WAV from samples (signed, -32768..32767). */
export function build_click_wav(samples: Int16Array, sample_rate = 44_100): Buffer {
	const header_size = 44;
	const data_size = samples.length * 2;
	const buffer = Buffer.alloc(header_size + data_size);
	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + data_size, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // mono
	buffer.writeUInt32LE(sample_rate, 24);
	buffer.writeUInt32LE(sample_rate * 2, 28); // byte rate
	buffer.writeUInt16LE(2, 32); // block align
	buffer.writeUInt16LE(16, 34); // bits per sample
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(data_size, 40);
	for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index]!, header_size + index * 2);
	return buffer;
}

/**
 * Write a short synthesized "click" (a decaying 1.6kHz sine transient, ~60ms)
 * as a WAV at `output_path`. The screencast records video only, so an audible
 * click has to be mixed onto the recording afterwards (see mux_narration) -
 * this is the asset that gets muxed at each click's timestamp.
 */
export async function synthesize_click_sound(output_path: string): Promise<void> {
	const sample_rate = 44_100;
	const duration_seconds = 0.06;
	const sample_count = Math.floor(sample_rate * duration_seconds);
	const samples = new Int16Array(sample_count);
	for (let index = 0; index < sample_count; index += 1) {
		const t = index / sample_rate;
		// Fast exponential decay turns a sine into a percussive "click" rather
		// than a sustained tone.
		const envelope = Math.exp(-t * 70);
		const value = Math.sin(2 * Math.PI * 1600 * t) * envelope;
		samples[index] = Math.round(Math.max(-1, Math.min(1, value)) * 32767 * 0.85);
	}
	await Bun.write(output_path, build_click_wav(samples, sample_rate));
}
