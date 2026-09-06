import type { Qa_run, Qa_run_status } from "./run_store";
import { iso_datetime } from "./format";

export type Qa_run_view = Qa_run & {
	command_display: string;
	started_display: string;
	duration_display: string;
	status_class: string;
	status_label: string;
};

const status_classes: Record<Qa_run_status, string> = {
	queued: "bg-neutral-200",
	running: "bg-primary text-white",
	canceling: "bg-warning text-white",
	passed: "pill-yes",
	failed: "bg-brand text-white",
	canceled: "bg-neutral-400 text-white",
};

const status_labels: Record<Qa_run_status, string> = {
	queued: "Queued",
	running: "Running",
	canceling: "Canceling",
	passed: "Passed",
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

export function present_run(run: Qa_run): Qa_run_view {
	return {
		...run,
		output: Bun.stripANSI(run.output),
		command_display: run.command.join(" "),
		started_display: iso_datetime(run.started_at),
		duration_display: format_duration(run.duration_ms),
		status_class: status_classes[run.status],
		status_label: status_labels[run.status],
	};
}
