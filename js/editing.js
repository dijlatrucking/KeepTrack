// Editing and deleting papers and loads, keeping everything that hangs off them in step:
// the copy in Google Drive (moved, renamed or trashed), an expense made from a receipt,
// expenses tied to a load, the load names shown on papers, and the storage meter.
import { db, collection, doc, getDoc, getDocs, query, where, updateDoc, writeBatch, serverTimestamp } from "./fb.js";
import { h, field, input, select, btn, toast, guard, num } from "./ui.js";
import { DOC_KINDS, shortId, lane, openDoc } from "./components.js";
import { driveUrl, sendToDrive, removeFromDrive } from "./drive.js";

const role = (ctx) => ctx.profile.role;
const KIND_CATEGORY = { BOL: "BOLs", POD: "BOLs", Receipt: "Receipts", Lumper: "Receipts", "Rate con": "Rate cons", Insurance: "Insurance", Authority: "Authority", "W-9": "W-9", Registration: "Registrations", "CDL / med card": "CDLs & med cards", Other: "Other" };
const isReceipt = (d) => d.kind === "Lumper" || d.kind === "Receipt" || d.category === "Receipts";
export const loadLabelOf = (l) => `${shortId(l.id)} ${lane(l)}`;

// Who may do what (the security rules enforce the same thing).
export function canEditDoc(ctx, d) {
  const r = role(ctx);
  if (r === "owner") return true;
  if (r === "dispatcher") return ctx.carriers.some((c) => c.id === d.carrierId);
  if (r === "carrierAdmin") return d.carrierId === ctx.profile.carrierId;
  return false;
}
export function canDeleteDoc(ctx, d) {
  const r = role(ctx);
  if (r === "owner") return true;
  if (r === "carrierAdmin") return d.carrierId === ctx.profile.carrierId;
  if (r === "driver") return d.uploadedBy === ctx.uid && d.status === "pending";
  return false;
}
export function canDeleteLoad(ctx, l) {
  const r = role(ctx);
  return r === "owner" || (r === "carrierAdmin" && l.carrierId === ctx.profile.carrierId && !l.dispatcherId);
}

// Small buttons for any paper list.
export function docActions(ctx, d) {
  return [
    canEditDoc(ctx, d) ? btn("Edit", () => editDocDialog(ctx, d), "ghost", { class: "btn btn-ghost btn-sm" }) : null,
    canDeleteDoc(ctx, d) ? btn("Delete", () => deleteDocFlow(ctx, d), "ghost", { class: "btn btn-ghost btn-sm danger" }) : null,
  ];
}

function modal(title, build) {
  const dlg = h("dialog", { class: "dialog", "aria-label": title });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.append(h("div", { class: "stack" }, h("h2", null, title), ...build(close)));
  document.body.append(dlg);
  dlg.showModal();
  return close;
}

async function loadsOf(carrierId) {
  const snap = await getDocs(query(collection(db, "loads"), where("carrierId", "==", carrierId))).catch(() => null);
  return snap ? snap.docs.map((x) => ({ id: x.id, ...x.data() }))
    .sort((a, b) => String(b.pickupDate || "").localeCompare(String(a.pickupDate || ""))).slice(0, 80) : [];
}

// Re-file a paper's Drive copy after its details change (the Drive script moves and renames it).
async function refile(ids) {
  if (!ids.length || !(await driveUrl())) return 0;
  let n = 0;
  for (const id of ids) if (await sendToDrive(id, { quiet: true })) n++;
  return n;
}

// ---------- Papers ----------

export function editDocDialog(ctx, d) {
  const kinds = [...new Set([...DOC_KINDS, d.kind].filter(Boolean))];
  const kindSel = select("kind", kinds.map((k) => ({ value: k, label: k, selected: k === d.kind })));
  const nameIn = input("name", { value: d.name || "" });
  const loadSel = select("loadId", [{ value: "", label: "Not for a load" }]);
  const amountIn = input("amount", { type: "number", min: "0", step: "0.01", inputmode: "decimal", value: d.amount ?? "" });
  const noteIn = input("note", { value: d.note || "" });
  const tagsIn = input("tags", { value: d.tags || "" });
  const expIn = input("expiresAt", { type: "date", value: d.expiresAt || "" });
  const amountField = field("Amount ($)", amountIn);
  const showAmount = () => { amountField.hidden = !(isReceipt({ ...d, kind: kindSel.value }) || d.amount); };
  kindSel.addEventListener("change", showAmount);
  showAmount();
  let loads = [];
  loadsOf(d.carrierId).then((ls) => {
    loads = ls;
    if (d.loadId && !ls.some((l) => l.id === d.loadId)) loads.push({ id: d.loadId, origin: "", destination: "", _label: d.loadLabel });
    loadSel.replaceChildren(h("option", { value: "" }, "Not for a load"),
      ...loads.map((l) => h("option", { value: l.id, selected: l.id === d.loadId }, l._label || `${shortId(l.id)} ${lane(l)}${l.loadNo ? " · #" + l.loadNo : ""}`)));
  });
  const close = modal("Edit paper", (close) => [
    h("p", { class: "muted small" }, [ctx.carrierName(d.carrierId), d.uploaderName ? "sent by " + d.uploaderName : null].filter(Boolean).join(" · ")),
    h("form", { class: "stack", onSubmit: async (e) => {
      e.preventDefault();
      const l = loads.find((x) => x.id === loadSel.value);
      const next = {
        kind: kindSel.value, name: nameIn.value.trim() || d.name || kindSel.value,
        loadId: l ? l.id : null, loadLabel: l ? (l._label || loadLabelOf(l)) : null,
        note: noteIn.value.trim(), tags: tagsIn.value.trim(),
      };
      if (!amountField.hidden) next.amount = amountIn.value === "" ? null : Math.round(num(amountIn.value) * 100) / 100;
      if (d.status === "filed" || d.expiresAt) next.expiresAt = expIn.value || null;
      if (next.kind !== d.kind) next.category = KIND_CATEGORY[next.kind] || next.kind;
      const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => (d[k] ?? null) !== (v ?? null) && !(k === "note" && !d[k] && !v) && !(k === "tags" && !d[k] && !v)));
      if (!Object.keys(changed).length) { close(); return; }
      const ok = await guard(async () => {
        const b = writeBatch(db);
        b.update(doc(db, "documents", d.id), changed);
        // an expense made from this receipt follows its amount and load
        if (d.expenseId && ["owner", "carrierAdmin"].includes(role(ctx)) && ("amount" in changed || "loadId" in changed)) {
          const exp = {};
          if ("amount" in changed && changed.amount) exp.amount = changed.amount;
          if ("loadId" in changed) { exp.loadId = changed.loadId; exp.loadLabel = changed.loadLabel; }
          if (Object.keys(exp).length) b.update(doc(db, "expenses", d.expenseId), exp);
        }
        await b.commit();
        return true;
      }, "Paper saved");
      if (!ok) return;
      close();
      // its Drive copy moves to the right folder and gets the new name
      if (["kind", "name", "loadId", "amount", "note"].some((k) => k in changed)) {
        const n = await refile([d.id]);
        if (n) toast("Updated in Google Drive too", "ok");
      }
    } },
      h("div", { class: "form-grid" },
        field("Type", kindSel), field("Name", nameIn), field("Load", loadSel), amountField,
        field("Note", noteIn), field("Search tags", tagsIn),
        d.status === "filed" || d.expiresAt ? field("Expires", expIn) : null),
      d.expenseId && ["owner", "carrierAdmin"].includes(role(ctx)) ? h("p", { class: "muted small" }, "This receipt was added to Expenses; changing its amount or load changes that expense too.") : null,
      h("div", { class: "row-inline" }, btn("Save", null, "primary", { type: "submit" }), btn("View scan", () => openDoc(d), "ghost"), btn("Cancel", () => close(), "ghost"))),
  ]);
  return close;
}

// Deletes a paper: its Drive copy goes to the Drive trash first (while KeepTrack can still prove who
// may delete it), then the record and the scan. Returns true when deleted.
export async function deleteDocFlow(ctx, d, { ask = true } = {}) {
  const inDrive = !!(d.driveFileId || d.fileFreed);
  if (ask && !confirm(`Delete “${d.name || d.kind || "this paper"}”?\n\n` +
    `It's removed from KeepTrack${inDrive || (await driveUrl()) ? ", and its copy in Google Drive goes to the Drive trash" : ""}.` +
    (d.fileFreed ? " (This scan only lives in Drive now.)" : "") +
    (d.expenseId ? "\n\nThe expense made from it stays in Expenses." : ""))) return false;
  const drive = await removeFromDrive(d.id, { deleting: true });
  const ok = await guard(async () => {
    const b = writeBatch(db);
    b.delete(doc(db, "docFiles", d.id));
    b.delete(doc(db, "documents", d.id));
    await b.commit();
    return true;
  }, ask ? "Paper deleted" : undefined);
  if (ok && ask && drive === null && inDrive) toast("Deleted in KeepTrack, but its Drive copy couldn't be removed. You can delete it in Drive.", "bad");
  return !!ok;
}

// ---------- Loads ----------

// After a load is edited: papers and expenses show the new load name, and Drive copies move to the
// load's renamed folder (folders are named after the pickup date, broker load # and lane).
export async function afterLoadEdit(ctx, before, after) {
  const id = before.id;
  const merged = { ...before, ...after, id };
  const oldLabel = loadLabelOf(before), newLabel = loadLabelOf(merged);
  const driveChanged = ["loadNo", "pickupDate", "origin", "destination"].some((k) => (before[k] || "") !== (after[k] || ""));
  if (oldLabel === newLabel && !driveChanged) return;
  const papers = await getDocs(query(collection(db, "documents"), where("carrierId", "==", before.carrierId), where("loadId", "==", id))).catch(() => null);
  const docs = papers ? papers.docs.map((x) => ({ id: x.id, ...x.data() })) : [];
  if (oldLabel !== newLabel) {
    const b = writeBatch(db);
    docs.forEach((d) => b.update(doc(db, "documents", d.id), { loadLabel: newLabel }));
    if (["owner", "carrierAdmin"].includes(role(ctx))) {
      const ex = await getDocs(query(collection(db, "expenses"), where("carrierId", "==", before.carrierId), where("loadId", "==", id))).catch(() => null);
      if (ex) ex.docs.forEach((x) => b.update(doc(db, "expenses", x.id), { loadLabel: newLabel }));
    }
    await b.commit().catch((e) => console.warn("load label update", e));
  }
  const inDrive = docs.filter((d) => !d.fileCleared && d.status !== "rejected");
  if (driveChanged && inDrive.length) {
    const n = await refile(inDrive.map((d) => d.id));
    if (n) toast(`Moved ${n} paper${n === 1 ? "" : "s"} to the load's new Drive folder`, "ok");
  }
}

export async function deleteLoadFlow(ctx, l) {
  const papersSnap = await getDocs(query(collection(db, "documents"), where("carrierId", "==", l.carrierId), where("loadId", "==", l.id))).catch(() => null);
  const papers = papersSnap ? papersSnap.docs.map((x) => ({ id: x.id, ...x.data() })) : [];
  const run = async (withPapers, close) => {
    close();
    const ok = await guard(async () => {
      if (withPapers) {
        for (const d of papers) await deleteDocFlow(ctx, d, { ask: false });
      } else if (papers.length) {
        const b = writeBatch(db);
        papers.forEach((d) => b.update(doc(db, "documents", d.id), { loadId: null, loadLabel: null }));
        await b.commit();
      }
      // expenses stay (real money was spent) but no longer point at a load that's gone
      const ex = await getDocs(query(collection(db, "expenses"), where("carrierId", "==", l.carrierId), where("loadId", "==", l.id))).catch(() => null);
      const b = writeBatch(db);
      if (ex) ex.docs.forEach((x) => b.update(doc(db, "expenses", x.id), { loadId: null, loadLabel: null }));
      b.delete(doc(db, "loadMoney", l.id));
      b.delete(doc(db, "loads", l.id));
      await b.commit();
      return true;
    }, "Load deleted");
    // kept papers leave the load's Drive folder for the driver's or company folder
    if (ok && !withPapers && papers.length) refile(papers.map((d) => d.id));
  };
  modal(`Delete load ${shortId(l.id)}?`, (close) => [
    h("p", null, `${lane(l)}${l.loadNo ? " · #" + l.loadNo : ""}${l.broker ? " · " + l.broker : ""}`),
    h("p", { class: "muted small" }, papers.length
      ? `This load has ${papers.length} paper${papers.length === 1 ? "" : "s"} (${[...new Set(papers.map((d) => d.kind || "Doc"))].join(", ")}). Expenses on it are kept but no longer tied to a load.`
      : "Expenses on it are kept but no longer tied to a load."),
    h("div", { class: "stack" },
      papers.length ? btn(`Delete load and its ${papers.length} paper${papers.length === 1 ? "" : "s"}`, () => run(true, close), "warn") : null,
      btn(papers.length ? "Delete load, keep the papers" : "Delete load", () => run(false, close), papers.length ? "ghost" : "warn"),
      btn("Cancel", () => close(), "ghost")),
  ]);
}

// Lists a load's papers with View / Edit / Delete (used in the load's Paperwork window).
export function loadPapers(ctx, load) {
  const box = h("div", { class: "stack" });
  const draw = async () => {
    const snap = await getDocs(query(collection(db, "documents"), where("carrierId", "==", load.carrierId), where("loadId", "==", load.id))).catch(() => null);
    const docs = snap ? snap.docs.map((x) => ({ id: x.id, ...x.data() })) : [];
    box.replaceChildren(...(docs.length ? [h("div", { class: "muted small upper" }, `On this load (${docs.length})`),
      h("div", { class: "list" }, docs.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)).map((d) => h("div", { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "strong" }, d.name || d.kind), h("div", { class: "muted small" }, [d.kind, d.uploaderName, d.amount ? "$" + num(d.amount).toFixed(2) : null, d.status].filter(Boolean).join(" · "))),
        h("div", { class: "row-meta" }, btn("View", () => openDoc(d), "ghost", { class: "btn btn-ghost btn-sm" }),
          canEditDoc(ctx, d) ? btn("Edit", () => { editDocDialog(ctx, d); }, "ghost", { class: "btn btn-ghost btn-sm" }) : null,
          canDeleteDoc(ctx, d) ? btn("Delete", async () => { if (await deleteDocFlow(ctx, d)) draw(); }, "ghost", { class: "btn btn-ghost btn-sm danger" }) : null))))] : []));
  };
  draw();
  return box;
}
