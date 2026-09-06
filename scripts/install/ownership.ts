import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const global_tool_names = ["tailwindcss", "typescript", "libvips", "reettier", "reesql"] as const;

export type global_tool_name = (typeof global_tool_names)[number];

type ownership_receipt = {
	version: 1;
	tools: global_tool_name[];
};

const receipt_dir = join(process.cwd(), ".reepolee");
const receipt_path = join(receipt_dir, "global_prerequisites.json");

function is_global_tool_name(value: unknown): value is global_tool_name {
	return typeof value === "string" && global_tool_names.includes(value as global_tool_name);
}

export async function read_ownership_receipt(): Promise<ownership_receipt> {
	const receipt_file = Bun.file(receipt_path);
	const exists = await receipt_file.exists();
	if (!exists) return { version: 1, tools: [] };

	const parsed: unknown = await receipt_file.json();
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`Invalid prerequisite ownership receipt: ${receipt_path}`);
	}

	const receipt = parsed as { version?: unknown; tools?: unknown; };
	if (receipt.version !== 1 || !Array.isArray(receipt.tools)) {
		throw new Error(`Unsupported prerequisite ownership receipt: ${receipt_path}`);
	}

	for (const tool of receipt.tools) {
		if (!is_global_tool_name(tool)) {
			throw new Error(`Unknown tool in prerequisite ownership receipt: ${String(tool)}`);
		}
	}

	return { version: 1, tools: [...receipt.tools] as global_tool_name[] };
}

async function write_ownership_receipt(receipt: ownership_receipt): Promise<void> {
	await mkdir(receipt_dir, { recursive: true });
	const serialized = JSON.stringify(receipt, null, "\t");
	await Bun.write(receipt_path, `${serialized}\n`);
}

export async function record_global_tool(tool: global_tool_name): Promise<void> {
	const receipt = await read_ownership_receipt();
	if (receipt.tools.includes(tool)) return;
	receipt.tools.push(tool);
	await write_ownership_receipt(receipt);
}

export async function forget_global_tool(tool: global_tool_name): Promise<void> {
	const receipt = await read_ownership_receipt();
	const remaining_tools: global_tool_name[] = [];
	for (const owned_tool of receipt.tools) {
		if (owned_tool !== tool) remaining_tools.push(owned_tool);
	}

	if (remaining_tools.length === 0) {
		const receipt_file = Bun.file(receipt_path);
		const exists = await receipt_file.exists();
		if (exists) await receipt_file.delete();
		return;
	}

	await write_ownership_receipt({ version: 1, tools: remaining_tools });
}
