import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { open_browser, type Qa_browser } from "./browser";
import { qa_project_root, qa_runtime_dir, visual_capture_height, visual_capture_width } from "./config";
import { describe_changed_elements } from "./dom_diff";
import { record_evidence } from "./evidence";
import {
	cleanup_narration_clips,
	glide_and_click,
	mux_narration,
	narration_overlay_script,
	synthesize_click_sound,
	synthesize_narration,
	type Caption_overlay,
	type Narration_line,
} from "./narration";
import { is_workflow_page_set, require_page_set } from "./page_set_store";
import { read_project_env } from "./project_env";
import type { Qa_project } from "./project_store";
import { checkpoint_replay_steps, element_rect_script, element_text_script, execute_workflow_step, scroll_to_center_target, step_annotation, type Presented_click, type Workflow_step } from "./workflow";
import { chrome_path, relative_artifact, resolve_artifact, settle_script, stabilize_script, type Visual_page, type Visual_run } from "./visual_store";

/**
 * The recording's presentation state: the cursor's last position (so it
 * glides continuously from click to click) and the wall-clock timestamps of
 * each click, relative to the recording's start - mixed onto the video as an
 * audible click sound afterwards.
 */
type Recording_presentation = {
	cursor: { x: number; y: number };
	click_times_ms: number[];
	recording_started_ms: number;
};

/** The fields element_rect_script() returns, enough to scroll to and outline a target before clicking it. */
type Element_viewport_info = {
	ok: boolean;
	error?: string;
	x?: number;
	y?: number;
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	scroll_y?: number;
	inner_height?: number;
	document_height?: number;
};

/**
 * Stepped, visible scroll that centers the target in the viewport. A single
 * scrollIntoView({ behavior: 'instant' }) teleports the page and the
 * change-driven screencast never shows the movement, so this scrolls in small
 * increments with a pause between each - each scrollTo repaints, which is
 * what makes the scroll show up in the recording.
 */
async function scroll_element_into_view(browser: Qa_browser, info: Element_viewport_info): Promise<void> {
	const target_y = scroll_to_center_target({ top: info.top!, height: info.height!, scroll_y: info.scroll_y!, inner_height: info.inner_height!, document_height: info.document_height! });
	const distance = target_y - info.scroll_y!;
	if (Math.abs(distance) < 2) return;
	const steps = 14;
	for (let step = 1; step <= steps; step += 1) {
		// behavior: "instant" overrides any page CSS scroll-behavior:smooth so
		// each stepped position lands exactly where asked, instead of animating
		// on top of the next step.
		await browser.evaluate(`window.scrollTo({ top: ${info.scroll_y! + distance * (step / steps)}, behavior: "instant" })`);
		await Bun.sleep(45);
	}
}

/**
 * A presented click for execute_workflow_step's hook: scroll the target into
 * view (visibly), outline it, glide the visible cursor there, and click for
 * real (a trusted CDP click, not element.click()).
 */
function presented_click_for(browser: Qa_browser, presentation: Recording_presentation): Presented_click {
	return async (target, timing) => {
		const before = await browser.evaluate<Element_viewport_info>(element_rect_script(target));
		if (!before?.ok) throw new Error(`Workflow click failed: ${before?.error ?? "the page returned no element position"}.`);
		await scroll_element_into_view(browser, before);

		const info = await browser.evaluate<Element_viewport_info>(element_rect_script(target));
		if (!info?.ok || info.x === undefined || info.y === undefined || info.left === undefined || info.top === undefined || info.width === undefined || info.height === undefined) {
			throw new Error(`Workflow click failed: ${info?.error ?? "the page returned no element position"}.`);
		}

		// Outline the target before the cursor moves in, so the viewer sees
		// what is about to be clicked. The outline holds alone for
		// `outline_seconds` so it's readable before the glide begins.
		await browser.evaluate(`window.__reeqa_highlight(${JSON.stringify({ left: info.left, top: info.top, width: info.width, height: info.height })})`);
		await Bun.sleep(Math.round(timing.outline_seconds * 1000));

		// A fixed number of moves keeps the glide smooth; the JSON's
		// `glide_seconds` sets the per-move delay so the whole glide takes as
		// long as the author asked (default 1.6s -> 32 × 50ms, matching the
		// previous hardcoded pace).
		const glide_steps = 32;
		const step_delay_ms = Math.max(1, Math.round((timing.glide_seconds * 1000) / glide_steps));
		await glide_and_click(browser, presentation.cursor, { x: info.x, y: info.y }, glide_steps, () => {
			presentation.click_times_ms.push(Date.now() - presentation.recording_started_ms);
		}, step_delay_ms);
		presentation.cursor.x = info.x;
		presentation.cursor.y = info.y;

		await browser.evaluate("window.__reeqa_clear_highlight()").catch(() => {});
	};
}

/**
 * The recording's on-screen action label. For a click given only a selector,
 * resolve the element's visible text so the label reads "Click \"Read the
 * reasoning\"" rather than the raw selector; every other step (and any failed
 * resolution) falls back to the pure step_annotation.
 */
async function resolve_step_annotation(browser: Qa_browser, step: Workflow_step): Promise<string> {
	if (step.type !== "click" || step.text !== undefined) return step_annotation(step);
	try {
		const text = await browser.evaluate<string | null>(element_text_script({ selector: step.selector! }));
		if (text) return `Click "${text}"`;
	} catch {
		// Element not found or the document is mid-navigation - the selector
		// is still a truthful fallback.
	}
	return step_annotation(step);
}

/** Show the recording's on-screen action label (a missing overlay is swallowed). */
async function show_annotation(browser: Qa_browser, text: string): Promise<void> {
	await browser.evaluate(`window.__reeqa_annotate(${JSON.stringify(text)})`).catch(() => {});
}

/** Hide the recording's on-screen action label. */
async function clear_annotation(browser: Qa_browser): Promise<void> {
	await browser.evaluate("window.__reeqa_annotate(null)").catch(() => {});
}

/**
 * Drives a fresh browser session to the state a recorded page was captured
 * at, before evidence/clip filming begins. A URL-list page is a single
 * navigate; a workflow checkpoint has to replay the page set's *current*
 * steps from the first through the checkpoint's own step - a bare navigate
 * to its URL can't reproduce a login-and-clicks sequence. Timing edits take
 * effect here without recapturing the baseline, which only supplies the
 * checkpoint screenshots (see compare_workflow_current). When `presentation`
 * is set, clicks are driven with a visible cursor and timestamped for an
 * audible click sound.
 */
export async function drive_to_page_state(run: Visual_run, browser: Qa_browser, page: Visual_page, project: Qa_project, presentation?: Recording_presentation): Promise<void> {
	if (page.step_index === undefined) {
		await browser.set_cookie({ name: "reepolee_cookie_consent", value: "accepted", url: page.url });
		await browser.navigate(page.url);
		return;
	}
	if (!run.page_set_id) throw new Error("The workflow checkpoint's page set is missing.");
	const page_set = await require_page_set(project.id, run.page_set_id);
	if (!is_workflow_page_set(page_set)) throw new Error("The workflow checkpoint's page set is no longer a workflow set.");
	const steps = page_set.steps;
	if (steps.length === 0) throw new Error("The page set has no workflow steps.");
	const replay_steps = checkpoint_replay_steps(steps, page.step_index);
	const env = await read_project_env(project);
	await browser.set_cookie({ name: "reepolee_cookie_consent", value: "accepted", url: project.base_url });
	const presented_click = presentation ? presented_click_for(browser, presentation) : undefined;
	// A navigate tears the document down (and its overlay), so its "Open …"
	// label is drawn on the freshly loaded page via the hook, then held for
	// the step's delay_seconds. Clicks and fills show their label before the
	// action and clear after; before_seconds / delay_seconds (plus a click's
	// scroll+outline+glide) keep it on screen for as long as the JSON asks.
	const presented_navigate = presentation
		? async (url: string) => { await show_annotation(browser, `Open ${url}`); }
	: undefined;
	for (const step of replay_steps) {
		if (!presentation) {
			await execute_workflow_step(browser, step, env, presented_click, presented_navigate);
			continue;
		}
		if (step.type !== "navigate") {
			await show_annotation(browser, await resolve_step_annotation(browser, step));
		}
		await execute_workflow_step(browser, step, env, presented_click, presented_navigate);
		await clear_annotation(browser);
	}
}

/** Wait until the narration overlay is injected on the current document (after navigating to a fresh one), so the intro card can render before the replay. */
async function wait_for_overlay(browser: Qa_browser): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			if (await browser.evaluate<boolean>("typeof window.__reeqa_narrate === 'function'")) return;
		} catch {
			// Document mid-navigation - keep polling.
		}
		await Bun.sleep(50);
	}
	throw new Error("The narration overlay did not load.");
}

/**
 * Record a narrated evidence clip for one changed/new page: intro card,
 * navigate, panel, diff image, outro - four narration lines pace four
 * overlay states, and evidence.ts's record_evidence() captures the whole
 * thing while the browser is driven through it. Returns the muxed video's
 * absolute path; the caller stores it as page.video_path.
 */
export async function record_page_evidence_video(run: Visual_run, page: Visual_page, project: Qa_project): Promise<string> {
	const report_directory = join(qa_runtime_dir, "reports", run.id);
	mkdirSync(report_directory, { recursive: true });
	const profile_directory = join(qa_runtime_dir, "profiles", `${run.id}-evidence-${page.id}`);
	const clips_directory = join(qa_runtime_dir, "narration-clips", `${run.id}-${page.id}`);
	const click_sound_path = join(clips_directory, "click.wav");
	const frames_directory = join(qa_runtime_dir, "frames", `${run.id}-${page.id}`);
	const silent_video_path = join(report_directory, `${page.id}-evidence-silent.mp4`);
	const output_path = join(report_directory, `${page.id}-evidence.mp4`);
	const capture_width = run.capture_width ?? visual_capture_width;
	const capture_height = run.capture_height ?? visual_capture_height;

	const path_label = (() => {
		try {
			const parsed = new URL(page.url);
			return parsed.pathname || page.url;
		} catch {
			return page.url;
		}
	})();

	// min_seconds is the floor each screen holds for (max(audio, min_seconds)
	// - see narration.ts) - 5s per screen (2s default + 3s requested) gives
	// the viewer room to actually read each card, not just hear it. Not used
	// for "outro" below - see its own comment.
	const screen_min_seconds = 5;
	// The specific "what changed" description is heard once, on the final
	// (current) screenshot where the viewer both sees and hears it. The diff
	// screen only points at the pixel diff instead of repeating the same
	// sentence, so the two screens never contradict each other.
	const change_narration = page.status === "new" ? "This page is new." : (describe_changed_elements(page.changed_elements) || `A ${page.diff_bounds_width ?? "?"} by ${page.diff_bounds_height ?? "?"} pixel region changed.`);
	const diff_narration = page.status === "new" ? "This page is new." : "Here are the modified parts.";
	const narration_lines: Narration_line[] = [
		{ id: "intro", text: run.page_set_name ? `Running test "${run.page_set_name}".` : "Running visual test.", min_seconds: screen_min_seconds },
		{ id: "step", text: `Opening ${path_label}.`, min_seconds: screen_min_seconds },
		{ id: "diff", text: diff_narration, min_seconds: screen_min_seconds },
		{ id: "current", text: change_narration, min_seconds: screen_min_seconds },
		// No floor, no post-voice tail: this is the last screen and the
		// recording stops right after it (controller.abort() below) - a pause
		// here would just be dead air with nothing to transition into. Holds
		// for exactly as long as "End of evidence." takes to say.
		{ id: "outro", text: "End of evidence.", min_seconds: 0, tail_seconds: 0 },
	];
	const narration = await synthesize_narration(narration_lines, clips_directory);

	// Opening-scene icon (the Reepolee mark) shown on the intro card; a missing
	// asset is tolerated - the card still renders title/subtitle on black.
	let intro_icon_data_url: string | undefined;
	try {
		const intro_icon_svg = await Bun.file(join(qa_project_root, "static", "favicon.svg")).text();
		intro_icon_data_url = `data:image/svg+xml;base64,${Buffer.from(intro_icon_svg).toString("base64")}`;
	} catch {
		intro_icon_data_url = undefined;
	}

	let browser: Qa_browser | undefined;
	try {
		browser = await open_browser({ executable_path: chrome_path(), width: capture_width, height: capture_height, profile_dir: profile_directory });
		await browser.install_on_new_document(stabilize_script());
		await browser.install_on_new_document(narration_overlay_script());

		const narrate = (state: Record<string, unknown>) => browser!.evaluate(`window.__reeqa_narrate(${JSON.stringify(state)})`);
		// Each narration screen's wall-clock moment, so its voice clip can be
		// muxed at exactly the second the screen was shown - the same Date.now
		// clock the click sounds use. This replaces a residual replay_seconds
		// (recording.duration - narration.total), which drifts when the replay's
		// idle time (page loads, delay_seconds) isn't reflected in the
		// change-driven screencast's frame timestamps, leaving the voice and its
		// CC on screen at different times.
		const narration_shown_ms = new Map<string, number>();
		const narrate_at = (id: string, state: Record<string, unknown>) => {
			narration_shown_ms.set(id, Date.now());
			return narrate(state);
		};

		// Opening scene: install_on_new_document() only injects on the *next*
		// navigation, not the current about:blank document - navigate to a
		// fresh black page so the overlay (and its solid-black intro card)
		// exist. The card is shown *before* the screencast starts, so the
		// video's first frame is the card itself (no white about:blank flash)
		// and the intro voice lands exactly at t=0 with it - previously the
		// recording started first and the intro clip at t=0 spoke a few
		// hundred ms ahead of the card that only appeared after this navigate.
		await browser.navigate("data:text/html,<html><body style='margin:0;background:black'></body></html>");
		await wait_for_overlay(browser);
		await narrate_at("intro", { type: "intro", title: project.name, subtitle: run.page_set_name ?? "", icon_data_url: intro_icon_data_url, caption: narration_lines[0]!.text });
		// Let the card paint before the first screencast frame is captured, so
		// the opening frame isn't a blank black page one paint behind.
		await Bun.sleep(200);

		const recording_started_ms = Date.now();
		const presentation: Recording_presentation = { cursor: { x: 60, y: 60 }, click_times_ms: [], recording_started_ms };
		const controller = new AbortController();
		const recording_promise = record_evidence({
			browser,
			frames_dir: frames_directory,
			output_path: silent_video_path,
			max_width: capture_width,
			max_height: capture_height,
			signal: controller.signal,
			// The screencast only emits a frame on visual change, so the idle
			// hold after the outro card appears (nothing on screen changes
			// again before abort()) produces no frames of its own - without
			// this, evidence.ts's default 0.5s held-frame gap would be shorter
			// than the outro's real narration hold and its voiceover would be
			// truncated mid-word by mux_narration's video-length silence base.
			held_final_frame_seconds: narration.timeline.at(-1)?.hold_seconds,
		});

		await Bun.sleep(narration.timeline[0]!.hold_seconds * 1000);

		await drive_to_page_state(run, browser, page, project, presentation);
		await browser.evaluate(settle_script());
		await browser.evaluate("window.scrollTo(0, 0)");

		// The step screen's caption is the only one the change-driven screencast
		// misses: it's a small overlay change (bottom panel + pill) right after
		// the replay's activity settles, so Chrome can go seconds without
		// emitting a frame and the paint lands in the video late while its
		// voice - placed on the wall clock - plays on time. The full-screen
		// cards (intro/diff/current/outro) force a frame whenever they change,
		// so their captions stay put. Fix: don't draw the step caption in the
		// browser at all - render it to a PNG here and burn it onto the video
		// at the voice clip's exact timestamp during mux (one clock, by
		// construction).
		let step_caption_image_path: string | undefined;
		try {
			const data_url = await browser.evaluate<string>(`window.__reeqa_render_caption(${JSON.stringify(narration_lines[1]!.text)})`);
			const base64 = data_url.replace(/^data:image\/png;base64,/, "");
			step_caption_image_path = join(clips_directory, "step-caption.png");
			await Bun.write(step_caption_image_path, Buffer.from(base64, "base64"));
		} catch {
			// Canvas render failed (e.g. mid-navigation) - fall back to the
			// overlay pill, late but still visible.
			step_caption_image_path = undefined;
		}
		await narrate_at("step", {
			type: "step",
			title: project.name,
			step_label: page.status,
			step_index: 0,
			step_count: 1,
			url: page.url,
			// Burned instead of drawn in the browser when the render succeeded.
			...(step_caption_image_path ? {} : { caption: narration_lines[1]!.text }),
		});
		await Bun.sleep(narration.timeline[1]!.hold_seconds * 1000);

		// diff_zoom_path (the padded bounding box around what actually differs,
		// computed in image_difference()) rather than diff_path - a full page
		// screenshot's worth of diff is mostly blank and the change can be
		// scrolled far below the fold.
		const diff_image_path = page.diff_zoom_path ?? page.diff_path;
		const diff_caption = `${page.diff_bounds_width ?? "?"} x ${page.diff_bounds_height ?? "?"} px changed`;
		if (diff_image_path) {
			const diff_bytes = await Bun.file(resolve_artifact(diff_image_path)).arrayBuffer();
			const diff_data_url = `data:image/png;base64,${Buffer.from(diff_bytes).toString("base64")}`;
			await narrate_at("diff", { type: "diff", image_data_url: diff_data_url, diff_caption, caption: narration_lines[2]!.text });
		} else {
			await narrate_at("diff", { caption: narration_lines[2]!.text });
		}
		await Bun.sleep(narration.timeline[2]!.hold_seconds * 1000);

		// Follow-up screen: the current/test capture itself (not the diff
		// overlay), same zoom crop as the diff image, narrated with the
		// fuller from/to wording now that the viewer has already seen where
		// the change is from the diff screen.
		const current_image_path = page.current_zoom_path ?? page.current_path;
		if (current_image_path) {
			const current_bytes = await Bun.file(resolve_artifact(current_image_path)).arrayBuffer();
			const current_data_url = `data:image/png;base64,${Buffer.from(current_bytes).toString("base64")}`;
			await narrate_at("current", { type: "diff", image_data_url: current_data_url, diff_caption: "Current state", caption: narration_lines[3]!.text });
		} else {
			await narrate_at("current", { caption: narration_lines[3]!.text });
		}
		await Bun.sleep(narration.timeline[3]!.hold_seconds * 1000);

		await narrate_at("outro", { type: "outro", title: "Done", caption: narration_lines[4]!.text });
		await Bun.sleep(narration.timeline[4]!.hold_seconds * 1000);

		controller.abort();
		const recording = await recording_promise;

		// Click sounds land where the clicks happened (during the replay, after
		// the opening scene). The intro plays at video start; the replay sits
		// between it and the remaining narration screens, so step/diff/current/
		// outro shift by the replay's duration while the intro clip stays at 0.
		const click_clips = presentation.click_times_ms.map((time_ms) => ({ audio_path: click_sound_path, start_seconds: time_ms / 1000 }));
		if (click_clips.length > 0) await synthesize_click_sound(click_sound_path);
		const narration_clips = narration.clips.map((clip) => {
			const line = narration_lines.find((candidate) => clip.audio_path.includes(`-${candidate.id}.aiff`));
			const shown_ms = line ? narration_shown_ms.get(line.id) : undefined;
			const start_seconds = shown_ms === undefined ? clip.start_seconds : Math.max((shown_ms - recording_started_ms) / 1000, 0);
			return { ...clip, start_seconds };
		});

		// Burn the step caption from its voice clip's start until the next
		// screen's voice starts - the same on-screen window the overlay pill
		// used to have, now on the voice's clock.
		const step_clip = narration_clips.find((clip) => clip.audio_path.includes("-step.aiff"));
		const diff_clip = narration_clips.find((clip) => clip.audio_path.includes("-diff.aiff"));
		const captions: Caption_overlay[] =
			step_caption_image_path && step_clip && diff_clip
				? [{ image_path: step_caption_image_path, start_seconds: step_clip.start_seconds, end_seconds: diff_clip.start_seconds }]
				: [];

		// Timeline trace: exact measured breakpoints, so a mis-timed screen can
		// be pointed at precisely. Written to a file under .reepolee (the worker
		// process's console output isn't always visible in the dev multiplexer),
		// once per evidence clip. Times are seconds from the video's first frame.
		const ms = (seconds: number) => `${seconds.toFixed(3)}s`;
		const trace: string[] = [];
		trace.push(`[reeqa timeline] ${page.url} (run ${run.id} / page ${page.id})`);
		trace.push(`  recording: ${ms(recording.duration_seconds)} (${recording.frame_count} frames)`);
		for (const line of narration_lines) {
			const shown = narration_shown_ms.get(line.id);
			const shown_seconds = shown === undefined ? NaN : (shown - recording_started_ms) / 1000;
			const clip = narration_clips.find((entry) => entry.audio_path.includes(`-${line.id}.aiff`));
			trace.push(
				`  ${line.id.padEnd(7)} shown@ ${ms(shown_seconds)} -> audio@ ${clip ? ms(clip.start_seconds) : "(silent)"}  "${line.text}"`,
			);
		}
		for (const [index, click] of presentation.click_times_ms.entries()) {
			trace.push(`  click#${index + 1}  audio@ ${ms(click / 1000)}`);
		}
		for (const caption of captions) {
			trace.push(`  cc@     burned [${ms(caption.start_seconds)}, ${ms(caption.end_seconds)})  "${narration_lines[1]!.text}"`);
		}
		const trace_dir = join(qa_runtime_dir, "timeline");
		mkdirSync(trace_dir, { recursive: true });
		const trace_path = join(trace_dir, `${run.id}-${page.id}.log`);
		writeFileSync(trace_path, `${trace.join("\n")}\n`);
		console.log(`[reeqa timeline] wrote ${trace_path}`);

		await mux_narration({
			video_path: recording.video_path,
			video_seconds: recording.duration_seconds,
			clips: [...click_clips, ...narration_clips],
			captions,
			output_path,
		});
		return output_path;
	} finally {
		browser?.close();
		if (existsSync(profile_directory)) rmSync(profile_directory, { recursive: true, force: true });
		cleanup_narration_clips(clips_directory);
		if (existsSync(silent_video_path)) rmSync(silent_video_path);
	}
}

/**
 * Record a clean, un-annotated clip for one unchanged (passing) page - mode 3
 * "recording run" in IN_PROGRESS_reeqa_qa_procedure.md §4: no narration
 * overlay, no diff cards, just navigate + settle + hold. The screencast only
 * emits frames on visual change, so the idle hold after the page settles
 * produces no frames of its own - held_final_frame_seconds is what actually
 * gives the clip its length (same reasoning as record_page_evidence_video's
 * outro card). Returns the encoded clip's absolute path.
 */
export async function record_page_clip(run: Visual_run, page: Visual_page, project: Qa_project): Promise<string> {
	const report_directory = join(qa_runtime_dir, "reports", run.id);
	mkdirSync(report_directory, { recursive: true });
	const profile_directory = join(qa_runtime_dir, "profiles", `${run.id}-recording-${page.id}`);
	const frames_directory = join(qa_runtime_dir, "frames", `${run.id}-recording-${page.id}`);
	const silent_video_path = join(report_directory, `${page.id}-recording-silent.mp4`);
	const output_path = join(report_directory, `${page.id}-recording.mp4`);
	const click_sound_path = join(report_directory, `${page.id}-click.wav`);
	const capture_width = run.capture_width ?? visual_capture_width;
	const capture_height = run.capture_height ?? visual_capture_height;
	const hold_seconds = 3;

	let browser: Qa_browser | undefined;
	try {
		browser = await open_browser({ executable_path: chrome_path(), width: capture_width, height: capture_height, profile_dir: profile_directory });
		await browser.install_on_new_document(stabilize_script());
		// The pointer overlay's cursor + click ripple render the presented
		// clicks; its cards stay hidden because nothing calls __reeqa_narrate
		// here (mode 3 is a clean, un-annotated clip).
		await browser.install_on_new_document(narration_overlay_script());

		const recording_started_ms = Date.now();
		const presentation: Recording_presentation = { cursor: { x: 60, y: 60 }, click_times_ms: [], recording_started_ms };
		const controller = new AbortController();
		const recording_promise = record_evidence({
			browser,
			frames_dir: frames_directory,
			output_path: silent_video_path,
			max_width: capture_width,
			max_height: capture_height,
			signal: controller.signal,
			held_final_frame_seconds: hold_seconds,
		});

		await drive_to_page_state(run, browser, page, project, presentation);
		await browser.evaluate(settle_script());
		await browser.evaluate("window.scrollTo(0, 0)");
		await Bun.sleep(hold_seconds * 1000);

		controller.abort();
		const recording = await recording_promise;

		const click_clips = presentation.click_times_ms.map((time_ms) => ({ audio_path: click_sound_path, start_seconds: time_ms / 1000 }));
		if (click_clips.length > 0) {
			await synthesize_click_sound(click_sound_path);
			await mux_narration({
				video_path: silent_video_path,
				video_seconds: recording.duration_seconds,
				clips: click_clips,
				output_path,
			});
		} else {
			// No presented clicks (a URL-list page, or a navigate-only
			// checkpoint): keep the clip exactly as before - no audio track.
			if (existsSync(output_path)) rmSync(output_path);
			renameSync(silent_video_path, output_path);
		}
		return output_path;
	} finally {
		browser?.close();
		if (existsSync(profile_directory)) rmSync(profile_directory, { recursive: true, force: true });
		if (existsSync(silent_video_path)) rmSync(silent_video_path);
		if (existsSync(click_sound_path)) rmSync(click_sound_path);
	}
}
