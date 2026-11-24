import { notify_evidence_ready as broadcast_evidence_ready, notify_recording_ready as broadcast_recording_ready } from "$lib/livereload";

function reeqa_port(): string | null {
	const port = Bun.env.REEQA_PORT?.trim();
	return port && port !== "N/A" ? port : null;
}

/**
 * Tell connected ReeQA browsers that an evidence video for a page finished
 * (or failed), so an open report page swaps its "recording" notice for the
 * video in place.
 *
 * The evidence job runs in the queue worker (a separate process with no
 * WebSocket clients of its own) or in-process as a fallback. So this both
 * broadcasts directly (covers the in-process case) and POSTs the ReeQA server,
 * which broadcasts on its own connections (covers the worker case). Best-effort
 * and never awaited by the caller - a transient failure must not fail the run.
 */
export function notify_evidence_ready(run_id: string, page_id: string, video_path?: string, error?: string): void {
	broadcast_evidence_ready(run_id, page_id, video_path, error);
	// The worker and server are co-located, so localhost is the correct target
	// (SERVER_NAME may be a public hostname that routes out and back).
	const port = reeqa_port();
	if (!port) return;
	const params = new URLSearchParams({ run_id, page_id });
	if (video_path) params.set("video_path", video_path);
	if (error) params.set("error", error);
	void fetch(`http://localhost:${port}/__reeqa_evidence_ready`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	}).catch(() => {});
}

/**
 * Tell connected ReeQA browsers that a recording clip for a page finished (or
 * failed) - the mode-3 sibling of notify_evidence_ready, same broadcast +
 * relay-POST double path for the in-process vs. worker-process cases.
 */
export function notify_recording_ready(run_id: string, page_id: string, recording_path?: string, error?: string): void {
	broadcast_recording_ready(run_id, page_id, recording_path, error);
	const port = reeqa_port();
	if (!port) return;
	const params = new URLSearchParams({ run_id, page_id });
	if (recording_path) params.set("recording_path", recording_path);
	if (error) params.set("error", error);
	void fetch(`http://localhost:${port}/__reeqa_recording_ready`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	}).catch(() => {});
}
