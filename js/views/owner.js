import { db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp, writeBatch } from "../fb.js";
import { h, card, table, stat, money, num, field, input, select, btn, formToObj, guard, inviteCode, pill, ago } from "../ui.js";
import { watch, byNewest } from "../data.js";
import { loadsTable, loadForm, docsReviewQueue, requestsList, showInvite, staffScanCard, openDoc } from "../components.js";

const allIds = (ctx) => ctx.carriers.map((c) => c.id);

async function createInvite(ctx, data) {
  const code = inviteCode();
  await setDoc(doc(db, "invites", code), { ...data, used: false, createdBy: ctx.uid, createdAt: serverTimestamp() });
  return code;
}

// People who signed up without a code. Approving a carrier creates their company in the same step.
function accessRequests(ctx, { hideWhenEmpty } = {}) {
  const body = h("div");
  const box = card("Access requests", null, body);
  box.classList.add("card-alert");
  const drafts = new Map(); // fee % and company picks survive live updates
  ctx.sub(watch(query(collection(db, "users"), where("role", "==", "pending")), (reqs) => {
    reqs.sort(byNewest);
    box.hidden = !!hideWhenEmpty && !reqs.length;
    body.replaceChildren(reqs.length ? h("div", { class: "list" }, reqs.map((u) => {
      const isCarrier = u.requestedRole !== "dispatcher";
      const carrierSel = select("carrier", [
        { value: "__new", label: `New carrier: ${u.company || u.name}` },
        ...ctx.carriers.map((c) => ({ value: c.id, label: `Add to existing: ${c.name}` }))]);
      const feeIn = input("fee", { type: "number", step: "0.1", min: "0", max: "100", placeholder: "e.g. 8" });
      const draft = drafts.get(u.id) || {};
      if (draft.carrier) carrierSel.value = draft.carrier;
      if (draft.fee) feeIn.value = draft.fee;
      const save = () => drafts.set(u.id, { carrier: carrierSel.value, fee: feeIn.value });
      feeIn.addEventListener("input", save);
      carrierSel.addEventListener("change", () => { save(); feeIn.closest("label").hidden = carrierSel.value !== "__new"; });

      const approve = async () => {
        const batch = writeBatch(db);
        const userRef = doc(db, "users", u.id);
        if (isCarrier) {
          let carrierId = carrierSel.value;
          if (carrierId === "__new") {
            const cRef = doc(collection(db, "carriers"));
            carrierId = cRef.id;
            batch.set(cRef, { name: u.company || u.name, mc: u.mc || "", dot: u.dot || "", phone: u.phone || "", feePercent: num(feeIn.value), createdAt: serverTimestamp() });
          }
          batch.update(userRef, { role: "carrierAdmin", carrierId, approvedAt: serverTimestamp() });
        } else {
          batch.update(userRef, { role: "dispatcher", carrierId: null, assignedCarriers: [], allCarriers: false, approvedAt: serverTimestamp() });
        }
        await batch.commit();
        if (isCarrier && carrierSel.value === "__new") ctx.reload();
      };

      const row = h("div", { class: "row col" },
        h("div", { class: "row-top" },
          h("div", null,
            h("div", { class: "strong" }, isCarrier ? (u.company || "Carrier") + " · " + u.name : u.name),
            h("div", { class: "muted small" }, (isCarrier ? "Carrier" : "Dispatcher") + " · requested " + ago(u.createdAt))),
          pill("pending", "Pending")),
        h("div", { class: "request-grid" },
          h("div", null, h("span", { class: "muted" }, "Email: "), u.email),
          u.phone ? h("div", null, h("span", { class: "muted" }, "Phone: "), h("a", { href: "tel:" + u.phone }, u.phone)) : null,
          u.mc ? h("div", null, h("span", { class: "muted" }, "MC: "), u.mc) : null,
          u.dot ? h("div", null, h("span", { class: "muted" }, "DOT: "), u.dot) : null),
        u.note ? h("div", { class: "quote" }, u.note) : null,
        isCarrier ? h("div", { class: "form-grid" }, field("Company", carrierSel), field("Dispatch fee %", feeIn)) : null,
        h("div", { class: "row-inline" },
          btn(isCarrier ? "Approve carrier" : "Approve dispatcher", () => guard(approve, "Approved"), "ok"),
          btn("Deny", () => confirm(`Deny ${u.name}? They won't get access.`) && guard(() => deleteDoc(doc(db, "users", u.id)), "Request denied"), "ghost")),
        !isCarrier ? h("p", { class: "muted small" }, "After approving, give them carriers under Team.") : null);
      if (isCarrier && carrierSel.value !== "__new") queueMicrotask(() => { const l = feeIn.closest("label"); if (l) l.hidden = true; });
      return row;
    })) : h("p", { class: "empty" }, "No one waiting."));
  }));
  return box;
}

function overview(ctx, root) {
  const stats = h("div", { class: "stats" });
  let loads = [], moneyRows = [], pending = 0;
  const draw = () => stats.replaceChildren(
    stat("Carriers", String(ctx.carriers.length)),
    stat("Active loads", String(loads.filter((l) => l.status === "booked" || l.status === "in_transit").length)),
    stat("Docs awaiting review", String(pending)),
    stat("Dispatch fees due", money(moneyRows.filter((m) => !m.feePaid).reduce((s, m) => s + num(m.fee), 0)), "Unpaid, all carriers"));
  ctx.sub(watch(collection(db, "loads"), (r) => { loads = r; draw(); }));
  ctx.sub(watch(collection(db, "loadMoney"), (r) => { moneyRows = r; draw(); }));
  draw();
  root.append(accessRequests(ctx, { hideWhenEmpty: true }), stats,
    h("div", { class: "grid-2" },
      docsReviewQueue(ctx, allIds(ctx), (n) => { pending = n; draw(); }),
      requestsList(ctx, allIds(ctx), { staff: true })),
    loadsTable(ctx, allIds(ctx), { showMoney: true, editable: true, showDispatcher: true }));
}

function loadsView(ctx, root) {
  root.append(loadForm(ctx), loadsTable(ctx, allIds(ctx), { showMoney: true, editable: true, showDispatcher: true }));
}

function carriersView(ctx, root) {
  const inviteSlot = h("div");
  const form = h("form", { class: "form-grid", onSubmit: async (e) => {
    e.preventDefault();
    const f = formToObj(form);
    const ok = await guard(() => addDoc(collection(db, "carriers"), {
      name: f.name.trim(), mc: f.mc.trim(), dot: f.dot.trim(), phone: f.phone.trim(),
      feePercent: num(f.feePercent), createdAt: serverTimestamp(),
    }), "Carrier added");
    if (ok) { form.reset(); ctx.reload(); }
  } },
    field("Company name", input("name", { required: true })),
    field("MC #", input("mc")),
    field("DOT #", input("dot")),
    field("Phone", input("phone", { type: "tel" })),
    field("Dispatch fee %", input("feePercent", { type: "number", step: "0.1", min: "0", max: "100", placeholder: "e.g. 8" })),
    h("div", { class: "form-actions" }, btn("Add carrier", null, "primary", { type: "submit" })));

  const list = table([
    { label: "Carrier", cell: (c) => h("span", { class: "strong" }, c.name) },
    { label: "MC / DOT", cell: (c) => [c.mc, c.dot].filter(Boolean).join(" / ") || "—" },
    { label: "Fee %", cell: (c) => (c.feePercent ? c.feePercent + "%" : "—"), align: "right" },
    { label: "", cell: (c) => btn("Invite carrier admin", async () => {
      const code = await guard(() => createInvite(ctx, { role: "carrierAdmin", carrierId: c.id, carrierName: c.name }));
      if (code) inviteSlot.replaceChildren(showInvite(code, `${c.name} (carrier admin)`));
    }) },
  ], ctx.carriers, "No carriers yet. Add your own company first, then client carriers.");

  root.append(card("Add a carrier", null, form), card("Carriers", null, inviteSlot, list), invitesCard(ctx));
}

function invitesCard(ctx) {
  const body = h("div");
  ctx.sub(watch(query(collection(db, "invites"), where("used", "==", false)), (r) => {
    r.sort(byNewest);
    body.replaceChildren(table([
      { label: "Code", cell: (i) => h("span", { class: "mono" }, i.id) },
      { label: "Role", cell: (i) => ({ carrierAdmin: "Carrier admin", dispatcher: "Dispatcher", driver: "Driver" }[i.role] || i.role) },
      { label: "Carrier", cell: (i) => i.carrierName || "—" },
      { label: "Created", cell: (i) => ago(i.createdAt) },
    ], r, "No open invites."));
  }));
  return card("Open invites", null, body);
}

function teamView(ctx, root) {
  const inviteSlot = h("div");
  const body = h("div");
  ctx.sub(watch(query(collection(db, "users"), where("role", "==", "dispatcher")), (users) => {
    body.replaceChildren(users.length ? h("div", { class: "list" }, users.map((u) => {
      const assigned = new Set(u.assignedCarriers || []);
      const allBox = h("input", { type: "checkbox", checked: !!u.allCarriers });
      const boxes = ctx.carriers.map((c) => ({ c, el: h("input", { type: "checkbox", checked: assigned.has(c.id) }) }));
      return h("div", { class: "row col" },
        h("div", { class: "row-top" }, h("div", null, h("div", { class: "strong" }, u.name || u.email), h("div", { class: "muted small" }, u.email))),
        h("div", { class: "checks" },
          h("label", { class: "check" }, allBox, h("strong", null, "All carriers")),
          boxes.map(({ c, el }) => h("label", { class: "check" }, el, c.name))),
        h("div", null, btn("Save access", () => guard(() => updateDoc(doc(db, "users", u.id), {
          allCarriers: allBox.checked,
          assignedCarriers: boxes.filter((b) => b.el.checked).map((b) => b.c.id),
        }), "Access saved"), "dark")));
    })) : h("p", { class: "empty" }, "No dispatchers yet."));
  }));
  root.append(card("Dispatchers",
    btn("Invite dispatcher", async () => {
      const code = await guard(() => createInvite(ctx, { role: "dispatcher", carrierId: null }));
      if (code) inviteSlot.replaceChildren(showInvite(code, "a dispatcher"));
    }, "primary"),
    inviteSlot, body));
}

function docsView(ctx, root) {
  const all = h("div");
  let docs = [], term = "";
  const draw = () => {
    const shown = docs.filter((d) => !term || [d.name, d.kind, d.category, d.tags, d.loadLabel, d.uploaderName, ctx.carrierName(d.carrierId)].filter(Boolean).join(" ").toLowerCase().includes(term))
      .sort(byNewest).slice(0, 100);
    all.replaceChildren(table([
      { label: "Document", cell: (d) => h("span", { class: "strong" }, d.name) },
      { label: "Type", cell: (d) => d.kind || d.category || "—" },
      { label: "Carrier", cell: (d) => ctx.carrierName(d.carrierId) },
      { label: "From", cell: (d) => d.uploaderName || "—" },
      { label: "Status", cell: (d) => pill(d.status) },
      { label: "", cell: (d) => btn("View", () => openDoc(d)) },
    ], shown, term ? "No matches." : "No documents yet."));
  };
  const search = input("q", { type: "search", placeholder: "Search name, carrier, load, type…", "aria-label": "Search all documents" });
  search.addEventListener("input", () => { term = search.value.trim().toLowerCase(); draw(); });
  ctx.sub(watch(collection(db, "documents"), (d) => { docs = d; draw(); }));
  root.append(staffScanCard(ctx), docsReviewQueue(ctx, allIds(ctx)), card("All documents", null, search, all));
}

export default [
  { id: "overview", label: "Overview", render: overview },
  { id: "access", label: "Access requests", render: (ctx, root) => root.append(accessRequests(ctx)) },
  { id: "loads", label: "Loads", render: loadsView },
  { id: "carriers", label: "Carriers", render: carriersView },
  { id: "team", label: "Team", render: teamView },
  { id: "documents", label: "Documents", render: docsView },
  { id: "requests", label: "Truck requests", render: (ctx, root) => root.append(requestsList(ctx, allIds(ctx), { staff: true })) },
];
