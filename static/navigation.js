(function initialize_navigation() {
	init_theme_toggle();

	const automatic_nav_details = document.querySelectorAll('details[data-nav-module][data-nav-manual="false"], details[data-nav-section][data-nav-manual="false"]');
	for (const automatic_nav_detail of automatic_nav_details) {
		const current_entry = automatic_nav_detail.querySelector("a.current");
		automatic_nav_detail.open = current_entry !== null;
	}

	function close_automatic_nav_siblings(nav_detail) {
		const section_id = nav_detail.dataset.navSection;
		const is_top_level = nav_detail.hasAttribute("data-nav-module") || section_id?.startsWith("root:");
		const sibling_selector = is_top_level
			? 'details[data-nav-module][data-nav-manual="false"], details[data-nav-section^="root:"][data-nav-manual="false"]'
			: `details[data-nav-section^="${CSS.escape(section_id?.split(":")[0] || "") }:"][data-nav-manual="false"]`;
		const sibling_details = document.querySelectorAll(sibling_selector);
		for (const sibling_detail of sibling_details) {
			if (sibling_detail !== nav_detail) sibling_detail.open = false;
		}
	}

	const nav_summaries = document.querySelectorAll("details[data-nav-module] > summary, details[data-nav-section] > summary");
	for (const nav_summary of nav_summaries) {
		nav_summary.addEventListener("click", (event) => {
			const nav_detail = nav_summary.parentElement;
			if (!(nav_detail instanceof HTMLDetailsElement)) return;
			if (nav_detail.dataset.navManual === "true") return;
			event.preventDefault();

			const should_open = !nav_detail.open;
			if (should_open) close_automatic_nav_siblings(nav_detail);
			nav_detail.open = should_open;
		});
	}

	const nav_module_details = document.querySelectorAll("details[data-nav-module]");
	for (const nav_module_detail of nav_module_details) {
		nav_module_detail.addEventListener("toggle", () => {
			const collapsed_modules = Array.from(document.querySelectorAll("details[data-nav-module]:not([open])"), (element) => element.dataset.navModule);
			const cookie_value = encodeURIComponent(JSON.stringify(collapsed_modules));
			document.cookie = `nav_collapsed_modules=${cookie_value}; path=/; max-age=31536000; samesite=lax`;
		});
	}

	const nav_mode_buttons = document.querySelectorAll("button[data-nav-mode-toggle]");
	for (const nav_mode_button of nav_mode_buttons) {
		nav_mode_button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const module_name = nav_mode_button.dataset.navModule;
			const nav_detail = document.querySelector(`details[data-nav-module="${module_name}"]`);
			if (!module_name || !(nav_detail instanceof HTMLDetailsElement)) return;

			const is_manual = nav_detail.dataset.navManual === "true";
			nav_detail.dataset.navManual = String(!is_manual);
			nav_mode_button.setAttribute("aria-pressed", String(!is_manual));
			const mode_label = is_manual ? nav_mode_button.dataset.autoLabel : nav_mode_button.dataset.manualLabel;
			nav_mode_button.setAttribute("aria-label", mode_label || "");
			nav_mode_button.title = mode_label || "";
			nav_mode_button.querySelector("[data-nav-auto-icon]")?.toggleAttribute("hidden", !is_manual);
			nav_mode_button.querySelector("[data-nav-manual-icon]")?.toggleAttribute("hidden", is_manual);

			const manual_modules = Array.from(document.querySelectorAll('details[data-nav-module][data-nav-manual="true"]'), (element) => element.dataset.navModule);
			const cookie_value = encodeURIComponent(JSON.stringify(manual_modules));
			document.cookie = `nav_manual_modules=${cookie_value}; path=/; max-age=31536000; samesite=lax`;

			if (is_manual) nav_detail.open = Boolean(nav_detail.querySelector("a.current"));
		});
	}

	const nav_section_details = document.querySelectorAll("details[data-nav-section]");
	for (const nav_section_detail of nav_section_details) {
		nav_section_detail.addEventListener("toggle", () => {
			const collapsed_sections = Array.from(document.querySelectorAll("details[data-nav-section]:not([open])"), (element) => element.dataset.navSection);
			const cookie_value = encodeURIComponent(JSON.stringify(collapsed_sections));
			document.cookie = `nav_collapsed_sections=${cookie_value}; path=/; max-age=31536000; samesite=lax`;
		});
	}

	const nav_section_mode_buttons = document.querySelectorAll("button[data-nav-section-mode-toggle]");
	for (const nav_section_mode_button of nav_section_mode_buttons) {
		nav_section_mode_button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const section_id = nav_section_mode_button.dataset.navSection;
			const nav_detail = document.querySelector(`details[data-nav-section="${section_id}"]`);
			if (!section_id || !(nav_detail instanceof HTMLDetailsElement)) return;

			const is_manual = nav_detail.dataset.navManual === "true";
			nav_detail.dataset.navManual = String(!is_manual);
			nav_section_mode_button.setAttribute("aria-pressed", String(!is_manual));
			const mode_label = is_manual ? nav_section_mode_button.dataset.autoLabel : nav_section_mode_button.dataset.manualLabel;
			nav_section_mode_button.setAttribute("aria-label", mode_label || "");
			nav_section_mode_button.title = mode_label || "";
			nav_section_mode_button.querySelector("[data-nav-auto-icon]")?.toggleAttribute("hidden", !is_manual);
			nav_section_mode_button.querySelector("[data-nav-manual-icon]")?.toggleAttribute("hidden", is_manual);

			const manual_sections = Array.from(document.querySelectorAll('details[data-nav-section][data-nav-manual="true"]'), (element) => element.dataset.navSection);
			const cookie_value = encodeURIComponent(JSON.stringify(manual_sections));
			document.cookie = `nav_manual_sections=${cookie_value}; path=/; max-age=31536000; samesite=lax`;

			if (is_manual) nav_detail.open = Boolean(nav_detail.querySelector("a.current"));
		});
	}
})();
