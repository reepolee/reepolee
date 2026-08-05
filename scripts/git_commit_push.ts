#!/usr/bin/env bun

import { version } from "../package.json";

if (!version) {
	console.error("package.json does not contain a version");
	process.exit(1);
}

await Bun.$`git add -A`;

const status_result = await Bun.$`git status --porcelain --untracked-files=no`.text();
const has_staged_changes = status_result.trim().length > 0;

if (!has_staged_changes) {
	console.log("Nothing to commit, skipping git:commit-push.");
	process.exit(0);
}

await Bun.$`git commit -m ${`Release ${version}`}`;
await Bun.$`git push`;
