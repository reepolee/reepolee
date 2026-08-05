import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

export async function simple_page_page(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const data_path = `${import.meta.dir}/data.json`;
	const records = await Bun.file(data_path).json();
	return render("index", { ctx, data: { records } });
}
