import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

export async function home_page(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	return render("home", { ctx });
}
