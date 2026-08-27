import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "bun:test";

import { open_browser, type Qa_browser } from "./browser";
import { chrome_path } from "./visual_store";

const profile_dir = mkdtempSync(join(tmpdir(), "reeqa-browser-test-"));
afterAll(() => rmSync(profile_dir, { recursive: true, force: true }));

// Bun.WebView appears to enforce a platform minimum window width (empirically
// 500px on macOS) - request comfortably above it so the test isn't asserting
// against a floor that has nothing to do with capture_full_page's own logic.
const view_width = 800;

async function with_browser<T>(fn: (browser: Qa_browser) => Promise<T>): Promise<T> {
	const browser = await open_browser({ executable_path: chrome_path(), width: view_width, height: 300, profile_dir });
	try {
		return await fn(browser);
	} finally {
		browser.close();
	}
}

// These tests drive a real Bun.WebView. Where its Chrome/Chromium backend
// cannot be loaded - a headless CI image, or Windows on the current canary,
// which throws ERR_DLOPEN_FAILED even with Chrome installed and resolvable -
// they cannot run at all. Probe once and skip explicitly, so an environment
// gap reads as a skip instead of a product failure.
const browser_available = await (async () => {
	try {
		const probe = await open_browser({ executable_path: chrome_path(), width: view_width, height: 300, profile_dir });
		probe.close();
		return true;
	} catch {
		return false;
	}
})();

if (!browser_available) { console.log("[reeqa] Bun.WebView backend unavailable - browser capture tests skipped"); }

test.skipIf(!browser_available)("capture_full_page captures beyond the viewport at the page's real size", async () => {
	await with_browser(async (browser) => {
		// Taller than the 300px viewport, so a viewport-only capture would crop it.
		await browser.navigate("data:text/html,<body style='margin:0;height:900px;background:red'></body>");
		const png = await browser.capture_full_page();
		const dimensions = await view_png_dimensions(png);
		expect(dimensions).toEqual({ width: view_width, height: 900 });
	});
});

test.skipIf(!browser_available)("record() yields at least one frame once the page changes, with even h264-safe dimensions", async () => {
	await with_browser(async (browser) => {
		await browser.navigate("data:text/html,<body style='margin:0;height:300px;background:white'></body>");
		const controller = new AbortController();
		const frames: { width: number }[] = [];
		const record_done = (async () => {
			for await (const frame of browser.record({ max_width: view_width, max_height: 300, signal: controller.signal })) {
				frames.push({ width: frame.data.byteLength });
				if (frames.length >= 1) controller.abort();
			}
		})();
		await browser.evaluate("document.body.style.background = 'blue'");
		await record_done;
		expect(frames.length).toBeGreaterThan(0);
	});
}, 15_000);

async function view_png_dimensions(png: Buffer): Promise<{ width: number; height: number }> {
	// PNG: 8-byte signature, then an IHDR chunk whose first 8 bytes are
	// width/height as big-endian uint32 - no image library needed to read it.
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
