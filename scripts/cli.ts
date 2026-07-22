import { install_reettier } from "./install/reettier";
import { install_reesql } from "./install/reesql";
import { install_vips } from "./install/vips";

const args = process.argv.slice(2);

const command = args[0];
switch (command) {
	case "reettier":
		{
			await install_reettier();
			process.exit(0);
			break;
		}
	case "vips":
		{
			const versionArg = args.find((a) => a.startsWith("--version="));
			const version = versionArg?.split("=")[1] ?? "latest";

			await install_vips({ version, get_task: `get:${command}` });
			process.exit(0);
			break;
		}
	case "reesql":
		{
			await install_reesql();
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
		`);
}
