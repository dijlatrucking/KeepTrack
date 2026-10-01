// Storage meter, "Back up to Drive" and "Free up space" (owner only).
// Scans live in Firestore (docFiles). The free Firebase plan holds 1 GiB, so the owner can copy every
// scan to Google Drive with a PDF report, then remove the copies from KeepTrack and start again.
// Records always stay, so search, paperwork lists and duplicate checks keep working; "View" then
// fetches the scan back from Drive.
import {
  db, collection, doc, getDoc, getDocs, setDoc, query, where, writeBatch, serverTimestamp, deleteField,
  getAggregateFromServer, getCountFromServer, sum,
} from "./fb.js";
import { h, card, btn, stat, toast, STATUS } from "./ui.js";
import { driveUrl, driveCall } from "./drive.js";
import { backupPdf } from "./reports.js";

const MB = 1024 * 1024;
export const FREE_LIMIT = 1024 * MB; // Firestore free plan: 1 GiB of stored data
const RECORD_BYTES = 2048; // one load, expense, account… with its indexes, roughly
const SCAN_GUESS = 400 * 1024; // for older scans saved before sizes were recorded
const OTHER = ["loads", "loadMoney", "expenses", "recurring", "users", "carriers", "trucks", "requests", "paystubs", "invites", "settings"];
const BATCH = 8; // scans per trip to the Drive script
const DRIVE_LAYOUT = 2; // bump when the Drive script files things differently, so the next backup re-files them

export const fmtMB = (b) => {
  const m = b / MB;
  return (m < 10 ? m.toFixed(1) : Math.round(m).toLocaleString()) + " MB";
};

const allDocs = async () => (await getDocs(collection(db, "documents"))).docs.map((d) => ({ id: d.id, ...d.data() }));

// Scans: how many are still in KeepTrack and roughly how many bytes they take.
async function scanUsage() {
  const docsCol = collection(db, "documents");
  try {
    // Count on its own: an aggregate that also sums "size" can skip records that have no size
    // (papers saved before sizes were recorded), which would hide them from the meter.
    const [all, a, freed, cleared, measured, backed] = await Promise.all([
      getCountFromServer(docsCol),
      getAggregateFromServer(docsCol, { bytes: sum("size") }),
      getCountFromServer(query(docsCol, where("fileFreed", "==", true))),
      getCountFromServer(query(docsCol, where("fileCleared", "==", true))),
      getCountFromServer(query(docsCol, where("size", ">", 0))),
      getCountFromServer(query(docsCol, where("backedUpAt", "!=", null))),
    ]);
    const total = all.data().count, bytes = a.data().bytes || 0, f = freed.data().count, c = cleared.data().count;
    return { total, held: total - f - c, freed: f, cleared: c, measured: measured.data().count, bytes, backed: backed.data().count };
  } catch (e) {
    // No aggregate queries available: add the records up here instead.
    const docs = await allDocs();
    const held = docs.filter((d) => !d.fileFreed && !d.fileCleared);
    const freed = docs.filter((d) => d.fileFreed).length;
    return {
      total: docs.length, held: held.length, freed, cleared: docs.length - held.length - freed,
      measured: held.filter((d) => d.size > 0).length, bytes: held.reduce((s, d) => s + (d.size || 0), 0),
      backed: held.filter((d) => d.backedUpAt).length,
    };
  }
}

export async function measureStorage({ quick = false } = {}) {
  const s = await scanUsage();
  const unmeasured = Math.max(0, s.held - s.measured);
  const scanBytes = s.bytes + unmeasured * (s.measured ? s.bytes / s.measured : SCAN_GUESS);
  let records = s.total;
  if (!quick) {
    const counts = await Promise.all(OTHER.map((c) => getCountFromServer(collection(db, c)).then((r) => r.data().count).catch(() => 0)));
    records += counts.reduce((a, b) => a + b, 0);
  }
  const recordBytes = records * RECORD_BYTES;
  return { ...s, unmeasured, scanBytes, recordBytes, used: scanBytes + recordBytes, limit: FREE_LIMIT };
}

let carrierNameOf = (id) => id || "";
const ctxCarrier = (id) => carrierNameOf(id);

const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`;

// Copy every scan that isn't in Drive yet, and list each one (with its info) in a dated PDF report
// in KeepTrack / Backups. Each copy is recorded on its document so "Free up space" knows it's safe.
// With { all: true } it goes over everything again (nothing is copied twice) to make a fresh, complete report.
export async function backupToDrive(onProgress = () => {}, { all = false } = {}) {
  if (!(await driveUrl())) throw new Error("Connect Google Drive first (below).");
  // New scans, plus anything filed under an older Drive layout (those get moved into place, not copied again).
  const todo = (await allDocs()).filter((d) => !d.fileCleared && d.status !== "rejected" &&
    (d.fileFreed ? d.driveFileId && (all || d.driveLayout !== DRIVE_LAYOUT) : all || !d.backedUpAt || d.driveLayout !== DRIVE_LAYOUT));
  const freedIds = new Set(todo.filter((d) => d.fileFreed).map((d) => d.id));
  if (!todo.length) return { done: 0, failed: 0, nothing: true };
  const name = "KeepTrack backup " + stamp(new Date());
  let done = 0, failed = 0, reportUrl = null, lastError = "";
  const byId = new Map(todo.map((d) => [d.id, d]));
  const listed = [], missed = [];
  const paperOf = (d) => [d.name || d.kind || "Document", d.note].filter(Boolean).join(" · ");
  onProgress(0, todo.length);
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    let j = null;
    try { j = await driveCall({ backup: name, docIds: part.map((d) => d.id) }); }
    catch (e) {
      lastError = e.message; failed += part.length;
      part.forEach((d) => missed.push({ paper: paperOf(d), why: e.message }));
      onProgress(done + failed, todo.length); continue;
    }
    const b = writeBatch(db);
    for (const r of j.results || []) {
      if (r.ok && r.fileId) {
        b.update(doc(db, "documents", r.docId), {
          driveFileId: r.fileId, driveUrl: r.url || null, driveLayout: DRIVE_LAYOUT,
          ...(freedIds.has(r.docId) ? {} : { backedUpAt: serverTimestamp() }), ...(r.size ? { size: r.size } : {}),
        });
        done++;
        const d = byId.get(r.docId) || {};
        listed.push({
          date: d.createdAt, carrier: ctxCarrier(d.carrierId), paper: paperOf(d), load: r.load || d.loadLabel || "",
          sentBy: d.uploaderName || "", amount: d.amount || 0, status: (STATUS[d.status] || [d.status || ""])[0], url: r.url || "",
        });
      } else {
        failed++; lastError = r.error || lastError;
        missed.push({ paper: paperOf(byId.get(r.docId) || {}), why: r.error });
      }
    }
    await b.commit();
    onProgress(done + failed, todo.length);
  }
  // The report: one PDF per backup in KeepTrack / Backups.
  if (listed.length) {
    try {
      const when = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      const data = await backupPdf({ title: "KeepTrack backup", sub: when, rows: listed, failed: missed });
      reportUrl = (await driveCall({ savePdf: name, data })).url || null;
    } catch (e) { lastError = "the backup report PDF couldn't be saved (" + e.message + ")"; }
  }
  await setDoc(doc(db, "settings", "backup"), { lastRunAt: serverTimestamp(), reportUrl, reportName: name, count: done, failed }, { merge: true });
  return { done, failed, reportUrl, lastError };
}

// What "Free up space" would remove: scans already backed up, plus scans of rejected papers
// (duplicates and bad photos) which aren't needed anymore.
export async function freeUpPlan() {
  const docs = (await allDocs()).filter((d) => !d.fileFreed && !d.fileCleared);
  const backed = docs.filter((d) => d.backedUpAt && d.driveFileId && d.status !== "rejected");
  const rejected = docs.filter((d) => d.status === "rejected");
  const notBacked = docs.length - backed.length - rejected.length;
  const bytes = [...backed, ...rejected].reduce((s, d) => s + (d.size || SCAN_GUESS), 0);
  return { backed, rejected, notBacked, bytes };
}

export async function freeUpSpace(plan, onProgress = () => {}) {
  let freed = 0, missing = 0, bytes = 0;
  const total = plan.backed.length + plan.rejected.length;
  // Backed-up scans are "freed" (the copy in Drive is the scan now); rejected ones are just "cleared".
  const free = (b, d, inDrive) => {
    b.delete(doc(db, "docFiles", d.id));
    b.update(doc(db, "documents", d.id), { [inDrive ? "fileFreed" : "fileCleared"]: true, freedAt: serverTimestamp(), size: 0, fileSize: d.size || null, backedUpAt: deleteField() });
    freed++; bytes += d.size || 0;
  };
  // Ask Drive to confirm each copy is really there (not trashed) before deleting anything.
  for (let i = 0; i < plan.backed.length; i += 20) {
    const part = plan.backed.slice(i, i + 20);
    const j = await driveCall({ verify: true, docIds: part.map((d) => d.id) });
    const okIds = new Set((j.results || []).filter((r) => r.ok).map((r) => r.docId));
    const b = writeBatch(db);
    for (const d of part) {
      if (okIds.has(d.id)) free(b, d, true);
      else { b.update(doc(db, "documents", d.id), { backedUpAt: deleteField() }); missing++; } // back it up again next time
    }
    await b.commit();
    onProgress(freed + missing, total);
  }
  for (let i = 0; i < plan.rejected.length; i += 50) {
    const b = writeBatch(db);
    plan.rejected.slice(i, i + 50).forEach((d) => free(b, d, false));
    await b.commit();
    onProgress(freed + missing, total);
  }
  return { freed, missing, bytes };
}

// ---------- Settings card ----------
export function storageCard(ctx) {
  if (ctx && ctx.carrierName) carrierNameOf = ctx.carrierName;
  const tiles = h("div", { class: "stats stats-compact" }, stat("Storage used", "…", "Measuring"));
  const bar = h("div", { class: "meter-fill" });
  const meterText = h("p", { class: "small" });
  const last = h("p", { class: "muted small" });
  const msg = h("p", { class: "scanmsg", role: "status" });
  let busy = false;
  const refresh = async () => {
    try {
      const [s, b] = await Promise.all([measureStorage(), getDoc(doc(db, "settings", "backup")).catch(() => null)]);
      const pct = Math.min(100, (s.used / s.limit) * 100);
      bar.style.width = Math.max(pct, 0.5) + "%";
      bar.className = "meter-fill" + (pct >= 90 ? " bad" : pct >= 75 ? " warn" : "");
      meterText.replaceChildren(h("strong", null, "About " + fmtMB(s.used)), ` of ${fmtMB(s.limit)} free plan used (${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%)`);
      tiles.replaceChildren(
        stat("Scans in KeepTrack", s.held.toLocaleString(), fmtMB(s.scanBytes) + (s.unmeasured ? ` · ${s.unmeasured} older estimated` : "")),
        stat("Not backed up yet", Math.max(0, s.held - s.backed).toLocaleString(), "Includes any rejected papers"),
        stat("Moved to Google Drive", s.freed.toLocaleString(), "Still open with View"),
        stat("Everything else", "~" + fmtMB(s.recordBytes), "Loads, expenses, accounts…"));
      const bd = b && b.exists() ? b.data() : null;
      last.replaceChildren(...(bd && bd.lastRunAt ? [
        `Last backup: ${bd.lastRunAt.toDate().toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${bd.count || 0} scan${bd.count === 1 ? "" : "s"}`,
        bd.reportUrl ? " · " : "", bd.reportUrl ? h("a", { href: bd.reportUrl, target: "_blank", rel: "noopener" }, "Open the backup report (PDF)") : ""] : ["No backups yet."]));
    } catch (e) { console.error(e); meterText.textContent = "Couldn't measure storage right now."; }
  };
  const lock = (on) => { busy = on; backupBtn.disabled = on; freeBtn.disabled = on; };
  const backupBtn = btn("Back up to Drive", async () => {
    if (busy) return;
    lock(true);
    msg.className = "scanmsg"; msg.textContent = "";
    try {
      const progress = (n, t) => { backupBtn.textContent = `Backing up… ${n}/${t}`; };
      let r = await backupToDrive(progress);
      // Nothing new? Offer a fresh report of everything (e.g. the last report was deleted).
      if (r.nothing && confirm("Everything is already backed up in Google Drive.\n\nMake a fresh backup report (PDF) that lists everything in Drive?")) {
        r = await backupToDrive(progress, { all: true });
      }
      if (r.nothing) { toast("Everything is already backed up.", "ok"); }
      else {
        const noReport = !r.reportUrl && r.lastError && /report/.test(r.lastError);
        toast(`Backed up ${r.done} scan${r.done === 1 ? "" : "s"} to Google Drive${r.failed ? `, ${r.failed} didn't make it` : ""}`, r.failed || noReport ? "bad" : "ok");
        msg.className = "scanmsg " + (r.failed || noReport ? "bad" : "ok");
        msg.replaceChildren(`Backed up ${r.done} scan${r.done === 1 ? "" : "s"}.`,
          r.failed ? ` ${r.failed} failed${r.lastError ? " (" + r.lastError + ")" : ""}; tap Back up again to retry them.` : "",
          noReport ? " But " + r.lastError + ". If you haven't yet, update the Drive script (Copy the script below, then deploy a new version) and tap Back up again." : "",
          r.reportUrl ? " " : "", r.reportUrl ? h("a", { href: r.reportUrl, target: "_blank", rel: "noopener" }, "Open the backup report (PDF)") : "");
      }
    } catch (e) { toast(e.message, "bad"); }
    backupBtn.textContent = "Back up to Drive";
    lock(false);
    refresh();
  }, "primary");
  const freeBtn = btn("Free up space", async () => {
    if (busy) return;
    lock(true);
    try {
      const plan = await freeUpPlan();
      const n = plan.backed.length, rej = plan.rejected.length;
      if (!n && !rej) {
        toast(plan.notBacked ? "Nothing to free yet. Tap Back up to Drive first." : "Nothing to free. KeepTrack has no scans left to move.", "info");
      } else if (confirm(
        (n ? `Remove ${n} backed-up scan${n === 1 ? "" : "s"} from KeepTrack` : "") + (n && rej ? " and " : n ? "" : "Clear ") +
        (rej ? `${rej} rejected scan${rej === 1 ? "" : "s"}` : "") + ` (about ${fmtMB(plan.bytes)})?\n\n` +
        "Backed-up scans stay in your Google Drive and still open with View. Records, search and duplicate checks are kept." +
        (plan.notBacked ? `\n\n${plan.notBacked} scan${plan.notBacked === 1 ? " isn't" : "s aren't"} backed up yet and will stay.` : ""))) {
        const r = await freeUpSpace(plan, (d, t) => { freeBtn.textContent = `Freeing… ${d}/${t}`; });
        toast(`Freed about ${fmtMB(r.bytes)} (${r.freed} scan${r.freed === 1 ? "" : "s"})` + (r.missing ? `. ${r.missing} weren't found in Drive and were kept; back up again.` : ""), r.missing ? "bad" : "ok");
      }
    } catch (e) { toast(e.message, "bad"); }
    freeBtn.textContent = "Free up space";
    lock(false);
    refresh();
  }, "warn");
  refresh();
  return card("Storage & backup", null,
    h("div", { class: "meter", role: "img", "aria-label": "Storage used" }, bar), meterText, tiles,
    h("div", { class: "row-inline" }, backupBtn, freeBtn), msg, last,
    h("p", { class: "muted small" }, "Estimates. Back up to Drive copies every new scan into your Drive folders and lists each one (date, carrier, paper, load, who sent it, amount, status, link) in a PDF report in KeepTrack / Backups. Free up space then removes those scans from KeepTrack, only after Drive confirms each copy is there. Rejected duplicates and bad photos are cleared too."));
}

// Overview nudge when the free plan is getting full.
export function storageAlert() {
  const box = card("Storage is getting full", null, h("p", null, "Measuring…"));
  box.classList.add("card-alert");
  box.hidden = true;
  measureStorage({ quick: true }).then((s) => {
    const pct = (s.used / s.limit) * 100;
    if (pct < 75) return;
    box.replaceChildren(h("div", { class: "card-head" }, h("h2", null, "Storage is getting full")),
      h("p", null, `Scans are using about ${fmtMB(s.used)} of the ${fmtMB(s.limit)} free plan (${Math.round(pct)}%). In Settings, tap Back up to Drive, then Free up space.`),
      h("div", null, h("a", { href: "#settings", class: "btn btn-primary" }, "Open Settings")));
    box.hidden = false;
  }).catch(() => {});
  return box;
}
