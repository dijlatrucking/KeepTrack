import { db, collection, doc, updateDoc, query, where, serverTimestamp } from "../fb.js";
import { h, card, stat, money, num, field, input, select, btn, guard, pill, fmtDate, ago, toDate, table } from "../ui.js";
import { watch, byNewest } from "../data.js";
import { lane, shortId, uploadDoc } from "../components.js";

const mine = (ctx, coll, field) => query(collection(db, coll), where("carrierId", "==", ctx.profile.carrierId), where(field, "==", ctx.uid));

function uploader(ctx, load) {
  const kindSel = select("kind", [{ value: "BOL", label: "BOL" }, { value: "POD", label: "Signed POD" }, { value: "Receipt", label: "Receipt" }, { value: "Other", label: "Other" }]);
  const file = h("input", { type: "file", name: "file", accept: "image/*,application/pdf", capture: "environment", class: "visually-hidden", id: "f-" + load.id });
  const status = h("span", { class: "muted small" });
  file.addEventListener("change", async () => {
    if (!file.files[0]) return;
    status.textContent = "Uploading…";
    const ok = await guard(() => uploadDoc(ctx, file.files[0], {
      carrierId: ctx.profile.carrierId, loadId: load.id, loadLabel: `${shortId(load.id)} ${lane(load)}`,
      kind: kindSel.value, status: "pending", name: `${kindSel.value} · ${shortId(load.id)}`,
    }), "Sent to dispatch");
    status.textContent = ok ? "Uploaded ✓" : "";
    file.value = "";
  });
  return h("div", { class: "upload-row" },
    field("Document type", kindSel),
    h("label", { for: "f-" + load.id, class: "btn btn-primary btn-big" }, "Take photo / upload"),
    file, status);
}

function home(ctx, root) {
  const active = h("div");
  const tiles = h("div", { class: "stats" });
  const recent = h("div");
  ctx.sub(watch(mine(ctx, "loads", "driverId"), (loads) => {
    loads.sort(byNewest);
    const now = loads.filter((l) => l.status === "booked" || l.status === "in_transit");
    const weekAgo = Date.now() - 7 * 86400000;
    const weekMiles = loads.filter((l) => l.status !== "cancelled" && (toDate(l.pickupDate || l.createdAt)?.getTime() || 0) >= weekAgo).reduce((s, l) => s + num(l.miles), 0);
    tiles.replaceChildren(stat("Miles, last 7 days", weekMiles.toLocaleString()), stat("Active loads", String(now.length)), stat("Loads delivered", String(loads.filter((l) => l.status === "delivered").length)));
    active.replaceChildren(...(now.length ? now.map((l) => card(null, null,
      h("div", { class: "row-top" }, h("span", { class: "muted small upper" }, "Current load " + shortId(l.id)), pill(l.status)),
      h("div", { class: "load-lane" }, lane(l)),
      h("div", { class: "muted" }, [l.pickupDate ? "Pickup " + fmtDate(l.pickupDate) : null, l.deliverBy ? "Deliver by " + fmtDate(l.deliverBy) : null, l.truckUnit, l.miles ? l.miles + " mi" : null].filter(Boolean).join(" · ")),
      l.notes ? h("div", { class: "quote" }, l.notes) : null,
      h("div", { class: "row-inline" },
        l.status === "booked" ? btn("Picked up", () => guard(() => updateDoc(doc(db, "loads", l.id), { status: "in_transit", updatedAt: serverTimestamp() }), "Marked picked up"), "dark") : null,
        l.status === "in_transit" ? btn("Delivered", () => guard(() => updateDoc(doc(db, "loads", l.id), { status: "delivered", updatedAt: serverTimestamp() }), "Marked delivered"), "ok") : null),
      uploader(ctx, l))) : [card(null, null, h("p", { class: "empty" }, "No active loads. Your dispatcher will assign one."))]));
    recent.replaceChildren(table([
      { label: "Load", cell: (l) => h("span", { class: "mono" }, shortId(l.id)) },
      { label: "Lane", cell: lane },
      { label: "Miles", cell: (l) => String(l.miles || "—"), align: "right" },
      { label: "Status", cell: (l) => pill(l.status) },
    ], loads.slice(0, 20), "No loads yet."));
  }));
  root.append(active, tiles, card("My loads", null, recent));
}

function uploads(ctx, root) {
  const body = h("div");
  ctx.sub(watch(mine(ctx, "documents", "uploadedBy"), (docs) => body.replaceChildren(table([
    { label: "Document", cell: (d) => h("span", { class: "strong" }, d.name) },
    { label: "Load", cell: (d) => d.loadLabel || "—" },
    { label: "Sent", cell: (d) => ago(d.createdAt) },
    { label: "Status", cell: (d) => pill(d.status) },
  ], docs.sort(byNewest), "Nothing uploaded yet."))));
  root.append(card("My uploads", null, body));
}

function pay(ctx, root) {
  const body = h("div");
  ctx.sub(watch(mine(ctx, "paystubs", "driverId"), (stubs) => {
    stubs.sort(byNewest);
    body.replaceChildren(...(stubs.length ? stubs.map((p) => h("details", { class: "stub" },
      h("summary", null, h("span", { class: "strong" }, `${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}`), h("span", { class: "mono" }, money(p.net))),
      table([
        { label: "Load", cell: (l) => h("span", { class: "mono" }, shortId(l.id)) },
        { label: "Lane", cell: (l) => l.lane },
        { label: "Miles", cell: (l) => String(l.miles), align: "right" },
        { label: "Pay", cell: (l) => money(l.pay), align: "right" },
      ], p.loads || []),
      h("p", null, `Gross ${money(p.gross)} · Deductions ${money(p.deductions)}${p.deductionNote ? " (" + p.deductionNote + ")" : ""} · `, h("strong", null, "Net " + money(p.net))))) : [h("p", { class: "empty" }, "No paystubs yet.")]));
  }));
  root.append(card("Paystubs", null, body));
}

export default [
  { id: "home", label: "Loads", render: home },
  { id: "uploads", label: "Uploads", render: uploads },
  { id: "pay", label: "Pay", render: pay },
];
