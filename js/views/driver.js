import { db, collection, doc, updateDoc, query, where, serverTimestamp } from "../fb.js";
import { h, card, stat, money, num, field, input, select, btn, guard, pill, fmtDate, ago, toDate, table, toast } from "../ui.js";
import { watch, byNewest } from "../data.js";
import { lane, shortId, uploadDoc, scanPicker, saveScans } from "../components.js";

const mine = (ctx, coll, field) => query(collection(db, coll), where("carrierId", "==", ctx.profile.carrierId), where(field, "==", ctx.uid));

function uploader(ctx, load) {
  const kindSel = select("kind", [{ value: "BOL", label: "BOL" }, { value: "POD", label: "Signed POD" }, { value: "Lumper", label: "Lumper receipt" }, { value: "Receipt", label: "Other receipt" }, { value: "Other", label: "Other" }]);
  const file = h("input", { type: "file", name: "file", accept: "image/*,application/pdf", capture: "environment", class: "visually-hidden", id: "f-" + load.id });
  const status = h("span", { class: "muted small" });
  file.addEventListener("change", async () => {
    if (!file.files[0]) return;
    status.textContent = "Uploading…";
    const ok = await guard(() => uploadDoc(ctx, file.files[0], {
      carrierId: ctx.profile.carrierId, loadId: load.id, loadLabel: `${shortId(load.id)} ${lane(load)}`,
      kind: kindSel.value, status: "pending", name: `${kindSel.value} · ${shortId(load.id)}`,
    }));
    if (ok && !ok.duplicate) toast("Sent to dispatch", "ok");
    status.textContent = ok ? (ok.duplicate ? "Already sent" : "Uploaded ✓") : "";
    file.value = "";
  });
  return h("div", { class: "upload-row" },
    field("Document type", kindSel),
    h("label", { for: "f-" + load.id, class: "btn btn-primary btn-big" }, "Take photo / upload"),
    file, status);
}

// Receipts that aren't BOLs: lumpers, repairs, tolls, anything unexpected. They go to the driver's
// Receipts folder in Google Drive and to dispatch for review.
function receiptsCard(ctx, loads) {
  const RTYPES = ["Lumper", "Fuel", "Repair", "Tolls", "Scale", "Parking", "Food / lodging", "Other"];
  const typeSel = select("rtype", RTYPES);
  const amt = input("amount", { type: "number", min: "0", step: "0.01", inputmode: "decimal", placeholder: "0.00" });
  const loadSel = select("loadId", [{ value: "", label: "Not for a load" }]);
  const note = input("note", { placeholder: "What was it for? e.g. lumper at Walmart DC" });
  const scans = scanPicker("Photo of the receipt");
  const fill = (ls) => loadSel.replaceChildren(h("option", { value: "" }, "Not for a load"), ...ls.slice(0, 15).map((l) => h("option", { value: l.id }, `${shortId(l.id)} ${lane(l)}`)));
  fill(loads());
  const form = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    if (!scans.files().length) return toast("Take a photo of the receipt first.", "bad");
    const l = loads().find((x) => x.id === loadSel.value);
    const ok = await guard(() => saveScans(ctx, scans.files(), {
      carrierId: ctx.profile.carrierId, kind: typeSel.value === "Lumper" ? "Lumper" : "Receipt", category: "Receipts", status: "pending",
      name: `${typeSel.value} receipt${amt.value ? " · $" + num(amt.value).toFixed(2) : ""}`,
      amount: amt.value ? Math.round(num(amt.value) * 100) / 100 : null, note: note.value.trim(), receiptType: typeSel.value,
      loadId: l ? l.id : null, loadLabel: l ? `${shortId(l.id)} ${lane(l)}` : null,
    }), "Receipt sent to dispatch");
    if (ok !== null) { form.reset(); scans.clear(); }
  } },
    h("div", { class: "form-grid" }, field("Type", typeSel), field("Amount ($)", amt), field("Load", loadSel), field("Note", note)),
    scans.el,
    h("div", null, btn("Send receipt", null, "primary", { type: "submit" })));
  return { el: card("Receipts", null, h("p", { class: "muted small" }, "Lumpers, repairs, tolls, anything you paid for on the road."), form), refresh: () => fill(loads()) };
}

function home(ctx, root) {
  const active = h("div");
  const tiles = h("div", { class: "stats" });
  const recent = h("div");
  let myLoads = [];
  const receipts = receiptsCard(ctx, () => myLoads);
  ctx.sub(watch(mine(ctx, "loads", "driverId"), (loads) => {
    myLoads = loads;
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
    receipts.refresh();
    recent.replaceChildren(table([
      { label: "Load", cell: (l) => h("span", { class: "mono" }, shortId(l.id)) },
      { label: "Lane", cell: lane },
      { label: "Miles", cell: (l) => String(l.miles || "—"), align: "right" },
      { label: "Status", cell: (l) => pill(l.status) },
    ], loads.slice(0, 20), "No loads yet."));
  }));
  root.append(active, tiles, receipts.el, card("My loads", null, recent));
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
