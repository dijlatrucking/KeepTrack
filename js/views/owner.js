import { db, collection, doc, addDoc, setDoc, updateDoc, query, where, serverTimestamp } from "../fb.js";
import { h, card, table, stat, money, num, field, input, btn, formToObj, guard, inviteCode, pill, ago } from "../ui.js";
import { watch, byNewest } from "../data.js";
import { loadsTable, loadForm, docsReviewQueue, requestsList, showInvite } from "../components.js";

const allIds = (ctx) => ctx.carriers.map((c) => c.id);

async function createInvite(ctx, data) {
  const code = inviteCode();
  await setDoc(doc(db, "invites", code), { ...data, used: false, createdBy: ctx.uid, createdAt: serverTimestamp() });
  return code;
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
  root.append(stats,
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
  ctx.sub(watch(collection(db, "documents"), (docs) => {
    docs.sort(byNewest);
    all.replaceChildren(table([
      { label: "Document", cell: (d) => h("span", { class: "strong" }, d.name) },
      { label: "Type", cell: (d) => d.kind || d.category || "—" },
      { label: "Carrier", cell: (d) => ctx.carrierName(d.carrierId) },
      { label: "From", cell: (d) => d.uploaderName || "—" },
      { label: "Status", cell: (d) => pill(d.status) },
    ], docs.slice(0, 100), "No documents yet."));
  }));
  root.append(docsReviewQueue(ctx, allIds(ctx)), card("All documents", null, all));
}

export default [
  { id: "overview", label: "Overview", render: overview },
  { id: "loads", label: "Loads", render: loadsView },
  { id: "carriers", label: "Carriers", render: carriersView },
  { id: "team", label: "Team", render: teamView },
  { id: "documents", label: "Documents", render: docsView },
  { id: "requests", label: "Truck requests", render: (ctx, root) => root.append(requestsList(ctx, allIds(ctx), { staff: true })) },
];
