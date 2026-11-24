// The dev issue reporter dialog (lib/issue_reporter_client.js, Ctrl+Shift+I)
// holds an in-progress draft (title, description, screenshot). A livereload-
// triggered page reload would discard it, so when the dialog is open we defer
// the reload until it closes (issue #123). The dialog element only exists
// after the reporter was first opened, so a missing element means no draft to
// protect and the reload proceeds normally.
let reload_pending = false;

// Announce an incoming reload so the page flicker is expected rather than
// startling. Styles are inline: a reload can fire before the stylesheet is
// re-fetched, and this must render identically either way.
function show_reload_banner() {
	if (document.getElementById("livereload-banner")) return;
	const banner = document.createElement("div");
	banner.id = "livereload-banner";
	banner.textContent = "Reloading…";
	banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;"
		+ "padding:6px 12px;text-align:center;font:12px system-ui;"
		+ "color:#fff;background:#1f6feb;opacity:0.95";
	document.body.appendChild(banner);
}

function reload_or_defer() {
	if (reload_pending) return;
	const dialog = document.getElementById("issue-reporter-dialog");
	if (dialog && dialog.open) {
		reload_pending = true;
		const on_close = () => {
			reload_pending = false;
			dialog.removeEventListener("close", on_close);
			show_reload_banner();
			location.reload();
		};
		dialog.addEventListener("close", on_close);
		return;
	}
	show_reload_banner();
	location.reload();
}

function connectLiveReload() {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(
		`${protocol}//${window.location.host}/__reload`,
	);
	let was_open = false;

	ws.onopen = () => was_open = true;

	ws.onmessage = (event) => {
		try {
			const data = JSON.parse(event.data);
			if (data.type === "reload") { reload_or_defer(); }
		} catch {}
	};

	ws.onerror = () => {};

	ws.onclose = () => {
		if (was_open) {
			// Connection was established and then dropped - the server is being
			// restarted (by bun --hot). Reload the page so the
			// browser picks up the new server with fresh changes.
			setTimeout(reload_or_defer, 500);
		} else {
			// Connection never opened - server might still be starting up.
			// Retry until it is ready.
			setTimeout(connectLiveReload, 1000);
		}
	};
}

connectLiveReload();
