self.addEventListener("push", (event) => {
	let payload = {};
	try { payload = event.data ? event.data.json() : {}; } catch {}
	const title = payload.title || "Notification";
	const options = {
		body: payload.message || "",
		data: { link: typeof payload.link === "string" ? payload.link : "/" },
	};
	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const candidate = event.notification.data?.link;
	let link = "/";
	if (typeof candidate === "string") {
		if (candidate.startsWith("/") && !candidate.startsWith("//")) link = candidate;
		else {
			try { if (new URL(candidate).protocol === "https:") link = candidate; } catch {}
		}
	}
	event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
		const same_origin = windows.find((window) => new URL(window.location.href).origin === self.location.origin);
		if (same_origin) return same_origin.focus().then(() => same_origin.navigate(link));
		return clients.openWindow(link);
	}));
});
