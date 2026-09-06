import { existsSync } from "node:fs";

function say_executable(): string {
	const configured = Bun.env.REEQA_SAY_PATH;
	if (configured && existsSync(configured)) return configured;
	const found = Bun.which("say");
	return found ?? "";
}

function chime_file(): string {
	const configured = Bun.env.REEQA_CHIME_PATH;
	if (configured && existsSync(configured)) return configured;
	for (const candidate of ["/System/Library/Sounds/Glass.aiff", "/System/Library/Sounds/Ping.aiff", "/System/Library/Sounds/Sosumi.aiff"]) {
		if (existsSync(candidate)) return candidate;
	}
	return "";
}

function say_args(say: string, message: string): string[] {
	const args = [say];
	const voice = Bun.env.REEQA_TTS_VOICE;
	if (voice) args.push("-v", voice);
	const rate = Bun.env.REEQA_TTS_RATE;
	if (rate) args.push("-r", rate);
	args.push(message);
	return args;
}

/**
 * Speak a run-completion summary aloud (macOS `say`) and, on failure, sound a
 * system chime. Best-effort: never throws, so a missing `say`/`afplay` binary
 * can't break the run pipeline that calls it. The chime plays after the speech
 * so the two don't overlap.
 */
export async function announce_run_complete(message: string, passed: boolean): Promise<void> {
	const say = say_executable();
	if (say) {
		try {
			const proc = Bun.spawn(say_args(say, message), { stdout: "pipe", stderr: "pipe" });
			await proc.exited;
		} catch (error) {
			console.warn(`[reeqa] TTS announcement failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!passed) {
		const chime = chime_file();
		if (chime) {
			try {
				const proc = Bun.spawn(["afplay", chime], { stdout: "pipe", stderr: "pipe" });
				await proc.exited;
			} catch (error) {
				console.warn(`[reeqa] failure chime failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}
