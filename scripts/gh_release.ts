/**
 * gh:release - create a GitHub Release for the current package.json version.
 *
 * Run this inside a public checkout (../reepolee or ../reeweb) after `bun
 * release` has mirrored the source there and it's been committed/pushed -
 * `gh` resolves the target repo from that checkout's git remote.
 */

const pkg = await Bun.file("package.json").json();
const version: string | undefined = pkg.version;
if (!version) {
	console.error("gh:release: no version found in package.json");
	process.exit(1);
}

const tag = `v${version}`;

console.log(`Creating GitHub release ${tag}...`);

// 1. Build release creation arguments
const args = ["gh", "release", "create", tag, "--title", tag, "--generate-notes", "--latest"];

// 2. Create the release
const create_result = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });

process.exit(create_result.exitCode ?? 1);
