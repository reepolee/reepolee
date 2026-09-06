import { existsSync } from "node:fs";

/**
 * External tool discovery (Chrome, libvips, ffmpeg, macOS say, ffprobe) and
 * the in-page scripts injected into captured pages. Split out of visual_store
 * so the run lifecycle module only holds run state and capture/diff logic.
 * Every function here is pure - no runtime state - so callers can probe
 * capabilities without starting a run.
 */

export function chrome_path(): string {
	const configured_path = Bun.env.REEQA_CHROME_PATH;
	if (configured_path && existsSync(configured_path)) return configured_path;
	for (const executable of ["google-chrome", "chromium", "chromium-browser", "chrome", "msedge"]) {
		const found = Bun.which(executable);
		if (found) return found;
	}
	const mac_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	if (existsSync(mac_path)) return mac_path;
	throw new Error("Chrome or Chromium is required. Set REEQA_CHROME_PATH to its executable.");
}

export function vips_path(): string {
	const configured_path = Bun.env.REEQA_VIPS_PATH;
	if (configured_path && existsSync(configured_path)) return configured_path;
	const found = Bun.which("vips");
	if (found) return found;
	throw new Error("libvips is required for comparison diffs. Set REEQA_VIPS_PATH to its executable.");
}

export function vipsheader_path(): string {
	const configured_path = Bun.env.REEQA_VIPSHEADER_PATH;
	if (configured_path && existsSync(configured_path)) return configured_path;
	const found = Bun.which("vipsheader");
	if (found) return found;
	throw new Error("libvips vipsheader is required. Set REEQA_VIPSHEADER_PATH to its executable.");
}

export function ffmpeg_path(): string {
	const configured_path = Bun.env.REEQA_FFMPEG_PATH;
	if (configured_path && existsSync(configured_path)) return configured_path;
	const found = Bun.which("ffmpeg");
	if (found) return found;
	throw new Error("ffmpeg is required to render annotated evidence video. Set REEQA_FFMPEG_PATH to its executable.");
}

export function say_path(): string {
	const configured_path = Bun.env.REEQA_SAY_PATH;
	if (configured_path && existsSync(configured_path)) return configured_path;
	const found = Bun.which("say");
	if (found) return found;
	throw new Error("macOS `say` is required for evidence voiceover. Set REEQA_SAY_PATH to its executable.");
}

export function ffprobe_path(): string {
	const configured_path = Bun.env.REEQA_FFPROBE_PATH;
	if (configured_path && existsSync(configured_path)) return configured_path;
	const found = Bun.which("ffprobe");
	if (found) return found;
	throw new Error("ffprobe is required to measure narration clip duration. Set REEQA_FFPROBE_PATH to its executable.");
}

export function stabilize_script(): string {
	return `
		(() => {
			// The browser's own scroll-restoration can reopen a page at a
			// remembered scroll offset instead of the top - capture_page()
			// forces scroll(0,0) right before the shot anyway, but this stops
			// a restore from fighting it (or from being visible mid-navigation
			// during the screencast recorder).
			if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
			const freeze_videos = () => {
				document.querySelectorAll('video').forEach((video) => {
					video.removeAttribute('data-hls-src');
					video.removeAttribute('autoplay');
					video.pause();
				});
			};
			freeze_videos();
			new MutationObserver(freeze_videos).observe(document, { attributes: true, attributeFilter: ['data-hls-src'], childList: true, subtree: true });
		})();
	`;
}

export function settle_script(): string {
	return `
		(async () => {
			const style = document.createElement('style');
			style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}.playwright-ignore,[data-playwright="hide"],video[data-playwright],audio[data-playwright]{visibility:hidden!important}';
			document.head.append(style);
			document.querySelectorAll('[data-playwright]').forEach((element) => {
				const replacement = element.getAttribute('data-playwright');
				if (!replacement || replacement === 'hide' || element instanceof HTMLMediaElement) return;
				if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) element.value = replacement;
				else element.textContent = replacement;
			});
			document.querySelectorAll('video').forEach((video) => { video.pause(); video.currentTime = 0; });
			await document.fonts.ready;
			// Two rAF frames in a backgrounded/occluded window can take ~2s
			// (Chrome throttles rAF to ~1fps); race against a fixed timeout so
			// the settle can't stall on frame delivery.
			await new Promise((resolve) => { const timer = setTimeout(resolve, 200); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });
			return true;
		})()
	`;
}

export function visual_capabilities(): {
	chrome: boolean;
	vips: boolean;
	ffmpeg: boolean;
	say: boolean;
	chrome_message: string;
	vips_message: string;
	ffmpeg_message: string;
	say_message: string;
} {
	let chrome_message = "Ready";
	let vips_message = "Ready";
	let ffmpeg_message = "Ready";
	let say_message = "Ready";
	try {
		chrome_path();
	} catch (error) {
		chrome_message = error instanceof Error ? error.message : String(error);
	}
	try {
		vips_path();
		vipsheader_path();
	} catch (error) {
		vips_message = error instanceof Error ? error.message : String(error);
	}
	try {
		ffmpeg_path();
	} catch (error) {
		ffmpeg_message = error instanceof Error ? error.message : String(error);
	}
	try {
		say_path();
	} catch (error) {
		say_message = error instanceof Error ? error.message : String(error);
	}
	return {
		chrome: chrome_message === "Ready",
		vips: vips_message === "Ready",
		ffmpeg: ffmpeg_message === "Ready",
		say: say_message === "Ready",
		chrome_message,
		vips_message,
		ffmpeg_message,
		say_message,
	};
}
