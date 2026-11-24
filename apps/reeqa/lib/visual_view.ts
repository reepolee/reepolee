import type { Visual_run, Visual_run_status } from "./visual_store";
import { iso_datetime } from "./format";

export type Visual_run_view = Visual_run & {
	started_display: string;
	duration_display: string;
	operation_label: string;
	status_class: string;
	status_label: string;
	changed_count: number;
	new_count: number;
	removed_count: number;
	unchanged_count: number;
	page_selection_label: string;
	capture_size_label: string;
};

const status_classes: Record<Visual_run_status, string> = {
	queued: "bg-neutral-200",
	running: "bg-primary text-white",
	canceling: "bg-warning text-white",
	passed: "pill-yes",
	failed: "bg-brand text-white",
	canceled: "bg-neutral-400 text-white",
};

const status_labels: Record<Visual_run_status, string> = {
	queued: "Queued",
	running: "Running",
	canceling: "Canceling",
	passed: "Complete",
	failed: "Failed",
	canceled: "Canceled",
};

function format_duration(duration_ms: number | undefined): string {
	if (duration_ms === undefined) return "Running";
	const total_seconds = Math.max(0, Math.round(duration_ms / 1000));
	const minutes = Math.floor(total_seconds / 60);
	const seconds = total_seconds % 60;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function present_visual_run(run: Visual_run): Visual_run_view {
	return {
		...run,
		output: Bun.stripANSI(run.output),
		started_display: iso_datetime(run.started_at),
		duration_display: format_duration(run.duration_ms),
		operation_label: run.operation === "baseline" ? "Capture baseline" : "Compare to baseline",
		status_class: status_classes[run.status],
		status_label: status_labels[run.status],
		changed_count: run.pages.filter((page) => page.status === "changed").length,
		new_count: run.pages.filter((page) => page.status === "new").length,
		removed_count: run.pages.filter((page) => page.status === "removed").length,
		unchanged_count: run.pages.filter((page) => page.status === "unchanged").length,
		page_selection_label: run.page_set_name ?? "All baseline pages",
		capture_size_label: run.capture_width === undefined ? "" : `${run.capture_width}×${run.capture_height ?? 1080}`,
	};
}
