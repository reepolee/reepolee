import type { RouteDefinition } from "$lib/route_builder";
import { default_language } from "$config/supported_languages";
import { get_lang_from_request, localized_url } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import {
	clear_queue_all,
	clear_queue_failed,
	clear_queue_pending,
	get_failed_job_ids,
	get_job,
	get_pending_job_ids,
	is_queue_available,
	is_worker_alive,
	queue_length,
	retry_job,
	scan_queue_names,
} from "$queue/index";
import type { BunRequest } from "bun";

export const system_queues_page = {
	"/queues": { GET: get_system_queues },
	"/queues/retry": { POST: post_system_queues_retry },
	"/queues/clear": { POST: post_system_queues_clear },
};

async function get_system_queues(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	if (!is_queue_available()) {
		return render("queues", {
			data: {
				error: ctx.translations.ui.redis_unavailable,
				queues: [],
				failed: [],
				worker_alive: false,
			},
			ctx,
		});
	}

	try {
		const worker_alive = await is_worker_alive();
		// Discover queue names dynamically from Redis
		const queue_names = await scan_queue_names();

		// Batch-gather queue depths and pending jobs
		const queues: { name: string; pending: number; pending_jobs: any[]; }[] = [];
		const queue_lengths = await Promise.all(queue_names.map((name) => queue_length(name)));
		const queue_pending_ids = await Promise.all(queue_names.map((name, i) => (queue_lengths[i] > 0 ? get_pending_job_ids(name, 50) : [])));

		// Batch all get_job calls across all queues
		const all_pending_jobs = await Promise.all(queue_pending_ids.flat().map((job_id) => get_job(job_id)));

		let pending_idx = 0;
		for (let qi = 0; qi < queue_names.length; qi++) {
			const ids = queue_pending_ids[qi];
			if (ids.length === 0) continue;
			const jobs: any[] = [];
			for (const _id of ids) {
				const job = all_pending_jobs[pending_idx++];
				if (job && job.status === "pending") {
					pending_job_map.set(job.id, job);
					jobs.push({ ...job, created_formatted: Temporal.Instant.fromEpochMilliseconds(job.created_at).toLocaleString() });
				}
			}
			if (jobs.length > 0) {
				queues.push({ name: queue_names[qi], pending: queue_lengths[qi], pending_jobs: jobs });
			}
		}

		// Batch-gather failed jobs across all queue names
		const failed_ids_by_queue = await Promise.all(queue_names.map((name) => get_failed_job_ids(name, 50)));
		const all_failed_ids = failed_ids_by_queue.flat();
		const failed_jobs = await Promise.all(all_failed_ids.map((id) => get_job(id)));

		const all_failed: any[] = [];
		for (const job of failed_jobs) {
			if (job && job.status === "failed") {
				all_failed.push({
					...job,
					created_formatted: Temporal.Instant.fromEpochMilliseconds(job.created_at).toLocaleString(),
					last_run_formatted: job.last_run_at > 0 ? Temporal.Instant.fromEpochMilliseconds(job.last_run_at).toLocaleString() : "-",
					scheduled_formatted: job.scheduled_for > 0 ? Temporal.Instant.fromEpochMilliseconds(job.scheduled_for).toLocaleString() : "-",
				});
			}
		}

		// Sort newest first by last_run_at
		all_failed.sort((a, b) => b.last_run_at - a.last_run_at);

		return render("queues", { data: { queues, failed: all_failed.slice(0, 100), worker_alive }, ctx });
	} catch (error) {
		const error_message = error instanceof Error ? error.message : String(error);
		console.error("[system/queues] Error loading dashboard:", error_message);
		return render("queues", {
			data: {
				error: `${ctx.translations.ui.error_loading}: ${error_message}`,
				queues: [],
				failed: [],
				worker_alive: false,
			},
			ctx,
		});
	}
}

async function post_system_queues_clear(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const queue = params.get("queue")?.trim();
	const action = params.get("action")?.trim();
	const lang = get_lang_from_request(req) || default_language;

	if (!queue) { return Response.redirect(localized_url("/system/queues", lang), 303); }

	try {
		if (action === "failed") {
			await clear_queue_failed(queue);
		} else if (action === "pending") {
			await clear_queue_pending(queue);
		} else if (action === "all") {
			await clear_queue_all(queue);
		}
	} catch (error) {
		console.error(`[system/queues] Error clearing queue ${queue} (${action}):`, error);
	}

	return Response.redirect(localized_url("/system/queues", lang), 303);
}

async function post_system_queues_retry(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const params = new URLSearchParams(body);
	const job_id = params.get("job_id")?.trim();
	const lang = ctx?.lang ?? default_language;

	if (!job_id) { return Response.redirect(localized_url("/system/queues", lang), 303); }

	try {
		const ok = await retry_job(job_id);
		if (!ok) { console.warn(`[system/queues] Retry failed: job ${job_id} not found`); }
	} catch (error) {
		console.error(`[system/queues] Error retrying job ${job_id}:`, error);
	}

	return Response.redirect(localized_url("/system/queues", lang), 303);
}

export const route_definitions: RouteDefinition[] = [
	{
		url: "/system/queues",
		crud: system_queues_page,
		nav_title_key: "system.queues",
		module: "system",
	},
];
