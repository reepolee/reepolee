import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { build_caption_overlay_filter_complex, build_click_wav, build_voiceover_filter_complex, compute_step_timeline, synthesize_click_sound, type Caption_overlay, type Timeline_step_input, type Voice_clip } from "./narration";

describe("compute_step_timeline", () => {
	test("holds each step for its audio duration plus a 2s tail after the voice finishes, when that's longer than the minimum", () => {
		const inputs: Timeline_step_input[] = [
			{ min_seconds: 1.5, audio_seconds: 3.0 },
			{ min_seconds: 1.5, audio_seconds: 0.8 },
		];
		const { steps, total_seconds } = compute_step_timeline(inputs);
		expect(steps).toEqual([
			{ start_seconds: 0, hold_seconds: 5.0 },
			{ start_seconds: 5.0, hold_seconds: 2.8 },
		]);
		expect(total_seconds).toBe(7.8);
	});

	test("a silent step (no audio) still holds for its minimum", () => {
		const { steps, total_seconds } = compute_step_timeline([{ min_seconds: 2, audio_seconds: 0 }]);
		expect(steps).toEqual([{ start_seconds: 0, hold_seconds: 2 }]);
		expect(total_seconds).toBe(2);
	});

	test("a step whose minimum is generous enough already covers the post-voice tail on its own", () => {
		// audio(1.2) + 2s tail = 3.2, still under the 5s minimum - the
		// minimum's own slack already leaves well over 2s of quiet after
		// the voice stops, so it (correctly) wins over audio+tail here.
		const { steps } = compute_step_timeline([{ min_seconds: 5, audio_seconds: 1.2 }]);
		expect(steps).toEqual([{ start_seconds: 0, hold_seconds: 5 }]);
	});

	test("a step with tail_seconds: 0 holds for exactly its audio duration, no post-voice pause", () => {
		// The recording's final screen: nothing follows it, so there's no
		// transition to protect with a trailing pause.
		const { steps } = compute_step_timeline([{ min_seconds: 0, audio_seconds: 1.4, tail_seconds: 0 }]);
		expect(steps).toEqual([{ start_seconds: 0, hold_seconds: 1.4 }]);
	});

	test("tail_seconds: 0 still respects an explicit minimum, if one is set", () => {
		const { steps } = compute_step_timeline([{ min_seconds: 3, audio_seconds: 1.4, tail_seconds: 0 }]);
		expect(steps).toEqual([{ start_seconds: 0, hold_seconds: 3 }]);
	});

	test("is empty for no steps", () => {
		expect(compute_step_timeline([])).toEqual({ steps: [], total_seconds: 0 });
	});
});

describe("build_click_wav", () => {
	test("writes a valid 16-bit mono PCM WAV header plus the samples", () => {
		const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
		const wav = build_click_wav(samples, 44_100);
		expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
		expect(wav.readUInt16LE(22)).toBe(1); // mono
		expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
		expect(wav.readUInt32LE(24)).toBe(44_100); // sample rate
		expect(wav.length).toBe(44 + samples.length * 2);
	});
});

describe("synthesize_click_sound", () => {
	test("writes a non-empty WAV that starts with RIFF/WAVE", async () => {
		const dir = join(tmpdir(), `reeqa-click-test-${Date.now()}`);
		try {
			const path = join(dir, "click.wav");
			await synthesize_click_sound(path);
			const bytes = await Bun.file(path).arrayBuffer();
			const view = new DataView(bytes);
			expect(bytes.byteLength).toBeGreaterThan(44);
			expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe("RIFF");
			expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe("WAVE");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("build_caption_overlay_filter_complex", () => {
	test("burns each caption in its own enable window, chaining overlays onto the video", () => {
		const captions: Caption_overlay[] = [
			{ image_path: "/tmp/a.png", start_seconds: 10.643, end_seconds: 15.645 },
			{ image_path: "/tmp/b.png", start_seconds: 15.645, end_seconds: 20.647 },
		];
		expect(build_caption_overlay_filter_complex(captions, 4)).toEqual({
			graph:
					"[0:v][4:v]overlay=x=(W-w)/2:y=H*0.9-h:enable='between(t,10.643,15.645)'[vcap0];[vcap0][5:v]overlay=x=(W-w)/2:y=H*0.9-h:enable='between(t,15.645,20.647)'[vout];",
			map: "[vout]",
		});
	});

	test("produces an empty graph and the video passthrough when there are no captions", () => {
		expect(build_caption_overlay_filter_complex([], 2)).toEqual({ graph: "", map: "[vout]" });
	});
});

describe("build_voiceover_filter_complex", () => {
	test("delays each clip to its own start offset and mixes against the silence base", () => {
		const clips: Voice_clip[] = [
			{ audio_path: "/tmp/a.aiff", start_seconds: 0 },
			{ audio_path: "/tmp/b.aiff", start_seconds: 2.5 },
		];
		expect(build_voiceover_filter_complex(clips)).toBe(
			"[2:a]adelay=0|0[a0];[3:a]adelay=2500|2500[a1];[1:a][a0][a1]amix=inputs=3:duration=first:normalize=0[aout]",
		);
	});

	test("mixes just the silence base when there are no clips", () => {
		expect(build_voiceover_filter_complex([])).toBe("[1:a]amix=inputs=1:duration=first:normalize=0[aout]");
	});

	test("never emits a negative adelay from a negative start offset", () => {
		const script = build_voiceover_filter_complex([{ audio_path: "/tmp/a.aiff", start_seconds: -1 }]);
		expect(script).toContain("adelay=0|0");
	});
});
