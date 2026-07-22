document.addEventListener("click", async (e) => {
	const a = e.target.closest('a[href^="/"]');
	if (!a) return;

	// console.log("🔗 Link clicked:", a.href);

	// Opt out for middle-click, new tab, modifiers
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
		console.log("⏭️ Opting out - modifier key or default prevented");
		return;
	}

	// console.log("✅ SPA loader intercepting navigation");
	e.preventDefault();
	const url = a.href;

	// Show loader
	document.documentElement.classList.add("loading");

	try {
		const res = await fetch(url, { credentials: "same-origin" });
		if (!res.ok) throw new Error(`Navigation failed: ${res.status}`);

		const html = await res.text();
		const doc = new DOMParser().parseFromString(html, "text/html");
		const newTitle = doc.querySelector("title")?.textContent || document.title;

		// Replace body
		document.title = newTitle;
		document.body.replaceWith(doc.body);

		// Re-execute external scripts
		const scripts = document.body.querySelectorAll("script[src]");
		scripts.forEach((script) => {
			const newScript = document.createElement("script");
			newScript.src = script.src;
			newScript.type = script.type;
			script.replaceWith(newScript);
		});

		// Execute inline scripts
		const inlineScripts = document.body.querySelectorAll("script:not([src])");
		inlineScripts.forEach((script) => {
			(() => {
				try {
					eval(script.textContent);
				} catch (err) {
					console.error("Script error:", err);
				}
			})();
		});

		history.pushState({}, newTitle, url);
		// console.log("📄 SPA navigation complete:", url);
	} catch (err) {
		console.error("❌ SPA failed, falling back to full reload:", err);
		window.location.href = url;
	} finally {
		document.documentElement.classList.remove("loading");
	}
});

window.addEventListener("popstate", () => {
	window.location.reload();
});
