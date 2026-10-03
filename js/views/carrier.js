import { db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp } from "../fb.js";
import { h, card, table, stat, money, num, field, input, select, btn, formToObj, guard, inviteCode, pill, fmtDate, ago, toDate, toast } from "../ui.js";
import { watch, byNewest, driverPayFor } from "../data.js";
import { lane, shortId, openDoc, scanPicker, saveScans, docsReviewQueue, showInvite, openSubjectFiles, isExpiring, FILE_CATEGORY } from "../components.js";
import { docActions } from "../editing.js";
import { personLabel } from "../login.js";
import { summaryView, loadsView, expensesView, taxView, carrierSettingsCard } from "../ops.js";

// The carrier these pages work on: the carrier admin's own company, or the one the owner picked.
const cid = (ctx) => ctx.cid || ctx.profile.carrierId;
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

function people(ctx, root) {
  let trucks = [];
  const inviteSlot = h("div");
  const driversBody = h("div");
  const trucksBody = h("div");
  const openEdits = new Set(); // keep a driver's edit form open through live updates

  const drawDrivers = (drivers) => driversBody.replaceChildren(drivers.length ? h("div", { class: "list" }, drivers.map((d) => {
    const typeSel = select("payType", [
      { value: "perMile", label: "Per mile", selected: (d.payType || "perMile") === "perMile" },
      { value: "percent", label: "% of load", selected: d.payType === "percent" },
      { value: "flat", label: "Flat per load", selected: d.payType === "flat" }]);
    const truckSel = select("truckId", [{ value: "", label: "No truck" }, ...trucks.map((t) => ({ value: t.id, label: t.unit, selected: t.id === d.truckId }))]);
    const edit = h("form", { class: "edit-panel", hidden: !openEdits.has(d.id), onSubmit: async (e) => {
      e.preventDefault();
      const f = formToObj(edit);
      const t = trucks.find((x) => x.id === f.truckId);
      const data = { payType: f.payType, payRate: num(f.payRate), truckId: t ? t.id : null, truckUnit: t ? t.unit : null };
      if (d.manual) Object.assign(data, { name: f.name.trim() || d.name, phone: f.phone.trim() });
      const ok = await guard(() => updateDoc(doc(db, "users", d.id), data), "Driver saved");
      if (ok !== null) { openEdits.delete(d.id); edit.hidden = true; }
    } },
      h("div", { class: "form-grid" },
        d.manual ? field("Name", input("name", { value: d.name || "" })) : null,
        d.manual ? field("Phone", input("phone", { type: "tel", value: d.phone || "" })) : null,
        field("Pay type", typeSel),
        field("Rate", input("payRate", { type: "number", step: "0.01", min: "0", inputmode: "decimal", placeholder: "e.g. 0.65", value: d.payRate ?? "" })),
        field("Truck", truckSel)),
      h("div", { class: "row-inline" }, btn("Save", null, "dark", { type: "submit" }), btn("Cancel", () => { openEdits.delete(d.id); edit.hidden = true; }, "ghost")));
    return h("div", { class: "row col" },
      h("div", { class: "row-top" },
        h("div", null, h("div", { class: "strong" }, personLabel(d), d.manual ? h("span", { class: "pill pill-neutral tag" }, "No app login") : null), h("div", { class: "muted small" }, [d.truckUnit, payText(d), d.phone].filter(Boolean).join(" · "))),
        h("div", { class: "row-meta" },
          filesBtn("driver", d.id, personLabel(d)),
          btn("Edit", () => { edit.hidden = !edit.hidden; edit.hidden ? openEdits.delete(d.id) : openEdits.add(d.id); }),
          btn("Remove", async () => {
            if (!confirm(d.manual ? `Remove ${d.name}?` : `Remove ${personLabel(d)}? They lose access to the company right away.`)) return;
            await guard(() => deleteDoc(doc(db, "users", d.id)), "Driver removed");
          }, "ghost"))),
      edit);
  })) : h("p", { class: "empty" }, "No drivers yet. Invite one, or add one by hand."));

  let driverCache = [];
  // Papers on file for each truck and driver (registration, insurance, IFTA… / CDL, med card…)
  let files = [];
  const filesOf = (key, id) => files.filter((d) => d[key] === id && d.status !== "rejected");
  const filesBtn = (kind, id, label) => {
    const list = filesOf(kind === "truck" ? "truckId" : "driverId", id), late = list.filter(isExpiring).length;
    return btn(list.length ? `Documents (${list.length})${late ? " ⚠" : ""}` : "Documents",
      () => openSubjectFiles(ctx, { kind, id, label, carrierId: cid(ctx) }), late ? "secondary" : "ghost",
      { class: "btn btn-sm" + (late ? " btn-warn" : " btn-ghost"), title: late ? `${late} expiring or expired` : "" });
  };
  const mergeFiles = (() => { const parts = [[], []]; return (i) => (r) => { parts[i] = r; files = [...parts[0], ...parts[1]]; drawDrivers(driverCache); drawTrucks(); }; })();
  ctx.sub(watch(q(ctx, "documents", where("category", "==", FILE_CATEGORY.truck)), mergeFiles(0)));
  ctx.sub(watch(q(ctx, "documents", where("category", "==", FILE_CATEGORY.driver)), mergeFiles(1)));
  const manualTruck = select("truckId", [{ value: "", label: "No truck" }]);
  ctx.sub(watch(q(ctx, "trucks"), (r) => {
    trucks = r.sort((a, b) => (a.unit || "").localeCompare(b.unit || ""));
    manualTruck.replaceChildren(h("option", { value: "" }, "No truck"), ...trucks.map((t) => h("option", { value: t.id }, t.unit)));
    drawDrivers(driverCache);
    drawTrucks();
  }));
  function drawTrucks() {
    trucksBody.replaceChildren(table([
      { label: "Unit", cell: (t) => h("span", { class: "strong" }, t.unit) },
      { label: "Type", cell: (t) => t.type || "—" },
      { label: "VIN / Plate", cell: (t) => [t.vin, t.plate].filter(Boolean).join(" · ") || "—" },
      { label: "Registration exp.", cell: (t) => fmtDate(t.regExpires) },
      { label: "Driver", cell: (t) => driverCache.filter((d) => d.truckId === t.id).map((d) => personLabel(d)).join(", ") || "—" },
      { label: "", cell: (t) => h("div", { class: "row-inline" }, filesBtn("truck", t.id, t.unit),
        btn("Remove", () => confirm(`Remove ${t.unit}?`) && guard(() => deleteDoc(doc(db, "trucks", t.id)), "Truck removed"), "ghost")) },
    ], trucks, "No trucks yet."));
  }
  ctx.sub(watch(q(ctx, "users", where("role", "==", "driver")), (r) => { driverCache = r; drawDrivers(r); drawTrucks(); }));

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

  // A driver added by hand has no app login (owner-operators, or drivers who don't use the app).
  // They can still be put on loads, given a truck and pay, and get paystubs.
  const manualForm = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    const f = formToObj(manualForm);
    if (!f.name.trim()) return;
    const t = trucks.find((x) => x.id === f.truckId);
    const id = "manual_" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    const ok = await guard(() => setDoc(doc(db, "users", id), {
      role: "driver", manual: true, carrierId: cid(ctx), name: f.name.trim(), phone: f.phone.trim(),
      payType: f.payType, payRate: num(f.payRate), truckId: t ? t.id : null, truckUnit: t ? t.unit : null, createdAt: serverTimestamp(),
    }), "Driver added");
    if (ok !== null) { manualForm.reset(); manualBox.open = false; }
  } },
    h("div", { class: "form-grid" },
      field("Name", input("name", { required: true, placeholder: "Driver's name" })),
      field("Phone", input("phone", { type: "tel" })),
      field("Pay type", select("payType", [{ value: "perMile", label: "Per mile" }, { value: "percent", label: "% of load" }, { value: "flat", label: "Flat per load" }])),
      field("Rate", input("payRate", { type: "number", step: "0.01", min: "0", inputmode: "decimal", placeholder: "e.g. 0.65" })),
      field("Truck", manualTruck)),
    h("div", null, btn("Add driver", null, "primary", { type: "submit" })),
    h("p", { class: "muted small" }, "No app login. To give them the app, use Invite driver instead."));
  const manualBox = h("details", { class: "add" }, h("summary", null, "+ Add a driver by hand"), manualForm);

  root.append(
    card("Drivers", btn("Invite driver", async () => {
      const code = inviteCode();
      const ok = await guard(() => setDoc(doc(db, "invites", code), { role: "driver", carrierId: cid(ctx), carrierName: ctx.carrierName(cid(ctx)), used: false, createdBy: ctx.uid, createdAt: serverTimestamp() }));
      if (ok !== null) inviteSlot.replaceChildren(showInvite(code, "a driver"));
    }, "primary"), inviteSlot, driversBody, manualBox),
    card("Trucks", null, trucksBody, h("details", { class: "add" }, h("summary", null, "+ Add truck"), truckForm)));
}

function documents(ctx, root) {
  let docs = [], term = "", cat = "All";
  const CATS = ["All", "Insurance", "Authority", "W-9", "Registrations", "CDLs & med cards", "Truck files", "Driver files", "Rate cons", "BOLs", "Receipts", "Other"];
  const listBody = h("div");
  const chips = h("div", { class: "chips" });
  const draw = () => {
    chips.replaceChildren(...CATS.map((c) => h("button", { type: "button", class: "chip" + (cat === c ? " on" : ""), "aria-pressed": String(cat === c), onClick: () => { cat = c; draw(); } }, c)));
    const t = term.toLowerCase();
    const shown = docs.filter((d) => {
      const category = (d.status === "filed" || d.truckId || d.driverId) && d.category ? d.category : ({ BOL: "BOLs", POD: "BOLs", Receipt: "Receipts", Lumper: "Receipts", "Rate con": "Rate cons", Insurance: "Insurance", Authority: "Authority", "W-9": "W-9", Registration: "Registrations", "CDL / med card": "CDLs & med cards" }[d.kind] || "Other");
      if (cat !== "All" && category !== cat) return false;
      if (!t) return true;
      return [d.name, d.category, d.kind, d.tags, d.uploaderName, d.loadLabel, d.truckUnit, d.driverName, d.note].filter(Boolean).join(" ").toLowerCase().includes(t);
    }).sort(byNewest);
    const soon = Date.now() + 30 * 86400000;
    listBody.replaceChildren(shown.length ? h("div", { class: "list" }, shown.map((d) => {
      const exp = toDate(d.expiresAt);
      const expTag = exp ? (exp.getTime() < Date.now() ? pill("x", "Expired") : exp.getTime() < soon ? pill("x", "Expires " + fmtDate(exp)) : null) : null;
      if (expTag) expTag.className = "pill pill-" + (exp.getTime() < Date.now() ? "bad" : "warn");
      return h("div", { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "strong" }, d.name),
          h("div", { class: "muted small" }, [d.category || d.kind, d.tags, d.uploaderName, exp ? "exp. " + fmtDate(exp) : null, ago(d.createdAt)].filter(Boolean).join(" · "))),
        expTag, h("div", { class: "row-meta" }, btn("Open", () => openDoc(d)), ...docActions(ctx, d)));
    })) : h("p", { class: "empty" }, docs.length ? "No matches." : "No documents yet."));
  };
  const merge = (() => { const parts = [[], []]; return (i) => (r) => { parts[i] = r; docs = [...parts[0], ...parts[1]]; draw(); }; })();
  ctx.sub(watch(q(ctx, "documents", where("status", "==", "filed")), merge(0)));
  ctx.sub(watch(q(ctx, "documents", where("status", "==", "approved")), merge(1)));

  const scans = scanPicker("Pages (scan with your camera or choose a PDF/photo)");
  const form = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    const f = formToObj(form);
    if (!scans.files().length) return toast("Scan or choose at least one page.", "bad");
    const ok = await guard(() => saveScans(ctx, scans.files(), {
      carrierId: cid(ctx), status: "filed", category: f.category, kind: f.category, name: f.name.trim() || undefined, tags: f.tags.trim(), expiresAt: f.expiresAt || null,
    }), "Uploaded");
    if (ok !== null) { form.reset(); scans.clear(); }
  } },
    h("div", { class: "form-grid" },
      field("Name", input("name", { placeholder: "e.g. Certificate of insurance 2026" })),
      field("Category", select("category", CATS.slice(1))),
      field("Search tags", input("tags", { placeholder: "Unit 3, driver name, policy #…" })),
      field("Expires", input("expiresAt", { type: "date" }), "We'll flag it 30 days out")),
    scans.el,
    h("div", null, btn("Upload", null, "primary", { type: "submit" })));

  const search = input("q", { type: "search", placeholder: "Search: insurance, Unit 3, CDL, load…", "aria-label": "Search documents" });
  search.addEventListener("input", () => { term = search.value; draw(); });
  draw();
  root.append(docsReviewQueue(ctx, [cid(ctx)]), card("Upload a document", null, form), card("Document vault", null, search, chips, listBody));
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
  // Driver pay fills in from the delivered loads × the driver's pay setup; type over it to pay a different amount.
  const payIn = input("pay", { type: "number", step: "0.01", min: "0", inputmode: "decimal", placeholder: "0.00", required: true });
  const dedIn = input("deductions", { type: "number", step: "0.01", min: "0", inputmode: "decimal", placeholder: "0.00" });
  const payHint = h("span", { class: "field-hint" }, "Fills in from the driver's delivered loads. Type a different amount to override.");
  const netLine = h("p", { class: "paystub-net" });
  let calc = null, typed = false;
  const showNet = () => {
    const pay = num(payIn.value), ded = num(dedIn.value);
    netLine.replaceChildren(payIn.value === "" ? "" : h("span", null, `Pay ${money(pay)}`, ded ? ` − deductions ${money(ded)}` : "", " = ", h("b", null, `Net ${money(Math.round((pay - ded) * 100) / 100)}`)));
  };
  const compute = () => {
    const d = state.drivers.find((x) => x.id === driverSel.value);
    if (!d || !from.value || !to.value) { preview.replaceChildren(); calc = null; return null; }
    const a = toDate(from.value).getTime() - 43200000, b = toDate(to.value).getTime() + 43200000;
    const loads = state.loads.filter((l) => l.driverId === d.id && ["delivered", "paid"].includes(l.status) && (() => { const t = toDate(l.deliverBy || l.pickupDate || l.createdAt)?.getTime() || 0; return t >= a && t <= b; })())
      .map((l) => ({ id: l.id, lane: lane(l), miles: num(l.miles), pay: Math.round(driverPayFor(l, state.money.get(l.id)?.rate, d) * 100) / 100 }));
    const total = Math.round(loads.reduce((s2, l) => s2 + l.pay, 0) * 100) / 100;
    const noRate = !num(d.payRate);
    // one line per load, so it fits a phone
    preview.replaceChildren(loads.length
      ? h("div", { class: "list" }, loads.map((l) => h("div", { class: "row" },
          h("div", { class: "grow" }, h("div", null, l.lane), h("div", { class: "muted small" }, `${shortId(l.id)} · ${l.miles.toLocaleString()} mi`)),
          h("b", { class: "mono" }, money(l.pay)))))
      : h("p", { class: "empty" }, "No delivered loads for this driver in that range. You can still enter a pay amount."),
    loads.length ? h("p", { class: "muted small" }, `From loads: ${money(total)}${noRate ? " (this driver has no pay rate set; set it in Drivers & trucks, or enter the amount)" : ""}`) : null);
    calc = { d, loads, total };
    if (!typed) payIn.value = loads.length ? total.toFixed(2) : "";
    payHint.textContent = typed && payIn.value !== "" && num(payIn.value) !== total
      ? `Changed from ${money(total)} (from loads). `
      : "Fills in from the driver's delivered loads. Type a different amount to override.";
    if (typed && num(payIn.value) !== total) payHint.append(h("button", { type: "button", class: "btn-link small", onClick: () => { typed = false; compute(); } }, "Use loads total"));
    showNet();
    return calc;
  };
  [driverSel, from, to].forEach((el) => el.addEventListener("change", compute));
  payIn.addEventListener("input", () => { typed = true; compute(); });
  dedIn.addEventListener("input", showNet);
  const form = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    const r = compute();
    if (!r) return;
    const pay = Math.round(num(payIn.value) * 100) / 100, deductions = Math.round(num(dedIn.value) * 100) / 100;
    if (!pay && !confirm("Issue a $0 paystub?")) return;
    const ok = await guard(() => addDoc(collection(db, "paystubs"), {
      carrierId: cid(ctx), driverId: r.d.id, driverName: r.d.name || r.d.username || r.d.email || "",
      periodStart: from.value, periodEnd: to.value, loads: r.loads,
      loadsPay: r.total, adjustment: Math.round((pay - r.total) * 100) / 100, gross: pay,
      deductions, deductionNote: form.deductionNote.value.trim(), net: Math.round((pay - deductions) * 100) / 100,
      miles: r.loads.reduce((s2, l) => s2 + l.miles, 0), createdAt: serverTimestamp(),
    }), "Paystub issued");
    if (ok) { form.reset(); typed = false; preview.replaceChildren(); netLine.replaceChildren(); calc = null; }
  } },
    h("div", { class: "form-grid" }, field("Driver", driverSel), field("From", from), field("To", to)),
    preview,
    h("div", { class: "form-grid" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Driver pay ($)"), payIn, payHint),
      field("Deductions ($)", dedIn),
      field("Deduction note", input("deductionNote", { placeholder: "Advances, escrow…" }))),
    netLine,
    h("div", null, btn("Issue paystub", null, "primary", { type: "submit" })));

  const issued = h("div");
  carrierData(ctx, (s2) => {
    state = s2;
    const cur = driverSel.value;
    driverSel.replaceChildren(h("option", { value: "" }, "Choose driver"), ...s2.drivers.map((d) => h("option", { value: d.id, selected: d.id === cur }, d.name || d.username || d.email)));
    compute();
  });
  ctx.sub(watch(q(ctx, "paystubs"), (r) => {
    r.sort(byNewest);
    issued.replaceChildren(r.length ? h("div", { class: "list" }, r.map((p) => h("div", { class: "row" },
      h("div", { class: "grow" },
        h("div", { class: "strong" }, p.driverName || "Driver"),
        h("div", { class: "muted small" }, [`${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}`, `${(p.loads || []).length} load${(p.loads || []).length === 1 ? "" : "s"}`,
          p.deductions ? `pay ${money(p.gross)} − ${money(p.deductions)}` : null].filter(Boolean).join(" · "))),
      h("b", { class: "mono" }, money(p.net)),
      btn("Delete", () => confirm(`Delete ${p.driverName || "this driver"}'s paystub for ${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}? The driver won't see it anymore.`)
        && guard(() => deleteDoc(doc(db, "paystubs", p.id)), "Paystub deleted"), "ghost", { class: "btn btn-ghost btn-sm danger" })))) : h("p", { class: "empty" }, "No paystubs issued yet."));
  }));
  root.append(card("Issue a paystub", null, form), card("Issued paystubs", null, issued));
}

export { people, documents, paystubs };

const mine = (ctx) => [ctx.profile.carrierId];

// The menu: a few sections; a section with several pages shows them as tabs.
export const sections = [
  { label: "Summary", pages: ["summary"] },
  { label: "Loads", pages: ["loads", "requests"] },
  { label: "Money", pages: ["expenses", "paystubs", "tax"] },
  { label: "Documents", pages: ["documents"] },
  { label: "Drivers & trucks", pages: ["people"] },
  { label: "Settings", pages: ["settings"] },
];

export default [
  { id: "summary", label: "Summary", render: (ctx, root) => summaryView(ctx, root, mine(ctx)) },
  { id: "loads", label: "Loads", render: (ctx, root) => loadsView(ctx, root, mine(ctx)) },
  { id: "expenses", label: "Expenses", render: (ctx, root) => expensesView(ctx, root, mine(ctx)) },
  { id: "tax", label: "1099", render: (ctx, root) => taxView(ctx, root, mine(ctx)) },
  { id: "people", label: "Drivers & trucks", render: people },
  { id: "documents", label: "Documents", render: documents },
  { id: "requests", label: "Requests", render: requests },
  { id: "paystubs", label: "Paystubs", render: paystubs },
  { id: "settings", label: "Settings", render: (ctx, root) => root.append(carrierSettingsCard(ctx, ctx.carriers.find((c) => c.id === ctx.profile.carrierId) || { id: ctx.profile.carrierId })) },
];
