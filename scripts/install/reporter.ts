/**
 * Install-time console reporter.
 *
 * The bootstrap runs many child scripts that each log in their own format (or
 * not at all). This gives them one voice: a single line per step that starts as
 * one completed line per step after the bootstrap succeeds.
 *
 * Child output is captured, not inherited, so it can be withheld on success and
 * replayed verbatim on failure. `--verbose` turns the capture off entirely and
 * restores the raw pass-through behaviour for debugging.
 */

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const LABEL_WIDTH = 18;

let is_verbose = false;

export function set_verbose(value: boolean): void { is_verbose = value; }

export function get_verbose(): boolean { return is_verbose; }

// Verbose mode keeps children on inherited stdio so their native output streams
// through live; quiet mode pipes so the reporter can hold it back.
export function child_stdio(): "inherit" | "pipe" { return is_verbose ? "inherit" : "pipe"; }

function write(text: string): void { process.stdout.write(text); }

// Only pad when a detail follows, so lines without one carry no trailing space.
function pad_label(label: string, has_detail: boolean): string { return has_detail ? label.padEnd(LABEL_WIDTH) : label; }

export function heading(title: string): void {
	process.stdout.write(`\n${BOLD}${title}${RESET}\n`);
}

export function section(title: string): void {
	write(`\n  ${DIM}${title}${RESET}\n`);
}

/**
 * Begin a step. Quiet mode holds the report until the bootstrap completes;
 * verbose mode streams progress immediately.
 */
export function step_start(label: string): void {
	if (is_verbose) {
		write(`\n${DIM}> installing ${label}${RESET}\n`);
		return;
	}
}

export function step_done(label: string, detail?: string): void {
	const suffix = detail ? ` ${DIM}${detail}${RESET}` : "";
	const line = `  ${GREEN}+${RESET} ${pad_label(label, Boolean(detail))}${suffix}`;
	if (is_verbose) {
		write(`${line}\n`);
		return;
	}
	write(`${line}\n`);
}

export function step_skip(label: string, detail?: string): void {
	const suffix = detail ? ` ${DIM}${detail}${RESET}` : "";
	const line = `  ${DIM}-${RESET} ${pad_label(label, Boolean(detail))}${suffix}`;
	if (is_verbose) {
		write(`${line}\n`);
		return;
	}
	write(`${line}\n`);
}

/**
 * Report a failed step and replay whatever the child printed. In verbose mode
 * the output already streamed through, so it is not repeated.
 */
export function step_fail(label: string, output?: string): void {
	const line = `  ${RED}x${RESET} ${pad_label(label, true)}${RED}failed${RESET}`;
	if (is_verbose) { write(`${line}\n`); return; }
	write(`${line}\n`);

	const trimmed = (output ?? "").trim();
	if (!trimmed) {
		return;
	}

	const lines = trimmed.split("\n");
	for (const out_line of lines) { write(`      ${DIM}${out_line}${RESET}\n`); }
}

export function note(text: string): void {
	write(`  ${DIM}${text}${RESET}\n`);
}

export function success(text: string): void {
	write(`\n${GREEN}${text}${RESET}\n`);
}
