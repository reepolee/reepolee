import { install_reettier } from "./install/reettier";
import { install_reesql } from "./install/reesql";
import { install_tailwind } from "./install/tailwind";
import { install_tsc } from "./install/tsc";
import { install_vips } from "./install/vips";
import { install_zod_types } from "./install/zod_types";
import { set_verbose } from "./install/reporter";
import { record_global_tool, type global_tool_name } from "./install/ownership";

const args = process.argv.slice(2);

// Invoked directly (or via `bun get:reesql`), so show the full per-tool log.
// The installer drives these same functions with verbosity off instead.
set_verbose(true);

const command = args[0];

async function record_added_tool(tool: global_tool_name, detail: string): Promise<void> {
	if (detail === "added") await record_global_tool(tool);
}

switch (command) {
	case "reettier":
		{
			const detail = await install_reettier();
			await record_added_tool("reettier", detail);
			console.log(`[reettier] ${detail}`);
			process.exit(0);
			break;
		}
	case "vips":
		{
			const version_arg = args.find((a) => a.startsWith("--version="));
			const version = version_arg?.split("=")[1] ?? "latest";

			const detail = await install_vips({ version, get_task: `get:${command}` });
			await record_added_tool("libvips", detail);
			console.log(`[vips] ${detail}`);
			process.exit(0);
			break;
		}
	case "reesql":
		{
			const detail = await install_reesql();
			await record_added_tool("reesql", detail);
			console.log(`[reesql] ${detail}`);
			process.exit(0);
			break;
		}
	case "tw":
		{
			const version_arg = args.find((a) => a.startsWith("--version="));
			const version = version_arg?.split("=")[1] ?? "latest";

			const detail = await install_tailwind({ version, get_task: `get:${command}` });
			await record_added_tool("tailwindcss", detail);
			console.log(`[tailwindcss] ${detail}`);
			process.exit(0);
			break;
		}
	case "tsc":
		{
			const version_arg = args.find((a) => a.startsWith("--version="));
			const version = version_arg?.split("=")[1] ?? "latest";

			const detail = await install_tsc({ version, get_task: `get:${command}` });
			await record_added_tool("typescript", detail);
			console.log(`[tsc] ${detail}`);
			process.exit(0);
			break;
		}
	case "zod-types":
		{
			const detail = await install_zod_types();
			console.log(`[zod-types] ${detail}`);
			process.exit(0);
			break;
		}
	default:
		console.log(`
Usage:
  bun scripts/cli.ts vips --version=latest
  bun scripts/cli.ts vips --version=8.15.3
  bun scripts/cli.ts reettier
  bun scripts/cli.ts reesql
  bun scripts/cli.ts tw --version=latest
  bun scripts/cli.ts tw --version=4.3.3
  bun scripts/cli.ts tsc --version=latest
  bun scripts/cli.ts tsc --version=7.0.2
  bun scripts/cli.ts zod-types
		`);
}
