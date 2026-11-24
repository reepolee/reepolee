// apps/reeqa/workers.ts - worker registrations for ReeQA run execution.
//
// Per .agents/PLAN_worker_registration.md, a resource declares its job handlers
// here (never in index.ts) and worker.ts imports this array. This module must
// not import anything from the server's render/i18n/CRUD chain - the worker
// process only needs the run stores, which are file-based and process-agnostic.

import type { Job } from "$queue/index";

import { cancel_run_in_worker, execute_command_run } from "./lib/run_store";
import { cancel_visual_run_in_worker, execute_page_evidence_job, execute_page_recording_job, execute_visual_run_job } from "./lib/visual_store";

export type WorkerRegistration = {
	type: string;
	queue?: string;
	concurrency?: number;
	handler: (job: Job) => Promise<void>;
};

export const reeqa_workers: WorkerRegistration[] = [
	{
		// Execute a QA suite run: spawn its command, stream output into
		// runs.json, mark passed/failed/canceled. Concurrency 1 keeps runs
		// single-flight, mirroring the store's own guard.
		type: "reeqa_suite_run",
		concurrency: 1,
		handler: async (job) => {
			const { run_id } = job.payload as { run_id: string; };
			await execute_command_run(run_id);
		},
	},
	{
		// Execute a visual run: headless Chrome capture + vips diff, streaming
		// page results into visual-runs.json. Concurrency 1 = single-flight.
		type: "reeqa_visual_run",
		concurrency: 1,
		handler: async (job) => {
			const { run_id } = job.payload as { run_id: string; };
			await execute_visual_run_job(run_id);
		},
	},
	{
		// Record a narrated evidence video for one changed/new page (Chrome +
		// TTS + ffmpeg). Concurrency 1: it shares Chrome/profile-dir/ffmpeg
		// resources with reeqa_visual_run and is not meant to run in parallel
		// with itself either.
		type: "reeqa_evidence",
		concurrency: 1,
		handler: async (job) => {
			const { run_id, page_id } = job.payload as { run_id: string; page_id: string; };
			await execute_page_evidence_job(run_id, page_id);
		},
	},
	{
		// Record a clean, un-annotated clip for one unchanged (passing) page -
		// mode 3 "recording run" in IN_PROGRESS_reeqa_qa_procedure.md §4.
		// Concurrency 1: shares Chrome/profile-dir/ffmpeg resources with
		// reeqa_visual_run and reeqa_evidence.
		type: "reeqa_recording",
		concurrency: 1,
		handler: async (job) => {
			const { run_id, page_id } = job.payload as { run_id: string; page_id: string; };
			await execute_page_recording_job(run_id, page_id);
		},
	},
	{
		// Cancel a run the server asked to stop: the subprocess lives in THIS
		// worker process, so kill it by run_id. Higher concurrency so a cancel
		// is not blocked behind a running suite job's own fiber.
		type: "reeqa_cancel",
		concurrency: 2,
		handler: async (job) => {
			const { run_id, kind } = job.payload as { run_id: string; kind: "suite" | "visual"; };
			if (kind === "visual") await cancel_visual_run_in_worker(run_id);
			else await cancel_run_in_worker(run_id);
		},
	},
];
