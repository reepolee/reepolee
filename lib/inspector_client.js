/**
 * lib/inspector_client.js
 *
 * Dev-only source inspector client. Injected sibling to livereload_client.js
 * and issue_reporter_client.js by inject_inspector()'s </body> rewrite (dev
 * server only - never present in production). Two chords:
 *   - Meta+Shift (Cmd+Shift on macOS, Win+Shift on Windows/Linux): content tier
 *     - edit a {_ } string in place, a {- }/{@ } markup string in a dialog, or
 *     open a block/component in the editor. Win+Shift+click does not collide
 *     with the reserved Win+Shift+<key> OS shortcuts (those need a third key).
 *   - Alt+Shift: class tier - edit the nearest .ree-stamped tag's class
 *     attribute (patched into the .ree source). A distinct chord from the
 *     content tier; plain Alt+click is avoided (PowerToys reserves it on
 *     Windows), Alt+Shift is not.
 * Hover with a chord held to highlight the target; click (chord still held) to act.
 *
 * Reads the stamps written by lib/inspector_stamp.ts during .ree loading
 * (dev only, cache off): data-ree="<repo-relative-path>:<line>" on block
 * tags, data-ree-i18n="<dotted.path>" + data-ree-i18n-raw="0|1" on
 * translation-lookup spans.
 */
(function () {
	"use strict";

	var STAMP_ATTRS = ["data-ree"];
	var overlay = null;
	var suppressed_disabled_click_target = null;

	// Inspect mode is active while Meta + Shift are held - one unified chord on
	// every platform: Cmd+Shift on macOS, Win+Shift on Windows/Linux (metaKey is
	// the Win/Super key there). Win+Shift+click doesn't collide with the reserved
	// Win+Shift+<key> OS shortcuts, which all need a third keyboard key. Derived
	// per-event from the modifier flags rather than tracked via keydown/keyup, so
	// a missed keyup (e.g. window blur while held) can never leave it stuck on.
	function is_active(e) { return e.metaKey && e.shiftKey; }

	// Class-edit mode is a distinct chord: Alt + Shift (without Ctrl/Cmd). It
	// edits the nearest stamped tag's class attribute in the .ree source, a
	// separate action from the Ctrl/Cmd+Shift content/i18n/open-code tiers.
	function is_class_active(e) { return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey; }

	function nearest_stamped(node) {
		var el = node && node.nodeType === 1 ? node : node && node.parentElement;
		while (el) {
			for (var i = 0; i < STAMP_ATTRS.length; i++) {
				var value = el.getAttribute && el.getAttribute(STAMP_ATTRS[i]);
				if (value) return { el: el, stamp: value, attr: STAMP_ATTRS[i] };
			}
			el = el.parentElement;
		}
		return null;
	}

	// Nearest ancestor stamped from a .ree source (data-ree). Class editing
	// patches .ree source, so this is the same stamp attribute as content.
	function nearest_ree_stamped(node) {
		var el = node && node.nodeType === 1 ? node : node && node.parentElement;
		while (el) {
			var value = el.getAttribute && el.getAttribute("data-ree");
			if (value) return { el: el, stamp: value };
			el = el.parentElement;
		}
		return null;
	}

	function parse_stamp(stamp) {
		var idx = stamp.lastIndexOf(":");
		if (idx < 0) return { file: stamp, line: 1 };
		var parsed = parseInt(stamp.slice(idx + 1), 10);
		var line = parsed > 0 ? parsed : 1;
		return { file: stamp.slice(0, idx), line: line };
	}

	// Nearest ancestor carrying an i18n key (a {_ }/{- }/{@ } wrapper span).
	function nearest_i18n(node) {
		var el = node && node.nodeType === 1 ? node : node && node.parentElement;
		while (el) {
			if (el.getAttribute && el.getAttribute("data-ree-i18n")) return el;
			el = el.parentElement;
		}
		return null;
	}

	// Disabled form controls suppress click events, but the inspector still needs
	// to target their source markup. Pointer events reach the capture listener,
	// so use this only as a disabled-control fallback and keep normal elements on
	// the existing click path.
	function nearest_disabled_control(node) {
		var el = node && node.nodeType === 1 ? node : node && node.parentElement;
		while (el) {
			if (el.matches && el.matches(":disabled")) return el;
			el = el.parentElement;
		}
		return null;
	}

	// -- inspector WebSocket (rides the same /__reload endpoint as live reload) --

	var inspector_ws = null;
	var pending = {};
	var msg_seq = 0;

	function ensure_ws() {
		if (inspector_ws && (inspector_ws.readyState === 0 || inspector_ws.readyState === 1)) return inspector_ws;
		var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		inspector_ws = new WebSocket(
			protocol + "//" + window.location.host + "/__reload",
		);
		inspector_ws.addEventListener("message", function (event) {
			var data;
			try {
				data = JSON.parse(event.data);
			} catch (e) {
				return;
			}
			// Accept reply types from both inspector edit paths (i18n + class); a
			// pending callback is keyed by the echoed id.
			var is_reply = data && (data.type === "i18n_value" || data.type === "i18n_saved" || data.type === "class_value" || data.type === "class_saved");
			if (!is_reply) return;
			var cb = pending[data.id];
			if (cb) {
				delete pending[data.id];
				cb(data);
			}
		});
		return inspector_ws;
	}

	function ws_send(payload, cb) {
		var ws = ensure_ws();
		var id = "m" + (++msg_seq);
		payload.id = id;
		payload.url = window.location.pathname;
		if (cb) pending[id] = cb;
		var send = function () { ws.send(JSON.stringify(payload)); };
		if (ws.readyState === 1) send(); else ws.addEventListener("open", send, { once: true });
	}

	function ensure_overlay() {
		if (overlay) return overlay;
		overlay = document.createElement("div");
		overlay.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;" + "background:rgba(64,128,255,0.18);border:1px solid rgba(64,128,255,0.9);" + "border-radius:2px;transition:all 40ms ease;display:none";
		document.body.appendChild(overlay);
		return overlay;
	}

	var hover_label = null;
	var hover_label_action = null;
	var hover_label_tag = null;
	var hover_label_class = null;
	function ensure_label() {
		if (hover_label) return hover_label;
		hover_label = document.createElement("div");
		hover_label.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;" + "display:none;white-space:nowrap;font:11px system-ui;";

		hover_label_action = document.createElement("span");
		hover_label_action.style.cssText = "padding:2px 6px;border-radius:3px;color:#fff";
		hover_label.appendChild(hover_label_action);

		// Tag name, shown only for the class-tier label: light text on black,
		// displayed before the class value so users see which element they're editing.
		hover_label_tag = document.createElement("span");
		hover_label_tag.style.cssText = "margin-left:4px;padding:1px 4px;border-radius:3px;" + "background:#000;color:#ddd;border:1px solid rgba(255,255,255,0.3);display:none";
		hover_label.appendChild(hover_label_tag);

		// Current class value, shown only for the class-tier label: light text on
		// black, distinct from the action pill so the two read as separate facts
		// (what a click does vs. what is currently on the element).
		hover_label_class = document.createElement("span");
		hover_label_class.style.cssText = "margin-left:4px;padding:1px 4px;border-radius:3px;" + "background:#000;color:#ddd;border:1px solid rgba(255,255,255,0.3);display:none";
		hover_label.appendChild(hover_label_class);

		document.body.appendChild(hover_label);
		return hover_label;
	}

	// Per-action colour, used for both the overlay border/tint and the label.
	var ACTION_COLORS = {
		text: "64,160,96", // green - edit text in place
		markup: "180,120,255", // purple - edit markup in a dialog
		code: "120,120,140", // grey - open in editor
		class: "230,150,40", // amber - edit the tag's class attribute
	};

	function highlight(el, kind) {
		var box = ensure_overlay();
		var rect = el.getBoundingClientRect();
		var rgb = ACTION_COLORS[kind] || ACTION_COLORS.code;
		box.style.display = "block";
		box.style.left = rect.left + "px";
		box.style.top = rect.top + "px";
		box.style.width = rect.width + "px";
		box.style.height = rect.height + "px";
		box.style.background = "rgba(" + rgb + ",0.16)";
		box.style.borderColor = "rgba(" + rgb + ",0.95)";

		var label = ensure_label();
		var text = kind === "text" ? "edit text" : kind === "markup" ? "edit markup" : kind === "class" ? "edit class" : "open code";
		hover_label_action.textContent = text;
		hover_label_action.style.background = "rgb(" + rgb + ")";

		if (kind === "class") {
			var tag_name = el.tagName.toLowerCase();
			hover_label_tag.textContent = "<" + tag_name + ">";
			hover_label_tag.style.display = "inline-block";
			var current_class = el.getAttribute("class") || "(none)";
			hover_label_class.textContent = current_class;
			hover_label_class.style.display = "inline-block";
		} else {
			hover_label_tag.style.display = "none";
			hover_label_class.style.display = "none";
		}

		label.style.display = "block";
		var ly = rect.top - 20;
		label.style.left = rect.left + "px";
		label.style.top = (ly < 0 ? rect.bottom + 4 : ly) + "px";
	}

	function hide_overlay() {
		if (overlay) overlay.style.display = "none";
		if (hover_label) hover_label.style.display = "none";
	}

	function toast(message, ok) {
		var el = document.createElement("div");
		el.textContent = message;
		el.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);" + "z-index:2147483647;padding:6px 12px;border-radius:6px;font:12px system-ui;" + "color:#fff;background:" + (ok ? "#1f7a3a" : "#a11") + ";opacity:0.95";
		document.body.appendChild(el);
		setTimeout(function () { el.remove(); }, 2200);
	}

	// Classify what a click at this target would do. An i18n span with
	// data-ree-i18n-raw="0" is editable text in place; raw="1" is markup edited in
	// a dialog; anything else stamped (a block/component) opens in the editor.
	function classify(target) {
		var i18n_el = nearest_i18n(target);
		if (i18n_el) {
			var raw = i18n_el.getAttribute("data-ree-i18n-raw") === "1";
			return { kind: raw ? "markup" : "text", el: i18n_el, i18n_el: i18n_el };
		}
		var hit = nearest_stamped(target);
		if (hit) return { kind: "code", el: hit.el, stamp: hit.stamp };
		return null;
	}

	// Class-edit target: the nearest .ree-stamped block, with its stamp parsed and
	// the tag name (needed server-side to locate the tag among same-line siblings).
	function classify_class(target) {
		var hit = nearest_ree_stamped(target);
		if (!hit) return null;
		var loc = parse_stamp(hit.stamp);
		return {
			kind: "class",
			el: hit.el,
			file: loc.file,
			line: loc.line,
			tag: hit.el.tagName.toLowerCase(),
		};
	}

	function on_move(e) {
		if (is_class_active(e)) {
			document.body.style.cursor = "crosshair";
			var cc = classify_class(e.target);
			if (cc) highlight(cc.el, "class"); else hide_overlay();
			return;
		}
		if (!is_active(e)) {
			hide_overlay();
			document.body.style.cursor = "";
			return;
		}
		document.body.style.cursor = "crosshair";
		var c = classify(e.target);
		if (c) highlight(c.el, c.kind); else hide_overlay();
	}

	function open_in_editor(stamp) {
		var loc = parse_stamp(stamp);
		var url = "/__ree_open?file=" + encodeURIComponent(loc.file) + "&line=" + loc.line;
		fetch(url, { method: "POST" }).then(function (r) {
			return r.json().then(function (j) {
				return { ok: r.ok, body: j };
			});
		}).then(function (res) {
			if (res.ok) toast("opened " + loc.file + ":" + loc.line, true); else toast(
				"open failed: " + (res.body.error || "error"),
				false
			);
		}).catch(function (err) { toast("open failed: " + err, false); });
	}

	// (1) Plain {_ } string: edit the rendered span in place with contenteditable,
	// text only. No dialog. Enter saves; Esc or blur (click-out) cancels - a save
	// only ever happens on an explicit Enter.
	function edit_text_in_place(i18n_el) {
		var key = i18n_el.getAttribute("data-ree-i18n");
		var file = i18n_el.getAttribute("data-ree-i18n-file");
		var locale = i18n_el.getAttribute("data-ree-i18n-locale");
		var original = i18n_el.textContent;
		i18n_el.setAttribute("contenteditable", "plaintext-only");
		i18n_el.style.outline = "2px solid rgb(" + ACTION_COLORS.text + ")";
		i18n_el.focus();

		var done = false;
		var finish = function (save) {
			if (done) return;
			done = true;
			i18n_el.removeAttribute("contenteditable");
			i18n_el.style.outline = "";
			i18n_el.removeEventListener("keydown", on_key);
			i18n_el.removeEventListener("blur", on_blur);
			var value = i18n_el.textContent;
			if (!save || value === original) {
				i18n_el.textContent = save ? value : original;
				return;
			}
			ws_send({ type: "i18n_update", key: key, file: file, locale: locale, value: value }, function (res) {
				if (res.ok) toast("saved " + key, true); else {
					i18n_el.textContent = original;
					toast("save failed: " + (res.error || "error"), false);
				}
			});
		};
		var on_key = function (ev) {
			if (ev.key === "Enter") {
				ev.preventDefault();
				finish(true);
			} else if (ev.key === "Escape") {
				ev.preventDefault();
				finish(false);
			}
		};
		var on_blur = function () { finish(false); };
		i18n_el.addEventListener("keydown", on_key);
		i18n_el.addEventListener("blur", on_blur);
	}

	// (2) {- }/{@ } markup string: open a dialog with the raw source (fetched via
	// i18n_get), edit as text, save back verbatim.
	var dialog = null;
	function close_dialog() {
		if (dialog) {
			dialog.remove();
			dialog = null;
		}
	}

	function edit_markup_dialog(i18n_el) {
		var key = i18n_el.getAttribute("data-ree-i18n");
		var file = i18n_el.getAttribute("data-ree-i18n-file");
		var locale = i18n_el.getAttribute("data-ree-i18n-locale");
		close_dialog();
		dialog = document.createElement("div");
		dialog.style.cssText = "position:fixed;z-index:2147483647;left:50%;top:20%;transform:translateX(-50%);" + "width:min(680px,90vw);background:#1b1b1f;color:#fff;border:1px solid #555;border-radius:8px;" + "font:13px system-ui;box-shadow:0 8px 32px rgba(0,0,0,0.5);padding:14px";
		dialog.innerHTML = "<div style=\"margin-bottom:8px;color:#bbb\">Edit markup: <b style=\"color:#c9a6ff\">" + key + "</b> <span style=\"color:#777\">(source)</span></div>";

		var ta = document.createElement("textarea");
		ta.style.cssText = "width:100%;min-height:160px;box-sizing:border-box;font:13px/1.5 ui-monospace,monospace;" + "padding:8px;border-radius:6px;border:1px solid #555;background:#111;color:#eee;resize:vertical";
		ta.value = "Loading...";
		ta.disabled = true;
		dialog.appendChild(ta);

		var bar = document.createElement("div");
		bar.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:10px";
		var mk_btn = function (label, primary) {
			var b = document.createElement("button");
			b.textContent = label;
			b.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid #555;cursor:pointer;font:13px system-ui;" + (primary ? "background:#4080ff;color:#fff;border-color:#4080ff" : "background:#2a2a30;color:#ddd");
			bar.appendChild(b);
			return b;
		};
		var cancel_btn = mk_btn("Cancel", false);
		var save_btn = mk_btn("Save", true);
		dialog.appendChild(bar);
		document.body.appendChild(dialog);

		// Fetch current source.
		ws_send({ type: "i18n_get", key: key, file: file, locale: locale }, function (res) {
			if (res.ok) {
				ta.value = res.value || "";
				ta.disabled = false;
				ta.focus();
				ta.select();
			} else {
				ta.value = "";
				ta.disabled = false;
				toast("load failed: " + (res.error || "error"), false);
			}
		});

		cancel_btn.onclick = function () { close_dialog(); };
		save_btn.onclick = function () {
			var value = ta.value;
			ws_send({ type: "i18n_update", key: key, file: file, locale: locale, value: value }, function (res) {
				if (res.ok) {
					toast("saved " + key + " (reloading)", true);
					close_dialog();
				} else toast("save failed: " + (res.error || "error"), false);
			});
		};
		dialog.addEventListener("keydown", function (ev) {
			if (ev.key === "Escape") {
				ev.preventDefault();
				close_dialog();
			} else if (ev.key === "Enter" && ev.ctrlKey) {
				ev.preventDefault();
				save_btn.click();
			}
		});
	}

	// (3) Plain tag class: a single-line input prefilled with the current literal
	// class (fetched via class_get). Enter saves (patches the .ree source), Esc or
	// Cancel/blur discards - a save only ever happens on an explicit Enter/Save.
	function edit_class_dialog(target) {
		close_dialog();
		dialog = document.createElement("div");
		dialog.style.cssText = "position:fixed;z-index:2147483647;left:50%;top:20%;transform:translateX(-50%);" + "width:min(560px,90vw);background:#1b1b1f;color:#fff;border:1px solid #555;border-radius:8px;" + "font:13px system-ui;box-shadow:0 8px 32px rgba(0,0,0,0.5);padding:14px";
		dialog.innerHTML = "<div style=\"margin-bottom:8px;color:#bbb\">Edit class: <b style=\"color:#e69628\">&lt;" + target.tag + "&gt;</b> <span style=\"color:#777\">" + target.file + ":" + target.line + "</span></div>";

		var input = document.createElement("input");
		input.type = "text";
		input.style.cssText = "width:100%;box-sizing:border-box;font:13px/1.5 ui-monospace,monospace;" + "padding:8px;border-radius:6px;border:1px solid #555;background:#111;color:#eee";
		input.value = "Loading...";
		input.disabled = true;
		dialog.appendChild(input);

		var bar = document.createElement("div");
		bar.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:10px";
		var mk_btn = function (label, primary) {
			var b = document.createElement("button");
			b.textContent = label;
			b.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid #555;cursor:pointer;font:13px system-ui;" + (primary ? "background:#e69628;color:#1b1b1f;border-color:#e69628" : "background:#2a2a30;color:#ddd");
			bar.appendChild(b);
			return b;
		};
		var cancel_btn = mk_btn("Cancel", false);
		var save_btn = mk_btn("Save", true);
		dialog.appendChild(bar);
		document.body.appendChild(dialog);

		var save = function () {
			var value = input.value;
			ws_send({
				type: "class_update",
				file: target.file,
				line: target.line,
				tag: target.tag,
				value: value,
			}, function (res) {
				if (res.ok) {
					toast("saved class on <" + target.tag + "> (reloading)", true);
					close_dialog();
				} else toast("save failed: " + (res.error || "error"), false);
			});
		};

		// Fetch current literal class value.
		ws_send({
			type: "class_get",
			file: target.file,
			line: target.line,
			tag: target.tag,
		}, function (res) {
			if (res.ok) {
				input.value = res.value || "";
				input.disabled = false;
				input.focus();
				input.select();
			} else {
				input.value = "";
				input.disabled = false;
				toast("load failed: " + (res.error || "error"), false);
			}
		});

		cancel_btn.onclick = function () { close_dialog(); };
		save_btn.onclick = save;
		dialog.addEventListener("keydown", function (ev) {
			if (ev.key === "Escape") {
				ev.preventDefault();
				close_dialog();
			} else if (ev.key === "Enter") {
				ev.preventDefault();
				save();
			}
		});
	}

	function on_click(e) {
		if (suppressed_disabled_click_target === e.target) {
			suppressed_disabled_click_target = null;
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (is_class_active(e)) {
			var cc = classify_class(e.target);
			if (!cc) return;
			e.preventDefault();
			e.stopPropagation();
			hide_overlay();
			edit_class_dialog(cc);
			return;
		}
		if (!is_active(e)) return;
		var c = classify(e.target);
		if (!c) return;
		e.preventDefault();
		e.stopPropagation();
		hide_overlay();
		if (c.kind === "text") edit_text_in_place(c.i18n_el); else if (c.kind === "markup") edit_markup_dialog(
			c.i18n_el
		); else open_in_editor(c.stamp);
	}

	function on_pointer_down(e) {
		if (!nearest_disabled_control(e.target)) return;
		if (is_class_active(e)) {
			var cc = classify_class(e.target);
			if (!cc) return;
			suppress_disabled_click(e.target);
			e.preventDefault();
			e.stopPropagation();
			hide_overlay();
			edit_class_dialog(cc);
			return;
		}
		if (!is_active(e)) return;
		var stamped = nearest_stamped(e.target);
		if (!stamped) return;
		suppress_disabled_click(e.target);
		e.preventDefault();
		e.stopPropagation();
		hide_overlay();
		open_in_editor(stamped.stamp);
	}

	function suppress_disabled_click(target) {
		suppressed_disabled_click_target = target;
		setTimeout(function () {
			if (suppressed_disabled_click_target === target) suppressed_disabled_click_target = null;
		}, 1000);
	}

	// Releasing any inspect modifier (Ctrl/Cmd/Alt/Shift) clears the highlight.
	function on_key_up(e) {
		if (e.key === "Control" || e.key === "Meta" || e.key === "Shift" || e.key === "Alt") {
			hide_overlay();
			document.body.style.cursor = "";
		}
	}

	// Suppress the native context menu while any inspect chord is active. The
	// content chord uses Meta (Cmd/Win) so it never overlaps the macOS Ctrl+click
	// secondary-click; the class chord (Alt+Shift) can also raise a menu on some
	// setups. Suppressing here stops a menu popping before the click handler runs.
	function on_context_menu(e) {
		if (is_active(e) || is_class_active(e)) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	document.addEventListener("mousemove", on_move, true);
	document.addEventListener("pointerdown", on_pointer_down, true);
	document.addEventListener("click", on_click, true);
	document.addEventListener("keyup", on_key_up, true);
	document.addEventListener("contextmenu", on_context_menu, true);
})();
