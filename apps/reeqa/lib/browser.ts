import { existsSync, mkdirSync, rmSync } from "node:fs";

/**
 * The only module that imports Bun.WebView (experimental as of Bun 1.4).
 * Named operations over raw cdp() so the flags that matter - full-page
 * capture, cookie scoping - live in one place. cdp() stays as an escape
 * hatch for what isn't wrapped yet.
 */
export type Qa_browser = {
	navigate(url: string): Promise<void>;
	evaluate<T = unknown>(expression: string): Promise<T>;
	capture_full_page(): Promise<Buffer>;
	/** Capture the page's DOM with layout rects (DOMSnapshot.captureSnapshot). */
	capture_dom_snapshot(): Promise<unknown>;
	/** Capture the rendered page's serialized markup (document.documentElement.outerHTML), for html_diff.ts. */
	capture_html(): Promise<string>;
	install_on_new_document(source: string): Promise<void>;
	set_cookie(cookie: { name: string; value: string; url: string }): Promise<void>;
	/**
	 * Stream a screencast as it's driven. Acks internally - callers only see
	 * the frames, and cannot forget to ack (the failure mode that silently
	 * stalls a screencast). `timestamp` is CDP's `Network.TimeSinceEpoch`
	 * (seconds), the only clock screencast frames arrive on - it is
	 * change-driven, not fixed-cadence, so per-frame duration must come from
	 * consecutive timestamps, never an assumed frame rate.
	 */
	record(options?: Record_options): AsyncIterable<Frame>;
	cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
	close(): void;
};

export type Frame = { data: Buffer; timestamp: number };

export type Record_options = {
	max_width?: number;
	max_height?: number;
	quality?: number;
	/** Stops the recording once aborted, after draining any already-queued frames. */
	signal?: AbortSignal;
};

export type Open_browser_options = {
	executable_path: string;
	width: number;
	height: number;
	profile_dir: string;
	extra_argv?: readonly string[];
};

type Screencast_frame_event = {
	data: string;
	sessionId: number;
	metadata: { timestamp: number };
};

type Cdp_fn = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

/**
 * Bun.WebView's cdp() allows exactly one in-flight call *per view*, not per
 * "operation kind" (contra the reading of PLAN_reeqa_webview.md §3's "acks
 * don't collide with driving" - confirmed empirically: a burst of frame acks
 * racing glide_and_click()'s own cdp() calls throws
 * `ERR_INVALID_STATE: a cdp() is already pending`). Every cdp() call in this
 * module - including internal ones like acks - must go through this single
 * queue instead of view.cdp() directly.
 */
function make_cdp_queue(view: Bun.WebView): Cdp_fn {
	let tail: Promise<unknown> = Promise.resolve();
	return <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
		const result = tail.then(() => view.cdp<T>(method, params));
		tail = result.catch(() => {});
		return result;
	};
}

/**
 * Bridge the push-based Page.screencastFrame CDP event to a pull-based async
 * generator. Acks are queued (not awaited) as frames arrive, so a burst of
 * frames doesn't serialize on ack round-trips before the next one can be
 * queued - but see make_cdp_queue: the ack itself still waits its turn
 * behind any other pending cdp() call, including another ack.
 */
async function* record_frames(cdp: Cdp_fn, view: Bun.WebView, options: Record_options): AsyncGenerator<Frame> {
	const pending: Frame[] = [];
	const in_flight_acks = new Set<Promise<unknown>>();
	let notify: (() => void) | null = null;
	let stopped = false;

	const on_frame = (event: Event) => {
		const { data, sessionId: session_id, metadata } = (event as MessageEvent<Screencast_frame_event>).data;
		const ack = cdp("Page.screencastFrameAck", { sessionId: session_id }).finally(() => in_flight_acks.delete(ack));
		in_flight_acks.add(ack);
		pending.push({ data: Buffer.from(data, "base64"), timestamp: metadata.timestamp });
		notify?.();
		notify = null;
	};
	const on_abort = () => {
		stopped = true;
		notify?.();
		notify = null;
	};

	view.addEventListener("Page.screencastFrame", on_frame);
	options.signal?.addEventListener("abort", on_abort);
	await cdp("Page.startScreencast", {
		format: "jpeg",
		quality: options.quality ?? 80,
		maxWidth: options.max_width,
		maxHeight: options.max_height,
	});

	try {
		// Keep draining already-queued frames after a stop request rather than
		// dropping them - the last navigation's frames matter as much as the first.
		while (!stopped || pending.length > 0) {
			if (pending.length === 0) {
				if (stopped) break;
				await new Promise<void>((resolve) => { notify = resolve; });
				continue;
			}
			yield pending.shift()!;
		}
	} finally {
		options.signal?.removeEventListener("abort", on_abort);
		view.removeEventListener("Page.screencastFrame", on_frame);
		await Promise.allSettled(in_flight_acks);
		await cdp("Page.stopScreencast").catch(() => {});
	}
}

export async function open_browser(options: Open_browser_options): Promise<Qa_browser> {
	if (existsSync(options.profile_dir)) rmSync(options.profile_dir, { recursive: true, force: true });
	mkdirSync(options.profile_dir, { recursive: true });

	const view = new Bun.WebView({
		backend: {
			type: "chrome",
			path: options.executable_path,
			argv: ["--disable-gpu", "--hide-scrollbars", ...(options.extra_argv ?? [])],
		},
		width: options.width,
		height: options.height,
		dataStore: { directory: options.profile_dir },
	});

	try {
		// cdp() requires a session, which only exists after the first navigate().
		await view.navigate("about:blank");
		const cdp = make_cdp_queue(view);
		await cdp("Page.enable");
		await cdp("Network.enable");
		return {
			navigate: (url) => view.navigate(url),
			evaluate: (expression) => view.evaluate(expression),
			async capture_full_page() {
				const result = await cdp<{ data?: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
				const data = result.data;
				if (typeof data !== "string") throw new Error("Chrome did not return screenshot data.");
				return Buffer.from(data, "base64");
			},
			async capture_dom_snapshot() {
				const result = await cdp<{ documents?: unknown[] }>("DOMSnapshot.captureSnapshot", { computedStyles: [], includeDOMRects: true });
				const documents = result.documents;
				if (!Array.isArray(documents) || documents.length === 0) throw new Error("Chrome did not return a DOM snapshot.");
				// Return the whole response: node names/values/attributes are
				// integer indices into the sibling `strings` table.
				return result;
			},
			capture_html: () => view.evaluate<string>("document.documentElement.outerHTML"),
			install_on_new_document: async (source) => {
				await cdp("Page.addScriptToEvaluateOnNewDocument", { source });
			},
			set_cookie: async (cookie) => {
				await cdp("Network.setCookie", cookie);
			},
			record: (record_options = {}) => record_frames(cdp, view, record_options),
			cdp: (method, params = {}) => cdp(method, params),
			close: () => view.close(),
		};
	} catch (error) {
		view.close();
		throw error;
	}
}
