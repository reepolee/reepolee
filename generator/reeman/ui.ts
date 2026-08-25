#!/usr/bin/env bun
/**
 * UI helpers: colors, prompts, menus
 */

// ---------------------------------------------------------------------------
// Colours / helpers (portable ANSI, degrade gracefully)
// ---------------------------------------------------------------------------

export const CYAN = "\u001b[36m";
export const GREEN = "\u001b[32m";
export const YELLOW = "\u001b[33m";
export const MAGENTA = "\u001b[35m";
export const RED = "\u001b[31m";
export const BOLD = "\u001b[1m";
export const DIM = "\u001b[2m";
export const RESET = "\u001b[0m";

export function color(text: string, code: string): string { return `${code}${text}${RESET}`; }

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escape sequences
const ANSI_PATTERN = /\[[0-9;]*m/g;

// ---------------------------------------------------------------------------
// Visual row counting - render() cursor math must move by actual terminal
// rows, not logical lines. A long label wraps into 2+ rows once its visible
// width (ANSI codes stripped) exceeds the terminal width, which previously
// desynced the cursor-up count and left stale lines stacked on screen.
// ---------------------------------------------------------------------------

function visual_row_count(line: string): number {
	const width = process.stdout.columns || 80;
	const visible_len = line.replace(ANSI_PATTERN, "").length;
	return Math.max(1, Math.ceil(visible_len / width));
}

function total_visual_rows(lines: string[]): number {
	const row_counts = lines.map(visual_row_count);
	return row_counts.reduce((sum, n) => sum + n, 0);
}

export function header(text: string): void {
	const HEADER_W = 3;
	const rule = "-".repeat(HEADER_W);
	const pad = Math.max(HEADER_W - text.length, 0);
	const pad_l = Math.floor(pad / 2);
	const pad_r = pad - pad_l;
	console.log(`\n${color(rule, CYAN)}`);
	console.log(`${color(" ".repeat(pad_l) + BOLD + text + " ".repeat(pad_r), CYAN)}`);
	console.log(`${color(rule, CYAN)}\n`);
}

export function dim(text: string): string { return color(text, DIM); }

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cancel signal - thrown by ask/confirm when the user presses Esc,
// so any text input can back out of the current flow to the main menu.
// ---------------------------------------------------------------------------

export class InputCancelled extends Error {
	constructor() { super("Input cancelled by user (Esc)"); }
}

// ---------------------------------------------------------------------------
// Raw line input - reads a line key-by-key (like select_from_list) so Esc is
// seen immediately. Returns the entered text, or null when cancelled via Esc.
// ---------------------------------------------------------------------------

function read_line_raw(): Promise<string | null> {
	const was_raw = (process.stdin as any).isRaw;
	process.stdin.setRawMode?.(true);
	process.stdin.resume();

	let line = "";

	return new Promise((resolve) => {
		const on_data = (data: Buffer) => {
			const key = data.toString("utf-8");

			if (key === "\u0003") {
				// Ctrl+C - exit
				cleanup();
				process.exit(1);
			}

			// Escape (standalone \x1b, not part of a sequence) - cancel input
			if (key === "\u001b" && data.length === 1) {
				cleanup();
				process.stdout.write("\n");
				resolve(null);
				return;
			}

			// Ignore other escape sequences (arrow keys, etc.)
			if (key.includes("\u001b")) return;

			for (const ch of key) {
				if (ch === "\r" || ch === "\n") {
					cleanup();
					process.stdout.write("\n");
					resolve(line);
					return;
				}
				if (ch === "\u007f" || ch === "\b") {
					if (line.length > 0) {
						line = line.slice(0, -1);
						process.stdout.write("\b \b");
					}
					continue;
				}
				if (ch < " ") continue; // skip other control characters
				line += ch;
				process.stdout.write(ch);
			}
		};

		function cleanup() {
			process.stdin.removeListener("data", on_data);
			process.stdin.setRawMode?.(was_raw);
			process.stdin.pause();
		}

		process.stdin.on("data", on_data);
	});
}

export async function ask(question: string, default_val = ""): Promise<string> {
	const suffix = default_val ? ` [${default_val}]` : "";
	process.stdout.write(`${color("?", YELLOW)} ${question}${dim(suffix)} `);
	const line = await read_line_raw();
	if (line === null) throw new InputCancelled();
	return line.trim() || default_val;
}

export async function confirm(question: string, default_val = "n"): Promise<boolean> {
	const suffix = default_val === "y" ? "Y/n" : "y/N";
	process.stdout.write(`${color("?", YELLOW)} ${question} ${dim(`(${suffix})`)} `);
	const line = await read_line_raw();
	if (line === null) throw new InputCancelled();
	const val = line.trim().toLowerCase() || default_val;
	return val === "y" || val === "yes" || val === "1";
}

// ---------------------------------------------------------------------------
// Select from list (arrow keys + enter, returns the chosen value).
// Escape throws InputCancelled so it cannot be confused with a valid empty value.
// ---------------------------------------------------------------------------

export async function select_from_list(prompt: string, items: { value: string; label: string; }[]): Promise<string> {
	if (items.length === 0) return "";

	let cursor = 0;
	let done = false;
	let prev_row_count = 0;

	// Enable raw mode for key-by-key input
	const was_raw = (process.stdin as any).isRaw;
	process.stdin.setRawMode?.(true);
	process.stdin.resume();

	// Hide cursor
	process.stdout.write("\u001b[?25l");

	function render() {
		const plain_lines = [`  ${prompt}`];
		for (let i = 0; i < items.length; i++) { plain_lines.push(`  x ${items[i]!.label}`); }
		plain_lines.push("  nav");

		if (prev_row_count > 0) {
			process.stdout.write(`\x1B[${prev_row_count}A\x1B[J`);
		}
		prev_row_count = total_visual_rows(plain_lines);

		process.stdout.write(`  ${color(BOLD + prompt, CYAN)}\n`);
		for (let i = 0; i < items.length; i++) {
			const pointer = i === cursor ? `${color("❯", CYAN)}` : " ";
			process.stdout.write(`  ${pointer} ${items[i]!.label}\n`);
		}
		process.stdout.write(`  ${dim("↑↓ navigate  ⏎ confirm  Esc back")}\n`);
	}

	// Initial render
	render();

	return new Promise(
		(resolve, reject) => {
			const on_data = (data: Buffer) => {
				const key = data.toString("utf-8");

				if (key === "\u0003") {
					// Ctrl+C - exit
					cleanup();
					process.exit(1);
				}

				if (done) return;

				if (key === "\r" || key === "\n") {
					// Enter - confirm selection
					done = true;
					cleanup();
					process.stdout.write(`\n`);
					resolve(items[cursor]!.value);
					return;
				}

				// Escape (standalone \x1B, not part of arrow seq) - cancel input
				if (key === "\u001b" && data.length === 1) {
					done = true;
					cleanup();
					process.stdout.write(`\n`);
					reject(new InputCancelled());
					return;
				}

				// Arrow keys emit escape sequences: \x1B[A (up), \x1B[B (down) - wrap around
				if (key === "\u001b[A") {
					cursor = (cursor - 1 + items.length) % items.length;
					render();
					return;
				}

				if (key === "\u001b[B") {
					cursor = (cursor + 1) % items.length;
					render();
					return;
				}
			};

			function cleanup() {
				process.stdin.removeListener("data", on_data);
				process.stdin.setRawMode?.(was_raw);
				process.stdin.pause();
				process.stdout.write("\u001b[?25h");
			}

			process.stdin.on("data", on_data);
		},
	);
}

// ---------------------------------------------------------------------------
// Multi-select with interactive checkboxes (arrow keys + space + enter).
// Escape throws InputCancelled so it cannot be confused with no selections.
// Enter with nothing toggled resolves to the item under the pointer, so the
// list can be driven as a single-select without touching space first.
// ---------------------------------------------------------------------------

export async function multi_select<T>(prompt: string, items: { value: T; label: string; }[]): Promise<T[]> {
	if (items.length === 0) return [];

	const checked = new Set<number>();
	let cursor = 0;
	let done = false;
	let prev_row_count = 0;

	// Enable raw mode for key-by-key input
	const was_raw = (process.stdin as any).isRaw;
	process.stdin.setRawMode?.(true);
	process.stdin.resume();

	// Hide cursor
	process.stdout.write("\u001b[?25l");

	function render() {
		const plain_lines = [`  ${prompt}`];
		for (let i = 0; i < items.length; i++) { plain_lines.push(`  x x ${items[i]!.label}`); }
		plain_lines.push("  nav");

		if (prev_row_count > 0) {
			// Move cursor up to the start of the widget and clear
			process.stdout.write(`\x1B[${prev_row_count}A\x1B[J`);
		}
		prev_row_count = total_visual_rows(plain_lines);

		// Re-render
		process.stdout.write(`  ${color(BOLD + prompt, CYAN)}\n`);
		for (let i = 0; i < items.length; i++) {
			const pointer = i === cursor ? `${color("❯", CYAN)}` : " ";
			const mark = checked.has(i) ? `${color("●", GREEN)}` : `${color("○", DIM)}`;
			process.stdout.write(`  ${pointer} ${mark} ${items[i]!.label}\n`);
		}
		process.stdout.write(`  ${dim("↑↓ navigate  ␣ toggle  ⏎ confirm  Ctrl+A select all  Esc back")}\n`);
	}

	// Initial render
	render();

	return new Promise(
		(resolve, reject) => {
			const on_data = (data: Buffer) => {
				const key = data.toString("utf-8");

				if (key === "\u0003") {
					// Ctrl+C - exit
					cleanup();
					process.exit(1);
				}

				if (done) return;

				if (key === "\r" || key === "\n") {
					// Enter - confirm selection. With nothing toggled, take the row
					// under the pointer: pressing enter on a highlighted item should
					// pick it rather than resolve to nothing.
					done = true;
					cleanup();
					const chosen = checked.size > 0 ? [...checked] : [cursor];
					const selected = chosen.map((i) => items[i]!.value);
					process.stdout.write(`\n`);
					resolve(selected);
					return;
				}

				// Escape (standalone \x1B, not part of arrow seq) - cancel input
				if (key === "\u001b" && data.length === 1) {
					done = true;
					cleanup();
					process.stdout.write(`\n`);
					reject(new InputCancelled());
					return;
				}

				if (key === "\u0001") {
					// Ctrl+A - select all
					if (checked.size === items.length) {
						// Already all selected - deselect all
						checked.clear();
					} else {
						// Select all
						for (let i = 0; i < items.length; i++) {
							checked.add(i);
						}
					}
					render();
					return;
				}

				if (key === " ") {
					// Space - toggle current item
					if (checked.has(cursor)) {
						checked.delete(cursor);
					} else {
						checked.add(cursor);
					}
					render();
					return;
				}

				// Arrow keys emit escape sequences: \x1B[A (up), \x1B[B (down) - wrap around
				if (key === "\u001b[A") {
					cursor = (cursor - 1 + items.length) % items.length;
					render();
					return;
				}

				if (key === "\u001b[B") {
					cursor = (cursor + 1) % items.length;
					render();
					return;
				}
			};

			function cleanup() {
				process.stdin.removeListener("data", on_data);
				process.stdin.setRawMode?.(was_raw);
				process.stdin.pause();
				// Show cursor
				process.stdout.write("\u001b[?25h");
			}

			process.stdin.on("data", on_data);
		},
	);
}

// ---------------------------------------------------------------------------
// Wait for user to press Enter/Esc before continuing (so they can see output)
// Both keys proceed — Esc does NOT cancel the flow here, since this is just
// an acknowledgement prompt shown after an action is already complete.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pending CLI command(s) - stashed by show_cli_tip(s) so the acknowledgement
// prompt (press_enter) can offer a "copy" action. We never touch the system
// clipboard automatically; the user has to press the copy key on purpose.
// ---------------------------------------------------------------------------

let pending_copy: string[] = [];

export async function press_enter(): Promise<void> {
	const was_raw = (process.stdin as any).isRaw;
	process.stdin.setRawMode?.(true);
	process.stdin.resume();

	function prompt(): void {
		const copy_hint =
			pending_copy.length > 0
				? ` ${dim("·")} ${color("[c]", CYAN)}${dim(` copy command${pending_copy.length === 1 ? "" : "s"}`)}`
				: "";
		process.stdout.write(`${dim("Press Enter to continue...")}${copy_hint} `);
	}

	prompt();

	return new Promise((resolve) => {
		const on_data = (data: Buffer) => {
			const key = data.toString("utf-8");

			if (key === "\u0003") {
				// Ctrl+C - exit
				cleanup();
				process.exit(1);
			}

			// c/C - copy the pending CLI command(s) to the clipboard. This is the
			// "button": an explicit keypress, so we only overwrite the clipboard
			// when the user asks. Stays on the prompt afterwards.
			if ((key === "c" || key === "C") && pending_copy.length > 0) {
				const n = pending_copy.length;
				const ok = copy_to_clipboard(pending_copy.join("\n"));
				const note = ok
					? `${color("✓", GREEN)} ${dim(`copied ${n} command${n === 1 ? "" : "s"} to clipboard`)}`
					: `${color("✗", RED)} ${dim("this terminal does not support clipboard copy (OSC 52)")}`;
				process.stdout.write(`\n  ${note}\n`);
				prompt();
				return;
			}

			// Standalone Esc - proceed (same as Enter)
			if (key === "\u001b" && data.length === 1) {
				cleanup();
				process.stdout.write("\n");
				resolve();
				return;
			}

			// Ignore other escape sequences (arrow keys, etc.) so they don't hang
			if (key.includes("\u001b")) return;

			// Enter - proceed
			if (key === "\r" || key === "\n") {
				cleanup();
				process.stdout.write("\n");
				resolve();
				return;
			}

			// Ignore any other key presses
		};

		function cleanup() {
			pending_copy = [];
			process.stdin.removeListener("data", on_data);
			process.stdin.setRawMode?.(was_raw);
			process.stdin.pause();
		}

		process.stdin.on("data", on_data);
	});
}

// ---------------------------------------------------------------------------
// Clipboard - the terminal equivalent of a "copy" button. OSC 52 asks the
// terminal emulator to place text on the system clipboard; works locally and
// over SSH, and degrades silently in terminals that ignore the sequence.
// Returns false (a no-op) when stdout is not a TTY, so the escape sequence is
// never leaked into piped/redirected output.
// ---------------------------------------------------------------------------

export function copy_to_clipboard(text: string): boolean {
	if (!process.stdout.isTTY) return false;
	const payload = Buffer.from(text, "utf8").toString("base64");
	// OSC 52: ESC ] 52 ; c ; <base64> BEL - asks the terminal to set the clipboard.
	process.stdout.write(`\u001b]52;c;${payload}\u0007`);
	return true;
}

// ---------------------------------------------------------------------------
// CLI tip - show the equivalent CLI command after a reeman action completes.
// The command is stashed so the following press_enter() prompt can offer to
// copy it; printing here has no clipboard side effect.
//
// `log_cmds` optionally supplies the sh/ps1 variants to persist when they
// differ from what's printed on screen (e.g. a SQLite/MySQL command, where
// PowerShell has no `<` redirection). When omitted, the printed command is
// logged verbatim to both files - true for plain `bun generator/...` calls.
// ---------------------------------------------------------------------------

// Returns the log-write promise (not typed Promise<void> in the signature so
// existing fire-and-forget callers can keep ignoring it) - non-interactive
// callers that immediately process.exit() after must await it, since the
// write is otherwise still in flight when the interactive flow's press_enter()
// would normally have given it time to finish.
export function show_cli_tip(cmd: string, label?: string, log_cmds?: { sh: string; ps1: string; }): Promise<void> {
	pending_copy = [cmd];
	console.log(`  ${dim("-".repeat(50))}`);
	console.log(`  ${color("💡", YELLOW)} CLI equivalent: ${color(BOLD + cmd, CYAN)}`);
	console.log(`  ${dim("-".repeat(50))}`);
	console.log();
	const sh_cmd = log_cmds?.sh ?? cmd;
	const ps1_cmd = log_cmds?.ps1 ?? cmd;
	return append_reeman_log([sh_cmd], [ps1_cmd], label).catch((err) => console.error(`  ${color("✗", RED)} ${dim(`failed to log command to ${REEMAN_SH_PATH}/${REEMAN_PS1_PATH}:`)}`, err));
}

/**
 * Same as show_cli_tip(), but for a batch of commands (bulk/nested flows) -
 * one line per command instead of cramming them onto a single "CLI equivalent:" line.
 */
export function show_cli_tips(cmds: string[], label?: string): Promise<void> {
	pending_copy = [...cmds];
	console.log(`  ${dim("-".repeat(50))}`);
	console.log(`  ${color("💡", YELLOW)} CLI equivalent (run later to reproduce):`);
	for (const cmd of cmds) { console.log(`    ${color(BOLD + cmd, CYAN)}`); }
	console.log(`  ${dim("-".repeat(50))}`);
	console.log();
	return append_reeman_log(cmds, cmds, label).catch((err) => console.error(`  ${color("✗", RED)} ${dim(`failed to log commands to ${REEMAN_SH_PATH}/${REEMAN_PS1_PATH}:`)}`, err));
}

// ---------------------------------------------------------------------------
// Command log - every CLI-equivalent command shown during this reeman session
// is appended to BOTH .reepolee/reeman.sh (bash/macOS/Linux) and
// .reepolee/reeman.ps1 (Windows), one per line, so the whole session can be
// replayed later on any platform with `bash .reepolee/reeman.sh` or
// `pwsh .reepolee/reeman.ps1` - whichever lines are needed for the target OS.
// Most commands (e.g. `bun generator/...`) are shell-agnostic and identical
// in both files; DB-CLI commands differ (PowerShell has no `<` redirection).
// ---------------------------------------------------------------------------

const REEMAN_SH_PATH = ".reepolee/reeman.sh";
const REEMAN_PS1_PATH = ".reepolee/reeman.ps1";

async function append_to_log(path: string, cmds: string[], label: string | undefined, shebang: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(".reepolee", { recursive: true });
	const log_file = Bun.file(path);
	const exists = await log_file.exists();
	const prefix = exists ? "" : shebang;
	const comment = label ? `# ${label}\n` : "";
	const cmd_lines = cmds.length > 0 ? `${cmds.join("\n")}\n` : "";
	const lines = `${comment}${cmd_lines}`;
	await Bun.write(log_file, prefix + (exists ? await log_file.text() : "") + lines);
}

async function append_reeman_log(sh_cmds: string[], ps1_cmds: string[], label?: string): Promise<void> {
	await Promise.all([
		append_to_log(REEMAN_SH_PATH, sh_cmds, label, "#!/usr/bin/env bash\n"),
		append_to_log(REEMAN_PS1_PATH, ps1_cmds, label, ""),
	]);
}

/**
 * Log a reeman action that has no CLI-equivalent command (e.g. interactive-only
 * destructive actions like remove_route or config edits like set_db_type) - writes
 * just a "# label" comment line to both .reepolee/reeman.sh and .reepolee/reeman.ps1,
 * no command to run.
 */
export function log_action(label: string): Promise<void> {
	return append_reeman_log([], [], label).catch((err) => console.error(`  ${color("✗", RED)} ${dim(`failed to log action to ${REEMAN_SH_PATH}/${REEMAN_PS1_PATH}:`)}`, err));
}

/**
 * Silently append a command to the reeman replay log without printing the
 * "CLI equivalent" box - for the bun reeman <subcommand> CLI, where the user
 * already typed the command themselves and doesn't need it echoed back.
 */
export function log_command(cmd: string, label?: string): Promise<void> {
	return append_reeman_log([cmd], [cmd], label).catch((err) => console.error(`  ${color("✗", RED)} ${dim(`failed to log command to ${REEMAN_SH_PATH}/${REEMAN_PS1_PATH}:`)}`, err));
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Grouped menu - two-level: groups first, then sub-options within a group
// ---------------------------------------------------------------------------

export interface MenuGroup {
	label: string;
	description: string;
	options: { cmd: string; label: string; description: string; }[];
}

/**
 * Show a two-level grouped menu:
 * 1. Groups are shown as an interactive selectable list (arrow keys).
 * 2. After selecting a group, its sub-options are shown via select_from_list (arrow keys).
 *
 * Esc at group level returns "" (caller handles, typically back to main loop).
 * Esc at submenu level -> loops back to group selection (no return to caller).
 *
 * @returns The selected command string, or "" if user escaped at group level.
 */
export async function show_grouped_menu(title: string, groups: MenuGroup[]): Promise<string> {
	if (groups.length === 0) return "";

	// Build group-level items for select_from_list
	const group_items = groups.map((g, i) => ({
		value: String(i),
		label: `${color(BOLD + g.label, MAGENTA)} - ${dim(g.description)}`,
	}));

	let group_idx_str = "";
	try {
		group_idx_str = await select_from_list(title, group_items);
	} catch (error) {
		if (error instanceof InputCancelled) return "";
		throw error;
	}

	const group_idx = parseInt(group_idx_str, 10);
	let group = groups[group_idx];
	if (!group || group.options.length === 0) return "";

	// Show sub-options within the group.
	// Loop on Esc so user goes back to group selection instead of exiting the reeman.
	while (true) {
		const sub_items = group.options.map((opt) => ({
			value: opt.cmd,
			label: `${color(BOLD + opt.label, CYAN)} ${dim(opt.description)}`,
		}));

		let choice = "";
		try {
			choice = await select_from_list(group.label, sub_items);
		} catch (error) {
			if (error instanceof InputCancelled) {
				choice = "";
			} else {
				throw error;
			}
		}
		if (choice !== "") return choice; // confirmed a command

		// Esc from submenu - go back to group selection
		let back_idx = "";
		try {
			back_idx = await select_from_list(title, group_items);
		} catch (error) {
			if (error instanceof InputCancelled) return "";
			throw error;
		}

		// User selected a (possibly different) group - update reference and loop
		const bg = groups[parseInt(back_idx, 10)];
		if (!bg || bg.options.length === 0) return "";
		group = bg;
	}
}
