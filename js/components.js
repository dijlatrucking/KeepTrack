// Pieces shared by several roles.
import {
  db, storage, collection, doc, addDoc, setDoc, updateDoc, getDocs, query, where,
  serverTimestamp, ref, uploadBytes, getDownloadURL
} from "./fb.js";
import { h, card, table, pill, money, num, fmtDate, ago, field, input, select, btn, formToObj, guard, toast } from "./ui.js";
import { watch, watchMany, perCarrier, byNewest } from "./data.js";

const LOAD_STATUSES = [
  { value: "booked", label: "Booked" },
  { value: "in_transit", label: "In transit" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
];

export const lane = (l) => `${l.origin || "?"} → ${l.destination || "?"}`;
export const shortId = (id) => "#" + id.slice(0, 6).toUpperCase();

// ---------- Documents ----------

export async function openDoc(d) {
  const w = window.open("", "_blank");
  try {
    const url = await getDownloadURL(ref(storage, d.storagePath));
    if (w) w.location = url; else window.location = url;
  } catch (e) {
    if (w) w.close();
    toast("Couldn't open that file.", "bad");
  }
}

export async function uploadDoc(ctx, file, meta) {
  if (!file) throw new Error("Choose a file first.");
  if (file.size > 15 * 1024 * 1024) throw new Error("Files must be under 15 MB.");
  const safe = file.name.replace(/[^\w.-]+/g, "_");
  const path = `docs/${meta.carrierId}/${ctx.uid}/${Date.now()}_${safe}`;
  await uploadBytes(ref(storage, path), file, { contentType: file.type || "application/octet-stream" });
  return addDoc(collection(db, "documents"), {
    ...meta,
    name: meta.name || file.name,
    storagePath: path,
    uploadedBy: ctx.uid,
    uploaderName: ctx.profile.name || "",
    uploaderRole: ctx.profile.role,
    createdAt: serverTimestamp(),
  });
}

// Pending BOLs/receipts for staff to approve. Approved docs become visible to the carrier admin.
export function docsReviewQueue(ctx, carrierIds, onCount) {
  const body = h("div");
  const box = card("Docs to review", h("span", { class: "muted small" }, "Approved docs pass up to the carrier + owner"), body);
  ctx.sub(watchMany(perCarrier("documents", carrierIds, where("status", "==", "pending")), (docs) => {
    docs.sort(byNewest);
    onCount && onCount(docs.length);
    body.replaceChildren(docs.length ? h("div", { class: "list" }, docs.map((d) => h("div", { class: "row" },
      h("div", { class: "badge-kind" }, (d.kind || "DOC").slice(0, 4).toUpperCase()),
      h("div", { class: "grow" },
        h("div", { class: "strong" }, d.name),
        h("div", { class: "muted small" }, [d.uploaderName, ctx.carrierName(d.carrierId), d.loadLabel, ago(d.createdAt)].filter(Boolean).join(" · "))),
      btn("View", () => openDoc(d)),
      btn("Approve", () => guard(() => updateDoc(doc(db, "documents", d.id), { status: "approved", reviewedBy: ctx.uid, reviewedAt: serverTimestamp() }), "Approved"), "ok"),
      btn("Reject", () => guard(() => updateDoc(doc(db, "documents", d.id), { status: "rejected", reviewedBy: ctx.uid, reviewedAt: serverTimestamp() }), "Rejected"), "ghost"),
    ))) : h("p", { class: "empty" }, "All caught up."));
  }));
  return box;
}

// ---------- Truck / lane requests ----------

export function requestsList(ctx, carrierIds, { staff, onCount } = {}) {
  const body = h("div");
  ctx.sub(watchMany(perCarrier("requests", carrierIds), (reqs) => {
    reqs.sort(byNewest);
    onCount && onCount(reqs.filter((r) => r.status === "open").length);
    body.replaceChildren(reqs.length ? h("div", { class: "list" }, reqs.map((r) => {
      const replyBox = h("form", { class: "inline-form", onSubmit: async (e) => {
        e.preventDefault();
        const text = e.target.reply.value.trim();
        if (!text) return;
        await guard(() => updateDoc(doc(db, "requests", r.id), { reply: text, status: "answered", repliedBy: ctx.profile.name || "Dispatch", repliedAt: serverTimestamp() }), "Reply sent");
      } }, input("reply", { placeholder: "Reply to the carrier…", "aria-label": "Reply" }), btn("Send", null, "dark", { type: "submit" }));
      return h("div", { class: "row col" },
        h("div", { class: "row-top" },
          h("div", { class: "strong" }, [ctx.carrierName(r.carrierId), r.truckUnit].filter(Boolean).join(" · ")),
          h("div", { class: "row-meta" }, pill(r.status), h("span", { class: "muted small" }, ago(r.createdAt)))),
        h("div", { class: "quote" }, r.text),
        r.reply ? h("div", { class: "reply" }, h("span", { class: "strong small" }, (r.repliedBy || "Dispatch") + ": "), r.reply) : null,
        staff && r.status !== "answered" ? replyBox : null);
    })) : h("p", { class: "empty" }, "No requests yet."));
  }));
  return card("Truck requests", null, body);
}

// ---------- Loads ----------

// opts: { showMoney, editable, title }
export function loadsTable(ctx, carrierIds, opts = {}) {
  let loads = [], moneyRows = new Map(), filter = "all";
  const body = h("div");
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter loads" });
  const draw = () => {
    chips.replaceChildren(...[["all", "All"], ["booked", "Booked"], ["in_transit", "In transit"], ["delivered", "Delivered"]].map(([v, l]) =>
      h("button", { type: "button", class: "chip" + (filter === v ? " on" : ""), "aria-pressed": String(filter === v), onClick: () => { filter = v; draw(); } }, l)));
    const shown = loads.filter((l) => filter === "all" || l.status === filter).sort(byNewest);
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
    cols.push({ label: "Status", cell: (l) => opts.editable
      ? h("select", { class: "input input-sm", "aria-label": "Status for load " + shortId(l.id), onChange: (e) => guard(() => updateDoc(doc(db, "loads", l.id), { status: e.target.value, updatedAt: serverTimestamp() })) },
          LOAD_STATUSES.map((s) => h("option", { value: s.value, selected: s.value === l.status }, s.label)))
      : pill(l.status) });
    body.replaceChildren(table(cols, shown, "No loads yet."));
  };
  ctx.sub(watchMany(perCarrier("loads", carrierIds), (r) => { loads = r; opts.onLoads && opts.onLoads(r); draw(); }));
  if (opts.showMoney) ctx.sub(watchMany(perCarrier("loadMoney", carrierIds), (r) => { moneyRows = new Map(r.map((m) => [m.id, m])); opts.onMoney && opts.onMoney(r); draw(); }));
  draw();
  return card(opts.title || "Load board", chips, body);
}

// Dispatcher/owner: book a new load for any carrier they work.
export function loadForm(ctx) {
  const carriers = ctx.carriers;
  const wrap = h("div");
  if (!carriers.length) {
    wrap.append(card("Book a load", null, h("p", { class: "empty" }, "No carriers assigned to you yet.")));
    return wrap;
  }
  const driverSel = select("driver", [{ value: "", label: "Unassigned" }]);
  const truckSel = select("truck", [{ value: "", label: "Unassigned" }]);
  const carrierSel = select("carrierId", carriers.map((c) => ({ value: c.id, label: c.name })));
  const rateIn = input("rate", { type: "number", step: "0.01", min: "0", inputmode: "decimal", required: true });
  const feeIn = input("fee", { type: "number", step: "0.01", min: "0", inputmode: "decimal" });
  let drivers = [], trucks = [];

  const loadPeople = async () => {
    const cid = carrierSel.value;
    const [ds, ts] = await Promise.all([
      getDocs(query(collection(db, "users"), where("carrierId", "==", cid), where("role", "==", "driver"))),
      getDocs(query(collection(db, "trucks"), where("carrierId", "==", cid))),
    ]).catch(() => [null, null]);
    drivers = ds ? ds.docs.map((d) => ({ id: d.id, ...d.data() })) : [];
    trucks = ts ? ts.docs.map((d) => ({ id: d.id, ...d.data() })) : [];
    driverSel.replaceChildren(h("option", { value: "" }, "Unassigned"), ...drivers.map((d) => h("option", { value: d.id }, d.name || d.email)));
    truckSel.replaceChildren(h("option", { value: "" }, "Unassigned"), ...trucks.map((t) => h("option", { value: t.id }, t.unit)));
  };
  const autoFee = () => {
    const c = carriers.find((x) => x.id === carrierSel.value);
    if (c && c.feePercent && rateIn.value && !feeIn.dataset.touched) feeIn.value = ((num(rateIn.value) * num(c.feePercent)) / 100).toFixed(2);
  };
  carrierSel.addEventListener("change", () => { loadPeople(); autoFee(); });
  rateIn.addEventListener("input", autoFee);
  feeIn.addEventListener("input", () => (feeIn.dataset.touched = "1"));
  driverSel.addEventListener("change", () => {
    const d = drivers.find((x) => x.id === driverSel.value);
    if (d && d.truckId) truckSel.value = d.truckId;
  });
  loadPeople();

  const form = h("form", { class: "form-grid", onSubmit: async (e) => {
    e.preventDefault();
    const f = formToObj(form);
    const driver = drivers.find((d) => d.id === f.driver);
    const truck = trucks.find((t) => t.id === f.truck);
    const ok = await guard(async () => {
      const loadRef = await addDoc(collection(db, "loads"), {
        carrierId: f.carrierId,
        origin: f.origin.trim(), destination: f.destination.trim(),
        pickupDate: f.pickupDate || null, deliverBy: f.deliverBy || null,
        miles: num(f.miles), notes: f.notes.trim(),
        driverId: driver ? driver.id : null, driverName: driver ? driver.name || driver.email : null,
        truckId: truck ? truck.id : null, truckUnit: truck ? truck.unit : null,
        dispatcherId: ctx.uid, dispatcherName: ctx.profile.name || "",
        status: "booked", createdAt: serverTimestamp(),
      });
      await setDoc(doc(db, "loadMoney", loadRef.id), { carrierId: f.carrierId, rate: num(f.rate), fee: num(f.fee), feePaid: false });
      return true;
    }, "Load booked");
    if (ok) { form.reset(); delete feeIn.dataset.touched; loadPeople(); }
  } },
    field("Carrier", carrierSel),
    field("Driver", driverSel),
    field("Truck", truckSel),
    field("Origin", input("origin", { required: true, placeholder: "City, ST" })),
    field("Destination", input("destination", { required: true, placeholder: "City, ST" })),
    field("Pickup date", input("pickupDate", { type: "date" })),
    field("Deliver by", input("deliverBy", { type: "date" })),
    field("Loaded miles", input("miles", { type: "number", min: "0", inputmode: "numeric" })),
    field("Load rate ($)", rateIn),
    field("Dispatch fee ($)", feeIn, "Auto-fills from the carrier's fee %"),
    field("Notes", input("notes", { placeholder: "Reefer temp, appointment #, etc." })),
    h("div", { class: "form-actions" }, btn("Book load", null, "primary", { type: "submit" })));

  let open = false;
  const toggle = btn("+ Book load", () => { open = !open; form.hidden = !open; toggle.textContent = open ? "Close" : "+ Book load"; }, "primary");
  form.hidden = true;
  wrap.append(card("Book a load", toggle, form));
  return wrap;
}

// Invite-code panel (owner → carrier admins & dispatchers, carrier admin → drivers).
export function showInvite(code, who) {
  const box = h("div", { class: "invite-box" },
    h("div", { class: "muted small" }, `Invite code for ${who}. Send it with the sign-up link; it works once.`),
    h("div", { class: "invite-code mono" }, code),
    btn("Copy", async () => { await navigator.clipboard.writeText(`Join KeepTrack: ${location.origin}${location.pathname} — invite code ${code}`); toast("Copied", "ok"); }));
  return box;
}
