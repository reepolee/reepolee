class TailwindSize extends HTMLElement {
	static get observedAttributes() {
		return ["one-line"];
	}

	connectedCallback() {
		this.resize_handler = () => this.render();
		window.addEventListener("resize", this.resize_handler);
		this.render();
	}

	disconnectedCallback() {
		window.removeEventListener("resize", this.resize_handler);
	}

	attributeChangedCallback() {
		this.render();
	}

	render() {
		const inner_width = window.innerWidth;
		const inner_height = window.innerHeight;
		const outer_width = window.outerWidth;
		const outer_height = window.outerHeight;

		if (inner_width === 0) {
			this.innerHTML = "";
			return;
		}

		const one_line = this.hasAttribute("one-line");
		const is_portrait = window.matchMedia("(orientation: portrait)").matches;
		const has_touch = navigator.maxTouchPoints > 0;
		const can_hover = window.matchMedia("(hover: hover)").matches;
		const zoom_percent = Math.round(window.devicePixelRatio * 100);

		this.innerHTML = `
			<div class="flex items-center gap-1 ${one_line ? "flex-row" : "flex-col"}">
				<div>Outer: ${outer_width} x ${outer_height}</div>
				<div>Inner: ${inner_width} x ${inner_height}</div>
				<div>Zoom: ${zoom_percent}%</div>
				<div class="flex items-center gap-1">
					<span>${is_portrait ? "P" : "L"}</span>
					${has_touch ? "<span>touch</span>" : ""}
					${can_hover ? "<span>hover</span>" : ""}
					<span class="inline-flex sm:hidden">xs</span>
					<span class="hidden sm:inline-flex md:hidden">sm</span>
					<span class="hidden md:inline-flex lg:hidden">md</span>
					<span class="hidden lg:inline-flex xl:hidden">lg</span>
					<span class="hidden xl:inline-flex 2xl:hidden">xl</span>
					<span class="hidden 2xl:inline-flex 3xl:hidden">2xl</span>
					<span class="hidden 3xl:inline-flex">3xl</span>
				</div>
			</div>
		`;
	}
}

customElements.define("tailwind-size", TailwindSize);

class TailwindSizeToggle extends HTMLElement {
	connectedCallback() {
		this.visible = JSON.parse(localStorage.getItem("info-visible") || "false");
		this.key_handler = (event) => {
			if (event.key === "/") this.flip();
		};
		document.addEventListener("keydown", this.key_handler);
		this.render();
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this.key_handler);
	}

	flip() {
		this.visible = !this.visible;
		localStorage.setItem("info-visible", JSON.stringify(this.visible));
		this.render();
	}

	render() {
		if (!this.visible) {
			this.innerHTML = "";
			return;
		}

		this.innerHTML = `
			<button type="button" class="fixed right-4 bottom-4 z-10 rounded-lg bg-black px-4 py-2 text-center text-sm text-white">
				<tailwind-size one-line></tailwind-size>
			</button>
		`;

		this.querySelector("button").addEventListener("click", () => this.flip());
	}
}

customElements.define("tailwind-size-toggle", TailwindSizeToggle);
