/** Extract a provider-supplied rate-limit delay in milliseconds. */
export function retry_after_ms(headers: Headers, body: string): number | null {
	const retry_after = headers.get("retry-after")?.trim();
	if (retry_after) {
		const seconds = Number(retry_after);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);

		const retry_at = Date.parse(retry_after);
		if (Number.isFinite(retry_at)) return Math.max(0, retry_at - Date.now());
	}

	let retry_seconds: number | null = null;
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const candidates = [parsed, parsed.error].filter((value): value is Record<string, unknown> => value !== null && typeof value === "object");
		for (const candidate of candidates) {
			for (const key of ["retry_after", "retry_after_seconds", "estimated_time"]) {
				const value = candidate[key];
				if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
					retry_seconds = value;
					break;
				}
			}
			if (retry_seconds !== null) break;
		}
	} catch {}

	if (retry_seconds === null) {
		const match = body.match(/(?:retry after|try again (?:in|after)|wait)\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i);
		if (match?.[1]) retry_seconds = Number(match[1]);
	}

	return retry_seconds !== null && Number.isFinite(retry_seconds) ? Math.ceil(retry_seconds * 1000) : null;
}

export function retry_delay_ms(error: { status?: unknown; retry_after_ms?: unknown; }, fallback_ms: number): number {
	if (error.status !== 429 || typeof error.retry_after_ms !== "number" || !Number.isFinite(error.retry_after_ms)) return fallback_ms;
	return Math.max(0, error.retry_after_ms);
}
