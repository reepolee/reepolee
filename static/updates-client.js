// Client for the ws "updates" channel (issue #336): index grids and edit
// forms listen here for record mutations on their own route. When a record
// that is currently on screen was updated/inserted/deleted by someone else,
// a green circular marker appears next to it (index) or in front of the
// timestamps (form). Clicking the marker reloads the page (the listing, when
// the record was deleted - the form URL no longer exists). Form markers are
// native anchors; index markers use a span because rows are already anchors.
//
// The page announces itself via a container marked with `data-updates-route`
// (the CRUD route, e.g. "/frameworks"). Index rows carry per-record marker
// cells (`[data-record-id="..."] .updates-marker-cell`); the edit form has a
// single marker cell with the record's own id.
//
// The page that ORIGINATED a mutation never marks itself - the user already
// knows what they just did. Only receiving windows (a second tab, another
// user) get the marker.

function connect_updates_channel() {
	const roots = Array.from(document.querySelectorAll("[data-updates-route]"));
	if (roots.length === 0) return;

	// Any form submit on this page means this page caused the mutation -
	// suppress marking briefly so the origin never shows its own marker.
	let origin_submit_ts = 0;
	document.addEventListener("submit", () => { origin_submit_ts = Date.now(); }, true);

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	let was_open = false;
	const ws = new WebSocket(`${protocol}//${window.location.host}/__updates`);

	ws.onopen = () => { was_open = true; };

	ws.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data);
			if (!msg || msg.type !== "updates") return;
			// Skip our own mutation (submit just happened on this page).
			if (Date.now() - origin_submit_ts < 4000) return;
			// Match by the table segment: flat pages announce "/users" while
			// messages carry the same base_path(), and nested pages announce
			// "admin/versions" while messages carry the parent id in the
			// middle ("admin/frameworks/12/versions"). Comparing the last
			// segment keeps both working; per-row/per-record ids below do the
			// precise filtering.
			const matching_roots = roots.filter((root) => {
				const route = root.getAttribute("data-updates-route");
				return route && String(msg.route).split("/").pop() === route.split("/").pop();
			});
			if (matching_roots.length === 0) return;

			const value = String(msg.value);
			// Index: every row has its own marker cell. Form: the single
			// marker cell carries the record id. Both are `[data-record-id]`.
			matching_roots.forEach((root) => {
				const cells = root.querySelectorAll(`[data-record-id="${css_escape_attr(value)}"]`);
				cells.forEach((cell) => {
					mark_cell(cell, msg);
				});
			});
		} catch {}
	};

	ws.onclose = (event) => {
		// Explicit rejection: the server completed the handshake and closed
		// with an application code (4401 no session, 4403 cross-origin). The
		// server will keep rejecting, so retrying every second would hammer it
		// for the page's whole lifetime. Stop, and reconnect once when the tab
		// becomes visible again (e.g. right after logging in elsewhere) - the
		// codes must match apps/main/server.ts WS_REJECT_*.
		if (event.code === 4401 || event.code === 4403) {
			document.addEventListener("visibilitychange", function resume() {
				document.removeEventListener("visibilitychange", resume);
				if (document.visibilityState === "visible") connect_updates_channel();
			});
			return;
		}
		if (was_open) {
			// Server restarted - reload so the page picks up fresh data.
			setTimeout(() => window.location.reload(), 500);
		} else {
			// Connection never opened - server still booting, retry.
			setTimeout(connect_updates_channel, 1000);
		}
	};
}

// Where the marker's reload link points. On an edit form whose record was
// just deleted the form URL is dead, so the link falls back to the listing
// page the form belongs to (stripping the trailing "/<id>/edit"; nested
// forms keep their parent scope, e.g. /sl/frameworks/3/versions). Index
// pages never end in "/edit", so they keep the current URL.
function marker_href(msg) {
	if (msg.action === "deleted") {
		const path = window.location.pathname.replace(/\/[^/]+\/edit\/?$/, "");
		return path + window.location.search + window.location.hash;
	}
	return window.location.href;
}

function css_escape_attr(value) {
	if (window.CSS && typeof window.CSS.escape === "function") {
		return window.CSS.escape(value);
	}
	// Fallback for very old browsers: ids here are record ids (numeric or
	// short slugs) - strip anything that could break the attribute selector.
	return value.replace(/["\\\]]/g, "");
}

function mark_cell(cell, msg) {
	if (cell.querySelector(".updates-marker")) return;

	// Index rows are themselves anchors, so a nested anchor is invalid HTML.
	// Use a real anchor for standalone form markers and a keyboard-accessible
	// span inside row anchors.
	const in_anchor = cell.closest("a");
	const link = document.createElement(in_anchor ? "span" : "a");
	link.className = "updates-marker";
	if (in_anchor) {
		link.setAttribute("role", "link");
		link.tabIndex = 0;
	} else {
		link.href = marker_href(msg);
	}
	link.title = msg.description || "Record updated";
	link.setAttribute("aria-label", msg.description || "Record updated");
	// Inline styles - the marker is injected at runtime, so it must render
	// identically whether or not the stylesheet has been rebuilt/loaded yet.
	// A fixed-size circle, not a pill.
	link.style.cssText = "display:inline-flex;align-items:center;justify-content:center;"
		+ "width:22px;height:22px;border-radius:50%;"
		+ "background:#dcfce7;color:#15803d;"
		+ "font:700 12px/1 system-ui;"
		+ "border:1px solid #86efac;cursor:pointer;user-select:none;";
	link.textContent = "●";

	const go = (e) => {
		e.preventDefault();
		e.stopPropagation();
		window.location.href = marker_href(msg);
	};
	link.addEventListener("click", go);
	if (in_anchor) {
		link.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") { go(e); }
		});
	}

	cell.appendChild(link);
}

// The static bundler hoists every <script src> into <head>, so the page's
// [data-updates-route] container may not exist yet - wait for the DOM.
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", connect_updates_channel);
} else {
	connect_updates_channel();
}
