import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { build_concat_script, total_recording_seconds, with_held_final_frame, type Captured_frame } from "./evidence";

// Simulates what with_held_final_frame() produces: three captured frames
// plus a duplicate of the last one, timed by held_final_frame_seconds.
const frames: Captured_frame[] = [
	{ path: "/tmp/000000.jpg", timestamp: 100.0 },
	{ path: "/tmp/000001.jpg", timestamp: 100.5 },
	{ path: "/tmp/000002.jpg", timestamp: 101.2 },
	{ path: "/tmp/000002-held.jpg", timestamp: 101.7 },
];

describe("build_concat_script", () => {
	test("derives each frame's duration from the gap to the previous frame", () => {
		const script = build_concat_script(frames);
		expect(script).toBe(
			"file '/tmp/000000.jpg'\n"
			+ "duration 0.500\n"
			+ "file '/tmp/000001.jpg'\n"
			+ "duration 0.700\n"
			+ "file '/tmp/000002.jpg'\n"
			+ "duration 0.500\n"
			+ "file '/tmp/000002-held.jpg'\n",
		);
	});

	test("the script ends on a file line, never a duration line - ffmpeg ignores a trailing duration outright", () => {
		const script = build_concat_script(frames);
		const lines = script.trim().split("\n");
		expect(lines.at(-1)).toBe("file '/tmp/000002-held.jpg'");
	});

	test("escapes single quotes in frame paths", () => {
		const script = build_concat_script([{ path: "/tmp/it's/000000.jpg", timestamp: 0 }, { path: "/tmp/it's/000001.jpg", timestamp: 1 }]);
		expect(script).toContain("file '/tmp/it'\\''s/000000.jpg'");
	});

	test("throws on an empty frame list", () => {
		expect(() => build_concat_script([])).toThrow();
	});

	test("never emits a negative duration from an out-of-order timestamp", () => {
		const script = build_concat_script([{ path: "/tmp/a.jpg", timestamp: 5 }, { path: "/tmp/b.jpg", timestamp: 4 }]);
		expect(script).toContain("duration 0.000");
	});
});

describe("with_held_final_frame", () => {
	test("appends a physically distinct duplicate of the last frame, not a repeated path", async () => {
		const dir = join(tmpdir(), `reeqa-evidence-test-${Date.now()}`);
		try {
			const last_path = join(dir, "000002.jpg");
			await Bun.write(last_path, "jpeg-bytes");
			const held = await with_held_final_frame(
				[{ path: "/tmp/000000.jpg", timestamp: 0 }, { path: "/tmp/000001.jpg", timestamp: 0.5 }, { path: last_path, timestamp: 1 }],
				0.5,
			);
			expect(held).toHaveLength(4);
			expect(held.at(-1)!.path).not.toBe(last_path);
			expect(held.at(-1)!.timestamp).toBeCloseTo(1.5, 5);
			expect(await Bun.file(held.at(-1)!.path).text()).toBe("jpeg-bytes");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("is a no-op for an empty frame list", async () => {
		expect(await with_held_final_frame([], 0.5)).toEqual([]);
	});
});

describe("total_recording_seconds", () => {
	test("spans first frame to last", () => {
		expect(total_recording_seconds(frames)).toBeCloseTo(1.7, 5);
	});

	test("is zero for no frames", () => {
		expect(total_recording_seconds([])).toBe(0);
	});

	test("is zero for a single frame", () => {
		expect(total_recording_seconds([{ path: "/tmp/a.jpg", timestamp: 42 }])).toBe(0);
	});
});
