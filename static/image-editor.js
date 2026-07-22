/**
 * Image Editor - standalone script (replaces the shadow‑DOM <image-editor> web component).
 *
 * Call `initImageEditor(config)` after the DOM is ready.
 *
 * config:
 * processUrl   - POST endpoint for preview/processing
 * saveUrl      - POST endpoint for saving to S3
 * returnUrl    - URL to navigate after save
 * imageId      - set for edit mode (image DB id)
 * s3Key        - S3 key of existing image (edit mode)
 * title        - pre-fill title
 * description  - pre-fill description
 * tags         - pre-fill tags
 * folder       - pre-fill folder
 * editMode     - boolean
 */

window.initImageEditor = (config) => {
	// CSRF token - read from config, then from meta tag
	let csrf_token = config.csrfToken || "";
	if (!csrf_token) {
		const meta = document.querySelector('meta[name="csrf-token"]');
		if (meta) csrf_token = meta.getAttribute("content") || "";
	}

	// State
	let image_data = null; // { data: ArrayBuffer, mime: string, name: string }
	let crop = { left: 0, top: 0, width: 0, height: 0 };
	let is_dragging = false;
	let drag_start = null;
	let image_natural = { width: 0, height: 0 };
	let image_display = { width: 0, height: 0 };
	let processing = false;
	let preview_timer = null;
	let crop_display_info = "";
	const edit_mode = config.editMode || false;
	const image_id = config.imageId || "";
	const original_s3_key = config.s3Key || "";
	const process_url = config.processUrl || "/system/images/process";
	const save_url = config.saveUrl || "/system/images/save";
	const return_url = config.returnUrl || "";
	const folder = config.folder || "";
	let save_as_copy = false;
	let _auto_resize_applied = false;
	let preview_url = null;
	const image_basepath = config.image_basepath || "/images";
	const app_basepath = config.app_basepath || "/system/images";

	const $ = (id) => document.getElementById(id);

	// Source tab switching

	function switch_source_tab(tab_name) {
		document
			.querySelectorAll("#source-tabs .tab-btn")
			.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab_name));
		document
			.querySelectorAll(".source-panel")
			.forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab_name));
	}

	// Image loading

	function load_file(file) {
		if (!file.type.startsWith("image/")) {
			show_status("Please select an image file", "error");
			return;
		}

		const reader = new FileReader();
		reader.onload = async (e) => {
			const data = e.target.result;
			await display_image(data, file.type, file.name);
		};
		reader.readAsArrayBuffer(file);
	}

	async function fetch_url() {
		const url_input = $("url-input");
		const url = url_input.value.trim();
		if (!url) return;

		show_status("Fetching image...", "info");

		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);

			const mime = response.headers.get("Content-Type") || "image/jpeg";
			if (!mime.startsWith("image/")) throw new Error("URL does not point to an image");

			const data = await response.arrayBuffer();
			const name = url.split("/").pop() || "remote-image";
			await display_image(data, mime, name);
			show_status("Image loaded from URL", "success");
		} catch (err) {
			show_status(`Failed to fetch image: ${err.message}`, "error");
		}
	}

	async function preload_from_s3(s3_key) {
		show_status("Loading image from S3...", "info");

		try {
			const response = await fetch(`${image_basepath}/${encodeURIComponent(s3_key)}`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);

			const mime = response.headers.get("Content-Type") || "image/webp";
			const data = await response.arrayBuffer();
			const name = s3_key.split("/").pop() || "image";

			await display_image(data, mime, name);
		} catch (err) {
			show_status(`Failed to load image: ${err.message}`, "error");
		}
	}

	async function display_image(data, mime, name) {
		image_data = { data, mime, name };

		const blob = new Blob([data], { type: mime });
		const url = URL.createObjectURL(blob);

		const img = new Image();
		await new Promise((resolve, reject) => {
			img.onload = resolve;
			img.onerror = reject;
			img.src = url;
		});

		image_natural = { width: img.naturalWidth, height: img.naturalHeight };

		// Show image area and editor form panel
		$("image-area").classList.remove("hidden");
		$("editor-form-panel").classList.remove("hidden");

		const canvas = $("crop-canvas");
		const ctx = canvas.getContext("2d");

		// Calculate canvas buffer (drawing resolution) - cap to max display size
		const max_buf = 2000;
		let buf_w = img.naturalWidth;
		let buf_h = img.naturalHeight;
		if (buf_w > max_buf) {
			buf_h = (buf_h * max_buf) / buf_w;
			buf_w = max_buf;
		}
		if (buf_h > max_buf) {
			buf_w = (buf_w * max_buf) / buf_h;
			buf_h = max_buf;
		}

		canvas.width = Math.round(buf_w);
		canvas.height = Math.round(buf_h);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

		// Read available space from the wrapper - the canvas is position:absolute,
		// so its intrinsic size NEVER influences the wrapper's layout dimensions.
		const wrapper = $("canvas-wrapper");
		const wrapper_rect = wrapper.getBoundingClientRect();
		const avail_w = wrapper_rect.width;
		const avail_h = wrapper_rect.height;

		const scale = Math.min(avail_w / canvas.width, avail_h / canvas.height, 1);
		const display_w = Math.round(canvas.width * scale);
		const display_h = Math.round(canvas.height * scale);

		// Center the canvas within the wrapper (position:absolute, so manual)
		canvas.style.left = `${Math.round((avail_w - display_w) / 2)}px`;
		canvas.style.top = `${Math.round((avail_h - display_h) / 2)}px`;
		canvas.style.width = `${display_w}px`;
		canvas.style.height = `${display_h}px`;

		// Read actual CSS display dimensions for crop coordinate calculations
		const rect = canvas.getBoundingClientRect();
		image_display = { width: rect.width, height: rect.height };

		// Reset crop
		crop = { left: 0, top: 0, width: 0, height: 0 };
		hide_crop_overlay();
		preview_url = null;
		_auto_resize_applied = false;

		// Show original pixel size and filename
		const orig_size_el = $("original-size");
		if (orig_size_el) {
			orig_size_el.textContent = `${image_natural.width} × ${image_natural.height} px`;
		}

		// Show original filename
		const orig_name_el = $("original-filename");
		if (orig_name_el) {
			orig_name_el.textContent = name || "(unnamed)";
		}

		// Clear preview size until a preview is generated
		const prev_size_el = $("preview-size");
		if (prev_size_el) prev_size_el.textContent = "";

		// Enable save button (for both modes)
		$("save-btn").disabled = false;

		update_dim_display();
		show_status("", "");

		URL.revokeObjectURL(url);

		// Auto-resize for large images (new mode)
		if (!edit_mode) {
			const longest = Math.max(image_natural.width, image_natural.height);
			if (longest > 3000) {
				const target = 3000;
				$("resize-width").value = String(target);
				_auto_resize_applied = true;
				update_dim_display();
				trigger_auto_preview();
			}
		}
	}

	// Crop interaction

	function crop_start(e) {
		is_dragging = true;
		const rect = $("crop-canvas").getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		drag_start = {
			x: Math.max(0, Math.min(x, image_display.width)),
			y: Math.max(0, Math.min(y, image_display.height)),
		};

		// Listen on document so dragging continues even if mouse leaves the canvas
		document.addEventListener("mousemove", on_drag_move);
		document.addEventListener("mouseup", on_drag_end);
	}

	function on_drag_move(e) {
		if (!is_dragging) return;

		const rect = $("crop-canvas").getBoundingClientRect();
		const x = Math.max(0, Math.min(e.clientX - rect.left, image_display.width));
		const y = Math.max(0, Math.min(e.clientY - rect.top, image_display.height));

		const left = Math.min(drag_start.x, x);
		const top = Math.min(drag_start.y, y);
		const width = Math.max(1, Math.abs(x - drag_start.x));
		const height = Math.max(1, Math.abs(y - drag_start.y));

		crop = { left, top, width, height };
		show_crop_overlay();
	}

	function on_drag_end() {
		if (!is_dragging) return;
		is_dragging = false;

		// Remove document listeners
		document.removeEventListener("mousemove", on_drag_move);
		document.removeEventListener("mouseup", on_drag_end);

		// If crop is very small, hide overlay
		if (crop.width < 5 || crop.height < 5) {
			crop = { left: 0, top: 0, width: 0, height: 0 };
			hide_crop_overlay();
		}

		update_dim_display();
		trigger_auto_preview();
	}

	function show_crop_overlay() {
		const overlay = $("crop-overlay");
		const info = $("crop-info");

		const { left, top, width, height } = crop;

		// The canvas is position:absolute and centered within the wrapper,
		// so the overlay (also position:absolute in the wrapper) needs to
		// account for the canvas's offset.
		const canvas = $("crop-canvas");
		const offset_left = canvas.offsetLeft || 0;
		const offset_top = canvas.offsetTop || 0;

		overlay.style.left = `${left + offset_left}px`;
		overlay.style.top = `${top + offset_top}px`;
		overlay.style.width = `${width}px`;
		overlay.style.height = `${height}px`;
		overlay.classList.remove("hidden");
		overlay.classList.add("active");

		// Calculate actual pixel values based on display/natural ratio
		const ratio_x = image_natural.width / image_display.width;
		const ratio_y = image_natural.height / image_display.height;
		const nat_left = Math.round(left * ratio_x);
		const nat_top = Math.round(top * ratio_y);
		const nat_width = Math.round(width * ratio_x);
		const nat_height = Math.round(height * ratio_y);

		info.textContent = `${nat_width} × ${nat_height} px`;
		crop_display_info = `Crop: ${nat_left}, ${nat_top} → ${nat_width} × ${nat_height}`;

		$("crop-display").textContent = crop_display_info;
	}

	function hide_crop_overlay() {
		const overlay = $("crop-overlay");
		overlay.classList.remove("active");
		overlay.classList.add("hidden");
	}

	// Update displays

	function update_dim_display() {
		const format = $("format-select").value;

		if (!image_natural.width) return;

		let w = image_natural.width;
		let h = image_natural.height;

		// If crop is active, use crop dimensions
		if (crop.width > 0 && crop.height > 0) {
			const ratio_x = image_natural.width / image_display.width;
			const ratio_y = image_natural.height / image_display.height;
			w = Math.round(crop.width * ratio_x);
			h = Math.round(crop.height * ratio_y);
		}

		// If resize is set, show those dimensions
		const rw_el = $("resize-width");
		const rh_el = $("resize-height");
		const rw = parseInt(rw_el?.value || "0", 10);
		const rh = parseInt(rh_el?.value || "0", 10);
		if (rw > 0 || rh > 0) {
			if (rw > 0) w = rw;
			if (rh > 0) h = rh;
		}

		const display = $("output-dim-display");
		if (display) {
			display.textContent = `Output: ${w} × ${h} ${format.toUpperCase()}`;
		}
	}

	// Auto-preview

	function trigger_auto_preview() {
		if (preview_timer) clearTimeout(preview_timer);
		preview_timer = setTimeout(() => do_auto_preview(), 500);
	}

	async function do_auto_preview() {
		if (!image_data || processing) return;

		// Update dim display
		update_dim_display();

		processing = true;
		set_buttons_disabled(true);
		$("preview-loading").classList.remove("hidden");

		try {
			const result = await send_to_server(false);
			if (!result) return;

			const blob = new Blob([result.data], { type: result.mime });
			const url = URL.createObjectURL(blob);
			if (preview_url) URL.revokeObjectURL(preview_url);
			preview_url = url;

			const preview_img = $("preview-img");
			preview_img.src = url;
			// Don't set explicit width/height - CSS max-width: 100% prevents enlargement
			// while allowing smaller previews to display at their natural size
			preview_img.removeAttribute("width");
			preview_img.removeAttribute("height");
			preview_img.classList.remove("hidden");
			$("preview-panel-right").classList.add("active");
			$("preview-empty").style.display = "none";

			// Show preview pixel size
			const prev_size_el = $("preview-size");
			if (prev_size_el && result.width && result.height) {
				prev_size_el.textContent = `${result.width} × ${result.height} px`;
			}
		} catch  {
			// Silent fail for auto-preview
		} finally {
			processing = false;
			set_buttons_disabled(false);
			$("preview-loading").classList.add("hidden");
		}
	}

	// Server interaction

	async function save_image() {
		if (!image_data || processing) return;

		processing = true;
		show_status("Saving to S3...", "info");
		set_buttons_disabled(true);

		try {
			const result = await send_to_server(true);

			show_status(
				`Saved: ${result.s3_url} (${result.width} × ${result.height} ${result.format.toUpperCase()}, ${
					(result.size_kb || 0).toFixed(1)
				} KB)`,
				"success",
			);

			// If save as copy, go to index
			if (result.db_id && save_as_copy) {
				save_as_copy = false;
				window.location.href = app_basepath;
			} else if (result.db_id && !edit_mode && !original_s3_key) {
				// New upload -> go to index
				window.location.href = app_basepath;
			} else if (return_url) {
				window.location.href = return_url;
			}
		} catch (err) {
			show_status(`Save failed: ${err.message}`, "error");
		} finally {
			processing = false;
			save_as_copy = false;
			set_buttons_disabled(false);
		}
	}

	function save_as_copy_handler() {
		save_as_copy = true;
		save_image();
	}

	async function send_to_server(save_to_s3) {
		// Build form data
		const form_data = new FormData();

		// CSRF token
		if (csrf_token) {
			form_data.append("_csrf_token", csrf_token);
		}

		// Original image
		const blob = new Blob([image_data.data], { type: image_data.mime });
		form_data.append("original_filename", image_data.name); // ← add this
		form_data.append("image", blob, image_data.name);

		// Crop coords (natural-size coordinates)
		if (crop.width > 0 && crop.height > 0) {
			const ratio_x = image_natural.width / image_display.width;
			const ratio_y = image_natural.height / image_display.height;
			form_data.append("crop_left", String(Math.round(crop.left * ratio_x)));
			form_data.append("crop_top", String(Math.round(crop.top * ratio_y)));
			form_data.append("crop_width", String(Math.round(crop.width * ratio_x)));
			form_data.append("crop_height", String(Math.round(crop.height * ratio_y)));
		}

		// Resize (clamped to max 5000)
		const rw = Math.min(parseInt($("resize-width").value, 10) || 0, 5000);
		const rh = Math.min(parseInt($("resize-height").value, 10) || 0, 5000);
		if (rw > 0) form_data.append("resize_width", String(rw));
		if (rh > 0) form_data.append("resize_height", String(rh));

		// Also clamp the input elements so the UI reflects the actual sent value
		if ($("resize-width").value && parseInt($("resize-width").value, 10) > 5000) $("resize-width").value = "5000";
		if ($("resize-height").value && parseInt($("resize-height").value, 10) > 5000) $("resize-height").value = "5000";

		// Format
		form_data.append("format", $("format-select").value);

		// Quality
		form_data.append("quality", $("quality-input").value || "85");

		// Folder
		const folder_val = $("image-folder")
			.value.trim()
			.replace(/^\/+|\/+$/g, "") || "";
		form_data.append("folder", folder_val);

		// Metadata
		const title = $("image-title").value.trim();
		const description = $("image-description").value.trim();
		const tags = $("image-tags").value.trim();
		if (title) form_data.append("title", title);
		if (description) form_data.append("description", description);
		if (tags) form_data.append("tags", tags);

		// save_as_copy flag
		if (save_as_copy) {
			form_data.append("save_as_copy", "1");
		}

		// Original S3 key (for reference)
		if (original_s3_key) {
			form_data.append("s3_key", original_s3_key);
		}

		// Image DB id (edit mode)
		if (image_id) {
			form_data.append("image_id", image_id);
		}

		// keep_original: checked = delete (don't keep), unchecked = keep
		const keep_original_el = $("keep-original");
		const keep_original = keep_original_el ? !keep_original_el.checked : true;
		form_data.append("keep_original", keep_original ? "1" : "0");

		const url = save_to_s3 ? save_url : process_url;
		const response = await fetch(url, {
			method: "POST",
			body: form_data,
		});

		if (!response.ok) {
			const err_text = await response.text().catch(() => "Unknown error");
			throw new Error(`Server error (${response.status}): ${err_text}`);
		}

		if (save_to_s3) {
			return await response.json();
		} else {
			const mime = response.headers.get("Content-Type") || "image/webp";
			const data = await response.arrayBuffer();
			return {
				data,
				mime,
				width: parseInt(response.headers.get("X-Image-Width") || "0", 10),
				height: parseInt(response.headers.get("X-Image-Height") || "0", 10),
				format: response.headers.get("X-Image-Format") || "webp",
				size_kb: data.byteLength / 1024,
			};
		}
	}

	// UI helpers

	function show_status(message, type) {
		const bar = $("status-bar");
		bar.textContent = message;
		bar.className = `hidden px-3 py-2 rounded text-sm ${
			type === "error"
				? "!block bg-red-50 text-brand border border-red-200"
				: type === "success"
				? "!block bg-green-50 text-green-600 border border-green-200"
				: type === "info"
				? "!block bg-blue-50 text-blue-600 border border-blue-200"
				: ""
		}`;
	}

	function set_buttons_disabled(disabled) {
		const save_btn = $("save-btn");
		save_btn.disabled = disabled;
		let spinner = save_btn.querySelector(".btn-spinner");
		let label = save_btn.querySelector(".btn-label");
		if (spinner) spinner.classList.toggle("hidden", !disabled);
		if (label) label.classList.toggle("hidden", disabled);

		const copy_btn = $("save-as-copy-btn");
		if (copy_btn) {
			copy_btn.disabled = disabled;
			spinner = copy_btn.querySelector(".btn-spinner");
			label = copy_btn.querySelector(".btn-label");
			if (spinner) spinner.classList.toggle("hidden", !disabled);
			if (label) label.classList.toggle("hidden", disabled);
		}
	}

	function clear_editor() {
		image_data = null;
		crop = { left: 0, top: 0, width: 0, height: 0 };
		save_as_copy = false;
		if (preview_url) {
			URL.revokeObjectURL(preview_url);
			preview_url = null;
		}

		const canvas = $("crop-canvas");
		const ctx = canvas.getContext("2d");
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		$("image-area").classList.add("hidden");
		$("editor-form-panel").classList.add("hidden");
		canvas.style.removeProperty("width");
		canvas.style.removeProperty("height");
		canvas.style.removeProperty("left");
		canvas.style.removeProperty("top");
		$("preview-panel-right").classList.remove("active");
		$("preview-empty").style.display = "";
		$("preview-img").src = "";
		$("preview-img").classList.add("hidden");
		$("preview-loading").classList.add("hidden");
		$("save-btn").disabled = true;
		$("file-input").value = "";
		$("url-input").value = "";
		$("image-folder").value = folder || "";
		$("image-title").value = "";
		$("image-description").value = "";
		$("image-tags").value = "";
		$("output-dim-display").textContent = "";
		$("resize-width").value = "";
		$("resize-height").value = "";
		$("format-select").value = "webp";
		$("quality-input").value = "85";
		if ($("keep-original")) $("keep-original").checked = true;

		show_status("", "");

		document.dispatchEvent(
			new CustomEvent("image-editor:cancel", {
				bubbles: true,
			}),
		);
	}

	// Event binding

	function bind_events() {
		// Source tabs
		document.querySelectorAll("#source-tabs .tab-btn").forEach((tab) => {
			tab.addEventListener("click", () => switch_source_tab(tab.dataset.tab));
		});

		// Upload (new mode only)
		const drop_zone = $("drop-zone");
		if (drop_zone) {
			const file_input = $("file-input");
			drop_zone.addEventListener("click", () => file_input?.click());
			file_input?.addEventListener("change", (e) => {
				if (e.target.files?.[0]) load_file(e.target.files[0]);
			});

			// Drag & drop
			drop_zone.addEventListener("dragover", (e) => {
				e.preventDefault();
				drop_zone.classList.add("drag-over");
			});
			drop_zone.addEventListener("dragleave", () => {
				drop_zone.classList.remove("drag-over");
			});
			drop_zone.addEventListener("drop", (e) => {
				e.preventDefault();
				drop_zone.classList.remove("drag-over");
				if (e.dataTransfer?.files?.[0]) load_file(e.dataTransfer.files[0]);
			});
		}

		// URL fetch (new mode only)
		const fetch_btn = $("fetch-url-btn");
		const url_input = $("url-input");
		if (fetch_btn && url_input) {
			fetch_btn.addEventListener("click", () => fetch_url());
			url_input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") fetch_url();
			});
		}

		// Clipboard paste - only loads when paste tab is active AND no image is already loaded
		document.addEventListener("paste", (e) => {
			// Only handle if paste tab is active and no image is already displayed
			if (image_data) return; // Don't override an already-loaded image

			const active_tab = document.querySelector("#source-tabs .tab-btn.active");
			if (!active_tab || active_tab.dataset.tab !== "paste") return;

			const items = e.clipboardData?.items;
			if (!items) return;
			for (const item of items) {
				if (item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) {
						load_file(file);
					}
					return;
				}
			}
		});

		// Canvas crop start - document-level mousemove/mouseup handle the rest
		const canvas = $("crop-canvas");
		canvas.addEventListener("mousedown", (e) => crop_start(e));

		// Clamp resize inputs to max 5000
		["resize-width", "resize-height"].forEach((id) => {
			const el = $(id);
			if (el) {
				el.addEventListener("input", () => {
					const val = parseInt(el.value, 10);
					if (val > 5000) el.value = "5000";
				});
			}
		});

		// Format/quality/resize changes -> auto-preview
		["format-select", "quality-input", "resize-width", "resize-height"].forEach((id) => {
			const el = $(id);
			if (el) el.addEventListener("input", () => trigger_auto_preview());
		});

		// Buttons
		$("clear-btn").addEventListener("click", () => clear_editor());
		$("save-btn").addEventListener("click", () => save_image());

		const copy_btn = $("save-as-copy-btn");
		if (copy_btn) {
			copy_btn.addEventListener("click", () => save_as_copy_handler());
		}
	}

	// Init

	function init() {
		// Pre-fill metadata
		if (config.title) $("image-title").value = config.title;
		if (config.description) $("image-description").value = config.description;
		if (config.tags) $("image-tags").value = config.tags;
		if (config.folder) $("image-folder").value = config.folder;

		if (edit_mode) {
			// Preload image from S3
			if (original_s3_key) {
				preload_from_s3(original_s3_key);
			}
		} else {
			// Keep original checkbox defaults to checked
			if ($("keep-original")) $("keep-original").checked = true;
		}

		bind_events();
	}

	init();
};
