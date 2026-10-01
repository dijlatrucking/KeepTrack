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

export function toast(msg, kind = "info") {
  let box = document.getElementById("toasts");
  if (!box) {
    box = h("div", { id: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(box);
  }
  const t = h("div", { class: "toast toast-" + kind }, msg);
  box.append(t);
  setTimeout(() => t.remove(), 4500);
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
    "auth/invalid-credential": "Wrong email or password.",
    "auth/email-already-in-use": "That email already has an account. Sign in instead.",
    "auth/weak-password": "Password needs at least 6 characters.",
    "auth/invalid-email": "That email doesn't look right.",
    "permission-denied": "You don't have access to do that.",
    "not-found": "Someone else just deleted that. The page will catch up in a moment.",
  };
  return map[code] || (e && e.message) || "Something went wrong.";
}
