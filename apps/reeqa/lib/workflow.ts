import type { Qa_browser } from "./browser";

/**
 * A workflow page set's step model - IN_PROGRESS_reeqa_qa_procedure.md §2.
 * Kept out of page_set_store.ts because that store is imported by
 * sidebar.ts, which every ReeQA route pulls in; the parser/executor here
 * have no business in that import graph.
 *
 * A `click` step targets its element by CSS `selector` or by visible `text`
 * (exactly one). `before_seconds` and `delay_seconds` pause before and after
 * the step's action; `outline_seconds` / `glide_seconds` size a recording's
 * click presentation (how long the target is outlined, how long the cursor
 * glides before clicking). They pace a recording (holding the on-screen
 * action label, "3 seconds between clicks") and are harmless in a capture,
 * since screenshots are taken after the step already ran.
 */
export type Workflow_step =
	| { type: "navigate"; url: string; checkpoint?: boolean; before_seconds?: number; delay_seconds?: number }
	| { type: "click"; selector?: string; text?: string; checkpoint?: boolean; before_seconds?: number; delay_seconds?: number; outline_seconds?: number; glide_seconds?: number }
	| { type: "fill"; selector: string; value?: string; value_env?: string; checkpoint?: boolean; before_seconds?: number; delay_seconds?: number };

const step_keys: Record<Workflow_step["type"], readonly string[]> = {
	navigate: ["type", "url", "checkpoint", "before_seconds", "delay_seconds"],
	click: ["type", "selector", "text", "checkpoint", "before_seconds", "delay_seconds", "outline_seconds", "glide_seconds"],
	fill: ["type", "selector", "value", "value_env", "checkpoint", "before_seconds", "delay_seconds"],
};

/** Default recording-presentation timings for a click step, applied when the JSON omits outline_seconds / glide_seconds. */
export const DEFAULT_OUTLINE_SECONDS = 1;
export const DEFAULT_GLIDE_SECONDS = 1.6;

/**
 * Rejects unknown keys - a hand-typed `chekpoint: true` would otherwise
 * silently produce a workflow that captures nothing, the single most likely
 * authoring mistake with a raw JSON textarea (see the create/update page-set
 * forms, which paste this parser's error straight into the error banner).
 */
function normalized_step(value: unknown, index: number): Workflow_step {
	const position = index + 1;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Workflow step ${position} must be an object.`);
	const entry = value as Record<string, unknown>;
	const type = entry.type;
	if (type !== "navigate" && type !== "click" && type !== "fill") {
		throw new Error(`Workflow step ${position} has an unknown type. Use navigate, click or fill.`);
	}
	const allowed = step_keys[type];
	const unknown_key = Object.keys(entry).find((key) => !allowed.includes(key));
	if (unknown_key) throw new Error(`Workflow step ${position} has an unknown field: ${unknown_key}.`);
	if (entry.checkpoint !== undefined && typeof entry.checkpoint !== "boolean") throw new Error(`Workflow step ${position}: checkpoint must be true or false.`);
	const checkpoint = entry.checkpoint === true ? { checkpoint: true as const } : {};

	let before: { before_seconds: number } | Record<string, never> = {};
	if (entry.before_seconds !== undefined) {
		if (typeof entry.before_seconds !== "number" || !Number.isFinite(entry.before_seconds) || entry.before_seconds < 0) {
			throw new Error(`Workflow step ${position}: before_seconds must be a non-negative number.`);
		}
		before = { before_seconds: entry.before_seconds };
	}

	let delay: { delay_seconds: number } | Record<string, never> = {};
	if (entry.delay_seconds !== undefined) {
		if (typeof entry.delay_seconds !== "number" || !Number.isFinite(entry.delay_seconds) || entry.delay_seconds < 0) {
			throw new Error(`Workflow step ${position}: delay_seconds must be a non-negative number.`);
		}
		delay = { delay_seconds: entry.delay_seconds };
	}

	let outline: { outline_seconds: number } | Record<string, never> = {};
	if (entry.outline_seconds !== undefined) {
		if (typeof entry.outline_seconds !== "number" || !Number.isFinite(entry.outline_seconds) || entry.outline_seconds < 0) {
			throw new Error(`Workflow step ${position}: outline_seconds must be a non-negative number.`);
		}
		outline = { outline_seconds: entry.outline_seconds };
	}

	let glide: { glide_seconds: number } | Record<string, never> = {};
	if (entry.glide_seconds !== undefined) {
		if (typeof entry.glide_seconds !== "number" || !Number.isFinite(entry.glide_seconds) || entry.glide_seconds < 0) {
			throw new Error(`Workflow step ${position}: glide_seconds must be a non-negative number.`);
		}
		glide = { glide_seconds: entry.glide_seconds };
	}

	if (type === "navigate") {
		if (typeof entry.url !== "string" || !entry.url.trim()) throw new Error(`Workflow step ${position}: url is required.`);
		let url: string;
		try {
			url = new URL(entry.url).href;
		} catch {
			throw new Error(`Workflow step ${position}: url is not a valid absolute URL.`);
		}
		return { type, url, ...checkpoint, ...before, ...delay };
	}

	if (type === "click") {
		const has_selector = entry.selector !== undefined;
		const has_text = entry.text !== undefined;
		if (has_selector === has_text) throw new Error(`Workflow step ${position}: set exactly one of selector or text.`);
		if (has_selector && (typeof entry.selector !== "string" || !entry.selector.trim())) throw new Error(`Workflow step ${position}: selector must be a non-empty string.`);
		if (has_text && (typeof entry.text !== "string" || !entry.text.trim())) throw new Error(`Workflow step ${position}: text must be a non-empty string.`);
		return {
			type,
			...(has_selector ? { selector: (entry.selector as string).trim() } : { text: (entry.text as string).trim() }),
			...checkpoint,
			...before,
			...delay,
			...outline,
			...glide,
		};
	}

	if (typeof entry.selector !== "string" || !entry.selector.trim()) throw new Error(`Workflow step ${position}: selector is required.`);
	if (entry.value !== undefined && typeof entry.value !== "string") throw new Error(`Workflow step ${position}: value must be a string.`);
	if (entry.value_env !== undefined && (typeof entry.value_env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.value_env))) {
		throw new Error(`Workflow step ${position}: value_env must be an environment variable name.`);
	}
	if (entry.value !== undefined && entry.value_env !== undefined) throw new Error(`Workflow step ${position}: set value or value_env, not both.`);
	return {
		type,
		selector: entry.selector.trim(),
		...(entry.value === undefined ? {} : { value: entry.value }),
		...(entry.value_env === undefined ? {} : { value_env: entry.value_env }),
		...checkpoint,
		...before,
		...delay,
	};
}

export function is_workflow_step(value: unknown): value is Workflow_step {
	try {
		normalized_step(value, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Parses a page set's pasted JSON steps. A workflow with no checkpoint would
 * capture an empty baseline and every later compare would trivially "pass",
 * so that's rejected here rather than left to be a confusing empty report.
 */
export function parse_workflow_steps(source: string): Workflow_step[] {
	const trimmed = source.trim();
	if (!trimmed) throw new Error("Workflow steps are required. Paste a JSON array of steps.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new Error(`Workflow steps are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error("Workflow steps must be a JSON array.");
	if (parsed.length === 0) throw new Error("Add at least one workflow step.");
	const steps = parsed.map((value, index) => normalized_step(value, index));
	if (steps[0]!.type !== "navigate") throw new Error("The first workflow step must be a navigate step.");
	if (!steps.some((step) => step.checkpoint)) throw new Error("Mark at least one step as a checkpoint (\"checkpoint\": true) - a workflow with no checkpoint captures nothing to compare.");
	return steps;
}

/**
 * value_env resolves against the target project's own .env (see
 * project_env.ts), never a literal stored in the page set - ReeQA stores no
 * secrets. Only the variable *name* is safe to put in an error or a run log;
 * the resolved value never is.
 */
export function resolve_fill_value(step: Extract<Workflow_step, { type: "fill" }>, env: Record<string, string>): string {
	if (step.value_env === undefined) return step.value ?? "";
	const value = env[step.value_env];
	if (value === undefined) throw new Error(`${step.value_env} is not set in the project's .env file.`);
	return value;
}

/** How a click step names its element - a CSS selector or a visible-text match. */
export type Click_target = { selector?: string; text?: string };

/**
 * The JS expression that resolves a click target to its element (or null).
 * Shared by the programmatic click script and the recording's presented
 * (cursor-driven) click so both hit the same element. Text matching looks
 * for an exact visible-text match first, then a substring, across clickable
 * elements only - never the whole document.
 */
export function click_target_expression(target: Click_target): string {
	if (target.selector !== undefined) return `document.querySelector(${JSON.stringify(target.selector)})`;
	const text = target.text!;
	return `(() => {
		const candidates = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"], input[type="submit"], input[type="button"]'));
		const normalize = (value) => (value || '').trim().toLowerCase();
		const needle = normalize(${JSON.stringify(text)});
		return candidates.find((element) => normalize(element.textContent) === needle)
			|| candidates.find((element) => normalize(element.textContent).includes(needle))
			|| null;
	})()`;
}

function click_script(target: Click_target): string {
	return `(() => {
		const element = ${click_target_expression(target)};
		if (!element) return { ok: false, error: 'no element matches' };
		element.scrollIntoView({ block: 'center', behavior: 'instant' });
		element.click();
		return { ok: true };
	})()`;
}

/**
 * The recording's presented click resolves the element *without* scrolling:
 * the scroll is driven separately (a visible, stepped scroll the screencast
 * captures), and only then is the element's viewport center read back so a
 * cursor can glide there and click for real. Returns { ok: false } with an
 * error string when nothing matches.
 */
export function element_rect_script(target: Click_target): string {
	return `(() => {
		const element = ${click_target_expression(target)};
		if (!element) return { ok: false, error: 'no element matches' };
		const rect = element.getBoundingClientRect();
		return {
			ok: true,
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
			scroll_y: window.scrollY,
			inner_height: window.innerHeight,
			document_height: document.documentElement.scrollHeight,
		};
	})()`;
}

/**
 * Resolve a click target's visible text (whitespace-normalized, truncated) -
 * the recording's annotation uses this for selector-based clicks so the label
 * reads "Click \"Read the reasoning\"" rather than the raw selector. Returns
 * null when the element has no visible text.
 */
export function element_text_script(target: Click_target): string {
	return `(() => {
		const element = ${click_target_expression(target)};
		if (!element) return null;
		const text = (element.textContent || "").replace(/\\s+/g, " ").trim();
		return text ? text.slice(0, 80) : null;
	})()`;
}

/** The element's rect as read by element_rect_script() - the fields scroll_to_center_target() needs to compute a visible, centered scroll. */
export type Element_rect = {
	top: number;
	height: number;
	scroll_y: number;
	inner_height: number;
	document_height: number;
};

/**
 * The window scroll position that centers the target element vertically in
 * the viewport (clamped to the document), for a stepped, *visible* scroll -
 * element.scrollIntoView({ behavior: 'instant' }) teleports the page and the
 * change-driven screencast never shows the movement.
 */
export function scroll_to_center_target(info: Element_rect): number {
	const target_center = info.top + info.height / 2;
	const max_scroll = Math.max(info.document_height - info.inner_height, 0);
	return Math.min(Math.max(Math.round(info.scroll_y + target_center - info.inner_height / 2), 0), max_scroll);
}

function fill_script(selector: string, value: string): string {
	return `(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) return { ok: false, error: 'no element matches' };
		if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
			return { ok: false, error: 'element has no value to fill' };
		}
		element.focus();
		element.value = ${JSON.stringify(value)};
		// A server-rendered form reads the value on submit, but a page with
		// client-side validation or a live-updating control listens for the
		// events instead - assigning .value alone fires neither.
		element.dispatchEvent(new Event('input', { bubbles: true }));
		element.dispatchEvent(new Event('change', { bubbles: true }));
		return { ok: true };
	})()`;
}

/** Exported only for injection-safety testing. */
export const workflow_step_scripts = { click_script, fill_script, click_target_expression, element_rect_script, element_text_script };

/**
 * A click that submits a form tears down the document, so the next
 * evaluate() can land on a context that no longer exists - poll through the
 * failure rather than assuming one attempt lands on the new document.
 */
async function wait_for_ready(browser: Qa_browser): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const state = await browser.evaluate<string>("document.readyState");
			if (state === "complete") {
				// Wait a beat for the page to paint before driving the next
				// step. requestAnimationFrame fires on the next *frame*, and in
				// the recording's Chrome window (not the active tab) it is
				// throttled to ~1fps - two frames there is ~2 seconds of dead
				// air. Race the two-frame wait against a fixed timeout so a
				// throttled (or never-painting) window cannot stall the replay.
				await browser.evaluate(
					"new Promise((resolve) => { const timer = setTimeout(resolve, 200); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); })"
				);
				return;
			}
		} catch {
			// The document is mid-navigation and evaluate() has nothing to run
			// against yet - keep polling rather than surfacing this as a failure.
		}
		await Bun.sleep(100);
	}
	throw new Error("The page did not finish loading within 15 seconds.");
}

async function run_step_script(browser: Qa_browser, source: string, label: string): Promise<void> {
	const result = await browser.evaluate<{ ok: boolean; error?: string }>(source);
	if (!result?.ok) throw new Error(`Workflow ${label} failed: ${result?.error ?? "the page returned no result"}.`);
}

/** A click step's recording-presentation timings, resolved to concrete seconds (defaults applied) before the click is driven. */
export type Click_presentation_timing = { outline_seconds: number; glide_seconds: number };

/**
 * A recording replays a click by gliding a visible cursor to the element and
 * clicking it for real (which also fires the overlay's click ripple). The
 * callback receives the click's target so the recording layer can resolve
 * the element's position and drive CDP mouse events, plus the step's
 * outline/glide timings (with defaults already applied).
 */
export type Presented_click = (target: Click_target, timing: Click_presentation_timing) => Promise<void>;

/**
 * A recording's hook for a navigate step, fired once the new page has loaded
 * (after wait_for_ready) - the moment the on-screen "Open …" label can be
 * drawn on the fresh document, before the step's delay_seconds pause holds it.
 */
export type Presented_navigate = (url: string) => Promise<void>;

export async function execute_workflow_step(browser: Qa_browser, step: Workflow_step, env: Record<string, string>, presented_click?: Presented_click, presented_navigate?: Presented_navigate): Promise<void> {
	if (step.before_seconds) await Bun.sleep(step.before_seconds * 1000);
	if (step.type === "navigate") {
		try {
			await browser.navigate(step.url);
		} catch (error) {
			throw new Error(`Chrome navigation failed for ${step.url}: ${error instanceof Error ? error.message : String(error)}`);
		}
		await wait_for_ready(browser);
		if (presented_navigate) await presented_navigate(step.url);
	} else if (step.type === "click") {
		const target: Click_target = step.selector !== undefined ? { selector: step.selector } : { text: step.text! };
		if (presented_click) {
			await presented_click(target, {
				outline_seconds: step.outline_seconds ?? DEFAULT_OUTLINE_SECONDS,
				glide_seconds: step.glide_seconds ?? DEFAULT_GLIDE_SECONDS,
			});
		} else {
			await run_step_script(browser, click_script(target), step_label(step));
		}
		await wait_for_ready(browser);
	} else {
		await run_step_script(browser, fill_script(step.selector, resolve_fill_value(step, env)), step_label(step));
	}
	if (step.delay_seconds) await Bun.sleep(step.delay_seconds * 1000);
}

/** A run-log line for a step - never the resolved fill value, even when it came from a literal rather than value_env. */
export function step_label(step: Workflow_step): string {
	if (step.type === "navigate") return `navigate ${step.url}`;
	if (step.type === "click") return `click ${step.selector ?? step.text}`;
	return `fill ${step.selector}${step.value_env ? ` from ${step.value_env}` : ""}`;
}

/**
 * A short, on-screen action label for the recording ("Click \"Approach\"",
 * "Fill #username", "Open https://…") - the verb phrase a viewer reads while
 * the cursor glides to its target. Like step_label it never exposes a resolved
 * (or literal) fill value; only the selector is shown.
 */
export function step_annotation(step: Workflow_step): string {
	if (step.type === "navigate") return `Open ${step.url}`;
	if (step.type === "click") return `Click ${step.text !== undefined ? `"${step.text}"` : step.selector}`;
	return `Fill ${step.selector}`;
}

/**
 * The steps to replay to reproduce one workflow checkpoint: everything from
 * the first step through the checkpoint's own step, inclusive. A checkpoint
 * reached by "login then click" can't be reproduced by navigating to its URL
 * alone, so the replay must include every preceding step (used by the
 * evidence/recording recorders, which re-drive the browser to the page before
 * filming it).
 */
export function checkpoint_replay_steps(steps: readonly Workflow_step[], step_index: number): Workflow_step[] {
	if (!Number.isInteger(step_index) || step_index < 0 || step_index >= steps.length) {
		throw new Error(`Workflow checkpoint ${step_index + 1} is outside the recorded ${steps.length} step(s).`);
	}
	return steps.slice(0, step_index + 1);
}
