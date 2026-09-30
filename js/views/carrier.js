import { db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp } from "../fb.js";
import { h, card, table, stat, money, num, field, input, select, btn, formToObj, guard, inviteCode, pill, fmtDate, ago, toDate } from "../ui.js";
import { watch, byNewest, driverPayFor } from "../data.js";
import { lane, shortId, uploadDoc, openDoc } from "../components.js";

const cid = (ctx) => ctx.profile.carrierId;
const q = (ctx, coll, ...w) => query(collection(db, coll), where("carrierId", "==", cid(ctx)), ...w);
const PAY_LABEL = { perMile: "per mile", percent: "% of load", flat: "flat per load" };
const payText = (d) => (d.payRate ? (d.payType === "percent" ? `${d.payRate}% of load` : `$${d.payRate} ${PAY_LABEL[d.payType || "perMile"]}`) : "Not set");

// Shared live data for the carrier pages.
function carrierData(ctx, cb) {
  const s = { loads: [], money: new Map(), drivers: [] };
  ctx.sub(watch(q(ctx, "loads"), (r) => { s.loads = r; cb(s); }));
  ctx.sub(watch(q(ctx, "loadMoney"), (r) => { s.money = new Map(r.map((m) => [m.id, m])); cb(s); }));
  ctx.sub(watch(q(ctx, "users", where("role", "==", "driver")), (r) => { s.drivers = r; cb(s); }));
}

function overview(ctx, root) {
  const tiles = h("div", { class: "stats" });
  const loadsBody = h("div");
  const periodSel = select("period", [{ value: "week", label: "Last 7 days" }, { value: "month", label: "Last 30 days" }, { value: "all", label: "All time" }], { "aria-label": "Period" });
  let last = null;
  const draw = (s) => {
    last = s;
    const days = periodSel.value === "week" ? 7 : periodSel.value === "month" ? 30 : null;
    const since = days ? Date.now() - days * 86400000 : 0;
    const inPeriod = s.loads.filter((l) => l.status !== "cancelled" && (!days || (toDate(l.pickupDate || l.createdAt)?.getTime() || 0) >= since));
    const drivers = new Map(s.drivers.map((d) => [d.id, d]));
    let gross = 0, fee = 0, owed = 0, pay = 0;
    const rows = inPeriod.map((l) => {
      const m = s.money.get(l.id) || {};
      const dp = driverPayFor(l, m.rate, drivers.get(l.driverId));
      gross += num(m.rate); fee += num(m.fee); pay += dp;
      if (!m.feePaid) owed += num(m.fee);
      return { ...l, rate: m.rate, fee: m.fee, feePaid: m.feePaid, dp, net: num(m.rate) - num(m.fee) - dp };
    }).sort(byNewest);
    tiles.replaceChildren(
      stat("Load gross", money(gross)),
      stat("Dispatch fees", money(fee)),
      stat("Owed to dispatch", money(owed), "Unpaid fees"),
      stat("Driver pay", money(pay), "From each driver's pay setup"),
      stat("Carrier net", money(gross - fee - pay)));
    loadsBody.replaceChildren(table([
      { label: "Load", cell: (l) => h("span", { class: "mono" }, shortId(l.id)) },
      { label: "Lane", cell: lane },
      { label: "Driver · Truck", cell: (l) => [l.driverName, l.truckUnit].filter(Boolean).join(" · ") || "—" },
      { label: "Pickup", cell: (l) => fmtDate(l.pickupDate) },
      { label: "Gross", cell: (l) => h("span", { class: "mono" }, money(l.rate)), align: "right" },
      { label: "Fee", cell: (l) => h("span", { class: "mono" }, money(l.fee)), align: "right" },
      { label: "Driver pay", cell: (l) => h("span", { class: "mono" }, money(l.dp)), align: "right" },
      { label: "Net", cell: (l) => h("span", { class: "mono strong" }, money(l.net)), align: "right" },
      { label: "Status", cell: (l) => pill(l.status) },
    ], rows, "No loads in this period."));
  };
  periodSel.addEventListener("change", () => last && draw(last));
  carrierData(ctx, draw);
  root.append(card("Money · full breakdown", periodSel, tiles), card("Loads", null, loadsBody));
}

function people(ctx, root) {
  let trucks = [];
  const inviteSlot = h("div");
  const driversBody = h("div");
  const trucksBody = h("div");

  const drawDrivers = (drivers) => driversBody.replaceChildren(drivers.length ? h("div", { class: "list" }, drivers.map((d) => {
    const typeSel = select("payType", [
      { value: "perMile", label: "Per mile", selected: (d.payType || "perMile") === "perMile" },
      { value: "percent", label: "% of load", selected: d.payType === "percent" },
      { value: "flat", label: "Flat per load", selected: d.payType === "flat" }]);
    const truckSel = select("truckId", [{ value: "", label: "No truck" }, ...trucks.map((t) => ({ value: t.id, label: t.unit, selected: t.id === d.truckId }))]);
    const edit = h("form", { class: "inline-form", hidden: true, onSubmit: async (e) => {
      e.preventDefault();
      const f = formToObj(edit);
      const t = trucks.find((x) => x.id === f.truckId);
      await guard(() => updateDoc(doc(db, "users", d.id), { payType: f.payType, payRate: num(f.payRate), truckId: t ? t.id : null, truckUnit: t ? t.unit : null }), "Driver saved");
    } },
      field("Pay type", typeSel), field("Rate", input("payRate", { type: "number", step: "0.01", min: "0", value: d.payRate ?? "" })),
      field("Truck", truckSel), btn("Save", null, "dark", { type: "submit" }));
    return h("div", { class: "row col" },
      h("div", { class: "row-top" },
        h("div", null, h("div", { class: "strong" }, d.name || d.email), h("div", { class: "muted small" }, [d.truckUnit, payText(d)].filter(Boolean).join(" · "))),
        h("div", { class: "row-meta" },
          btn("Edit", () => (edit.hidden = !edit.hidden)),
          btn("Remove", async () => {
            if (!confirm(`Remove ${d.name || d.email}? They lose access to your company right away.`)) return;
            await guard(() => deleteDoc(doc(db, "users", d.id)), "Driver removed");
          }, "ghost"))),
      edit);
  })) : h("p", { class: "empty" }, "No drivers yet. Invite one below."));

  let driverCache = [];
  ctx.sub(watch(q(ctx, "trucks"), (r) => {
    trucks = r.sort((a, b) => (a.unit || "").localeCompare(b.unit || ""));
    drawDrivers(driverCache);
    trucksBody.replaceChildren(table([
      { label: "Unit", cell: (t) => h("span", { class: "strong" }, t.unit) },
      { label: "Type", cell: (t) => t.type || "—" },
      { label: "VIN / Plate", cell: (t) => [t.vin, t.plate].filter(Boolean).join(" · ") || "—" },
      { label: "Registration exp.", cell: (t) => fmtDate(t.regExpires) },
      { label: "", cell: (t) => btn("Remove", () => confirm(`Remove ${t.unit}?`) && guard(() => deleteDoc(doc(db, "trucks", t.id)), "Truck removed"), "ghost") },
    ], trucks, "No trucks yet."));
  }));
  ctx.sub(watch(q(ctx, "users", where("role", "==", "driver")), (r) => { driverCache = r; drawDrivers(r); }));

  const truckForm = h("form", { class: "form-grid", onSubmit: async (e) => {
    e.preventDefault();
    const f = formToObj(truckForm);
    const ok = await guard(() => addDoc(collection(db, "trucks"), {
      carrierId: cid(ctx), unit: f.unit.trim(), type: f.type, vin: f.vin.trim(), plate: f.plate.trim(),
      regExpires: f.regExpires || null, status: "active", createdAt: serverTimestamp(),
    }), "Truck added");
    if (ok) truckForm.reset();
  } },
    field("Unit #", input("unit", { required: true, placeholder: "Unit 3" })),
    field("Type", select("type", ["Reefer", "Dry van", "Flatbed", "Step deck", "Tanker", "Other"])),
    field("VIN", input("vin")), field("Plate", input("plate")),
    field("Registration expires", input("regExpires", { type: "date" })),
    h("div", { class: "form-actions" }, btn("Add truck", null, "primary", { type: "submit" })));

  root.append(
    card("Drivers", btn("Invite driver", async () => {
      const code = inviteCode();
      const ok = await guard(() => setDoc(doc(db, "invites", code), { role: "driver", carrierId: cid(ctx), carrierName: ctx.carrierName(cid(ctx)), used: false, createdBy: ctx.uid, createdAt: serverTimestamp() }));
      if (ok !== null) {
        const { showInvite } = await import("../components.js");
        inviteSlot.replaceChildren(showInvite(code, "a driver"));
      }
    }, "primary"), inviteSlot, driversBody),
    card("Trucks", null, trucksBody, h("details", { class: "add" }, h("summary", null, "+ Add truck"), truckForm)));
}

function documents(ctx, root) {
  let docs = [], term = "", cat = "All";
  const CATS = ["All", "Insurance", "Authority", "W-9", "Registrations", "CDLs & med cards", "BOLs", "Receipts", "Other"];
  const listBody = h("div");
  const chips = h("div", { class: "chips" });
  const draw = () => {
    chips.replaceChildren(...CATS.map((c) => h("button", { type: "button", class: "chip" + (cat === c ? " on" : ""), "aria-pressed": String(cat === c), onClick: () => { cat = c; draw(); } }, c)));
    const t = term.toLowerCase();
    const shown = docs.filter((d) => {
      const category = d.category || (d.kind === "BOL" ? "BOLs" : d.kind === "Receipt" ? "Receipts" : "Other");
      if (cat !== "All" && category !== cat) return false;
      if (!t) return true;
      return [d.name, d.category, d.kind, d.tags, d.uploaderName, d.loadLabel].filter(Boolean).join(" ").toLowerCase().includes(t);
    }).sort(byNewest);
    const soon = Date.now() + 30 * 86400000;
    listBody.replaceChildren(shown.length ? h("div", { class: "list" }, shown.map((d) => {
      const exp = toDate(d.expiresAt);
      const expTag = exp ? (exp.getTime() < Date.now() ? pill("x", "Expired") : exp.getTime() < soon ? pill("x", "Expires " + fmtDate(exp)) : null) : null;
      if (expTag) expTag.className = "pill pill-" + (exp.getTime() < Date.now() ? "bad" : "warn");
      return h("div", { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "strong" }, d.name),
          h("div", { class: "muted small" }, [d.category || d.kind, d.tags, d.uploaderName, exp ? "exp. " + fmtDate(exp) : null, ago(d.createdAt)].filter(Boolean).join(" · "))),
        expTag, btn("Open", () => openDoc(d)));
    })) : h("p", { class: "empty" }, docs.length ? "No matches." : "No documents yet."));
  };
  const merge = (() => { const parts = [[], []]; return (i) => (r) => { parts[i] = r; docs = [...parts[0], ...parts[1]]; draw(); }; })();
  ctx.sub(watch(q(ctx, "documents", where("status", "==", "filed")), merge(0)));
  ctx.sub(watch(q(ctx, "documents", where("status", "==", "approved")), merge(1)));

  const fileIn = input("file", { type: "file", accept: "image/*,application/pdf", required: true });
  const form = h("form", { class: "form-grid", onSubmit: async (e) => {
    e.preventDefault();
    const f = formToObj(form);
    const ok = await guard(() => uploadDoc(ctx, fileIn.files[0], {
      carrierId: cid(ctx), status: "filed", category: f.category, name: f.name.trim(), tags: f.tags.trim(), expiresAt: f.expiresAt || null,
    }), "Uploaded");
    if (ok) form.reset();
  } },
    field("File (PDF or photo)", fileIn),
    field("Name", input("name", { placeholder: "e.g. Certificate of insurance 2026" })),
    field("Category", select("category", CATS.slice(1))),
    field("Search tags", input("tags", { placeholder: "Unit 3, driver name, policy #…" })),
    field("Expires", input("expiresAt", { type: "date" }), "We'll flag it 30 days out"),
    h("div", { class: "form-actions" }, btn("Upload", null, "primary", { type: "submit" })));

  const search = input("q", { type: "search", placeholder: "Search: insurance, Unit 3, CDL, load…", "aria-label": "Search documents" });
  search.addEventListener("input", () => { term = search.value; draw(); });
  draw();
  root.append(card("Upload a document", null, form), card("Document vault", null, search, chips, listBody));
}

function requests(ctx, root) {
  let trucks = [];
  const truckSel = select("truck", [{ value: "", label: "Any truck" }]);
  ctx.sub(watch(q(ctx, "trucks"), (r) => { trucks = r; truckSel.replaceChildren(h("option", { value: "" }, "Any truck"), ...r.map((t) => h("option", { value: t.id }, t.unit))); }));
  const form = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    const f = formToObj(form);
    if (!f.text.trim()) return;
    const t = trucks.find((x) => x.id === f.truck);
    const ok = await guard(() => addDoc(collection(db, "requests"), {
      carrierId: cid(ctx), truckId: t ? t.id : null, truckUnit: t ? t.unit : null, text: f.text.trim(),
      status: "open", createdBy: ctx.uid, createdByName: ctx.profile.name || "", createdAt: serverTimestamp(),
    }), "Request sent to dispatch");
    if (ok) form.reset();
  } },
    field("Where do you want a truck to go?", h("textarea", { name: "text", class: "input", rows: "3", required: true, placeholder: "e.g. Unit 3 empty in Reno Thursday, want to head back toward Boise" })),
    h("div", { class: "row-inline" }, field("Truck", truckSel), btn("Send request", null, "primary", { type: "submit" })));
  import("../components.js").then(({ requestsList }) => root.append(requestsList(ctx, [cid(ctx)], { staff: false })));
  root.append(card("Request a load or lane", null, form));
}

function paystubs(ctx, root) {
  let state = { loads: [], money: new Map(), drivers: [] };
  const driverSel = select("driver", [{ value: "", label: "Choose driver" }], { required: true });
  const preview = h("div");
  const from = input("from", { type: "date", required: true });
  const to = input("to", { type: "date", required: true });
  const compute = () => {
    const d = state.drivers.find((x) => x.id === driverSel.value);
    if (!d || !from.value || !to.value) { preview.replaceChildren(); return null; }
    const a = toDate(from.value).getTime() - 43200000, b = toDate(to.value).getTime() + 43200000;
    const loads = state.loads.filter((l) => l.driverId === d.id && l.status === "delivered" && (() => { const t = toDate(l.deliverBy || l.pickupDate || l.createdAt)?.getTime() || 0; return t >= a && t <= b; })())
      .map((l) => ({ id: l.id, lane: lane(l), miles: num(l.miles), pay: Math.round(driverPayFor(l, state.money.get(l.id)?.rate, d) * 100) / 100 }));
    const total = loads.reduce((s, l) => s + l.pay, 0);
    preview.replaceChildren(table([
      { label: "Load", cell: (l) => h("span", { class: "mono" }, shortId(l.id)) },
      { label: "Lane", cell: (l) => l.lane },
      { label: "Miles", cell: (l) => String(l.miles), align: "right" },
      { label: "Pay", cell: (l) => h("span", { class: "mono" }, money(l.pay)), align: "right" },
    ], loads, "No delivered loads for this driver in that range."), h("p", { class: "strong" }, "Gross pay: " + money(total)));
    return { d, loads, total };
  };
  [driverSel, from, to].forEach((el) => el.addEventListener("change", compute));
  const form = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    const r = compute();
    if (!r) return;
    const deductions = num(form.deductions.value);
    const ok = await guard(() => addDoc(collection(db, "paystubs"), {
      carrierId: cid(ctx), driverId: r.d.id, driverName: r.d.name || r.d.email,
      periodStart: from.value, periodEnd: to.value, loads: r.loads, gross: r.total,
      deductions, deductionNote: form.deductionNote.value.trim(), net: Math.round((r.total - deductions) * 100) / 100,
      miles: r.loads.reduce((s, l) => s + l.miles, 0), createdAt: serverTimestamp(),
    }), "Paystub issued");
    if (ok) { form.reset(); preview.replaceChildren(); }
  } },
    h("div", { class: "form-grid" }, field("Driver", driverSel), field("From", from), field("To", to),
      field("Deductions ($)", input("deductions", { type: "number", step: "0.01", min: "0" })),
      field("Deduction note", input("deductionNote", { placeholder: "Advances, escrow…" }))),
    preview, h("div", null, btn("Issue paystub", null, "primary", { type: "submit" })));

  const issued = h("div");
  carrierData(ctx, (s) => {
    state = s;
    const cur = driverSel.value;
    driverSel.replaceChildren(h("option", { value: "" }, "Choose driver"), ...s.drivers.map((d) => h("option", { value: d.id, selected: d.id === cur }, d.name || d.email)));
  });
  ctx.sub(watch(q(ctx, "paystubs"), (r) => issued.replaceChildren(table([
    { label: "Driver", cell: (p) => h("span", { class: "strong" }, p.driverName) },
    { label: "Period", cell: (p) => `${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}` },
    { label: "Loads", cell: (p) => String((p.loads || []).length), align: "right" },
    { label: "Net", cell: (p) => h("span", { class: "mono" }, money(p.net)), align: "right" },
  ], r.sort(byNewest), "No paystubs issued yet."))));
  root.append(card("Issue a paystub", null, form), card("Issued paystubs", null, issued));
}

export default [
  { id: "overview", label: "Overview", render: overview },
  { id: "people", label: "Drivers & trucks", render: people },
  { id: "documents", label: "Documents", render: documents },
  { id: "requests", label: "Requests", render: requests },
  { id: "paystubs", label: "Paystubs", render: paystubs },
];
