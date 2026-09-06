import { feature_enabled } from "$lib/helpers";
import type { Middleware } from "$lib/middleware/types";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SIGNAL_TIMEOUT_MS = 1_000;

export type PublisherFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

function response_confirms_mutation(response: Response): boolean {
	const is_created = response.status === 201;
	const is_no_content = response.status === 204;
	const is_redirect = response.status >= 300 && response.status < 400;
	return is_created || is_no_content || is_redirect;
}

/**
 * Whether the paired Ree-web Publisher is expected to be reachable.
 *
 * The URL alone is not enough of a gate: a developer keeps REEWEB_PUBLISHER_URL
 * in .env while the publisher itself is usually not running, so every mutation
 * logs a connection warning. REEWEB_PUBLISHER_ENABLED is the explicit opt-in.
 */
export function publisher_enabled(): boolean { return feature_enabled("REEWEB_PUBLISHER_ENABLED"); }

export async function send_publisher_signal(
	publisher_url: string | undefined = Bun.env.REEWEB_PUBLISHER_URL,
	fetcher: PublisherFetch = fetch,
	enabled: boolean = publisher_enabled(),
): Promise<void> {
	if (!enabled) return;

	const signal_url = publisher_url?.trim();
	if (!signal_url) return;

	try {
		const signal = AbortSignal.timeout(SIGNAL_TIMEOUT_MS);
		await fetcher(signal_url, {
			method: "POST",
			signal,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[publisher] Render signal failed: ${message}`);
	}
}

export function publisher_signal_mw(
	send_signal: () => Promise<void> = send_publisher_signal,
): Middleware {
	return async (req, next) => {
		const response = await next(req);
		const is_mutation = MUTATION_METHODS.has(req.method);
		const mutation_completed = response_confirms_mutation(response);

		if (is_mutation && mutation_completed) { await send_signal(); }

		return response;
	};
}
