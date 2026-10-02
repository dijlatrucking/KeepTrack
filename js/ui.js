// Small DOM + formatting helpers. No framework.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "selected" || k === "disabled") el[k] = !!v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const money = (n) =>
  n == null || n === "" || isNaN(n)
    ? "—"
    : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? 0 : Number(v));

export function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (typeof v === "string") return new Date(v.length === 10 ? v + "T12:00:00" : v);
  return new Date(v);
}

export function fmtDate(v) {
  const d = toDate(v);
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
}

export function ago(v) {
  const d = toDate(v);
  if (!d) return "just now";
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " hr ago";
  return fmtDate(d);
}

export const STATUS = {
  booked: ["Booked", "neutral"],
  in_transit: ["In transit", "info"],
  delivered: ["Delivered", "ok"],
  cancelled: ["Cancelled", "neutral"],
  pending: ["Needs review", "warn"],
  approved: ["Approved", "ok"],
  rejected: ["Rejected", "bad"],
  filed: ["Filed", "neutral"],
  open: ["Open", "warn"],
  answered: ["Answered", "ok"],
  paid: ["Paid", "ok"],
  unpaid: ["Unpaid", "warn"],
};

export function pill(status, label) {
  const [text, tone] = STATUS[status] || [label || status, "neutral"];
  return h("span", { class: "pill pill-" + tone }, label || text);
}

// Pop-up messages. Never more than two on screen: one spot for good news, one for problems, so a
// burst of activity (deleting 20 papers, a 44-page scan) can't cover the page. The newest message
// takes its spot; the same message repeated rolls into one with a count ("Paper deleted ×12").
// msg can be a function of the running count, and { key, add } groups different calls under one count
// ("Copied 5 files to Google Drive"). Tap a pop-up to dismiss it.
const slots = { good: null, bad: null };
const counts = new Map(); // key → { n, until }
const MIN_SHOW = 1200; // a message stays at least this long before the next one takes its spot
export function toast(msg, kind = "info", { key, add = 1 } = {}) {
  let box = document.getElementById("toasts");
  if (!box) {
    box = h("div", { id: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(box);
  }
  const k = key || kind + "|" + (typeof msg === "function" ? msg(1) : msg);
  const now = Date.now();
  const c = counts.get(k);
  const n = c && c.until > now ? c.n + add : add;
  counts.set(k, { n, until: now + 8000 });
  const text = typeof msg === "function" ? msg(n) : n > 1 ? `${msg} ×${n}` : msg;
  const slot = kind === "bad" ? "bad" : "good";
  let t = slots[slot];
  if (!t) {
    const el = h("div", { class: "toast" });
    t = slots[slot] = { el, timer: null, wait: null, key: null, shownAt: 0, queue: [] };
    el.addEventListener("click", () => { el.remove(); clearTimeout(t.wait); clearTimeout(t.timer); t.queue = []; if (slots[slot] === t) slots[slot] = null; });
  }
  const show = (m) => {
    t.key = m.k; t.shownAt = Date.now();
    t.el.className = "toast toast-" + m.kind;
    t.el.textContent = m.text;
    if (!t.el.isConnected) { if (slot === "bad") box.prepend(t.el); else box.append(t.el); }
    clearTimeout(t.timer);
    t.timer = setTimeout(() => { t.el.remove(); if (slots[slot] === t) slots[slot] = null; }, m.kind === "bad" ? 7000 : 3500);
  };
  const next = () => {
    t.wait = null;
    const m = t.queue.shift();
    if (!m) return;
    show(m);
    if (t.queue.length) t.wait = setTimeout(next, MIN_SHOW);
  };
  const m = { k, kind, text };
  // the message on screen updates in place; others line up and each gets its turn (same ones merge)
  if (t.key === k && t.el.isConnected) { show(m); return; }
  const queued = t.queue.find((x) => x.k === k);
  if (queued) Object.assign(queued, m);
  else { t.queue.push(m); if (t.queue.length > 3) t.queue.shift(); }
  if (!t.wait) {
    const age = Date.now() - t.shownAt;
    if (!t.el.isConnected || age >= MIN_SHOW) next();
    else t.wait = setTimeout(next, MIN_SHOW - age);
  }
}

export function card(title, actions, ...body) {
  return h("section", { class: "card" },
    title || actions ? h("div", { class: "card-head" }, title ? h("h2", null, title) : null, actions || null) : null,
    ...body);
}

export function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), input, hint ? h("span", { class: "field-hint" }, hint) : null);
}

export function input(name, attrs = {}) {
  return h("input", { name, class: "input", ...attrs });
}

// A password box with a Show / Hide button in it, so people can check what they typed.
// Returns the wrapper (put it in the form); the box itself is wrapper.input.
// shown: start with the password visible (for passwords the owner is about to send someone).
export function passwordInput(name, attrs = {}, { shown = false } = {}) {
  const box = input(name, { autocapitalize: "none", autocorrect: "off", spellcheck: "false", ...attrs, type: shown ? "text" : "password" });
  const toggle = h("button", { type: "button", class: "pw-toggle" }, shown ? "Hide" : "Show");
  const set = (show) => { box.type = show ? "text" : "password"; toggle.textContent = show ? "Hide" : "Show"; };
  // keep the cursor (and the phone keyboard) in the box while tapping the button
  toggle.addEventListener("mousedown", (e) => e.preventDefault());
  toggle.addEventListener("click", (e) => { e.preventDefault(); set(box.type === "password"); });
  const wrap = h("span", { class: "pw-wrap" }, box, toggle);
  wrap.input = box;
  wrap.show = set;
  return wrap;
}

export function select(name, options, attrs = {}) {
  return h("select", { name, class: "input", ...attrs },
    options.map((o) => (typeof o === "string" ? h("option", { value: o }, o) : h("option", { value: o.value, selected: o.selected }, o.label))));
}

export function btn(label, onClick, kind = "secondary", attrs = {}) {
  return h("button", { type: attrs.type || "button", class: "btn btn-" + kind, onClick, ...attrs }, label);
}

export function formToObj(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// columns: [{ label, cell: row => node|string, align }]
export function table(columns, rows, empty = "Nothing here yet.") {
  if (!rows.length) return h("p", { class: "empty" }, empty);
  return h("div", { class: "table-wrap" },
    h("table", { class: "table" },
      h("thead", null, h("tr", null, columns.map((c) => h("th", { class: c.align === "right" ? "r" : null }, c.label)))),
      h("tbody", null, rows.map((r) => h("tr", null, columns.map((c) => h("td", { class: c.align === "right" ? "r" : null }, c.cell(r))))))));
}

export function stat(label, value, sub) {
  return h("div", { class: "stat" }, h("span", { class: "stat-label" }, label), h("span", { class: "stat-value" }, value), sub ? h("span", { class: "stat-sub" }, sub) : null);
}

export function inviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const arr = crypto.getRandomValues(new Uint32Array(10));
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

export async function guard(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, "ok");
    return r;
  } catch (e) {
    console.error(e);
    toast(friendlyError(e), "bad");
    return null;
  }
}

export function friendlyError(e) {
  const code = e && e.code ? e.code : "";
  const map = {
    "auth/invalid-credential": "Wrong username or password.",
    "auth/wrong-password": "Wrong username or password.",
    "auth/user-not-found": "Wrong username or password.",
    "auth/too-many-requests": "Too many tries. Wait a few minutes and try again.",
    "auth/email-already-in-use": "That username is already taken. Try another one.",
    "auth/weak-password": "Password needs at least 6 characters.",
    "auth/invalid-email": "That username doesn't look right. Use letters and numbers, no spaces.",
    "auth/requires-recent-login": "For safety, sign out and back in, then try again.",
    "permission-denied": "You don't have access to do that.",
    "not-found": "Someone else just deleted that. The page will catch up in a moment.",
  };
  return map[code] || (e && e.message) || "Something went wrong.";
}
