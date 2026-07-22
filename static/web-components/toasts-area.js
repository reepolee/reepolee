class ToastsArea extends HTMLElement {
	constructor() {
		super();

		this.toasts = [];
		this.expiry_timer = null;
	}

	connectedCallback() {
		this.setup_layout();
		this.start_expiry_loop();
	}

	setup_layout() {
		this.style.position = "fixed";
		this.style.bottom = "1rem";

		// center horizontally
		this.style.left = "50%";
		this.style.transform = "translateX(-50%)";

		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.gap = "0.5rem";

		this.style.pointerEvents = "none";

		// optional: keep it above most UI layers
		this.style.zIndex = "9999";
	}

	/* ---------------- API ---------------- */
	add_toast(toast) {
		if (typeof toast === "string") {
			try {
				toast = JSON.parse(toast);
			} catch  {
				// fallback if invalid JSON string
				toast = { message: toast };
			}
		}

		const new_toast = {
			id: toast.id || crypto.randomUUID(),
			type: toast.type || "neutral",
			message: toast.message || "",
			expires_at: Temporal.Now.instant().epochMilliseconds + (toast.duration ?? 3000),
			user: toast.user,
		};

		this.toasts.push(new_toast);

		const index = this.toasts.length - 1;

		setTimeout(() => {
			this.render_toast(new_toast);
		}, index * 80);

		return new_toast;
	}

	remove_toast(id) {
		this.toasts = this.toasts.filter((t) => t.id !== id);

		const el = this.querySelector(`[data-toast-id="${id}"]`);
		if (el) el.remove();
	}

	/* ---------------- render ---------------- */

	render_toast(toast) {
		const el = document.createElement("div");

		el.setAttribute("data-toast-id", toast.id);

		const type_class = this.get_type_class(toast.type);

		const duration = Math.max(0, toast.expires_at - Temporal.Now.instant().epochMilliseconds);

		const rendered_element = `
		<div class="animate-in-top"
		     style="--toast-duration:${duration}ms">

			<div class="relative px-3 py-2 mb-3 ${type_class}
			            font-semibold rounded-sm
			            min-w-96
			            pointer-events-auto">

				<div class="pr-6">
					${toast.message} ${toast.user ? ` (${toast.user})` : ""}
				</div>

				<button
					type="button"
					class="absolute top-1 right-1 
						h-8 w-8
						flex items-center justify-center
						text-lg leading-none
						opacity-70 hover:opacity-100
						hover:bg-black/10
						rounded-full"
					aria-label="Close toast">
					🗙
				</button>

			</div>
		</div>
	`;

		el.innerHTML = rendered_element;

		// click handler for close button
		const close_btn = el.querySelector("button");

		close_btn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.remove_toast(toast.id);
		});

		// optional: click whole toast to dismiss
		el.addEventListener("click", () => {
			this.remove_toast(toast.id);
		});

		this.appendChild(el);
	}

	get_type_class(type) {
		if (type === "green") return "bg-green-600/90 text-white";
		if (type === "red") return "bg-brand/90 text-white";
		if (type === "yellow") return "bg-amber-300/90 text-black";

		return "bg-white text-black border border-neutral-300";
	}

	/* ---------------- expiry loop ---------------- */

	start_expiry_loop() {
		this.expiry_timer = setInterval(() => {
			const now = Temporal.Now.instant().epochMilliseconds;

			const expired = this.toasts.filter((t) => t.expires_at <= now);

			for (const t of expired) {
				this.remove_toast(t.id);
			}
		}, 500);
	}
}

customElements.define("toasts-area", ToastsArea);

window.add_toast = window.add_toast
	|| ((toast) => {
		const el = document.querySelector("toasts-area");

		if (!el) {
			console.warn("<toasts-area></toasts-area> not found");
			return null;
		}

		return el.add_toast(toast);
	});
