document.addEventListener("DOMContentLoaded", () => {
	for (const editor of document.querySelectorAll("[data-localized-editor]")) {
		const form = editor.closest("form");
		if (!form) continue;

		const default_locale = editor.dataset.defaultLocale || "";
		const default_label = editor.dataset.defaultLabel || default_locale;
		const add_label = editor.dataset.addLabel || "Add language";
		const remove_label = editor.dataset.removeLabel || "Remove translation";
		const open_original_label = editor.dataset.openOriginalLabel || "Open original";
		const dialog = form.querySelector("[data-localized-first-language-dialog]");
		const language_target = dialog?.querySelector("[data-localized-dialog-language]");
		const remove_dialog = form.querySelector("[data-localized-remove-dialog]");
		const remove_language_target = remove_dialog?.querySelector("[data-localized-remove-language]");
		const locale_labels = new Map();
		for (const option of editor.querySelectorAll("[data-localized-locale]")) {
			locale_labels.set(option.dataset.localizedLocale, option.dataset.localeLabel || option.dataset.localizedLocale);
		}

		const panels = [...form.querySelectorAll("[data-localized-panel][data-field]")];
		const fields = new Map();
		for (const panel of panels) {
			const field_name = panel.dataset.field;
			if (!fields.has(field_name)) fields.set(field_name, []);
			fields.get(field_name).push(panel);
			locale_labels.set(panel.dataset.locale, panel.dataset.localeLabel || panel.dataset.locale);
		}

		// Every configured locale holds a real row, so every locale is always
		// available - there is no "not yet translated" state to activate out of.
		const activated_locales = new Set(panels.map((panel) => panel.dataset.locale));

		const original_url = new URL(location.href);
		original_url.hash = "original";
		let pending_field = null;
		let pending_locale = "";
		let pending_remove_source = null;
		let pending_remove_locale = "";

		const abbreviation = (locale) => {
			const language = locale.split("-")[0] || locale;
			return language.toUpperCase();
		};

		const source_control = (source) => {
			const column = source.querySelector(":scope > div");
			if (!column) return null;
			return [...column.children].find((child) => child.matches("input, textarea, select, markdown-editor, .input, .image-upload-wrapper")) || null;
		};

		const remember_key = (field_name) => `localized-field:${location.pathname}:${field_name}`;

		const refresh_menu = (source) => {
			const menu = source.querySelector("[data-localized-language-menu]");
			if (!menu) return;
			const existing = new Set([...source.querySelectorAll("[data-localized-language]")].map((button) => button.dataset.locale));
			let has_available_locale = false;
			for (const option of menu.querySelectorAll("[data-localized-add-locale]")) {
				option.hidden = existing.has(option.dataset.locale);
				if (!option.hidden) has_available_locale = true;
			}

			const picker = menu.closest("[data-localized-language-picker]");
			const summary = picker?.querySelector(":scope > summary");
			picker?.classList.toggle("is-disabled", !has_available_locale);
			if (summary) {
				summary.setAttribute("aria-disabled", has_available_locale ? "false" : "true");
				summary.tabIndex = has_available_locale ? 0 : -1;
			}
			if (!has_available_locale && picker) picker.open = false;
		};

		const add_badge = (source, locale) => {
			let button = source.querySelector(`[data-localized-language][data-locale="${CSS.escape(locale)}"]`);
			if (button) return button;
			const languages = source.querySelector("[data-localized-languages]");
			const entry = document.createElement("span");
			entry.className = "localized-language-entry";
			button = document.createElement("button");
			button.type = "button";
			button.className = "localized-language";
			button.dataset.localizedLanguage = "";
			button.dataset.locale = locale;
			button.textContent = abbreviation(locale);
			button.title = locale_labels.get(locale) || locale;
			entry.append(button);
			if (locale !== default_locale) {
				const remove = document.createElement("button");
				remove.type = "button";
				remove.className = "localized-language-remove";
				remove.dataset.localizedRemoveLocale = "";
				remove.dataset.locale = locale;
				remove.textContent = "×";
				remove.title = `${remove_label}: ${locale_labels.get(locale) || locale}`;
				remove.setAttribute("aria-label", remove.title);
				entry.append(remove);
			}
			languages?.append(entry);
			refresh_menu(source);
			return button;
		};

		// "×" resets this locale's value back to the default locale's, rather
		// than deleting an override - every locale always has a row, so there is
		// nothing to remove. The copy happens on save; here it only updates the
		// visible input so the user sees what they are about to store.
		const remove_translation = (source, locale) => {
			if (!locale || locale === default_locale) return;
			const field_name = source.dataset.localizedFieldSource || source.dataset.field;
			const panel = (fields.get(field_name) || []).find((item) => item.dataset.locale === locale);
			if (!panel) return;

			const input = panel.querySelector("[data-localized-value]");
			const original = source_control(source);
			if (input && original && "value" in original) input.value = original.value;

			select_language(source, locale);
		};

		const request_remove_translation = (source, locale) => {
			if (!locale || locale === default_locale) return;
			if (!remove_dialog) return;
			pending_remove_source = source;
			pending_remove_locale = locale;
			if (remove_language_target) remove_language_target.textContent = locale_labels.get(locale) || locale;
			remove_dialog.showModal();
		};

		const move_language_indicator = (source, locale) => {
			const languages = source.querySelector("[data-localized-languages]");
			const button = source.querySelector(`[data-localized-language][data-locale="${CSS.escape(locale)}"]`);
			if (!languages || !button) return;

			const languages_bounds = languages.getBoundingClientRect();
			const button_bounds = button.getBoundingClientRect();
			const indicator_left = button_bounds.left - languages_bounds.left;
			languages.style.setProperty("--localized-language-left", `${indicator_left}px`);
			languages.style.setProperty("--localized-language-width", `${button_bounds.width}px`);
			languages.classList.add("has-active-language");
		};

		const select_language = (source, locale, activate = false) => {
			const field_name = source.dataset.localizedFieldSource || source.dataset.field;
			const field_panels = fields.get(field_name) || [];
			const selected_panel = field_panels.find((panel) => panel.dataset.locale === locale);
			if (locale !== default_locale && !selected_panel) return;

			if (activate && selected_panel) {
				activated_locales.add(locale);
				add_badge(source, locale);
			}

			const original = source_control(source);
			if (original) original.hidden = locale !== default_locale;
			const source_error = source.querySelector(":scope > div > validation-error");
			if (source_error) source_error.hidden = locale !== default_locale;

			for (const panel of field_panels) panel.hidden = panel.dataset.locale !== locale;
			for (const button of source.querySelectorAll("[data-localized-language]")) {
				const active = button.dataset.locale === locale;
				button.classList.toggle("is-active", active);
				button.setAttribute("aria-pressed", active ? "true" : "false");
			}
			move_language_indicator(source, locale);
			sessionStorage.setItem(remember_key(field_name), locale);
		};

		const request_language = (source, locale) => {
			const details = source.querySelector("[data-localized-language-picker]");
			if (details) details.open = false;
			if (activated_locales.has(locale) || !dialog) {
				select_language(source, locale, true);
				return;
			}
			pending_field = source;
			pending_locale = locale;
			if (language_target) language_target.textContent = locale_labels.get(locale) || locale;
			dialog.showModal();
		};

		const select_form_language = (locale, activate = false) => {
			for (const field_name of fields.keys()) {
				let source = form.querySelector(`[data-localized-field-source="${CSS.escape(field_name)}"]`);
				if (source?.classList.contains("contents")) source = source.querySelector(`field-wrapper[data-field="${CSS.escape(field_name)}"]`);
				if (!source) source = form.querySelector(`field-wrapper[data-field="${CSS.escape(field_name)}"]`);
				if (source) select_language(source, locale, activate);
			}
		};

		for (const [field_name, field_panels] of fields) {
			let source = form.querySelector(`[data-localized-field-source="${CSS.escape(field_name)}"]`);
			if (!source) source = form.querySelector(`field-wrapper[data-field="${CSS.escape(field_name)}"]`);
			if (!source) continue;
			if (source.classList.contains("contents")) {
				const inner = source.querySelector(`field-wrapper[data-field="${CSS.escape(field_name)}"]`);
				if (inner) source = inner;
			}
			source.dataset.localizedFieldSource = field_name;

			const column = source.querySelector(":scope > div");
			const image_upload = column?.querySelector(":scope > .image-upload-wrapper");
			const label = column?.querySelector(":scope > label") || image_upload?.querySelector(":scope > div > label");
			if (!column || !label) continue;

			const heading = document.createElement("div");
			heading.className = "localized-field-heading";
			if (image_upload) {
				label.classList.add("px-3");
				image_upload.before(heading);
			} else {
				label.before(heading);
			}
			heading.append(label);

			const controls = document.createElement("div");
			controls.className = "localized-field-controls";
			const languages = document.createElement("span");
			languages.dataset.localizedLanguages = "";
			languages.className = "localized-languages";
			controls.append(languages);
			heading.append(controls);

			add_badge(source, default_locale).title = default_label;
			for (const panel of field_panels) {
				column.append(panel);
				// Every locale gets a badge: its row always exists.
				add_badge(source, panel.dataset.locale);
			}

			const picker = document.createElement("details");
			picker.dataset.localizedLanguagePicker = "";
			picker.className = "localized-language-picker";
			const summary = document.createElement("summary");
			summary.textContent = "+";
			summary.title = add_label;
			picker.append(summary);
			const menu = document.createElement("div");
			menu.dataset.localizedLanguageMenu = "";
			menu.className = "localized-language-menu";
			for (const panel of field_panels) {
				const option = document.createElement("button");
				option.type = "button";
				option.dataset.localizedAddLocale = "";
				option.dataset.locale = panel.dataset.locale;
				option.textContent = locale_labels.get(panel.dataset.locale) || panel.dataset.locale;
				menu.append(option);
			}
			picker.append(menu);
			controls.append(picker);

			const reference = document.createElement("a");
			reference.className = "localized-original-reference";
			reference.href = original_url.toString();
			reference.target = "_blank";
			reference.rel = "noopener";
			reference.title = open_original_label;
			reference.textContent = "👁";
			controls.append(reference);

			controls.addEventListener("click", (event) => {
				const remove = event.target.closest("[data-localized-remove-locale]");
				if (remove) {
					request_remove_translation(source, remove.dataset.locale || "");
					return;
				}
				const language = event.target.closest("[data-localized-language]");
				if (language) select_language(source, language.dataset.locale || default_locale);
				const option = event.target.closest("[data-localized-add-locale]");
				if (option) request_language(source, option.dataset.locale || "");
			});

			controls.addEventListener("dblclick", (event) => {
				const language = event.target.closest("[data-localized-language]");
				if (!language) return;
				event.preventDefault();
				select_form_language(language.dataset.locale || default_locale);
			});

			refresh_menu(source);
			const remembered = sessionStorage.getItem(remember_key(field_name));
			const error_panel = field_panels.find((panel) => panel.querySelector(".localized-error"));
			const requested = location.hash === "#original" ? default_locale : (error_panel?.dataset.locale || remembered || default_locale);
			const can_restore = requested === default_locale || source.querySelector(`[data-localized-language][data-locale="${CSS.escape(requested)}"]`);
			select_language(source, can_restore ? requested : default_locale);
		}

		dialog?.querySelector("[data-localized-dialog-field]")?.addEventListener("click", () => {
			if (pending_field && pending_locale) select_language(pending_field, pending_locale, true);
			dialog.close();
			pending_field = null;
			pending_locale = "";
		});

		dialog?.querySelector("[data-localized-dialog-all]")?.addEventListener("click", () => {
			select_form_language(pending_locale, true);
			dialog.close();
			pending_field = null;
			pending_locale = "";
		});

		remove_dialog?.querySelector("[data-localized-remove-confirm]")?.addEventListener("click", () => {
			if (pending_remove_source && pending_remove_locale) remove_translation(pending_remove_source, pending_remove_locale);
			remove_dialog.close();
			pending_remove_source = null;
			pending_remove_locale = "";
		});

		remove_dialog?.querySelector("[data-localized-remove-cancel]")?.addEventListener("click", () => {
			remove_dialog.close();
			pending_remove_source = null;
			pending_remove_locale = "";
		});

		form.classList.add("localized-ready");
	}
});
