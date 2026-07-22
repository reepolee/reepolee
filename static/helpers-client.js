/**
 * Check whether the page is currently in dark mode.
 * Detects both explicit class (cookie-set) and OS preference (auto-detect).
 * Used in layout templates for theme detection.
 */
// eslint-disable-next-line no-unused-vars
function is_dark() {
	return (
		document.documentElement.classList.contains("dark")
		|| (!document.documentElement.classList.contains("light")
			&& window.matchMedia("(prefers-color-scheme: dark)").matches)
	);
}

/**
 * Initialize the theme toggle button: correct icon/logo on load,
 * wire up click handler for toggling dark/light mode.
 */
// eslint-disable-next-line no-unused-vars
function init_theme_toggle() {
	var toggle = document.getElementById("theme-toggle");
	if (!toggle) return;

	// Correct icon and logo on page load (handles auto-detect case)
	toggle.textContent = is_dark() ? "☀️" : "🌙";
	var logo = document.querySelector("nav img[alt='Reepolee logo']");
	if (logo) {
		logo.src = is_dark() ? "/logo-light.svg" : "/logo-dark.svg";
	}

	// Theme toggle with smooth transition
	toggle.addEventListener("click", function() {
		var html = document.documentElement;
		var currently_dark = is_dark();

		// Enable transition for this toggle
		html.classList.add("theme-transitioning");

		// Toggle: remove opposite class, add active class
		html.classList.remove(currently_dark ? "dark" : "light");
		html.classList.add(currently_dark ? "light" : "dark");

		// Swap logo
		var logo = document.querySelector("nav img[alt='Reepolee logo']");
		if (logo) {
			logo.src = currently_dark ? "/logo-dark.svg" : "/logo-light.svg";
		}

		// Persist preference
		document.cookie = `theme=${currently_dark ? "light" : "dark"}; path=/; max-age=31536000; SameSite=Lax`;

		// Update button icon
		this.textContent = currently_dark ? "🌙" : "☀️";

		// Remove transition class after animation completes
		setTimeout(() => {
			html.classList.remove("theme-transitioning");
		}, 300);
	});
}

// eslint-disable-next-line no-unused-vars
function $(selector, root = document) {
	return root.querySelector(selector);
}

// eslint-disable-next-line no-unused-vars
function $$(selector, root = document) {
	return Array.from(root.querySelectorAll(selector));
}

function on_checkbox_changed(should_flip_main_checkbox) {
	const cb_select_all = document.getElementById("select_all");
	const selected_checkboxes = Array.from(document.querySelectorAll('input[name="checkboxes[]"]:checked'));
	const all_checkboxes = Array.from(document.querySelectorAll('input[name="checkboxes[]"]'));
	let main_state = -1;
	const count_all = all_checkboxes.length;
	const count_selected = selected_checkboxes.length;
	main_state = count_selected === 0 ? 0 : main_state;
	main_state = count_selected > 0 && count_selected === count_all ? 1 : main_state;

	if (!should_flip_main_checkbox) return main_state;

	if (main_state === -1) {
		cb_select_all.checked = false;
		cb_select_all.indeterminate = true;
	}

	if (main_state === 0) {
		cb_select_all.checked = false;
		cb_select_all.indeterminate = false;
	}
	if (main_state === 1) {
		cb_select_all.checked = true;
		cb_select_all.indeterminate = false;
	}

	enable_buttons(main_state !== 0);
}

// eslint-disable-next-line no-unused-vars
function on_select_all_changed(_event) {
	const cb_select_all = document.getElementById("select_all");
	const all_checkboxes = Array.from(document.querySelectorAll('input[name="checkboxes[]"]'));

	const main_state = on_checkbox_changed(false);

	if (main_state === -1) {
		all_checkboxes.forEach((e) => (e.checked = !e.checked));
		cb_select_all.indeterminate = true;
	} else {
		all_checkboxes.forEach((e) => (cb_select_all.checked ? (e.checked = true) : (e.checked = false)));
		cb_select_all.indeterminate = false;
	}

	enable_buttons(cb_select_all.checked);
}

function enable_buttons(bool) {
	document.getElementById("action").disabled = !bool;
}

function navigate_to(paramName, value) {
	const params = new URLSearchParams(window.location.search);
	params.delete("after");
	params.delete("before");
	params.delete("last");
	// Reset offset when changing filter/limit/order
	params.delete("offset");
	params.set(paramName, value);
	const url = `${window.location.pathname}?${params.toString()}`;

	const link = document.createElement("a");
	link.href = url;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}
