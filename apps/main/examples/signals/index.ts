import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

export async function signals_page(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	return render("signals", { ctx });
}
