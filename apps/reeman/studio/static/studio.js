(() => {
	const form = document.getElementById("studio-table-form");
	if (!form) return;

	const rows = document.getElementById("studio-column-rows");
	const row_template = document.getElementById("studio-column-template");
	const preview = document.getElementById("studio-ddl-preview");
	const delete_dialog = document.getElementById("delete-column-dialog");
	const add_fk_dialog = document.getElementById("add-fk-dialog");
	const add_column_dialog = document.getElementById("add-column-dialog");
	const add_column_form = document.getElementById("studio-add-column-form");
	const add_column_domain = document.getElementById("studio-add-column-domain");
	const add_column_name = document.getElementById("studio-add-column-name");
	const fk_target = document.getElementById("studio-fk-target");
	const hide_system = document.getElementById("hide-system-columns");
	const domain_help = document.getElementById("studio-domain-help");
	const domain_help_title = document.getElementById("studio-domain-help-title");
	const domain_help_description = document.getElementById("studio-domain-help-description");
	const favorite_types = document.getElementById("studio-favorite-types");
	const recent_types = document.getElementById("studio-recent-types");
	const domain_types = document.getElementById("studio-domain-types");
	const undo_button = document.getElementById("studio-undo");
	const undo_form = document.getElementById("studio-undo-form");
	const form_version = document.getElementById("studio-form-version");
	const undo_form_version = undo_form ? undo_form.querySelector('[name="v"]') : null;
	const FAVORITES_KEY = "studio_favorite_types";
	const RECENTS_KEY = "studio_recent_types";
	const HIDE_KEY = "studio_hide_system_columns";
	const ACTIVE_DOMAIN_GROUP_KEY = "studio_active_domain_group";
	const domain_toolbox = document.getElementById("studio-domain-toolbox");
	const domain_toolbox_handle = document.getElementById("studio-domain-toolbox-handle");
	const DOMAIN_TOOLBOX_POSITION_KEY = "studio_domain_toolbox_position";
	const DOMAIN_TOOLBOX_SIZE_KEY = "studio_domain_toolbox_size";
	let dirty = false;
	let preview_timer = 0;
	let pending_delete = null;
	let pending_domain = null;
	let dragged_row = null;
	let favorite_drag = null;
	let domain_help_timer = 0;
	const column_drop_marker = make_drop_marker();
	const favorite_drop_placeholder = make_favorite_placeholder();

	// Domain palette and shelves
	const DOMAIN_GROUPS = {
		"Keys": ["pk_id", "uuid_v7", "foreign_key"],
		"Numbers": ["integer", "unsigned_integer", "bigint", "real", "numeric", "decimal", "float", "double", "amount", "percentage"],
		"Text": ["varchar", "char", "longtext", "short_description", "long_description", "short_text", "text", "markdown", "slug", "url"],
		"Names and Identity": ["first_name", "last_name", "full_name", "username"],
		"Contact": ["email", "phone_number", "locale"],
		"Codes and Status": ["code_short", "code", "code_long", "status_enum", "currency_code", "sku", "gtin", "tax_id"],
		"Address": ["street_line_1", "street_line_2", "city", "state_province", "postal_code", "country_code", "country_name"],
		"Security and Network": ["password_hash", "ip_address"],
		"Date and Time": ["date", "datetime", "timestamp", "days", "months", "years", "hours", "minutes"],
		"Boolean": ["boolean"],
		"Files": ["binary", "blob", "image_path", "file_path"],
		"Structured Data": ["json", "json_data"],
		"Quantities": ["quantity"],
	};

	function group_for_domain(domain_name) {
		for (const [group_name, domain_names] of Object.entries(DOMAIN_GROUPS)) {
			if (domain_names.includes(domain_name)) return group_name;
		}
		return "Application Fields";
	}

	function build_domain_groups() {
		if (!domain_types) return;
		const items = Array.from(domain_types.querySelectorAll(":scope > .studio-domain-item"));
		const grouped_items = new Map();
		for (const item of items) {
			const group_name = group_for_domain(item.dataset.domain);
			const group_items = grouped_items.get(group_name) || [];
			group_items.push(item);
			grouped_items.set(group_name, group_items);
		}
		domain_types.replaceChildren();
		for (const group_name of [...Object.keys(DOMAIN_GROUPS), "Application Fields"]) {
			const group_items = grouped_items.get(group_name);
			if (!group_items?.length) continue;
			const details = document.createElement("details");
			details.className = "studio-domain-group rounded border border-border px-2 py-2";
			details.dataset.group = group_name;
			const summary = document.createElement("summary");
			summary.className = "cursor-pointer text-xs font-semibold uppercase tracking-wider";
			summary.textContent = `${group_name} (${group_items.length})`;
			const body = document.createElement("div");
			body.className = "studio-domain-group-body";
			const grid = document.createElement("div");
			grid.className = "mt-2 grid gap-2";
			grid.style.gridTemplateColumns = "repeat(auto-fit, 30ch)";
			grid.append(...group_items);
			body.append(grid);
			details.append(summary, body);
			details.addEventListener("toggle", () => {
				if (!details.open) return;
				const anchor_top = summary.getBoundingClientRect().top;
				for (const other of domain_types.querySelectorAll(".studio-domain-group")) {
					if (other !== details) other.open = false;
				}
				// Keep the group the user just opened anchored under their pointer
				// instead of letting the collapse of every other group shove the
				// scroll position around underneath them.
				const scroll_container = domain_types.closest("#studio-domain-toolbox") ?? domain_types;
				scroll_container.scrollTop += summary.getBoundingClientRect().top - anchor_top;
				localStorage.setItem(ACTIVE_DOMAIN_GROUP_KEY, group_name);
			});
			domain_types.append(details);
		}
		const active_name = localStorage.getItem(ACTIVE_DOMAIN_GROUP_KEY);
		const available_groups = Array.from(domain_types.querySelectorAll(".studio-domain-group"));
		const active_group = available_groups.find((details) => details.dataset.group === active_name);
		const first_group = domain_types.querySelector(".studio-domain-group");
		(active_group || first_group)?.setAttribute("open", "");
	}

	function toolbox_limits(width, height) {
		let maximum_top = Math.max(8, window.innerHeight - height - 8);
		// Keep the save row reachable while the palette is detached: clamp the
		// toolbox above it. On short viewports the plain viewport clamp still
		// wins (the toolbox can overlap the save row, but the page scrolls).
		const save_row = document.getElementById("studio-save-row");
		if (save_row) {
			const save_row_top = save_row.getBoundingClientRect().top;
			maximum_top = Math.min(maximum_top, Math.max(8, save_row_top - 8 - height));
		}
		return {
			maximum_left: Math.max(8, window.innerWidth - width - 8),
			maximum_top,
		};
	}

	function set_domain_grid_columns(is_floating) {
		const columns = is_floating ? "repeat(auto-fit, minmax(min(30ch, 100%), 1fr))" : "repeat(auto-fit, 30ch)";
		for (const shelf of [favorite_types, recent_types]) {
			if (shelf) shelf.style.gridTemplateColumns = columns;
		}
		for (const grid of domain_types.querySelectorAll(".studio-domain-group-body > div")) {
			grid.style.gridTemplateColumns = columns;
		}
	}

	function position_domain_toolbox(left, top) {
		const toolbox_rect = domain_toolbox.getBoundingClientRect();
		const limits = toolbox_limits(toolbox_rect.width, toolbox_rect.height);
		const next_left = Math.min(limits.maximum_left, Math.max(8, left));
		const next_top = Math.min(limits.maximum_top, Math.max(8, top));
		domain_toolbox.style.left = `${next_left}px`;
		domain_toolbox.style.top = `${next_top}px`;
		return { left: next_left, top: next_top };
	}

	// Toolbox position and editor sizing

	// The toolbox is fixed-positioned with sane defaults in CSS from first
	// paint (see #studio-domain-toolbox in studio.css) - this only applies a
	// user's remembered drag/resize as an override on top of that.
	function restore_domain_toolbox() {
		set_domain_grid_columns(true);
		try {
			const position = JSON.parse(localStorage.getItem(DOMAIN_TOOLBOX_POSITION_KEY));
			const size = JSON.parse(localStorage.getItem(DOMAIN_TOOLBOX_SIZE_KEY));
			if (Number.isFinite(size?.width) && Number.isFinite(size?.height)) {
				domain_toolbox.style.width = `${size.width}px`;
				domain_toolbox.style.height = `${size.height}px`;
			}
			if (Number.isFinite(position?.left) && Number.isFinite(position?.top)) {
				position_domain_toolbox(position.left, position.top);
			}
		} catch {
			localStorage.removeItem(DOMAIN_TOOLBOX_POSITION_KEY);
			localStorage.removeItem(DOMAIN_TOOLBOX_SIZE_KEY);
		}
		domain_toolbox.classList.add("studio-toolbox-ready");
	}

	function stored_list(key) {
		try {
			const value = JSON.parse(localStorage.getItem(key) || "[]");
			return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
		} catch {
			return [];
		}
	}

	function store_list(key, value) {
		localStorage.setItem(key, JSON.stringify(value));
	}

	function mark_dirty() {
		dirty = true;
		window.clearTimeout(preview_timer);
		preview_timer = window.setTimeout(refresh_preview, 300);
	}

	function apply_hidden_columns() {
		if (!hide_system) return;
		for (const row of rows.querySelectorAll('[data-system="1"]')) {
			row.classList.toggle("hidden", hide_system.checked && row.querySelector(":invalid") === null);
		}
	}


	function render_field_validation(control) {
		const label = control.closest("label");
		if (!label) return;
		let error = label.querySelector(".studio-validation-error");
		if (control.validity.valid) {
			control.removeAttribute("aria-invalid");
			error?.remove();
			return;
		}
		control.setAttribute("aria-invalid", "true");
		if (!error) {
			error = document.createElement("span");
			error.className = "studio-validation-error normal-case tracking-normal text-danger";
			label.append(error);
		}
		error.textContent = control.validationMessage;
	}

	function validate_form() {
		const controls = Array.from(form.elements).filter((control) => control.willValidate);
		for (const control of controls) render_field_validation(control);
		const first_invalid = controls.find((control) => !control.validity.valid);
		const hidden_row = first_invalid?.closest(".studio-column-row.hidden");
		if (hidden_row) {
			hidden_row.classList.remove("hidden");
			first_invalid.scrollIntoView({ block: "center" });
		}
		return first_invalid === undefined;
	}

	async function refresh_preview() {
		if (!preview) return;
		if (!validate_form()) {
			preview.textContent = "Fix the highlighted validation errors to preview DDL.";
			preview.classList.add("text-danger");
			return;
		}
		try {
			const body = new URLSearchParams(new FormData(form));
			const response = await fetch(form.dataset.previewUrl, { method: "POST", body });
			if (!response.ok) {
				preview.textContent = await response.text();
				preview.classList.add("text-danger");
				return;
			}
			const { diff, version } = await response.json();
			render_ddl_diff(diff);
			preview.classList.remove("text-danger");
			if (form_version) form_version.value = String(version);
			if (undo_form_version) undo_form_version.value = String(version);
			if (undo_button) undo_button.disabled = version === 0;
			const url = new URL(location.href);
			url.searchParams.set("v", String(version));
			history.replaceState(null, "", url);
		} catch (error) {
			preview.textContent = error instanceof Error ? error.message : "Preview failed.";
			preview.classList.add("text-danger");
		}
	}

	function render_ddl_diff(diff) {
		preview.replaceChildren();
		const kind_class = { add: "bg-success/20", remove: "bg-danger/20", same: "" };
		const kind_prefix = { add: "+ ", remove: "- ", same: "  " };
		for (const line of diff) {
			const row = document.createElement("div");
			row.className = `studio-diff-line whitespace-pre-wrap break-words ${kind_class[line.kind] ?? ""}`;
			row.textContent = `${kind_prefix[line.kind] ?? "  "}${line.text}`;
			preview.append(row);
		}
	}

	function init_domain_selects(root) {
		for (const wrapper of root.querySelectorAll(".domain-select:not([data-ds-init])")) {
			wrapper.dataset.dsInit = "1";
			const select = wrapper.querySelector(".studio-column-domain");
			const trigger = wrapper.querySelector(".domain-select-trigger");
			const menu = wrapper.querySelector(".domain-select-menu");
			if (!select || !trigger || !menu) continue;

			const anchor_name = `--domain-select-${Math.random().toString(36).slice(2)}`;
			trigger.style.anchorName = anchor_name;
			menu.style.positionAnchor = anchor_name;
			menu.id = `${anchor_name}-menu`;
			trigger.setAttribute("popovertarget", menu.id);

			function sync_trigger() {
				const option = select.selectedOptions[0];
				trigger.textContent = option && option.value ? option.textContent.trim() : "-";
				for (const item of menu.querySelectorAll(".domain-select-option")) {
					item.setAttribute("aria-selected", item.dataset.value === select.value ? "true" : "false");
				}
			}

			function select_option(item) {
				select.value = item.dataset.value;
				select.dispatchEvent(new Event("change", { bubbles: true }));
				sync_trigger();
				menu.hidePopover();
				trigger.focus();
			}

			trigger.addEventListener("click", sync_trigger);
			menu.addEventListener("click", (event) => {
				const item = event.target.closest(".domain-select-option");
				if (item) select_option(item);
			});
			menu.addEventListener("keydown", (event) => {
				const items = Array.from(menu.querySelectorAll(".domain-select-option"));
				const current_index = items.indexOf(document.activeElement);
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					if (items[current_index]) select_option(items[current_index]);
				} else if (event.key === "ArrowDown") {
					event.preventDefault();
					const next = items[current_index + 1] || items[0];
					next.focus();
					next.scrollIntoView({ behavior: "smooth", block: "nearest" });
				} else if (event.key === "ArrowUp") {
					event.preventDefault();
					const prev = items[current_index - 1] || items[items.length - 1];
					prev.focus();
					prev.scrollIntoView({ behavior: "smooth", block: "nearest" });
				} else if (event.key === "Escape") {
					menu.hidePopover();
					trigger.focus();
				}
			});
			menu.addEventListener("toggle", (event) => {
				if (event.newState !== "open") return;
				const active = menu.querySelector('.domain-select-option[aria-selected="true"]') || menu.querySelector(".domain-select-option");
				active?.scrollIntoView({ block: "nearest" });
			});
			select.addEventListener("change", sync_trigger);
			select.addEventListener("domainsync", sync_trigger);
			sync_trigger();
		}
	}

	function unique_name(base) {
		const names = new Set(Array.from(rows.querySelectorAll("[name=column_name]"), (input) => input.value));
		if (!names.has(base)) return base;
		let index = 2;
		while (names.has(`${base}_${index}`)) index++;
		return `${base}_${index}`;
	}

	function add_row(name, domain, sql_type, reference = "") {
		const fragment = row_template.content.cloneNode(true);
		const row = fragment.querySelector(".studio-column-row");
		row.querySelector("[name=column_name]").value = unique_name(name);
		row.querySelector("[name=column_domain]").value = domain;
		row.querySelector("[name=column_type]").value = sql_type.replace(/\s+COMMENT\s+'.*'$/i, "");
		row.querySelector("[name=column_reference]").value = reference;
		const display_row = Array.from(rows.querySelectorAll(".studio-column-row"))
			.find((candidate) => candidate.querySelector("[name=column_name]")?.value === "display");
		rows.insertBefore(fragment, display_row ?? null);
		init_domain_selects(row);
		row.querySelector("[name=column_name]").focus();
		mark_dirty();
	}

	function request_domain_column(button) {
		const domain = button.dataset.domain;
		const sql_type = button.dataset.sqlType;
		const is_basic = button.dataset.basic === "1";
		const table = form.querySelector("[name=table_name]").value.replace(/s$/, "");
		const suffixes = { image_path: "_image", file_path: "_file", timestamp: "_at", date: "_on", minutes: "_minutes", hours: "_hours", days: "_days", months: "_months", years: "_years" };
		if (domain === "boolean") {
			add_domain_row(`is_${table}`, domain, sql_type);
			return;
		}
		if (!is_basic && !suffixes[domain]) {
			add_domain_row(domain, domain, sql_type);
			return;
		}
		pending_domain = { domain, sql_type, suffix: is_basic ? "" : suffixes[domain] };
		add_column_domain.textContent = domain;
		add_column_name.value = is_basic ? "new_column" : table;
		add_column_dialog.showModal();
		add_column_name.focus();
		add_column_name.select();
	}

	function add_domain_row(name, domain, sql_type) {
		add_row(name, domain, sql_type);
		track_recent(domain);
	}

	function apply_domain(row, domain_name, option) {
		const domain = row.querySelector(".studio-column-domain");
		const selected = option ?? (() => { domain.value = domain_name; return domain.selectedOptions[0]; })();
		if (!selected?.dataset.sqlType) return;
		if (domain.selectedOptions[0] !== selected) domain.value = domain_name;
		domain.dispatchEvent(new Event("domainsync"));
		row.querySelector(".studio-column-type").value = selected.dataset.sqlType.replace(/\s+COMMENT\s+'.*'$/i, "");
		row.querySelector("[name=column_preserve_type]").value = selected.dataset.current === "1" ? "1" : "0";
		if (selected.dataset.current !== "1") row.querySelector(".studio-domain-warning")?.remove();
	}

	function track_recent(domain) {
		const favorites = stored_list(FAVORITES_KEY);
		const recents = stored_list(RECENTS_KEY).filter((item) => item !== domain && !favorites.includes(item));
		recents.unshift(domain);
		store_list(RECENTS_KEY, recents.slice(0, 10));
		render_shelves();
	}

	function render_shelf(target_id, names, title) {
		const target = document.getElementById(target_id);
		if (!target) return;
		target.replaceChildren();
		if (names.length === 0) return;
		const heading = document.createElement("h3");
		heading.className = "col-span-full font-semibold uppercase tracking-wider";
		heading.textContent = title;
		target.append(heading);
		for (const name of names) {
			const source = document.querySelector(`#studio-domain-types [data-domain="${CSS.escape(name)}"]`);
			if (!source) continue;
			const item = source.cloneNode(true);
			if (target_id === "studio-favorite-types") {
				item.draggable = true;
				item.classList.add("studio-favorite-item", "cursor-grab");
				item.querySelector(".studio-add-domain")?.classList.add("pl-6");
				const drag_marker = document.createElement("span");
				drag_marker.className = "pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-sm text-text-tertiary";
				drag_marker.textContent = "⠿";
				drag_marker.setAttribute("aria-hidden", "true");
				item.append(drag_marker);
			}
			target.append(item);
		}
	}

	function render_shelves() {
		const favorites = stored_list(FAVORITES_KEY);
		const recents = stored_list(RECENTS_KEY).filter((name) => !favorites.includes(name));
		render_shelf("studio-favorite-types", favorites, "Favorites");
		render_shelf("studio-recent-types", recents, "Recent");
		for (const item of document.querySelectorAll(".studio-domain-item")) {
			const active = favorites.includes(item.dataset.domain);
			const star = item.querySelector(".studio-favorite-toggle");
			if (star) star.textContent = active ? "★" : "☆";
		}
	}

	// Event bindings

	document.addEventListener("click", (event) => {
		const help_button = event.target.closest(".studio-domain-help-button");
		if (help_button) {
			show_domain_help(help_button);
			return;
		}

		const add_domain = event.target.closest(".studio-add-domain");
		if (add_domain) {
			request_domain_column(add_domain);
			return;
		}

		const favorite = event.target.closest(".studio-favorite-toggle");
		if (favorite) {
			const domain = favorite.closest(".studio-domain-item").dataset.domain;
			const current = stored_list(FAVORITES_KEY);
			const next = current.includes(domain) ? current.filter((item) => item !== domain) : [domain, ...current];
			store_list(FAVORITES_KEY, next);
			render_shelves();
			return;
		}

		const delete_button = event.target.closest(".studio-delete-column");
		if (delete_button) {
			pending_delete = delete_button.closest(".studio-column-row");
			delete_dialog.showModal();
		}
	});

	document.addEventListener("pointerover", (event) => {
		const help_button = event.target.closest(".studio-domain-help-button");
		if (help_button) show_domain_help(help_button);
	});
	document.addEventListener("pointerout", (event) => {
		const help_button = event.target.closest(".studio-domain-help-button");
		if (!help_button || help_button.contains(event.relatedTarget)) return;
		domain_help_timer = window.setTimeout(hide_domain_help, 120);
	});
	domain_help.addEventListener("pointerenter", () => window.clearTimeout(domain_help_timer));
	domain_help.addEventListener("pointerleave", hide_domain_help);

	favorite_types.addEventListener("dragstart", (event) => {
		const item = event.target.closest(".studio-favorite-item");
		if (!item) return;
		start_favorite_drag(item);
		event.dataTransfer.effectAllowed = "move";
	});
	favorite_types.addEventListener("dragover", (event) => {
		if (!favorite_drag) return;
		event.preventDefault();
		preview_favorite_drop(event.clientX, event.clientY);
	});
	favorite_types.addEventListener("drop", (event) => {
		if (!favorite_drag) return;
		event.preventDefault();
		commit_favorite_drop(event.clientX, event.clientY);
	});
	favorite_types.addEventListener("dragend", finish_favorite_drag);

	build_domain_groups();

	if (domain_toolbox && domain_toolbox_handle) {
		// ResizeObserver fires once immediately on observe() even with no
		// actual user resize - skip that first call, or every page load would
		// record the CSS default size/position as if the user had set it.
		let toolbox_observed_once = false;
		const toolbox_resize_observer = new ResizeObserver(() => {
			if (!toolbox_observed_once) {
				toolbox_observed_once = true;
				return;
			}
			const toolbox_rect = domain_toolbox.getBoundingClientRect();
			const size = { width: toolbox_rect.width, height: toolbox_rect.height };
			localStorage.setItem(DOMAIN_TOOLBOX_SIZE_KEY, JSON.stringify(size));
			position_domain_toolbox(toolbox_rect.left, toolbox_rect.top);
		});
		toolbox_resize_observer.observe(domain_toolbox);
		domain_toolbox_handle.addEventListener("pointerdown", (event) => {
			if (event.target.closest("button")) return;
			const initial_rect = domain_toolbox.getBoundingClientRect();
			const horizontal_ratio = (event.clientX - initial_rect.left) / initial_rect.width;
			const pointer_offset_y = event.clientY - initial_rect.top;
			domain_toolbox_handle.setPointerCapture(event.pointerId);
			const move_toolbox = (move_event) => {
				const floating_rect = domain_toolbox.getBoundingClientRect();
				const pointer_offset_x = horizontal_ratio * floating_rect.width;
				position_domain_toolbox(move_event.clientX - pointer_offset_x, move_event.clientY - pointer_offset_y);
			};
			const finish_move = () => {
				const final_rect = domain_toolbox.getBoundingClientRect();
				localStorage.setItem(DOMAIN_TOOLBOX_POSITION_KEY, JSON.stringify({ left: final_rect.left, top: final_rect.top }));
				domain_toolbox_handle.removeEventListener("pointermove", move_toolbox);
				domain_toolbox_handle.removeEventListener("pointerup", finish_move);
				domain_toolbox_handle.removeEventListener("pointercancel", finish_move);
			};
			domain_toolbox_handle.addEventListener("pointermove", move_toolbox);
			domain_toolbox_handle.addEventListener("pointerup", finish_move);
			domain_toolbox_handle.addEventListener("pointercancel", finish_move);
		});
		domain_toolbox_handle.addEventListener("keydown", (event) => {
			if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
			event.preventDefault();
			const distance = event.shiftKey ? 50 : 10;
			const toolbox_rect = domain_toolbox.getBoundingClientRect();
			const horizontal = event.key === "ArrowLeft" ? -distance : event.key === "ArrowRight" ? distance : 0;
			const vertical = event.key === "ArrowUp" ? -distance : event.key === "ArrowDown" ? distance : 0;
			const position = position_domain_toolbox(toolbox_rect.left + horizontal, toolbox_rect.top + vertical);
			localStorage.setItem(DOMAIN_TOOLBOX_POSITION_KEY, JSON.stringify(position));
		});
		window.addEventListener("resize", () => {
			const toolbox_rect = domain_toolbox.getBoundingClientRect();
			const position = position_domain_toolbox(toolbox_rect.left, toolbox_rect.top);
			localStorage.setItem(DOMAIN_TOOLBOX_POSITION_KEY, JSON.stringify(position));
		});
		restore_domain_toolbox();
	}

	document.getElementById("confirm-delete-column")?.addEventListener("click", () => {
		pending_delete?.remove();
		pending_delete = null;
		delete_dialog.close();
		mark_dirty();
	});

	document.getElementById("confirm-add-fk")?.addEventListener("click", () => {
		if (!fk_target?.reportValidity()) return;
		const selected = fk_target.selectedOptions[0];
		const foreign_key = document.querySelector('#studio-domain-types [data-domain="foreign_key"] .studio-add-domain');
		if (!selected?.dataset.columnName || !foreign_key?.dataset.sqlType) return;
		add_row(selected.dataset.columnName, "foreign_key", foreign_key.dataset.sqlType, selected.value);
		track_recent("foreign_key");
		fk_target.value = "";
		add_fk_dialog.close();
	});

	add_column_form?.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!pending_domain || !add_column_name.reportValidity()) return;
		const name = `${add_column_name.value.trim()}${pending_domain.suffix}`;
		add_domain_row(name, pending_domain.domain, pending_domain.sql_type);
		pending_domain = null;
		add_column_dialog.close();
	});
	add_column_dialog?.addEventListener("close", () => { pending_domain = null; });

	rows.addEventListener("change", (event) => {
		const reference = event.target.closest("[name=column_reference]");
		if (reference?.value) apply_domain(reference.closest(".studio-column-row"), "foreign_key");

		const domain = event.target.closest(".studio-column-domain");
		if (domain) {
			const row = domain.closest(".studio-column-row");
			const current_reference = row.querySelector("[name=column_reference]");
			if (current_reference.value && domain.value !== "foreign_key") current_reference.value = "";
			if (domain.value) apply_domain(row, domain.value, domain.selectedOptions[0]);
		}
		mark_dirty();
	});
	rows.addEventListener("input", (event) => {
		if (event.target.willValidate) render_field_validation(event.target);
		mark_dirty();
	});
	form.addEventListener("invalid", (event) => render_field_validation(event.target), true);

	rows.addEventListener("dragstart", (event) => {
		dragged_row = event.target.closest(".studio-column-row");
		if (dragged_row) {
			column_drop_marker.remove();
			dragged_row.classList.add("opacity-50");
			event.dataTransfer.effectAllowed = "move";
		}
	});
	rows.addEventListener("dragover", (event) => {
		if (!dragged_row) return;
		event.preventDefault();
		const target = event.target.closest(".studio-column-row");
		if (target === dragged_row) return;
		place_drop_marker(rows, target, event.clientY, column_drop_marker);
	});
	rows.addEventListener("drop", (event) => {
		event.preventDefault();
		if (dragged_row && column_drop_marker.parentElement === rows) {
			rows.insertBefore(dragged_row, column_drop_marker);
			column_drop_marker.remove();
			mark_dirty();
		}
	});
	rows.addEventListener("dragend", () => {
		dragged_row?.classList.remove("opacity-50");
		column_drop_marker.remove();
		dragged_row = null;
	});

	if (hide_system) {
		// Initial checked state and hidden rows are rendered server-side from
		// the studio_hide_system_columns cookie - this only keeps the toggle
		// live after the page has loaded.
		hide_system.addEventListener("change", () => {
			document.cookie = `${HIDE_KEY}=${hide_system.checked ? "1" : "0"}; path=/; max-age=31536000; SameSite=Lax`;
			apply_hidden_columns();
		});
	}

	form.addEventListener("submit", () => { dirty = false; });
	undo_form?.addEventListener("submit", () => { dirty = false; });
	window.addEventListener("beforeunload", (event) => {
		if (!dirty) return;
		event.preventDefault();
		event.returnValue = "";
	});
	form.addEventListener("keydown", (event) => {
		if (!(event.key === "z" || event.key === "Z") || !(event.ctrlKey || event.metaKey) || event.shiftKey) return;
		if (undo_button?.disabled) return;
		event.preventDefault();
		undo_button?.form?.requestSubmit(undo_button);
	});
	render_shelves();
	init_domain_selects(document);

	function show_domain_help(button) {
		window.clearTimeout(domain_help_timer);
		domain_help_title.textContent = button.dataset.domain;
		domain_help_description.textContent = button.dataset.description;
		if (!domain_help.matches(":popover-open")) domain_help.showPopover();
		position_domain_help(button);
	}

	// Shared drag helpers

	function hide_domain_help() {
		window.clearTimeout(domain_help_timer);
		if (domain_help.matches(":popover-open")) domain_help.hidePopover();
	}

	function persist_favorite_order() {
		const ordered = Array.from(favorite_types.querySelectorAll(".studio-favorite-item"), (item) => item.dataset.domain);
		store_list(FAVORITES_KEY, ordered);
	}

	function make_drop_marker() {
		const marker = document.createElement("div");
		marker.className = "studio-drop-marker pointer-events-none h-1 rounded-full bg-primary shadow-sm";
		marker.setAttribute("aria-hidden", "true");
		return marker;
	}

	function place_drop_marker(container, target, pointer_y, marker) {
		if (!target) {
			container.append(marker);
			return;
		}
		const target_rect = target.getBoundingClientRect();
		const before = pointer_y < target_rect.top + target_rect.height / 2;
		container.insertBefore(marker, before ? target : target.nextSibling);
	}

	function start_favorite_drag(item) {
		const order = Array.from(favorite_types.querySelectorAll(".studio-favorite-item"));
		const original_index = order.indexOf(item);
		const slots = order.map((favorite) => favorite.getBoundingClientRect());
		const remaining_items = order.filter((favorite) => favorite !== item);
		favorite_drag = { item, item_count: order.length, remaining_items, slots, original_index, hide_frame: 0 };
		favorite_drop_placeholder.style.height = `${slots[original_index].height}px`;
		favorite_types.append(favorite_drop_placeholder);
		const current_drag = favorite_drag;
		current_drag.hide_frame = window.requestAnimationFrame(() => {
			if (favorite_drag === current_drag) current_drag.item.classList.add("hidden");
		});
	}

	function preview_favorite_drop(pointer_x, pointer_y) {
		if (!favorite_drag) return;
		const insertion_index = favorite_insertion_index(favorite_drag, pointer_x, pointer_y);
		if (insertion_index >= favorite_drag.remaining_items.length) {
			favorite_types.append(favorite_drop_placeholder);
			return;
		}
		const reference = favorite_drag.remaining_items[insertion_index];
		favorite_types.insertBefore(favorite_drop_placeholder, reference);
	}

	function commit_favorite_drop(pointer_x, pointer_y) {
		if (!favorite_drag) return;
		preview_favorite_drop(pointer_x, pointer_y);
		const item = favorite_drag.item;
		favorite_types.insertBefore(item, favorite_drop_placeholder);
		persist_favorite_order();
		finish_favorite_drag();
	}

	function finish_favorite_drag() {
		if (!favorite_drag) return;
		window.cancelAnimationFrame(favorite_drag.hide_frame);
		favorite_drag.item.classList.remove("hidden");
		favorite_drop_placeholder.remove();
		favorite_drag = null;
	}

	function favorite_insertion_index(drag, pointer_x, pointer_y) {
		if (pointer_is_after_last_favorite(drag, pointer_x, pointer_y)) return drag.item_count - 1;
		let closest_index = 0;
		let closest_distance = Number.POSITIVE_INFINITY;
		for (let index = 0; index < drag.slots.length; index++) {
			const item_rect = drag.slots[index];
			const horizontal_distance = pointer_x - (item_rect.left + item_rect.width / 2);
			const vertical_distance = pointer_y - (item_rect.top + item_rect.height / 2);
			const distance = horizontal_distance * horizontal_distance + vertical_distance * vertical_distance;
			if (distance >= closest_distance) continue;
			closest_distance = distance;
			closest_index = index;
		}
		const closest_rect = drag.slots[closest_index];
		const after = pointer_x >= closest_rect.left + closest_rect.width / 2;
		let insertion_index = closest_index + (after ? 1 : 0);
		if (insertion_index > drag.original_index) insertion_index--;
		return Math.max(0, Math.min(drag.item_count - 1, insertion_index));
	}

	function pointer_is_after_last_favorite(drag, pointer_x, pointer_y) {
		const last_item = drag.remaining_items[drag.remaining_items.length - 1];
		if (!last_item) return true;
		const last_rect = last_item.getBoundingClientRect();
		if (pointer_y > last_rect.bottom) return true;
		const same_row = pointer_y >= last_rect.top && pointer_y <= last_rect.bottom;
		return same_row && pointer_x >= last_rect.left + last_rect.width / 2;
	}

	function make_favorite_placeholder() {
		const placeholder = document.createElement("div");
		placeholder.className = "pointer-events-none rounded border border-dashed border-primary bg-surface-raised";
		placeholder.setAttribute("aria-hidden", "true");
		return placeholder;
	}

	function position_domain_help(button) {
		const gap = 8;
		const button_rect = button.getBoundingClientRect();
		const popover_rect = domain_help.getBoundingClientRect();
		let left = button_rect.right + gap;
		if (left + popover_rect.width > window.innerWidth - gap) left = button_rect.left - popover_rect.width - gap;
		left = Math.max(gap, left);
		const max_top = window.innerHeight - popover_rect.height - gap;
		const top = Math.max(gap, Math.min(button_rect.top, max_top));
		domain_help.style.left = `${left}px`;
		domain_help.style.top = `${top}px`;
	}
})();
