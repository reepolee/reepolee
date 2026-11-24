const count_result = Bun.spawnSync([
	"git",
	"rev-list",
	"main..develop",
	"--count",
]);
const commit_count = parseInt(count_result.stdout.toString().trim(), 10);

console.log(`Commits ahead of main: ${commit_count}`);

if (commit_count === 0) {
	console.log("Nothing to ship.");
	process.exit(0);
}

const checkout_main = Bun.spawnSync(["git", "checkout", "main"], {
	stdout: "inherit",
	stderr: "inherit",
});
if (checkout_main.exitCode !== 0) process.exit(checkout_main.exitCode);

if (commit_count > 1) {
	console.log("Squash merging develop into main...");
	const squash = Bun.spawnSync(["git", "merge", "--squash", "develop"], {
		stdout: "inherit",
		stderr: "inherit",
	});
	if (squash.exitCode !== 0) process.exit(squash.exitCode);

	const commit = Bun.spawnSync(["git", "commit"], {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});
	if (commit.exitCode !== 0) process.exit(commit.exitCode);
} else {
	console.log("Fast-forward merging develop into main...");
	const merge = Bun.spawnSync(["git", "merge", "--ff-only", "develop"], {
		stdout: "inherit",
		stderr: "inherit",
	});
	if (merge.exitCode !== 0) process.exit(merge.exitCode);
}

console.log("Pushing main...");
const push_main = Bun.spawnSync(["git", "push", "origin", "main"], {
	stdout: "inherit",
	stderr: "inherit",
});
if (push_main.exitCode !== 0) process.exit(push_main.exitCode);

const checkout_develop = Bun.spawnSync(["git", "checkout", "develop"], {
	stdout: "inherit",
	stderr: "inherit",
});
if (checkout_develop.exitCode !== 0) process.exit(checkout_develop.exitCode);

console.log("Syncing develop with main...");
const reset = Bun.spawnSync(["git", "reset", "--hard", "main"], {
	stdout: "inherit",
	stderr: "inherit",
});
if (reset.exitCode !== 0) process.exit(reset.exitCode);

console.log("Pushing develop...");
const push_develop = Bun.spawnSync(
	["git", "push", "--force-with-lease", "origin", "develop"],
	{
		stdout: "inherit",
		stderr: "inherit",
	},
);

process.exit(push_develop.exitCode);
