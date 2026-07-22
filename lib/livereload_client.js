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
			if (data.type === "reload") { location.reload(); }
		} catch {}
	};

	ws.onerror = () => {};

	ws.onclose = () => {
		if (was_open) {
			// Connection was established and then dropped - the server is being
			// restarted (by bun --hot). Reload the page so the
			// browser picks up the new server with fresh changes.
			setTimeout(() => location.reload(), 500);
		} else {
			// Connection never opened - server might still be starting up.
			// Retry until it is ready.
			setTimeout(connectLiveReload, 1000);
		}
	};
}

connectLiveReload();
