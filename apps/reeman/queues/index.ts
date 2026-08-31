import type { RouteDefinition } from "$lib/route_builder";
import { default_locale } from "$config/supported_locales";
import { get_locale_from_request, localized_url } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

import { clear_queue, delete_job, get_dashboard_data, queue_available, queue_backend, retry_job, set_worker_paused } from "./store";

export const system_queues_page = {
	"/queues": { GET: get_system_queues },
	"/queues/retry": { POST: post_system_queues_retry },
	"/queues/delete": { POST: post_system_queues_delete },
	"/queues/clear": { POST: post_system_queues_clear },
	"/queues/pause": { POST: post_system_queues_pause },
};

// Index-grid columns for the two grids, mirroring the reeman:ui list layout
// (logs, db_tables). The flexible "1fr"/minmax tracks absorb the leftover
// width so no trailing grid_filler track is needed.
const queue_columns: Record<string, { width: string; class: string }> = {
	queue: { width: "minmax(16ch, 1fr)", class: "" },
	id: { width: "12ch", class: "" },
	type: { width: "16ch", class: "" },
	created: { width: "24ch", class: "" },
};

const failed_columns: Record<string, { width: string; class: string }> = {
	id: { width: "12ch", class: "" },
	type: { width: "16ch", class: "" },
	attempts: { width: "10ch", class: "text-center" },
	error: { width: "minmax(24ch, 1fr)", class: "break-words" },
	created: { width: "24ch", class: "" },
	actions: { width: "auto", class: "text-right" },
};

function grid_cols(columns: Record<string, { width: string }>): string {
	return Object.values(columns).map((column) => column.width).join(" ");
}

async function get_system_queues(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	if (!queue_available()) {
		return render("index", {
			data: {
				error: ctx.translations.ui.redis_unavailable,
				queues: [],
				failed: [],
				running: [],
				worker_alive: false,
				worker_state: null,
				worker_paused: false,
				queue_backend: queue_backend(),
				queue_columns,
				queue_grid_cols: grid_cols(queue_columns),
				failed_columns,
				failed_grid_cols: grid_cols(failed_columns),
			},
			ctx,
		});
	}

	try {
		const dashboard = await get_dashboard_data();
		const worker_state_label = dashboard.worker_paused
			? ctx.translations.ui.worker_paused
			: dashboard.worker_state === "draining"
				? ctx.translations.ui.worker_draining
				: dashboard.worker_state === "stopped"
					? ctx.translations.ui.worker_stopped
					: ctx.translations.ui.worker_running;

		return render("index", {
			data: {
				...dashboard,
				worker_state_label,
				queue_columns,
				queue_grid_cols: grid_cols(queue_columns),
				failed_columns,
				failed_grid_cols: grid_cols(failed_columns),
			},
			ctx,
		});
	} catch (error) {
		const error_message = error instanceof Error ? error.message : String(error);
		console.error("[system/queues] Error loading dashboard:", error_message);
		return render("index", {
			data: {
				error: `${ctx.translations.ui.error_loading}: ${error_message}`,
				queues: [],
				failed: [],
				running: [],
				worker_alive: false,
				worker_state: null,
				worker_paused: false,
				queue_backend: queue_backend(),
				queue_columns,
				queue_grid_cols: grid_cols(queue_columns),
				failed_columns,
				failed_grid_cols: grid_cols(failed_columns),
			},
			ctx,
		});
	}
}

async function post_system_queues_pause(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const action = params.get("action")?.trim();
	const locale = get_locale_from_request(req) || default_locale;

	try {
		if (action === "pause") await set_worker_paused(true);
		else if (action === "resume") await set_worker_paused(false);
	} catch (error) {
		console.error(`[system/queues] Error ${action ?? "?"}ing worker:`, error);
	}

	return Response.redirect(localized_url("/queues", locale), 303);
}

async function post_system_queues_clear(req: BunRequest): Promise<Response> {
	const url = new URL(req.url);
	const body = await req.text();
	const params = new URLSearchParams(body);
	const queue = params.get("queue")?.trim();
	const action = (url.searchParams.get("action") ?? params.get("action"))?.trim();
	const locale = get_locale_from_request(req) || default_locale;

	if (!queue) { return Response.redirect(localized_url("/queues", locale), 303); }

	try {
		if (action === "pending" || action === "failed" || action === "all") {
			await clear_queue(queue, action);
		}
	} catch (error) {
		console.error(`[system/queues] Error clearing queue ${queue} (${action}):`, error);
	}

	return Response.redirect(localized_url("/queues", locale), 303);
}

async function post_system_queues_retry(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const params = new URLSearchParams(body);
	const job_id = params.get("job_id")?.trim();
	const locale = ctx?.locale ?? default_locale;

	if (!job_id) { return Response.redirect(localized_url("/queues", locale), 303); }

	try {
		const ok = await retry_job(job_id);
		if (!ok) { console.warn(`[system/queues] Retry failed: job ${job_id} not found`); }
	} catch (error) {
		console.error(`[system/queues] Error retrying job ${job_id}:`, error);
	}

	return Response.redirect(localized_url("/queues", locale), 303);
}

async function post_system_queues_delete(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const params = new URLSearchParams(body);
	const job_id = params.get("job_id")?.trim();
	const locale = ctx?.locale ?? default_locale;

	if (!job_id) { return Response.redirect(localized_url("/queues", locale), 303); }

	try {
		const ok = await delete_job(job_id);
		if (!ok) { console.warn(`[system/queues] Delete failed: job ${job_id} not found`); }
	} catch (error) {
		console.error(`[system/queues] Error deleting job ${job_id}:`, error);
	}

	return Response.redirect(localized_url("/queues", locale), 303);
}

export const route_definitions: RouteDefinition[] = [
	{
		url: "/queues",
		crud: system_queues_page,
		nav_title_key: "reeman.queues",
		module: "system",
		nav_module: null,
		nav_section_key: "reeman.nav.data",
		nav_section_order: 20,
		nav_item_order: 60,
	},
];
