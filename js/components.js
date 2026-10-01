// Pieces shared by several roles.
import {
  db, storage, collection, doc, addDoc, setDoc, updateDoc, getDoc, getDocs, query, where,
  serverTimestamp, writeBatch, ref, getDownloadURL
} from "./fb.js";
import { h, card, table, pill, money, num, fmtDate, ago, field, input, select, btn, formToObj, guard, toast } from "./ui.js";
import { watch, watchMany, perCarrier, scoped, byNewest } from "./data.js";
import { sendToDrive, removeFromDrive } from "./drive.js";

const LOAD_STATUSES = [
  { value: "booked", label: "Booked" },
  { value: "in_transit", label: "In transit" },
  { value: "delivered", label: "Delivered" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
];

export const lane = (l) => `${l.origin || "?"} → ${l.destination || "?"}`;
export const shortId = (id) => "#" + id.slice(0, 6).toUpperCase();

// ---------- Documents ----------

// Scans are shrunk in the browser and saved in Firestore (docFiles/{docId}), so no Storage/Blaze plan is needed.
// Firestore caps a document at 1 MiB, so each scan is squeezed under ~900 KB.
const MAX_CHARS = 900000;

function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("Couldn't read that file."));
    r.readAsDataURL(file);
  });
}

async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (_) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export async function toScan(file) {
  if (file.type === "application/pdf") {
    const url = await readAsDataURL(file);
    if (url.length > MAX_CHARS) throw new Error("That PDF is too big (max about 650 KB). Take a photo of the page instead.");
    return url;
  }
  if (!file.type.startsWith("image/")) throw new Error("Use a photo or a PDF.");
  const img = await decodeImage(file);
  const w0 = img.width, h0 = img.height;
  let max = 1800, q = 0.72;
  for (let i = 0; i < 7; i++) {
    const scale = Math.min(1, max / Math.max(w0, h0));
    const c = document.createElement("canvas");
    c.width = Math.round(w0 * scale);
    c.height = Math.round(h0 * scale);
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", q);
    if (url.length <= MAX_CHARS) return url;
    max = Math.round(max * 0.8);
    q = Math.max(0.45, q - 0.07);
  }
  throw new Error("Couldn't shrink that photo enough. Try again a little closer to the page.");
}

export async function openDoc(d) {
  const w = window.open("", "_blank");
  try {
    let url;
    if (d.storagePath) {
      url = await getDownloadURL(ref(storage, d.storagePath));
    } else {
      const snap = await getDoc(doc(db, "docFiles", d.id));
      if (!snap.exists()) throw new Error("missing");
      const blob = await (await fetch(snap.data().data)).blob();
      url = URL.createObjectURL(blob);
    }
    if (w) w.location = url; else window.location = url;
  } catch (e) {
    console.error(e);
    if (w) w.close();
    toast("Couldn't open that file.", "bad");
  }
}

// A fingerprint of the saved file. The same PDF or photo always gives the same fingerprint,
// so the same paper uploaded twice (by a driver, dispatch or the carrier) can be spotted.
export async function fingerprint(data) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Is this exact file already on file for the carrier? Drivers can only check their own uploads.
async function alreadyOnFile(ctx, carrierId, hash) {
  try {
    const w = [where("carrierId", "==", carrierId), where("hash", "==", hash)];
    if (ctx.profile.role === "driver") w.push(where("uploadedBy", "==", ctx.uid));
    const snap = await getDocs(query(collection(db, "documents"), ...w));
    const hit = snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((d) => d.status !== "rejected");
    return hit || null;
  } catch (e) { return null; }
}

export async function uploadDoc(ctx, file, meta) {
  if (!file) throw new Error("Choose a file or take a photo first.");
  const data = await toScan(file);
  const hash = await fingerprint(data);
  const dupe = await alreadyOnFile(ctx, meta.carrierId, hash);
  if (dupe) {
    toast(`Already on file: “${dupe.name}”${dupe.uploaderName ? " from " + dupe.uploaderName : ""}. Not saved twice.`, "info");
    return { id: dupe.id, duplicate: true };
  }
  const docRef = doc(collection(db, "documents"));
  const batch = writeBatch(db);
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  batch.set(docRef, {
    ...clean,
    name: meta.name || file.name,
    fileType: data.startsWith("data:application/pdf") ? "pdf" : "image",
    hash,
    uploadedBy: ctx.uid,
    uploaderName: ctx.profile.name || "",
    uploaderRole: ctx.profile.role,
    createdAt: serverTimestamp(),
  });
  batch.set(doc(db, "docFiles", docRef.id), { carrierId: meta.carrierId, uploadedBy: ctx.uid, data });
  await batch.commit();
  sendToDrive(docRef.id); // copy to Google Drive in the background (if connected)
  return docRef;
}

export const DOC_KINDS = ["Rate con", "BOL", "POD", "Receipt", "Lumper", "Insurance", "Authority", "W-9", "Registration", "CDL / med card", "Other"];

// Scanner: "Scan with camera" opens the phone camera; "Choose file" picks a photo or PDF.
// Several pages can be added before saving; each is shown as a thumbnail.
export function scanPicker(label = "Scan or upload") {
  let picked = [];
  const list = h("div", { class: "scan-list" });
  const id = "scan-" + Math.random().toString(36).slice(2, 8);
  const draw = () => {
    list.replaceChildren(...picked.map((f, i) => {
      const thumb = f.type.startsWith("image/")
        ? h("img", { src: URL.createObjectURL(f), alt: `Page ${i + 1}`, class: "scan-thumb" })
        : h("div", { class: "scan-thumb scan-pdf" }, "PDF");
      return h("div", { class: "scan-item" }, thumb,
        h("span", { class: "small" }, `Page ${i + 1}`),
        h("button", { type: "button", class: "scan-remove", "aria-label": `Remove page ${i + 1}`, onClick: () => { picked.splice(i, 1); draw(); } }, "×"));
    }));
  };
  const onPick = (e) => { picked.push(...e.target.files); e.target.value = ""; draw(); };
  const camera = h("input", { type: "file", accept: "image/*", capture: "environment", id: id + "-cam", class: "visually-hidden", "data-role": "camera", onChange: onPick });
  const chooser = h("input", { type: "file", accept: "image/*,application/pdf", multiple: true, id: id + "-file", class: "visually-hidden", "data-role": "choose", onChange: onPick });
  const el = h("div", { class: "scanner" },
    h("div", { class: "field-label" }, label),
    h("div", { class: "scan-actions" },
      h("label", { for: id + "-cam", class: "btn btn-dark" }, "Scan with camera"),
      h("label", { for: id + "-file", class: "btn btn-ghost" }, "Choose file")),
    camera, chooser, list);
  return { el, files: () => picked.slice(), clear: () => { picked = []; draw(); }, add: (f) => { picked.push(f); draw(); } };
}

// Save each picked page as its own document. Multi-page scans get "p1/2" style names.
export async function saveScans(ctx, files, meta) {
  const ids = [];
  for (let i = 0; i < files.length; i++) {
    const name = (meta.name || `${meta.kind || "Doc"}${meta.loadLabel ? " · " + meta.loadLabel.split(" ")[0] : ""}`) + (files.length > 1 ? ` p${i + 1}/${files.length}` : "");
    ids.push((await uploadDoc(ctx, files[i], { ...meta, name })).id);
  }
  return ids;
}

// Pop-up scanner for one load (from the load board's "Scan" button).
export function openScanDialog(ctx, load) {
  const scans = scanPicker("Pages");
  const kindSel = select("kind", DOC_KINDS.slice(0, 5));
  const dlg = h("dialog", { class: "dialog", "aria-label": "Add paperwork" });
  const close = () => { dlg.close(); dlg.remove(); };
  const form = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    if (!scans.files().length) return toast("Scan or choose at least one page.", "bad");
    const ok = await guard(() => saveScans(ctx, scans.files(), {
      carrierId: load.carrierId, loadId: load.id, loadLabel: `${shortId(load.id)} ${lane(load)}`, kind: kindSel.value, status: "approved",
    }), "Paperwork saved");
    if (ok !== null) close();
  } },
    h("h2", null, "Add paperwork"),
    h("p", { class: "muted small" }, `${shortId(load.id)} · ${lane(load)} · ${ctx.carrierName(load.carrierId)}`),
    field("Type", kindSel),
    scans.el,
    h("div", { class: "row-inline" }, btn("Save", null, "primary", { type: "submit" }), btn("Cancel", close, "ghost")));
  dlg.append(form);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
}

// Owner/dispatcher: scan paperwork for any carrier they work, optionally tied to a load.
export function staffScanCard(ctx) {
  if (!ctx.carriers.length) return card("Scan a document", null, h("p", { class: "empty" }, "No carriers assigned to you yet."));
  const carrierSel = select("carrierId", ctx.carriers.map((c) => ({ value: c.id, label: c.name })));
  const loadSel = select("loadId", [{ value: "", label: "Not tied to a load" }]);
  let loads = [];
  const fillLoads = async () => {
    const snap = await getDocs(query(collection(db, "loads"), where("carrierId", "==", carrierSel.value))).catch(() => null);
    loads = snap ? snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byNewest).slice(0, 50) : [];
    loadSel.replaceChildren(h("option", { value: "" }, "Not tied to a load"), ...loads.map((l) => h("option", { value: l.id }, `${shortId(l.id)} ${lane(l)}`)));
  };
  carrierSel.addEventListener("change", fillLoads);
  fillLoads();
  const scans = scanPicker("Pages");
  const form = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    const f = formToObj(form);
    if (!scans.files().length) return toast("Scan or choose at least one page.", "bad");
    const l = loads.find((x) => x.id === f.loadId);
    const ok = await guard(() => saveScans(ctx, scans.files(), {
      carrierId: f.carrierId, kind: f.kind, category: f.kind, status: "approved",
      name: f.name.trim() || undefined, tags: f.tags.trim(),
      loadId: l ? l.id : null, loadLabel: l ? `${shortId(l.id)} ${lane(l)}` : null,
    }), "Saved");
    if (ok !== null) { form.reset(); scans.clear(); fillLoads(); }
  } },
    h("div", { class: "form-grid" },
      field("Carrier", carrierSel),
      field("Load", loadSel),
      field("Type", select("kind", DOC_KINDS)),
      field("Name (optional)", input("name", { placeholder: "e.g. Rate con – Boise to Denver" })),
      field("Search tags", input("tags", { placeholder: "Broker, PO #, reference…" }))),
    scans.el,
    h("div", null, btn("Save document", null, "primary", { type: "submit" })),
    h("p", { class: "muted small" }, "Saved documents are visible to that carrier right away."));
  return card("Scan a document", null, form);
}

// Receipt types → expense categories
const RECEIPT_CAT = { Lumper: "Lumper", Fuel: "Fuel", Repair: "Repairs", Tolls: "Tolls", Scale: "Scale", Parking: "Parking", "Food / lodging": "Other", Other: "Other" };
const isReceiptDoc = (d) => d.kind === "Lumper" || d.kind === "Receipt" || d.category === "Receipts";

// Look for a copy of this paper already on file: the exact same file, the same kind of paper on the
// same load (two BOLs for one load), or a receipt with the same amount on the same load/day.
const dupeCache = new Map();
export function findDuplicate(d) {
  if (dupeCache.has(d.id)) return dupeCache.get(d.id);
  const run = (async () => {
    const base = [where("carrierId", "==", d.carrierId)];
    const tries = [];
    if (d.hash) tries.push(["exact", [...base, where("hash", "==", d.hash)]]);
    if (d.loadId && ["BOL", "POD", "Rate con", "Lumper"].includes(d.kind)) tries.push(["load", [...base, where("loadId", "==", d.loadId), where("kind", "==", d.kind)]]);
    if (d.amount) tries.push(["amount", [...base, where("amount", "==", d.amount)]]);
    for (const [why, w] of tries) {
      try {
        const snap = await getDocs(query(collection(db, "documents"), ...w));
        const day = (x) => (x.createdAt && x.createdAt.seconds ? Math.floor(x.createdAt.seconds / 86400) : 0);
        const other = snap.docs.map((x) => ({ id: x.id, ...x.data() }))
          .filter((x) => x.id !== d.id && x.status !== "rejected")
          .filter((x) => why !== "amount" || (d.loadId ? x.loadId === d.loadId : Math.abs(day(x) - day(d)) <= 2))
          .sort(byNewest).pop();
        if (other) return { why, other };
      } catch (e) { /* missing index or no access: just don't flag */ }
    }
    cleanChecks.add(d.id);
    return null;
  })();
  dupeCache.set(d.id, run);
  return run;
}
const cleanChecks = new Set();
function forgetCleanChecks() { cleanChecks.forEach((id) => dupeCache.delete(id)); cleanChecks.clear(); }
const dupeText = (r) => r.why === "exact" ? `Exact copy of “${r.other.name}”` : r.why === "load" ? `This load already has a ${r.other.kind}` : `Same amount already sent`;

// Turn a driver's receipt into an expense (owner / carrier only), so nobody types it twice.
export async function receiptToExpense(ctx, d) {
  let amount = num(d.amount);
  if (!amount) {
    const a = prompt(`Amount for “${d.name}”?`);
    if (a === null) return null;
    amount = num(a);
    if (!amount) { toast("Enter an amount to add it as an expense.", "bad"); return null; }
  }
  let truckId = null;
  try {
    if (d.loadId) { const l = await getDoc(doc(db, "loads", d.loadId)); truckId = l.exists() ? l.data().truckId || null : null; }
    if (!truckId && d.uploadedBy) { const u = await getDoc(doc(db, "users", d.uploadedBy)); truckId = u.exists() ? u.data().truckId || null : null; }
  } catch (e) {}
  const created = d.createdAt && d.createdAt.toDate ? d.createdAt.toDate() : new Date();
  const date = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}-${String(created.getDate()).padStart(2, "0")}`;
  const ref = await addDoc(collection(db, "expenses"), {
    carrierId: d.carrierId, cat: RECEIPT_CAT[d.receiptType] || (d.kind === "Lumper" ? "Lumper" : "Other"), amount: Math.round(amount * 100) / 100,
    truckId, date, paidWith: "own", gallons: 0, state: "", note: [d.uploaderName, d.note].filter(Boolean).join(" · "),
    loadId: d.loadId || null, loadLabel: d.loadLabel || null, docId: d.id, createdAt: serverTimestamp(),
  });
  await updateDoc(doc(db, "documents", d.id), { status: "approved", reviewedBy: ctx.uid, reviewedAt: serverTimestamp(), expenseId: ref.id, ...(d.amount ? {} : { amount: Math.round(amount * 100) / 100 }) });
  return ref.id;
}

// A driver's papers and receipts go to dispatch AND the carrier at the same time. Whoever gets to it
// first approves it, or rejects it (a duplicate, a bad photo). The owner sees everything.
export function docsReviewQueue(ctx, carrierIds, onCount) {
  const body = h("div");
  const canExpense = ["owner", "carrierAdmin"].includes(ctx.profile.role);
  const box = card("Docs to review", h("span", { class: "muted small" }, "From drivers · goes to the carrier and dispatch"), body);
  let limit = 25, last = [];
  const reject = async (d, reason) => {
    const ok = await guard(() => updateDoc(doc(db, "documents", d.id), { status: "rejected", rejectReason: reason, reviewedBy: ctx.uid, reviewedAt: serverTimestamp() }), reason === "duplicate" ? "Duplicate rejected" : "Rejected");
    if (ok !== null) removeFromDrive(d.id);
  };
  const draw = (docs) => {
    last = docs;
    docs.sort((a, b) => -byNewest(a, b)); // oldest first: first in, first reviewed
    onCount && onCount(docs.length);
    forgetCleanChecks(); // something new may have arrived that duplicates an older one
    body.replaceChildren(docs.length ? h("div", { class: "list" }, docs.slice(0, limit).map((d) => {
      const flag = h("div", { class: "dupe-slot" });
      const dupBtn = btn("Reject duplicate", () => reject(d, "duplicate"), "warn", { hidden: true });
      findDuplicate(d).then((r) => {
        if (!r) return;
        flag.replaceChildren(h("span", { class: "pill pill-warn" }, "Possible duplicate"), " ", h("span", { class: "small" }, dupeText(r)),
          r.other.uploaderName ? h("span", { class: "muted small" }, ` · from ${r.other.uploaderName}`) : null,
          " ", h("button", { type: "button", class: "btn-link small", onClick: () => openDoc(r.other) }, "View the other"));
        dupBtn.hidden = false;
      });
      return h("div", { class: "row col review-row" },
        h("div", { class: "row-top" },
          h("div", { class: "review-main" },
            h("div", { class: "badge-kind" }, (d.kind || "DOC").slice(0, 4).toUpperCase()),
            h("div", { class: "grow" },
              h("div", { class: "strong" }, d.name),
              h("div", { class: "muted small" }, [d.uploaderName, ctx.carrierName(d.carrierId), d.loadLabel, d.amount ? money(d.amount) : null, ago(d.createdAt)].filter(Boolean).join(" · ")),
              d.note ? h("div", { class: "small" }, d.note) : null))),
        flag,
        h("div", { class: "acts" },
          btn("View", () => openDoc(d)),
          canExpense && isReceiptDoc(d) ? btn("Approve + add expense", () => guard(() => receiptToExpense(ctx, d), "Approved and added to expenses"), "ok") : null,
          btn("Approve", () => guard(() => updateDoc(doc(db, "documents", d.id), { status: "approved", reviewedBy: ctx.uid, reviewedAt: serverTimestamp() }), "Approved"), canExpense && isReceiptDoc(d) ? "ghost" : "ok"),
          dupBtn,
          btn("Reject", () => reject(d, "rejected"), "ghost")));
    }), moreButton(docs.length, limit, () => { limit += 25; draw(last); })) : h("p", { class: "empty" }, "All caught up."));
  };
  ctx.sub(watchMany(scoped(ctx, "documents", carrierIds, where("status", "==", "pending")), draw));
  return box;
}

// ---------- Truck / lane requests ----------

export function requestsList(ctx, carrierIds, { staff, onCount } = {}) {
  const body = h("div");
  const drafts = new Map(); // half-typed replies survive live updates
  let limit = 25, last = [];
  const draw = (reqs) => {
    last = reqs;
    // Keep focus in the reply box the dispatcher is typing in.
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.reqId : null;
    const rank = (r) => (r.status === "open" ? 0 : 1);
    reqs.sort((a, b) => rank(a) - rank(b) || byNewest(a, b));
    onCount && onCount(reqs.filter((r) => r.status === "open").length);
    const shown = reqs.slice(0, limit);
    let refocus = null;
    body.replaceChildren(reqs.length ? h("div", { class: "list" }, shown.map((r) => {
      const replyIn = input("reply", { placeholder: "Reply to the carrier…", "aria-label": "Reply", value: drafts.get(r.id) || "", "data-req-id": r.id });
      replyIn.addEventListener("input", () => drafts.set(r.id, replyIn.value));
      if (focused === r.id) refocus = replyIn;
      const replyBox = h("form", { class: "inline-form", onSubmit: async (e) => {
        e.preventDefault();
        const text = replyIn.value.trim();
        if (!text) return;
        const ok = await guard(() => updateDoc(doc(db, "requests", r.id), { reply: text, status: "answered", repliedBy: ctx.profile.name || "Dispatch", repliedAt: serverTimestamp() }), "Reply sent");
        if (ok !== null) drafts.delete(r.id);
      } }, replyIn, btn("Send", null, "dark", { type: "submit" }));
      return h("div", { class: "row col" },
        h("div", { class: "row-top" },
          h("div", { class: "strong" }, [ctx.carrierName(r.carrierId), r.truckUnit].filter(Boolean).join(" · ")),
          h("div", { class: "row-meta" }, pill(r.status), h("span", { class: "muted small" }, ago(r.createdAt)))),
        h("div", { class: "quote" }, r.text),
        r.reply ? h("div", { class: "reply" }, h("span", { class: "strong small" }, (r.repliedBy || "Dispatch") + ": "), r.reply) : null,
        staff && r.status !== "answered" ? replyBox : null);
    }), moreButton(reqs.length, limit, () => { limit += 25; draw(last); })) : h("p", { class: "empty" }, "No requests yet."));
    if (refocus) { refocus.focus(); refocus.setSelectionRange(refocus.value.length, refocus.value.length); }
  };
  ctx.sub(watchMany(scoped(ctx, "requests", carrierIds), draw));
  return card("Truck requests", null, body);
}

export function moreButton(total, shown, onMore) {
  if (total <= shown) return null;
  return h("div", { class: "more" }, h("span", { class: "muted small" }, `Showing ${shown} of ${total}`), btn("Show more", onMore, "ghost"));
}

// ---------- Loads ----------

// opts: { showMoney, editable, title }
export function loadsTable(ctx, carrierIds, opts = {}) {
  let loads = [], moneyRows = new Map(), filter = "all", search = "", limit = 100;
  const body = h("div");
  const searchIn = input("q", { type: "search", placeholder: "Search lane, driver, truck, load #…", "aria-label": "Search loads" });
  searchIn.addEventListener("input", () => { search = searchIn.value.trim().toLowerCase(); limit = 100; draw(); });
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter loads" });
  const draw = () => {
    chips.replaceChildren(...[["all", "All"], ["booked", "Booked"], ["in_transit", "In transit"], ["delivered", "Delivered"], ["paid", "Paid"]].map(([v, l]) =>
      h("button", { type: "button", class: "chip" + (filter === v ? " on" : ""), "aria-pressed": String(filter === v), onClick: () => { filter = v; limit = 100; draw(); } }, l)));
    const matches = loads.filter((l) => (filter === "all" || l.status === filter) &&
      (!search || [shortId(l.id), lane(l), l.driverName, l.truckUnit, ctx.carrierName(l.carrierId), l.dispatcherName].filter(Boolean).join(" ").toLowerCase().includes(search)))
      .sort(byNewest);
    const shown = matches.slice(0, limit);
    const cols = [
      { label: "Load", cell: (l) => h("span", { class: "mono" }, shortId(l.id)) },
      { label: "Carrier", cell: (l) => h("span", { class: "strong" }, ctx.carrierName(l.carrierId)) },
      { label: "Driver · Truck", cell: (l) => [l.driverName, l.truckUnit].filter(Boolean).join(" · ") || "—" },
      { label: "Lane", cell: lane },
      { label: "Pickup", cell: (l) => fmtDate(l.pickupDate) },
      { label: "Miles", cell: (l) => h("span", { class: "mono" }, l.miles || "—"), align: "right" },
    ];
    if (opts.showMoney) {
      cols.push({ label: "Rate", cell: (l) => h("span", { class: "mono" }, money(moneyRows.get(l.id)?.rate)), align: "right" });
      cols.push({ label: "Dispatch fee", cell: (l) => {
        const m = moneyRows.get(l.id);
        if (!m) return "—";
        const v = h("span", { class: "mono" }, money(m.fee));
        if (!opts.editable || !m.fee) return v;
        return h("span", { class: "fee-cell" }, v, h("label", { class: "tiny-check" },
          h("input", { type: "checkbox", checked: !!m.feePaid, onChange: (e) => guard(() => updateDoc(doc(db, "loadMoney", l.id), { feePaid: e.target.checked })) }), "paid"));
      }, align: "right" });
    }
    if (opts.showDispatcher) cols.push({ label: "Dispatcher", cell: (l) => l.dispatcherName || "—" });
    if (opts.editable) cols.push({ label: "Paperwork", cell: (l) => h("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-label": "Scan paperwork for load " + shortId(l.id), onClick: () => openScanDialog(ctx, l) }, "Scan") });
    cols.push({ label: "Status", cell: (l) => opts.editable
      ? h("select", { class: "input input-sm", "aria-label": "Status for load " + shortId(l.id), onChange: (e) => guard(() => updateDoc(doc(db, "loads", l.id), { status: e.target.value, updatedAt: serverTimestamp() })) },
          LOAD_STATUSES.map((s) => h("option", { value: s.value, selected: s.value === l.status }, s.label)))
      : pill(l.status) });
    body.replaceChildren(table(cols, shown, search ? "No loads match that search." : "No loads yet."),
      moreButton(matches.length, limit, () => { limit += 100; draw(); }));
  };
  let pending = null;
  const soon = () => { if (!pending) pending = setTimeout(() => { pending = null; draw(); }, 50); };
  ctx.sub(watchMany(scoped(ctx, "loads", carrierIds), (r) => { loads = r; opts.onLoads && opts.onLoads(r); soon(); }));
  if (opts.showMoney) ctx.sub(watchMany(scoped(ctx, "loadMoney", carrierIds), (r) => { moneyRows = new Map(r.map((m) => [m.id, m])); opts.onMoney && opts.onMoney(r); soon(); }));
  ctx.sub(() => clearTimeout(pending));
  draw();
  return card(opts.title || "Load board", chips, searchIn, body);
}

// Invite-code panel (owner → carrier admins & dispatchers, carrier admin → drivers).
export function showInvite(code, who) {
  const box = h("div", { class: "invite-box" },
    h("div", { class: "muted small" }, `Invite code for ${who}. Send it with the sign-up link; it works once.`),
    h("div", { class: "invite-code mono" }, code),
    btn("Copy", async () => { await navigator.clipboard.writeText(`Join KeepTrack: ${location.origin}${location.pathname} — invite code ${code}`); toast("Copied", "ok"); }));
  return box;
}
