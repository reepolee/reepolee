import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { normalize_visual_diff } from "./diff_image";

function image_bands(image_path: string): number {
	const executable = Bun.which("vipsheader");
	if (!executable) throw new Error("vipsheader is required for the visual difference test.");
	const result = Bun.spawnSync([executable, "-f", "bands", image_path], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const stderr_text = result.stderr.toString();
		throw new Error(stderr_text.trim());
	}
	const stdout_text = result.stdout.toString();
	return Number(stdout_text.trim());
}

// Spawns the external vips binary twice; under a full parallel test run the
// spawns can take longer than the default 5s timeout, so give it headroom.
test("normalizes Playwright RGBA differences for the annotation renderer", () => {
	const executable = Bun.which("vips");
	if (!executable) throw new Error("libvips is required for the visual difference test.");
	const temp_directory = mkdtempSync(join(tmpdir(), "reeqa-diff-"));
	const rgba_path = join(temp_directory, "rgba.png");
	const rgb_path = join(temp_directory, "rgb.png");
	try {
		const create_result = Bun.spawnSync([executable, "black", rgba_path, "4", "4", "--bands", "4"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(create_result.exitCode).toBe(0);
		expect(image_bands(rgba_path)).toBe(4);

		normalize_visual_diff(rgba_path, rgb_path);

		expect(image_bands(rgb_path)).toBe(3);
	} finally {
		rmSync(temp_directory, { recursive: true, force: true });
	}
}, { timeout: 30_000 });
