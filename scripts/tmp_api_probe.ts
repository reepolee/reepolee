// Temporary probe: is --dev actually seen by the running agent server?

const BASE = "http://127.0.0.1:2500";
const json_headers = { "Accept": "application/json" };

// The 404 body comes from the `!Bun.argv.includes("--dev")` guard in the
// generated handler. Bun.argv in a --hot child may differ from the parent.
console.log("this process argv:", JSON.stringify(Bun.argv));

const res = await fetch(`${BASE}/frameworks?locale=sl-si`, { headers: json_headers, redirect: "follow" });
console.log("follow redirects ->", res.status, res.url);
console.log("  body:", (await res.text()).slice(0, 100));

// Compare: same request without ?locale= reaches the JSON branch fine,
// so the guard passes there. That means ?locale= changes which handler runs.
const plain = await fetch(`${BASE}/frameworks`, { headers: json_headers, redirect: "follow" });
console.log("no locale param ->", plain.status, plain.url);
