import type { BunRequest } from "bun";

import type { Middleware } from "./types";

export const add_cors: Middleware = async (req: BunRequest, next) => {
	const res = await next(req);
	const headers = new Headers(res.headers);
	headers.append("Access-Control-Allow-Origin", "*");
	return new Response(res.body, { ...res, headers });
};
