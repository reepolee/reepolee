try {
	await Bun.file(".env").stat();
} catch {

	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	const example_text = await Bun.file(".env.example").text();
	const env_text = example_text.replace(/^TIME_ZONE=.*$/m, `TIME_ZONE=${tz}`);

	await Bun.write(".env", env_text);
}

const folder_name = import.meta.dir.split("/").at(-2) ?? import.meta.dir.split("\\").at(-2);
if (folder_name) {
	const pkg = await Bun.file("package.json").json();
	if (pkg.name !== folder_name) {
		pkg.name = folder_name;
		await Bun.write("package.json", JSON.stringify(pkg, null, "\t") + "\n");
	}
}

process.exit(0);
