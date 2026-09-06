// The locale tab switcher itself is pure CSS (radio inputs + :has()). Two
// small client behaviors sit on top of it:
// - remembering the last locale tab used, so it stays selected on the next
//   page load - written as a plain cookie, read back by
//   build_localization_props() when the form is next rendered.
// - double-clicking a tab label applies that locale to every localized
//   field on the form at once, not just the one it belongs to.
document.addEventListener("change", (event) => {
	const radio = event.target.closest("[data-localized-tab]");
	if (!radio) return;
	document.cookie = `preferred_locale=${encodeURIComponent(radio.value)};path=/;max-age=31536000;samesite=lax`;
});

// A locale reset button is a submitter so its formaction and name/value pair
// are preserved when it is clicked. Keep it out of the form's implicit-submit
// path: pressing Enter in a locale input must activate the primary Save action.
document.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" || event.isComposing) return;

	const input = event.target;
	if (!(input instanceof HTMLInputElement) || input.type === "hidden" || input.type === "radio") return;

	const form = input.form;
	if (!form?.matches("[data-localized-form]")) return;

	const save_button = form.querySelector("#btn-submit");
	if (!(save_button instanceof HTMLButtonElement) || save_button.disabled) return;

	event.preventDefault();
	save_button.click();
});

document.addEventListener("dblclick", (event) => {
	const label = event.target.closest(".localized-tab-label");
	if (!label) return;
	const form = label.closest("form");
	if (!form) return;

	const locale = label.dataset.locale;
	for (const radio of form.querySelectorAll(`[data-localized-tab][value="${CSS.escape(locale)}"]`)) {
		radio.checked = true;
		radio.dispatchEvent(new Event("change", { bubbles: true }));
	}
});
