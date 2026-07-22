import type { BunRequest } from "bun";

import type { Middleware } from "./types";

export const timing: Middleware = async (req: BunRequest, next) => {
	const start = performance.now();
	const res = await next(req);
	const ms = (performance.now() - start).toFixed(1);
	const headers = new Headers(res.headers);
	headers.append("Server-Timing", `app;dur=${ms}`);
	return new Response(res.body, { ...res, headers });
};
