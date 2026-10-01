import { db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDocs, query, where, serverTimestamp, writeBatch } from "../fb.js";
import { h, card, table, stat, money, num, field, input, select, btn, formToObj, guard, inviteCode, pill, ago, toast } from "../ui.js";
import { watch, byNewest } from "../data.js";
import { loadsTable, docsReviewQueue, requestsList, showInvite, staffScanCard, openDoc } from "../components.js";
import { pickerPage, summaryView, loadsView, expensesView, taxView, carrierSettingsCard } from "../ops.js";
import { driveUrl, forgetDriveUrl, pingDrive, sendToDrive } from "../drive.js";

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


function carriersView(ctx, root) {
  const inviteSlot = h("div");
  const editSlot = h("div");
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
    { label: "Dispatch fee", cell: (c) => (c.feePercent ? c.feePercent + "%" : "—"), align: "right" },
    { label: "Factoring", cell: (c) => (c.factorPct ? `${c.factorName || "Factoring"} ${c.factorPct}%` : "—") },
    { label: "", cell: (c) => btn("Edit", () => { editSlot.replaceChildren(carrierSettingsCard(ctx, c, { full: true })); editSlot.scrollIntoView({ block: "start", behavior: "smooth" }); }, "ghost") },
    { label: "", cell: (c) => btn("Invite carrier admin", async () => {
      const code = await guard(() => createInvite(ctx, { role: "carrierAdmin", carrierId: c.id, carrierName: c.name }));
      if (code) inviteSlot.replaceChildren(showInvite(code, `${c.name} (carrier admin)`));
    }) },
  ], ctx.carriers, "No carriers yet. Add your own company first, then client carriers.");

  root.append(card("Add a carrier", null, form), editSlot, card("Carriers", null, inviteSlot, list), invitesCard(ctx));
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
      { label: "", cell: (d) => h("div", { class: "row-meta" }, btn("View", () => openDoc(d)),
        btn("To Drive", async () => { const j = await sendToDrive(d.id, { quiet: true }); toast(j ? `Copied to Drive: ${j.folder}` : "Couldn't reach Google Drive. Check Settings.", j ? "ok" : "bad"); }, "ghost")) },
    ], shown, term ? "No matches." : "No documents yet."));
  };
  const search = input("q", { type: "search", placeholder: "Search name, carrier, load, type…", "aria-label": "Search all documents" });
  search.addEventListener("input", () => { term = search.value.trim().toLowerCase(); draw(); });
  ctx.sub(watch(collection(db, "documents"), (d) => { docs = d; draw(); }));
  root.append(staffScanCard(ctx), docsReviewQueue(ctx, allIds(ctx)), card("All documents", null, search, all));
}


const ROLE_LABEL = { owner: "Owner", dispatcher: "Dispatcher", carrierAdmin: "Carrier admin", driver: "Driver", pending: "Pending" };

// Every account on KeepTrack: search, filter by role or carrier, change role/carrier, remove access.
function accountsView(ctx, root) {
  let users = [], q = "", roleF = "all", carrierF = "all";
  const stats = h("div", { class: "stats" });
  const editSlot = h("div");
  const body = h("div");
  const search = input("q", { type: "search", placeholder: "Search name, email, phone…", "aria-label": "Search accounts" });
  const roleSel = select("role", [{ value: "all", label: "All roles" }, ...Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }))], { "aria-label": "Role" });
  const carrierSel = select("carrier", [{ value: "all", label: "All carriers" }, { value: "none", label: "No carrier" }, ...ctx.carriers.map((c) => ({ value: c.id, label: c.name }))], { "aria-label": "Carrier" });
  search.addEventListener("input", () => { q = search.value.trim().toLowerCase(); draw(); });
  roleSel.addEventListener("change", () => { roleF = roleSel.value; draw(); });
  carrierSel.addEventListener("change", () => { carrierF = carrierSel.value; draw(); });

  const edit = (u) => {
    const r = select("role", Object.entries(ROLE_LABEL).filter(([k]) => k !== "pending").map(([value, label]) => ({ value, label, selected: value === u.role })));
    const c = select("carrierId", [{ value: "", label: "No carrier" }, ...ctx.carriers.map((x) => ({ value: x.id, label: x.name, selected: x.id === u.carrierId }))]);
    const sync = () => { c.closest("label").hidden = !["carrierAdmin", "driver"].includes(r.value); };
    r.addEventListener("change", sync);
    const form = h("form", { class: "stack", onSubmit: async (e) => {
      e.preventDefault();
      if (u.id === ctx.uid && r.value !== "owner") return toast("You can't remove your own owner access.", "bad");
      if (["carrierAdmin", "driver"].includes(r.value) && !c.value) return toast("Pick their carrier.", "bad");
      const data = { role: r.value, carrierId: ["carrierAdmin", "driver"].includes(r.value) ? c.value : null };
      if (r.value === "dispatcher" && u.role !== "dispatcher") Object.assign(data, { assignedCarriers: [], allCarriers: false });
      const ok = await guard(() => updateDoc(doc(db, "users", u.id), data), "Account updated");
      if (ok !== null) editSlot.replaceChildren();
    } },
      h("div", { class: "form-grid" }, field("Role", r), field("Carrier", c)),
      h("p", { class: "muted small" }, "Dispatchers get their carriers under Team."),
      h("div", { class: "row-inline" }, btn("Save", null, "primary", { type: "submit" }), btn("Cancel", () => editSlot.replaceChildren(), "ghost")));
    editSlot.replaceChildren(card(`Edit ${u.name || u.email}`, null, form));
    sync();
    editSlot.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const draw = () => {
    const counts = {};
    users.forEach((u) => (counts[u.role] = (counts[u.role] || 0) + 1));
    stats.replaceChildren(stat("Accounts", String(users.length)), stat("Carrier admins", String(counts.carrierAdmin || 0)), stat("Drivers", String(counts.driver || 0)), stat("Dispatchers", String(counts.dispatcher || 0)), stat("Pending", String(counts.pending || 0)));
    const shown = users.filter((u) => (roleF === "all" || u.role === roleF) && (carrierF === "all" || (carrierF === "none" ? !u.carrierId : u.carrierId === carrierF)) &&
      (!q || [u.name, u.email, u.phone, u.company].filter(Boolean).join(" ").toLowerCase().includes(q)))
      .sort((a, b) => (a.name || a.email || "").localeCompare(b.name || b.email || ""));
    body.replaceChildren(table([
      { label: "Name", cell: (u) => h("div", null, h("div", { class: "strong" }, u.name || "—"), h("div", { class: "muted small" }, u.email || "")) },
      { label: "Role", cell: (u) => pill(u.role === "pending" ? "pending" : "x", ROLE_LABEL[u.role] || u.role) },
      { label: "Carrier", cell: (u) => (u.carrierId ? ctx.carrierName(u.carrierId) : u.role === "dispatcher" ? (u.allCarriers ? "All carriers" : `${(u.assignedCarriers || []).length} assigned`) : u.company || "—") },
      { label: "Phone", cell: (u) => (u.phone ? h("a", { href: "tel:" + u.phone }, u.phone) : "—") },
      { label: "Joined", cell: (u) => ago(u.createdAt) },
      { label: "", cell: (u) => u.role === "pending" ? h("span", { class: "muted small" }, "See Access requests") : h("div", { class: "row-meta" },
        btn("Edit", () => edit(u), "ghost"),
        u.id !== ctx.uid ? btn("Remove", () => confirm(`Remove ${u.name || u.email}? They lose access right away.`) && guard(() => deleteDoc(doc(db, "users", u.id)), "Access removed"), "ghost") : null) },
    ], shown, "No accounts match."));
  };
  ctx.sub(watch(collection(db, "users"), (r) => { users = r; draw(); }));
  root.append(stats, editSlot, card("Accounts", null, h("div", { class: "form-grid" }, field("Search", search), field("Role", roleSel), field("Carrier", carrierSel)), body));
}


// Google Drive: every scan is also copied into the owner's Drive through an Apps Script.
function settingsView(ctx, root) {
  const status = h("p", { class: "muted" }, "Checking…");
  const urlIn = input("driveUrl", { type: "url", placeholder: "https://script.google.com/macros/s/…/exec", "aria-label": "Apps Script web app URL" });
  const msg = h("p", { class: "scanmsg", role: "status" });
  const show = async () => {
    forgetDriveUrl();
    const u = await driveUrl();
    urlIn.value = u;
    status.textContent = u ? "Connected. New scans are copied to Google Drive automatically." : "Not connected yet. Scans are saved in KeepTrack only.";
  };
  show();
  const copyScript = btn("Copy the script", async () => {
    try {
      const code = await (await fetch("drive/KeepTrackDrive.gs?v=" + Date.now())).text();
      await navigator.clipboard.writeText(code);
      toast("Script copied", "ok");
    } catch (e) { window.open("drive/KeepTrackDrive.gs", "_blank"); }
  }, "dark");
  const form = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    const u = urlIn.value.trim();
    if (u && !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(u)) { msg.textContent = "That doesn't look like an Apps Script web app URL (it ends in /exec)."; msg.className = "scanmsg bad"; return; }
    if (u) {
      msg.textContent = "Testing the connection…"; msg.className = "scanmsg";
      try { const j = await pingDrive(u); msg.textContent = "It works. Files will go to your KeepTrack folder in Google Drive."; msg.className = "scanmsg ok"; if (j.root) msg.append(" ", h("a", { href: j.root, target: "_blank", rel: "noopener" }, "Open folder")); }
      catch (err) { msg.textContent = "Couldn't reach the script: " + err.message + ". Check it's deployed as a Web app with access for Anyone."; msg.className = "scanmsg bad"; return; }
    }
    await guard(() => setDoc(doc(db, "settings", "app"), { driveUrl: u, updatedAt: serverTimestamp() }, { merge: true }), u ? "Google Drive connected" : "Google Drive disconnected");
    show();
  } },
    field("Web app URL", urlIn),
    h("div", { class: "row-inline" }, btn("Save and test", null, "primary", { type: "submit" })),
    msg);
  const backfill = btn("Copy existing documents to Drive", async () => {
    if (!(await driveUrl())) return toast("Connect Google Drive first.", "bad");
    const snap = await getDocs(collection(db, "documents"));
    if (!confirm(`Copy ${snap.size} document${snap.size === 1 ? "" : "s"} to Google Drive? Files already there are skipped.`)) return;
    let ok = 0, bad = 0;
    for (const d of snap.docs) { (await sendToDrive(d.id, { quiet: true })) ? ok++ : bad++; backfill.textContent = `Copying… ${ok + bad}/${snap.size}`; }
    backfill.textContent = "Copy existing documents to Drive";
    toast(`Copied ${ok} to Google Drive${bad ? `, ${bad} failed` : ""}`, bad ? "bad" : "ok");
  }, "ghost");
  root.append(card("Google Drive", null, status,
    h("ol", { class: "steps-list" },
      h("li", null, "Tap ", h("b", null, "Copy the script"), " below."),
      h("li", null, "Open ", h("a", { href: "https://script.google.com/home/projects/create", target: "_blank", rel: "noopener" }, "script.google.com → New project"), ", delete what's there and paste."),
      h("li", null, "Tap ", h("b", null, "Deploy → New deployment"), ", pick type ", h("b", null, "Web app"), ". Execute as: ", h("b", null, "Me"), ". Who has access: ", h("b", null, "Anyone"), ". Deploy, then allow access when Google asks."),
      h("li", null, "Copy the ", h("b", null, "Web app URL"), " and paste it here, then tap ", h("b", null, "Save and test"), ".")),
    copyScript, form,
    h("p", { class: "muted small" }, "Folders: KeepTrack / Carrier / Drivers / Driver name / (Load folders, Receipts) · Carrier / Loads / Load · Carrier / Company / Insurance, W-9… · Carrier / Receipts."),
    h("div", null, backfill)));
}

export default [
  { id: "overview", label: "Overview", render: overview },
  { id: "summary", label: "Summary", render: (ctx, root) => pickerPage(ctx, root, "summary", summaryView) },
  { id: "loads", label: "Loads", render: (ctx, root) => pickerPage(ctx, root, "loads", loadsView) },
  { id: "expenses", label: "Expenses", render: (ctx, root) => pickerPage(ctx, root, "expenses", expensesView) },
  { id: "tax", label: "1099", render: (ctx, root) => pickerPage(ctx, root, "tax", taxView, { requireOne: true }) },
  { id: "documents", label: "Documents", render: docsView },
  { id: "requests", label: "Truck requests", render: (ctx, root) => root.append(requestsList(ctx, allIds(ctx), { staff: true })) },
  { id: "carriers", label: "Carriers", render: carriersView },
  { id: "accounts", label: "Accounts", render: accountsView },
  { id: "team", label: "Team", render: teamView },
  { id: "access", label: "Access requests", render: (ctx, root) => root.append(accessRequests(ctx)) },
  { id: "settings", label: "Settings", render: settingsView },
];
