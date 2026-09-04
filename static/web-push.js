(() => {
	const button = document.getElementById("web-push-toggle");
	if (!button) return;
	if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || !window.isSecureContext) {
		button.hidden = true;
		return;
	}

	const csrf_token = () => document.querySelector('meta[name="csrf-token"]')?.content || document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)?.[1] || "";
	const decode_key = (value) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));
	const set_label = (label) => { button.textContent = label; };

	const sync_label = async () => {
		try {
			const registration = await navigator.serviceWorker.getRegistration("/");
			const subscription = await registration?.pushManager.getSubscription();
			if (subscription) set_label(button.dataset.enabledLabel || "Disable notifications");
		} catch {}
	};
	void sync_label();

	button.addEventListener("click", async () => {
		button.disabled = true;
		try {
			const registration = await navigator.serviceWorker.register("/web-push-sw.js", { scope: "/" });
			const existing = await registration.pushManager.getSubscription();
			if (existing) {
				const response = await fetch("/web-push/unsubscribe", {
					method: "POST",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf_token() },
					body: JSON.stringify({ endpoint: existing.endpoint }),
				});
				if (!response.ok) throw new Error("unsubscribe failed");
				await existing.unsubscribe();
				set_label(button.dataset.disabledLabel || "Enable notifications");
				return;
			}

			const key_response = await fetch("/web-push/public-key", { credentials: "same-origin" });
			if (!key_response.ok) throw new Error("push unavailable");
			const { public_key } = await key_response.json();
			if (!public_key) throw new Error("push unavailable");
			const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
			if (permission !== "granted") throw new Error("permission denied");
			const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decode_key(public_key) });
			const response = await fetch("/web-push/subscribe", {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf_token() },
				body: JSON.stringify(subscription.toJSON()),
			});
			if (!response.ok) {
				await subscription.unsubscribe();
				throw new Error("subscribe failed");
			}
			set_label(button.dataset.enabledLabel || "Disable notifications");
		} catch {
			set_label(button.dataset.errorLabel || "Notifications unavailable");
		} finally {
			button.disabled = false;
		}
	});
})();
