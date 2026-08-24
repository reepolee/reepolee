import { get_running_jobs, is_queue_available, queue_length } from "$queue/index";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { post_reload_routes } from "./handlers";
import { get_and_clear_completed_return_to, is_busy } from "./actions";
import { any_busy } from "./lib/busy_state";
import { load_reeman_data, type PageOverrides } from "./page";
import { load_runs } from "./lib/state";

const TRANSLATE_QUEUE = "translate_batch";

/**
 * Number of AI translation jobs still queued or in flight.
 *
 * Counts pending + running: a job is enqueued by the generator (pending) and
 * then claimed by the worker (running), and both mean "translations have not
 * landed yet". Returns 0 when the queue store is unavailable, so a project
 * without a worker never shows a translation indicator that can never clear.
 */
async function count_translation_jobs(): Promise<number> {
	if (!is_queue_available()) return 0;
	try {
		const pending = await queue_length(TRANSLATE_QUEUE);
		const running = await get_running_jobs();
		const running_translations = running.filter((job) => job.queue === TRANSLATE_QUEUE).length;
		return pending + running_translations;
	} catch {
		// Status display must never break the page it decorates.
		return 0;
	}
}

export async function get_reeman_page(req: BunRequest, overrides: PageOverrides = {}): Promise<Response> {
	const data = await load_reeman_data({ tables: true, runs: true });
	const ctx = await create_ctx(req, import.meta.dir);

	return render("index", {
		data: { ...data, form_error: overrides.form_error ?? "" },
		ctx,
		status: overrides.status ?? 200,
	});
}

/**
 * Busy status for pages rendered while an action is running. The busy-poller
 * component polls this and reloads once the action finishes (live-reload can
 * otherwise strand the page on the busy banner mid-generation).
 *
 * A page rendered with a specific busy target (the table detail form) passes
 * ?target=<table> so the poller only reacts to that table's action finishing
 * - a different table's concurrent generation must not trigger a reload here.
 * Pages with no specific target (dashboard, database, logs, locales) omit it
 * and get the generic "anything running" status instead.
 *
 * When the action completes and a redirect target was stored (by the POST
 * handler), the response includes redirect_to so the poller can navigate
 * to the intended page instead of just reloading the current one.
 */
export async function get_busy_status(req: BunRequest): Promise<Response> {
	const url = new URL(req.url);
	const target = url.searchParams.get("target")?.trim() || "";

	const busy = target
		? (await is_busy(target)) !== null
		: (await any_busy()) !== null;

	// Generation and AI translation are two phases, not one. The generator only
	// *enqueues* translate_batch and exits, so the busy key clears while the AI
	// work is still queued or in flight. Report that second phase separately
	// instead of letting a cleared banner imply the whole pipeline finished.
	const translating = await count_translation_jobs();

	const redirect_to = busy ? null : get_and_clear_completed_return_to();
	const runs = await load_runs();
	const latest_run = runs[0];
	const error = !busy && latest_run && !latest_run.ok
		? {
			id: latest_run.id,
			action: latest_run.action,
			target: latest_run.target,
			message: latest_run.error || "The action failed. See the run log for details.",
		}
		: null;
	const payload: Record<string, unknown> = { busy, error };
	if (translating > 0) payload.translating = translating;
	if (redirect_to && !error) payload.redirect_to = redirect_to;
	return Response.json(payload);
}

export const dashboard_crud = {
	"/": { GET: get_reeman_page },
	"/__busy": { GET: get_busy_status },
	"/reload-routes": { POST: post_reload_routes },
};

export const route_definitions: RouteDefinition[] = [
	{
		// The reeman dashboard is the app root on this origin.
		url: "/",
		crud: dashboard_crud,
		nav_title_key: "reeman.reeman",
		module: "system",
		nav_module: null,
	},
];
