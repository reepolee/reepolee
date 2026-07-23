import { existsSync, rmSync } from "node:fs";

if (existsSync(".git")) {
	rmSync(".git", { recursive: true, force: true });
}

process.exit(0);
