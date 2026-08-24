import { pathToFileURL } from "node:url";

declare var self: Worker;

type WorkerResult = {
	ok: boolean;
	module_data?: Record<string, unknown>;
	error?: string;
};

const table_module_exports = [
	"columns",
	"fields",
	"global_scopes",
	"grid_filler",
	"indexed_columns",
	"pagination_strategy",
	"parent",
	"render_strategy",
	"route_param",
	"template_tags",
	"v_fields",
] as const;

self.onmessage = async (event: MessageEvent<string>) => {
	try {
		const table_url = pathToFileURL(event.data);
		const table_module = await import(table_url.href);
		const module_data: Record<string, unknown> = {};
		for (const export_name of table_module_exports) {
			module_data[export_name] = table_module[export_name];
		}
		const result: WorkerResult = { ok: true, module_data };
		self.postMessage(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const result: WorkerResult = { ok: false, error: message };
		self.postMessage(result);
	}
};
