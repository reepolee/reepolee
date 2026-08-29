const GITHUB_LABELS = [
	{ name: "bug", color: "#d73a4a" },
	{ name: "documentation", color: "#0075ca" },
	{ name: "duplicate", color: "#cfd3d7" },
	{ name: "enhancement", color: "#a2eeef" },
	{ name: "good first issue", color: "#7057ff" },
	{ name: "help wanted", color: "#008672" },
	{ name: "invalid", color: "#e4e669" },
	{ name: "question", color: "#d876e3" },
	{ name: "wontfix", color: "#ffffff" },
];

let dialog_el = null;
let filed_from_url = null; // page URL captured when the dialog opened (issue #11)
let snapshots = []; // ordered list of { label, blob } (issue #153)

// Theming comes from the app's Tailwind tokens (css/app.css). The dialog uses
// semantic utilities (bg-surface-raised, text-text-tertiary, border-border, ...)
// whose underlying CSS variables flip with the app's html.dark class / OS
// preference, so no per-element theme handling is needed here.

// Populate the Repo dropdown from GET /__issue_repos (first entry is the
// default shown by the server). The endpoint degrades to an empty list when
// no repos are configured, in which case the select keeps its single disabled
// prompt option and the server falls back to its own default behavior.
async function load_repos() {
	if (!dialog_el) return;
	const select = dialog_el.querySelector("#issue-reporter-repo");
	if (!select) return;
	try {
		const response = await fetch("/__issue_repos");
		const data = await response.json();
		const repos = Array.isArray(data?.repos) ? data.repos : [];
		select.innerHTML = "";
		if (repos.length === 0) {
			const option = document.createElement("option");
			option.value = "";
			option.textContent = "No repo configured";
			option.disabled = true;
			select.appendChild(option);
			return;
		}
		repos.forEach((repo, index) => {
			const option = document.createElement("option");
			option.value = repo;
			option.textContent = repo;
			if (index === 0) option.selected = true;
			select.appendChild(option);
		});
	} catch {
		const option = document.createElement("option");
		option.value = "";
		option.textContent = "No repo configured";
		option.disabled = true;
		select.appendChild(option);
	}
}

function build_dialog() {
	const dialog = document.createElement("dialog");
	dialog.id = "issue-reporter-dialog";
	dialog.className = "w-[520px] max-w-[92vw] bg-surface-raised shadow-lg";

	const labels_html = GITHUB_LABELS.map((label) => `
		<label class="my-0.5 mr-2.5 inline-flex cursor-pointer items-center gap-1 text-[13px]">
			<input type="checkbox" name="labels" value="${label.name}" />
			<span class="inline-block h-2.5 w-2.5 rounded-full border border-border" style="background:${label.color}"></span>
			${label.name}
		</label>
	`).join("");

	dialog.innerHTML = `
		<form id="issue-reporter-form" class="flex flex-col gap-3 p-5 text-sm">
			<h2 class="m-0 text-base font-semibold">New GitHub Issue</h2>

			<label class="flex flex-col gap-1">
				Repo:
				<select name="repo" id="issue-reporter-repo" class="w-full rounded-sm border border-border bg-surface px-2 py-1.5">
					<option value="">Loading…</option>
				</select>
			</label>

			<label class="flex flex-col gap-1">
				Title:
				<input type="text" name="title" required class="w-full rounded-sm border border-border bg-surface px-2 py-1.5" />
			</label>

			<div>
				<div class="mb-1">Labels:</div>
				${labels_html}
			</div>

			<div class="flex flex-col gap-1">
				<label for="issue-reporter-description">Description:</label>
				<markdown-editor id="issue-reporter-description" name="description" placeholder="Describe the issue... (Markdown supported: **bold**, _italic_, # headings, \`code\`, - lists)"></markdown-editor>
			</div>

			<div>
				<div class="mb-1">Screenshots:</div>

				<div class="mb-1.5 flex flex-wrap items-center gap-2">
					<button type="button" id="issue-reporter-capture-before" class="capture-btn cursor-pointer rounded-sm border border-border bg-surface px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-50">Capture before state</button>
					<div id="issue-reporter-before-slot" class="flex flex-wrap items-center gap-2"></div>
				</div>

				<div class="mb-1.5 flex flex-wrap items-center gap-2">
					<button type="button" id="issue-reporter-capture-after" class="capture-btn cursor-pointer rounded-sm border border-border bg-surface px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-50">Capture after state</button>
					<div id="issue-reporter-after-slot" class="flex flex-wrap items-center gap-2"></div>
				</div>

				<div class="mb-1.5 flex flex-wrap items-center gap-2">
					<button type="button" id="issue-reporter-add-another" class="capture-btn cursor-pointer rounded-sm border border-border bg-surface px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-50">Add another</button>
					<button type="button" id="issue-reporter-paste" class="cursor-pointer rounded-sm border border-border bg-surface px-2.5 py-1">Paste from clipboard</button>
				</div>

				<div id="issue-reporter-extra-slot" class="flex flex-wrap items-center gap-2"></div>

				<div id="issue-reporter-capture-hint" class="mb-1.5 hidden text-xs text-warning">Screen capture needs https - open over your tunnel, or use "Paste from clipboard" instead.</div>
				<span id="issue-reporter-screenshot-status" class="text-xs text-text-tertiary"></span>
			</div>

			<div id="issue-reporter-error" class="hidden text-[13px] text-danger"></div>
			<div id="issue-reporter-success" class="hidden text-[13px] text-success"></div>

			<div class="mt-1 flex justify-end gap-2">
				<button type="button" id="issue-reporter-cancel" class="cursor-pointer rounded-sm border border-border bg-surface px-3 py-1.5">Cancel</button>
				<button type="submit" id="issue-reporter-submit" class="cursor-pointer rounded-sm border border-success bg-success px-3 py-1.5 text-white">Create Issue</button>
			</div>
		</form>
	`;

	document.body.appendChild(dialog);
	return dialog;
}

function set_status(message) {
	if (!dialog_el) return;
	const status_el = dialog_el.querySelector("#issue-reporter-screenshot-status");
	if (status_el) status_el.textContent = message;
}

// Enable/disable the capture buttons based on whether getDisplayMedia is
// available in this context, and show the secure-context hint when it is not.
function update_capture_availability() {
	if (!dialog_el) return;
	const supported = screen_capture_supported();
	for (const button of dialog_el.querySelectorAll(".capture-btn")) {
		button.disabled = !supported;
	}
	dialog_el.querySelector("#issue-reporter-capture-hint").classList.toggle("hidden", supported);
}

function add_snapshot(label, blob) {
	snapshots.push({ label: label || "Screenshot", blob });
	render_thumbnails();
}

function build_snapshot_row(snapshot, index) {
	const row = document.createElement("div");
	row.className = "flex items-center gap-2";

	const image = document.createElement("img");
	image.src = URL.createObjectURL(snapshot.blob);
	image.className = "h-[54px] w-[72px] rounded border border-border object-cover";

	const label = document.createElement("input");
	label.type = "text";
	label.value = snapshot.label;
	label.className = "w-[110px] rounded border border-border bg-surface px-1.5 py-1";
	label.addEventListener("change", () => { snapshot.label = label.value.trim() || "Screenshot"; });

	const annotate_btn = document.createElement("button");
	annotate_btn.type = "button";
	annotate_btn.textContent = "Annotate";
	annotate_btn.className = "cursor-pointer rounded border border-border bg-surface px-2 py-1 text-xs";
	annotate_btn.addEventListener("click", () => re_annotate(index));

	const remove_btn = document.createElement("button");
	remove_btn.type = "button";
	remove_btn.textContent = "Remove";
	remove_btn.className = "cursor-pointer p-1 text-xs text-danger";
	remove_btn.addEventListener("click", () => {
		snapshots.splice(index, 1);
		render_thumbnails();
	});

	row.append(image, label, annotate_btn, remove_btn);
	return row;
}

function render_thumbnails() {
	const slots = {
		before: dialog_el.querySelector("#issue-reporter-before-slot"),
		after: dialog_el.querySelector("#issue-reporter-after-slot"),
		extra: dialog_el.querySelector("#issue-reporter-extra-slot"),
	};
	for (const slot of Object.values(slots)) slot.innerHTML = "";

	snapshots.forEach((snapshot, index) => {
		const row = build_snapshot_row(snapshot, index);
		if (snapshot.label === "Before") slots.before.appendChild(row);
		else if (snapshot.label === "After") slots.after.appendChild(row);
		else slots.extra.appendChild(row);
	});
}

async function paste_from_clipboard() {
	set_status("");
	try {
		const clipboard_items = await navigator.clipboard.read();
		for (const item of clipboard_items) {
			const image_type = item.types.find((t) => t.startsWith("image/"));
			if (image_type) {
				const blob = await item.getType(image_type);
				add_snapshot("Screenshot", blob);
				return;
			}
		}
		set_status("No image found in clipboard");
	} catch (err) {
		const err_name = err instanceof Error ? err.name : "Error";
		const err_message = err instanceof Error ? err.message : String(err);
		set_status(`Clipboard read failed (${err_name}: ${err_message}) - use Ctrl+V in the dialog instead`);
	}
}

function blob_to_image(blob) {
	return new Promise((resolve, reject) => {
		const object_url = URL.createObjectURL(blob);
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("Failed to load image"));
		image.src = object_url;
	});
}

// Screen capture (getDisplayMedia) is only exposed in a secure context (https
// or localhost). QA reaches the app over https via a Cloudflare tunnel, so it
// works there; on plain http the capture button is disabled with a hint.
function screen_capture_supported() {
	return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

async function capture_viewport_frame() {
	if (!screen_capture_supported()) {
		throw new Error("Screen capture requires a secure context (https or localhost)");
	}
	const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
	try {
		const video = document.createElement("video");
		video.muted = true;
		video.srcObject = stream;
		await new Promise((resolve, reject) => {
			if (video.videoWidth) return resolve();
			video.onloadeddata = resolve;
			video.onerror = () => reject(new Error("Failed to decode the captured stream"));
			video.play().catch(reject);
		});
		await settle_capture_stream(video);
		const canvas = document.createElement("canvas");
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		canvas.getContext("2d").drawImage(video, 0, 0);
		return canvas;
	} finally {
		stream.getTracks().forEach((track) => track.stop());
	}
}

// Chrome composites its tab-capture indicator ("You're sharing this screen"
// toast + tab outline) into the first frames of a tab-capture stream, sometimes
// at the indicator's own small dimensions. The real page frames only arrive
// once the indicator clears, so grabbing the first decoded frame produced a
// screenshot of the indicator alone (issue #406). Wait for the stream to switch
// to real content: the switch changes the video dimensions and fires a resize
// event on the video element, while window/screen capture never resizes, so the
// wait is capped by a timeout instead of hanging when the first size is final.
function settle_capture_stream(video) {
	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, 1500);
		video.addEventListener("resize", () => {
			clearTimeout(timeout);
			// Let the first frame at the new dimensions land before drawing.
			requestAnimationFrame(() => requestAnimationFrame(resolve));
		}, { once: true });
	});
}

function reopen_issue_dialog() {
	if (!dialog_el || dialog_el.open) return;
	dialog_el.showModal();
}

async function capture_and_annotate(label) {
	// Close the dialog first so it does not appear in the captured screen.
	dialog_el.close();
	let capture_error = "";
	try {
		const canvas = await capture_viewport_frame();
		// Load the most recent snapshot as a reference so the before and after
		// states are visible side by side while annotating the new capture.
		let reference_canvas = null;
		let reference_label = null;
		if (snapshots.length > 0) {
			const previous = snapshots[snapshots.length - 1];
			try {
				const image = await blob_to_image(previous.blob);
				reference_canvas = document.createElement("canvas");
				reference_canvas.width = image.naturalWidth;
				reference_canvas.height = image.naturalHeight;
				reference_canvas.getContext("2d").drawImage(image, 0, 0);
				reference_label = previous.label || "Previous";
			} catch {
				// Previous snapshot could not be loaded; proceed without a reference.
			}
		}
		return await run_annotation(canvas, reference_canvas, reference_label, label);
	} catch (err) {
		capture_error = err instanceof Error ? err.message : String(err);
		return null;
	} finally {
		// Always restore the issue form, including when the annotation editor is
		// canceled or an unexpected capture/annotation error occurs.
		reopen_issue_dialog();
		if (capture_error) set_status(`Capture failed: ${capture_error}`);
	}
}

async function re_annotate(index) {
	const snapshot = snapshots[index];
	let canvas;
	try {
		const image = await blob_to_image(snapshot.blob);
		canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		canvas.getContext("2d").drawImage(image, 0, 0);
	} catch (err) {
		set_status("Failed to load snapshot for annotation");
		return;
	}
	dialog_el.close();
	try {
		const blob = await run_annotation(canvas);
		if (blob) {
			snapshot.blob = blob;
			render_thumbnails();
		}
	} finally {
		// Canceling re-annotation must return to the issue form with the
		// original snapshot still available.
		reopen_issue_dialog();
	}
}

async function on_capture(label) {
	set_status("");
	const blob = await capture_and_annotate(label);
	if (blob) add_snapshot(label, blob);
}

// Sample the captured frame to decide whether it is dark or light, so the
// default annotation color contrasts with the screenshot.
function canvas_is_dark(canvas) {
	try {
		const sample = document.createElement("canvas");
		sample.width = 16;
		sample.height = 16;
		const sample_ctx = sample.getContext("2d", { willReadFrequently: true });
		sample_ctx.drawImage(canvas, 0, 0, 16, 16);
		const data = sample_ctx.getImageData(0, 0, 16, 16).data;
		let luminance = 0;
		for (let i = 0; i < data.length; i += 4) {
			luminance += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
		}
		return luminance / (16 * 16) < 128;
	} catch {
		return false;
	}
}

// Annotation tool settings are persisted in localStorage so QA does not have to
// re-pick the tool, color, and stroke width on every capture.
const ANNOTATION_SETTINGS_KEY = "reepolee.annotation-settings";

function load_annotation_settings() {
	try {
		return JSON.parse(localStorage.getItem(ANNOTATION_SETTINGS_KEY)) || {};
	} catch {
		return {};
	}
}

function save_annotation_settings(settings) {
	try {
		localStorage.setItem(ANNOTATION_SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// localStorage may be unavailable (private mode / blocked); ignore.
	}
}

// Full-viewport annotation editor. Draws shapes on top of `base_canvas` and
// resolves with the flattened PNG blob, or null when the user cancels.
function run_annotation(base_canvas, reference_canvas, reference_label, active_label) {
	return new Promise((resolve) => {
		const overlay = document.createElement("div");
		overlay.className = "fixed inset-0 z-[2147483000] flex select-none flex-col bg-black/85";

		const toolbar = document.createElement("div");
		toolbar.className = "flex items-center gap-2.5 overflow-x-auto bg-surface-overlay px-3 py-2 text-sm text-white";

		const tool_select = document.createElement("select");
		tool_select.innerHTML = `
			<option value="arrow">Arrow</option>
			<option value="double_arrow">Double Arrow</option>
			<option value="rect">Rectangle</option>
			<option value="ellipse">Ellipse</option>
			<option value="crop">Crop</option>
			<option value="pen">Pen</option>
			<option value="blur">Blur / redact</option>
			<option value="text">Text</option>
		`;
		tool_select.className = "h-7 w-[130px] shrink-0 appearance-none rounded-sm border border-neutral-400 bg-white px-2 pr-6 leading-none text-[#1f2328]";
		tool_select.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns=\'http://www.w3.org/2000/svg\'%20viewBox=\'0%200%2016%2016\'%3E%3Cpath%20fill=\'%236b7280\'%20d=\'M8%2011%203%206h10z\'/%3E%3C/svg%3E")';
		tool_select.style.backgroundRepeat = "no-repeat";
		tool_select.style.backgroundPosition = "right 8px center";
		tool_select.style.backgroundSize = "12px 12px";

		const saved = load_annotation_settings();
		const is_dark = canvas_is_dark(base_canvas);
		const color_input = document.createElement("input");
		color_input.type = "color";
		color_input.value = saved.color || (is_dark ? "#ffffff" : "#111111");
		color_input.className = "h-7 w-8 cursor-pointer border-none bg-transparent p-0";

		const width_input = document.createElement("input");
		width_input.type = "range";
		width_input.min = "2";
		width_input.max = "24";
		width_input.value = saved.width || "4";
		width_input.className = "w-[90px]";

		if (saved.tool && Array.from(tool_select.options).some((option) => option.value === saved.tool)) {
			tool_select.value = saved.tool;
		}

		// Persist tool/width on every change, and color only when the user
		// explicitly picks one - so the auto-contrast default still applies to
		// screenshots of a different brightness until they override it.
		let user_picked_color = false;
		function persist_settings() {
			const settings = load_annotation_settings();
			settings.tool = tool_select.value;
			settings.width = width_input.value;
			if (user_picked_color) settings.color = color_input.value;
			save_annotation_settings(settings);
		}
		tool_select.addEventListener("change", persist_settings);
		width_input.addEventListener("input", persist_settings);
		color_input.addEventListener("input", () => { user_picked_color = true; persist_settings(); });

		function toolbar_button(text) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = text;
			button.className = "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-sm border border-white/20 bg-white/10 px-2.5 leading-none text-white";
			return button;
		}

		function toolbar_group(label, control) {
			const group = document.createElement("span");
			group.className = "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap";
			group.append(label, control);
			return group;
		}

		const undo_btn = toolbar_button("Undo");
		const redo_btn = toolbar_button("Redo");
		const clear_btn = toolbar_button("Clear");
		const cancel_btn = toolbar_button("Cancel");
		const done_btn = toolbar_button("Done");
		done_btn.className = "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-sm border border-success bg-success px-3.5 leading-none text-white";

		toolbar.append(
			toolbar_group("Tool", tool_select),
			toolbar_group("Color", color_input),
			toolbar_group("Width", width_input),
			undo_btn,
			redo_btn,
			clear_btn,
			cancel_btn,
			done_btn
		);

		const canvas_wrap = document.createElement("div");
		canvas_wrap.className = "flex flex-1 items-center justify-center gap-4 overflow-auto p-3";

		function build_panel(label_text, source_canvas, active) {
			const panel = document.createElement("div");
			panel.className = reference_canvas ? "flex min-w-0 flex-1 flex-col items-center gap-1.5" : "flex flex-col items-center gap-1.5";
			if (label_text) {
				const label = document.createElement("div");
				label.textContent = label_text;
				label.className = "text-[13px] text-white opacity-85";
				panel.appendChild(label);
			}
			const el = document.createElement("canvas");
			el.width = source_canvas.width;
			el.height = source_canvas.height;
			el.className = active ? "max-h-[calc(100vh-160px)] max-w-full cursor-crosshair touch-none bg-white" : "max-h-[calc(100vh-160px)] max-w-full bg-white";
			el.getContext("2d").drawImage(source_canvas, 0, 0);
			panel.appendChild(el);
			canvas_wrap.appendChild(panel);
			return { panel, canvas: el };
		}

		const reference_panel = reference_canvas ? build_panel(reference_label || "Previous", reference_canvas, false) : null;
		const canvas = build_panel(active_label || "", base_canvas, true).canvas;

		const ctx = canvas.getContext("2d");

		// Collapse/expand the reference (previous) panel while annotating.
		if (reference_panel) {
			const ref_name = reference_label || "previous";
			const toggle_btn = toolbar_button(`Hide ${ref_name}`);
			toggle_btn.addEventListener("click", () => {
				const was_hidden = reference_panel.panel.style.display === "none";
				reference_panel.panel.style.display = was_hidden ? "" : "none";
				toggle_btn.textContent = `${was_hidden ? "Hide" : "Show"} ${ref_name}`;
			});
			toolbar.insertBefore(toggle_btn, done_btn);
		}

		overlay.append(toolbar, canvas_wrap);
		document.body.appendChild(overlay);

		const actions = []; // completed shapes/blurs, in order
		const redo_stack = [];
		let drawing = null; // in-progress shape

		function canvas_point(event) {
			const rect = canvas.getBoundingClientRect();
			return {
				x: (event.clientX - rect.left) * (canvas.width / rect.width),
				y: (event.clientY - rect.top) * (canvas.height / rect.height),
			};
		}

		function draw_shape(shape) {
			ctx.save();
			ctx.strokeStyle = shape.color;
			ctx.fillStyle = shape.color;
			ctx.lineWidth = shape.size;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			if (shape.type === "pen") {
				ctx.beginPath();
				ctx.moveTo(shape.points[0][0], shape.points[0][1]);
				for (let i = 1; i < shape.points.length; i++) ctx.lineTo(shape.points[i][0], shape.points[i][1]);
				ctx.stroke();
			} else if (shape.type === "arrow" || shape.type === "double_arrow") {
				const dx = shape.x2 - shape.x1;
				const dy = shape.y2 - shape.y1;
				const angle = Math.atan2(dy, dx);
				const head = Math.max(10, shape.size * 3);
				ctx.beginPath();
				ctx.moveTo(shape.x1, shape.y1);
				ctx.lineTo(shape.x2, shape.y2);
				ctx.stroke();
				const draw_arrow_head = (x, y, direction) => {
					ctx.beginPath();
					ctx.moveTo(x, y);
					ctx.lineTo(x - head * Math.cos(direction - Math.PI / 6), y - head * Math.sin(direction - Math.PI / 6));
					ctx.moveTo(x, y);
					ctx.lineTo(x - head * Math.cos(direction + Math.PI / 6), y - head * Math.sin(direction + Math.PI / 6));
					ctx.stroke();
				};
				draw_arrow_head(shape.x2, shape.y2, angle);
				if (shape.type === "double_arrow") draw_arrow_head(shape.x1, shape.y1, angle + Math.PI);
			} else if (shape.type === "rect") {
				const x = Math.min(shape.x1, shape.x2);
				const y = Math.min(shape.y1, shape.y2);
				const w = Math.abs(shape.x2 - shape.x1);
				const h = Math.abs(shape.y2 - shape.y1);
				ctx.strokeRect(x, y, w, h);
			} else if (shape.type === "ellipse") {
				const cx = (shape.x1 + shape.x2) / 2;
				const cy = (shape.y1 + shape.y2) / 2;
				const rx = Math.abs(shape.x2 - shape.x1) / 2;
				const ry = Math.abs(shape.y2 - shape.y1) / 2;
				ctx.beginPath();
				ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
				ctx.stroke();
			} else if (shape.type === "text") {
				// The input the text was typed in uses CSS pixels; canvas fonts use
				// canvas pixels. Scale by the displayed size so the committed text
				// renders at the same on-screen size, and anchor from the top like
				// the input did, so it also stays where it was typed.
				const canvas_rect = canvas.getBoundingClientRect();
				const display_scale = canvas_rect.width / canvas.width;
				ctx.font = `${Math.max(12, shape.size * 4) / display_scale}px system-ui, sans-serif`;
				ctx.textBaseline = "top";
				ctx.fillText(shape.text, shape.x, shape.y);
			}
			ctx.restore();
		}

		function apply_blur(shape) {
			const x = Math.min(shape.x1, shape.x2);
			const y = Math.min(shape.y1, shape.y2);
			const w = Math.abs(shape.x2 - shape.x1);
			const h = Math.abs(shape.y2 - shape.y1);
			if (w < 1 || h < 1) return;
			const radius = Math.max(6, shape.size * 3);
			const tmp = document.createElement("canvas");
			tmp.width = Math.max(1, Math.round(w));
			tmp.height = Math.max(1, Math.round(h));
			tmp.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
			ctx.save();
			ctx.filter = `blur(${radius}px)`;
			ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
			ctx.restore();
		}

		function apply_action(shape) {
			if (shape.type === "blur") apply_blur(shape);
			else if (shape.type !== "crop") draw_shape(shape);
		}

		// The crop tool's keep-region box: dim everything outside the box and
		// outline it, so the user sees exactly what the exported image will
		// focus on. The overlay itself never appears in the export.
		function draw_crop_preview(shape) {
			if (!shape) return;
			const x = Math.min(shape.x1, shape.x2);
			const y = Math.min(shape.y1, shape.y2);
			const w = Math.abs(shape.x2 - shape.x1);
			const h = Math.abs(shape.y2 - shape.y1);
			ctx.save();
			ctx.fillStyle = "rgba(0,0,0,0.45)";
			ctx.fillRect(0, 0, canvas.width, y);
			ctx.fillRect(0, y, x, h);
			ctx.fillRect(x + w, y, canvas.width - x - w, h);
			ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
			ctx.setLineDash([8, 5]);
			ctx.strokeStyle = "#ffffff";
			ctx.lineWidth = 2;
			ctx.strokeRect(x, y, w, h);
			ctx.setLineDash([]);
			ctx.restore();
		}

		// Only the most recently drawn crop box applies - drawing another one
		// replaces the previous keep-region.
		function latest_crop() {
			for (let i = actions.length - 1; i >= 0; i--) {
				if (actions[i].type === "crop") return actions[i];
			}
			return null;
		}

		function redraw() {
			ctx.filter = "none";
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(base_canvas, 0, 0);
			for (const action of actions) apply_action(action);
			if (drawing) apply_action(drawing);
			draw_crop_preview(latest_crop() || (drawing && drawing.type === "crop" ? drawing : null));
		}

		function commit_action(shape) {
			if (shape.type === "crop") {
				// last crop wins: drop any earlier keep-region box
				for (let i = actions.length - 1; i >= 0; i--) {
					if (actions[i].type === "crop") actions.splice(i, 1);
				}
			}
			actions.push(shape);
			redo_stack.length = 0;
		}

		function place_text(point, event) {
			const input = document.createElement("input");
			input.type = "text";
			input.placeholder = "Type annotation...";
			const input_bg = is_dark ? "rgba(20,22,26,.9)" : "rgba(255,255,255,.95)";
			input.className = "absolute z-10 select-text";
			input.style.cssText = `left:${event.clientX}px;top:${event.clientY}px;border:1px solid ${color_input.value};border-radius:4px;padding:2px 6px;font:${Math.max(12, Number(width_input.value) * 4)}px system-ui,sans-serif;color:${color_input.value};background:${input_bg};`;
			overlay.appendChild(input);
			// Defer focus so the browser's default mousedown focus handling cannot
			// immediately blur (and dismiss) the freshly created input.
			setTimeout(() => input.focus(), 0);
			let committed = false;
			function commit() {
				if (committed) return;
				committed = true;
				const text = input.value.trim();
				if (text) {
					// Anchor the committed text exactly where the input's own text
					// sits (offset by its border + padding), converted to canvas
					// coordinates, so the annotation never moves when the input
					// disappears. The font size is scaled in draw_shape() below to
					// match the input's on-screen size (canvas units vs CSS px).
					const input_style = getComputedStyle(input);
					const text_left_css = event.clientX + parseFloat(input_style.borderLeftWidth) + parseFloat(input_style.paddingLeft);
					const text_top_css = event.clientY + parseFloat(input_style.borderTopWidth) + parseFloat(input_style.paddingTop);
					const canvas_rect = canvas.getBoundingClientRect();
					const x = (text_left_css - canvas_rect.left) * (canvas.width / canvas_rect.width);
					const y = (text_top_css - canvas_rect.top) * (canvas.height / canvas_rect.height);
					commit_action({ type: "text", text, x, y, color: color_input.value, size: Number(width_input.value) });
				}
				input.remove();
				redraw();
			}
			input.addEventListener("keydown", (key_event) => {
				if (key_event.key === "Enter") commit();
				else if (key_event.key === "Escape") { committed = true; input.remove(); }
			});
			input.addEventListener("blur", commit);
		}

		function on_pointer_down(event) {
			const point = canvas_point(event);
			const active_tool = tool_select.value;
			if (active_tool === "text") { event.preventDefault(); place_text(point, event); return; }
			drawing = { type: active_tool, color: color_input.value, size: Number(width_input.value), x1: point.x, y1: point.y, x2: point.x, y2: point.y };
			if (active_tool === "pen") drawing.points = [[point.x, point.y]];
			canvas.setPointerCapture(event.pointerId);
			redraw();
		}

		function on_pointer_move(event) {
			if (!drawing) return;
			const point = canvas_point(event);
			if (drawing.type === "pen") drawing.points.push([point.x, point.y]);
			else if ((drawing.type === "arrow" || drawing.type === "double_arrow") && (event.ctrlKey || event.metaKey)) {
				// CTRL constrains arrows to the nearest horizontal or vertical
				// axis: the off-axis coordinate snaps back to its starting
				// value so the arrow never lands a few degrees off.
				if (Math.abs(point.x - drawing.x1) >= Math.abs(point.y - drawing.y1)) {
					drawing.x2 = point.x;
					drawing.y2 = drawing.y1;
				} else {
					drawing.x2 = drawing.x1;
					drawing.y2 = point.y;
				}
			}
			else { drawing.x2 = point.x; drawing.y2 = point.y; }
			redraw();
		}

		function on_pointer_up(event) {
			if (!drawing) return;
			if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
				canvas.releasePointerCapture(event.pointerId);
			}
			// A click-sized crop box is meaningless - drop it instead of
			// committing a keep-region that would clip the whole image.
			if (drawing.type === "crop" && (Math.abs(drawing.x2 - drawing.x1) < 8 || Math.abs(drawing.y2 - drawing.y1) < 8)) {
				drawing = null;
				redraw();
				return;
			}
			commit_action(drawing);
			drawing = null;
			redraw();
		}

		function undo() {
			const action = actions.pop();
			if (action) { redo_stack.push(action); redraw(); }
		}

		function redo() {
			const action = redo_stack.pop();
			if (action) { actions.push(action); redraw(); }
		}

		function clear() {
			actions.length = 0;
			redo_stack.length = 0;
			redraw();
		}

		function cleanup() {
			document.removeEventListener("keydown", on_keydown);
			overlay.remove();
		}

		function finish() {
			// Re-render without the crop overlay - the keep-region box is a UI
			// affordance, not part of the exported image.
			ctx.filter = "none";
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(base_canvas, 0, 0);
			for (const action of actions) apply_action(action);

			const crop = latest_crop();
			let out_canvas = canvas;
			if (crop) {
				const sx = Math.max(0, Math.min(Math.round(Math.min(crop.x1, crop.x2)), canvas.width));
				const sy = Math.max(0, Math.min(Math.round(Math.min(crop.y1, crop.y2)), canvas.height));
				const sw = Math.max(1, Math.min(Math.round(Math.abs(crop.x2 - crop.x1)), canvas.width - sx));
				const sh = Math.max(1, Math.min(Math.round(Math.abs(crop.y2 - crop.y1)), canvas.height - sy));
				const cropped = document.createElement("canvas");
				cropped.width = sw;
				cropped.height = sh;
				cropped.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
				out_canvas = cropped;
			}
			out_canvas.toBlob((blob) => {
				cleanup();
				resolve(blob);
			}, "image/png");
		}

		function cancel() {
			cleanup();
			resolve(null);
		}

		function on_keydown(event) {
			const target = event.target;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
			if (event.key === "Escape") {
				// cancel() reopens the issue dialog asynchronously (the promise
				// resolves on the next microtask). Without preventDefault, the
				// browser's own Escape-closes-dialog default action runs after
				// dispatch and closes the freshly reopened dialog, making the
				// whole issue form (title, snapshots) look lost (issue #398).
				event.preventDefault();
				cancel();
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && event.shiftKey) { event.preventDefault(); redo(); }
		}

		canvas.addEventListener("pointerdown", on_pointer_down);
		canvas.addEventListener("pointermove", on_pointer_move);
		canvas.addEventListener("pointerup", on_pointer_up);
		canvas.addEventListener("pointercancel", on_pointer_up);
		undo_btn.addEventListener("click", undo);
		redo_btn.addEventListener("click", redo);
		clear_btn.addEventListener("click", clear);
		cancel_btn.addEventListener("click", cancel);
		done_btn.addEventListener("click", finish);
		document.addEventListener("keydown", on_keydown);
	});
}

async function submit_issue(event) {
	event.preventDefault();

	const form = dialog_el.querySelector("#issue-reporter-form");
	const submit_btn = dialog_el.querySelector("#issue-reporter-submit");
	const error_el = dialog_el.querySelector("#issue-reporter-error");
	const success_el = dialog_el.querySelector("#issue-reporter-success");

	error_el.classList.add("hidden");
	success_el.classList.add("hidden");

	const form_data = new FormData(form);
	form_data.set("page_url", filed_from_url || window.location.href);
	for (const snapshot of snapshots) {
		form_data.append("screenshot", snapshot.blob, "screenshot.png");
		form_data.append("screenshot_label", snapshot.label || "Screenshot");
	}

	submit_btn.disabled = true;
	submit_btn.textContent = "Creating...";

	try {
		const response = await fetch("/__issue", { method: "POST", body: form_data });
		const result = await response.json();

		if (!response.ok || !result.ok) {
			error_el.textContent = result.error || "Failed to create issue";
			error_el.classList.remove("hidden");
			return;
		}

		// Upload degrades server-side: the issue is filed even when a screenshot
		// fails. Keep the dialog open in that case so the warning is actually read.
		const screenshot_errors = result.screenshot_errors || [];
		if (screenshot_errors.length > 0) {
			success_el.textContent = `Issue created without screenshot(s): ${result.url}`;
			success_el.classList.remove("hidden");
			error_el.textContent = `Screenshot upload failed: ${screenshot_errors.join("; ")}`;
			error_el.classList.remove("hidden");
			window.open(result.url, "_blank");
			return;
		}

		success_el.textContent = `Issue created: ${result.url}`;
		success_el.classList.remove("hidden");
		window.open(result.url, "_blank");
		dialog_el.close();
	} catch (err) {
		error_el.textContent = err instanceof Error ? err.message : String(err);
		error_el.classList.remove("hidden");
	} finally {
		submit_btn.disabled = false;
		submit_btn.textContent = "Create Issue";
	}
}

function reset_form_state() {
	const error_el = dialog_el.querySelector("#issue-reporter-error");
	const success_el = dialog_el.querySelector("#issue-reporter-success");
	error_el.classList.add("hidden");
	success_el.classList.add("hidden");
	dialog_el.querySelector("#issue-reporter-form").reset();
	// form.reset() restores the markdown-editor's hidden textarea to its
	// default (empty) value, but its contenteditable surface still shows the
	// previous filing's rendered markdown - clear both so a fresh dialog opens
	// empty (issue #417).
	const md_editor = dialog_el.querySelector("markdown-editor[name=\"description\"]");
	if (md_editor && typeof md_editor.clear === "function") md_editor.clear();
	snapshots = [];
	render_thumbnails();
	set_status("");
	update_capture_availability();
}

function open_issue_dialog() {
	// Ignore when already open: reset_form_state() below would wipe the title,
	// description, and any captured snapshots the user already entered.
	if (dialog_el && dialog_el.open) return;

	if (!dialog_el) {
		dialog_el = build_dialog();
		load_repos();
		dialog_el.querySelector("#issue-reporter-form").addEventListener("submit", submit_issue);
		dialog_el.querySelector("#issue-reporter-cancel").addEventListener("click", () => dialog_el.close());
		dialog_el.querySelector("#issue-reporter-paste").addEventListener("click", paste_from_clipboard);
		dialog_el.querySelector("#issue-reporter-capture-before").addEventListener("click", () => on_capture("Before"));
		dialog_el.querySelector("#issue-reporter-capture-after").addEventListener("click", () => on_capture("After"));
		dialog_el.querySelector("#issue-reporter-add-another").addEventListener("click", () => on_capture("Screenshot"));
		dialog_el.addEventListener("paste", (event) => {
			const item = Array.from(event.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
			if (item) {
				const file = item.getAsFile();
				if (file) add_snapshot("Screenshot", file);
			}
		});
	}

	reset_form_state();
	filed_from_url = window.location.href;
	dialog_el.showModal();
	dialog_el.querySelector('input[name="title"]').focus();
}

document.addEventListener("keydown", (event) => {
	if (event.ctrlKey && event.shiftKey && (event.key === "I" || event.key === "i")) {
		event.preventDefault();
		open_issue_dialog();
	}
});
