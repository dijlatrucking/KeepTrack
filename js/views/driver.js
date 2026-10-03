import { db, collection, doc, updateDoc, query, where, serverTimestamp } from "../fb.js";
import { h, card, stat, money, num, field, input, select, btn, guard, pill, fmtDate, ago, toDate, table, toast } from "../ui.js";
import { watch, byNewest } from "../data.js";
import { lane, shortId, uploadDoc, scanPicker, saveScans, openDoc, moreButton, fileRow, TRUCK_DOC_TYPES, DRIVER_DOC_TYPES } from "../components.js";

const mine = (ctx, coll, field) => query(collection(db, coll), where("carrierId", "==", ctx.profile.carrierId), where(field, "==", ctx.uid));

// One of the driver's own uploads: what it is, where it stands, and a button to look at it again.
const DRIVER_STATUS = { pending: "Waiting for review", approved: "Approved", rejected: "Not accepted", filed: "Filed" };
function uploadRow(ctx, d, { showLoad = true } = {}) {
  const why = d.status === "rejected"
    ? (d.rejectReason === "duplicate" ? "Not accepted: this was already on file, so it's not needed twice." : "Not accepted. Send a clearer photo if dispatch asks for one.")
    : null;
  return h("div", { class: "row col" },
    h("div", { class: "row-top" },
      h("div", { class: "review-main" },
        h("div", { class: "badge-kind" }, (d.kind || "DOC").slice(0, 4).toUpperCase()),
        h("div", { class: "grow" },
          h("div", { class: "strong" }, d.name || d.kind || "Document"),
          h("div", { class: "muted small" }, [showLoad ? d.loadLabel : null, d.amount ? money(d.amount) : null, ago(d.createdAt)].filter(Boolean).join(" · ")),
          d.note ? h("div", { class: "small" }, d.note) : null)),
      h("div", { class: "row-meta" }, pill(d.status, DRIVER_STATUS[d.status]), btn("View", () => openDoc(d)),
        d.status === "pending" ? btn("Delete", () => import("../editing.js").then((m) => m.deleteDocFlow(ctx, d)), "ghost", { class: "btn btn-ghost btn-sm danger" }) : null)),
    why ? h("div", { class: "small muted" }, why) : null);
}

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
  // what the driver already sent for each active load, kept live
  let myDocs = [];
  const sentBoxes = new Map();
  const drawSent = () => sentBoxes.forEach((box, loadId) => {
    const docs = myDocs.filter((d) => d.loadId === loadId).sort(byNewest);
    box.replaceChildren(...(docs.length ? [h("div", { class: "muted small upper" }, "Sent for this load"), h("div", { class: "list" }, docs.map((d) => uploadRow(ctx, d, { showLoad: false })))] : []));
  });
  ctx.sub(watch(mine(ctx, "documents", "uploadedBy"), (docs) => { myDocs = docs; drawSent(); }));
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
      uploader(ctx, l),
      (() => { const box = h("div", { class: "sent-box" }); sentBoxes.set(l.id, box); return box; })())) : [card(null, null, h("p", { class: "empty" }, "No active loads. Your dispatcher will assign one."))]));
    for (const id of [...sentBoxes.keys()]) if (!now.some((l) => l.id === id)) sentBoxes.delete(id);
    drawSent();
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
  const tiles = h("div", { class: "stats stats-compact" });
  const body = h("div");
  const chips = h("div", { class: "chips", "aria-label": "Show" });
  let docs = [], show = "all", term = "", limit = 50;
  const FILTERS = [["all", "All"], ["pending", "Waiting"], ["approved", "Approved"], ["rejected", "Not accepted"]];
  const draw = () => {
    tiles.replaceChildren(
      stat("Waiting for review", String(docs.filter((d) => d.status === "pending").length)),
      stat("Approved", String(docs.filter((d) => d.status === "approved").length)),
      stat("Not accepted", String(docs.filter((d) => d.status === "rejected").length)));
    chips.replaceChildren(...FILTERS.map(([v, label]) => h("button", { type: "button", class: "chip" + (show === v ? " on" : ""), "aria-pressed": String(show === v), onClick: () => { show = v; limit = 50; draw(); } }, label)));
    const t = term.toLowerCase();
    const shown = docs.filter((d) => (show === "all" || d.status === show)
      && (!t || [d.name, d.kind, d.receiptType, d.loadLabel, d.note, d.amount ? String(d.amount) : ""].filter(Boolean).join(" ").toLowerCase().includes(t)))
      .sort(byNewest);
    body.replaceChildren(shown.length
      ? h("div", { class: "list" }, shown.slice(0, limit).map((d) => uploadRow(ctx, d)), moreButton(shown.length, limit, () => { limit += 50; draw(); }))
      : h("p", { class: "empty" }, docs.length ? "Nothing matches." : "Nothing uploaded yet. Photos you send from the Loads page show up here."));
  };
  const search = input("q", { type: "search", placeholder: "Search: BOL, lumper, load #…", "aria-label": "Search my uploads" });
  search.addEventListener("input", () => { term = search.value.trim(); limit = 50; draw(); });
  ctx.sub(watch(mine(ctx, "documents", "uploadedBy"), (r) => { docs = r; draw(); }));
  draw();
  root.append(tiles, card("My uploads", null, h("p", { class: "muted small" }, "Everything you've sent: BOLs, PODs and receipts. Tap View to see the photo again."), search, chips, body));
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
      p.adjustment ? h("p", { class: "small" }, `Loads ${money(p.loadsPay)} · ${p.adjustment > 0 ? "Added" : "Taken off"} ${money(Math.abs(p.adjustment))}`) : null,
      h("p", null, `Pay ${money(p.gross)} · Deductions ${money(p.deductions)}${p.deductionNote ? " (" + p.deductionNote + ")" : ""} · `, h("strong", null, "Net " + money(p.net))))) : [h("p", { class: "empty" }, "No paystubs yet.")]));
  }));
  root.append(card("Paystubs", null, body));
}

// The truck the carrier assigned to this driver, with its papers (registration, insurance, IFTA…) to open,
// download or print, plus the driver's own papers on file (CDL, med card…).
// The rules only let a driver read papers that are on file, so the query has to say so too.
const ON_FILE = where("status", "in", ["filed", "approved"]);
function truckPage(ctx, root) {
  const truckId = ctx.profile.truckId, cid = ctx.profile.carrierId;
  const byType = (types) => (a, b) => types.indexOf(a.kind) - types.indexOf(b.kind) || String(a.kind || "").localeCompare(String(b.kind || ""));
  const shown = (d) => d.status === "filed" || d.status === "approved";
  const mineBody = h("div", null, h("p", { class: "muted small" }, "Loading…"));
  ctx.sub(watch(query(collection(db, "documents"), where("carrierId", "==", cid), where("driverId", "==", ctx.uid), ON_FILE), (docs) => {
    const list = docs.filter(shown).sort(byType(DRIVER_DOC_TYPES));
    mineBody.replaceChildren(list.length ? h("div", { class: "list" }, list.map((d) => fileRow(ctx, d))) : h("p", { class: "empty" }, "Nothing on file yet."));
  }));
  const mine = card("My papers on file", null, h("p", { class: "muted small" }, "What your carrier keeps on file for you."), mineBody);
  if (!truckId) {
    root.append(card("My truck", null, h("p", { class: "empty" }, "No truck assigned to you yet. Your carrier sets this under Drivers & trucks.")), mine);
    return;
  }
  const head = h("div", { class: "muted" }, ctx.profile.truckUnit || "");
  ctx.sub(watch(query(collection(db, "trucks"), where("carrierId", "==", cid)), (trucks) => {
    const t = trucks.find((x) => x.id === truckId);
    if (t) head.replaceChildren(h("div", { class: "load-lane" }, t.unit || "Truck"),
      h("div", { class: "muted" }, [t.type, t.plate ? "Plate " + t.plate : null, t.vin ? "VIN " + t.vin : null, t.regExpires ? "Registration exp. " + fmtDate(t.regExpires) : null].filter(Boolean).join(" · ")));
  }));
  const body = h("div", null, h("p", { class: "muted small" }, "Loading…"));
  ctx.sub(watch(query(collection(db, "documents"), where("carrierId", "==", cid), where("truckId", "==", truckId), ON_FILE), (docs) => {
    const list = docs.filter(shown).sort(byType(TRUCK_DOC_TYPES));
    body.replaceChildren(list.length ? h("div", { class: "list" }, list.map((d) => fileRow(ctx, d)))
      : h("p", { class: "empty" }, "No documents for this truck yet. Ask your carrier to add the registration, insurance and IFTA papers."));
  }));
  root.append(card("My truck", null, head), card("Truck documents", null, h("p", { class: "muted small" }, "Keep these handy for inspections and scales. Open, download or print any of them."), body), mine);
}

export default [
  { id: "home", label: "Loads", render: home },
  { id: "truck", label: "My truck", render: truckPage },
  { id: "uploads", label: "My uploads", render: uploads },
  { id: "pay", label: "Pay", render: pay },
];
