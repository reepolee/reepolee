import { install_reettier } from "./install/reettier";
import { install_reesql } from "./install/reesql";
import { install_tailwind } from "./install/tailwind";
import { install_vips } from "./install/vips";
import { install_zod_types } from "./install/zod_types";
import { set_verbose } from "./install/reporter";

const args = process.argv.slice(2);

// Invoked directly (or via `bun get:reesql`), so show the full per-tool log.
// The installer drives these same functions with verbosity off instead.
set_verbose(true);

const command = args[0];
switch (command) {
	case "reettier":
		{
			const detail = await install_reettier();
			console.log(`[reettier] ${detail}`);
			process.exit(0);
			break;
		}
	case "vips":
		{
			const version_arg = args.find((a) => a.startsWith("--version="));
			const version = version_arg?.split("=")[1] ?? "latest";

			const detail = await install_vips({ version, get_task: `get:${command}` });
			console.log(`[vips] ${detail}`);
			process.exit(0);
			break;
		}
	case "reesql":
		{
			const detail = await install_reesql();
			console.log(`[reesql] ${detail}`);
			process.exit(0);
			break;
		}
	case "tw":
		{
			const version_arg = args.find((a) => a.startsWith("--version="));
			const version = version_arg?.split("=")[1] ?? "latest";

			const detail = await install_tailwind({ version, get_task: `get:${command}` });
			console.log(`[tailwindcss] ${detail}`);
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
  bun scripts/cli.ts zod-types
		`);
}
