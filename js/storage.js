// Storage meter, "Back up to Drive", the backup report and "Free up space" (owner only).
// Scans live in Firestore (docFiles). The free Firebase plan holds 1 GiB, so the owner can copy every
// scan to Google Drive, then remove the copies from KeepTrack and start again.
// Records always stay, so search, paperwork lists and duplicate checks keep working; "View" then
// fetches the scan back from Drive.
//
// The backup report is ONE PDF (KeepTrack / Backups / "KeepTrack backup report"). It's made again from
// the records after every backup and whenever papers it lists are deleted or rejected, so it always
// lists what's in Drive right now (each save replaces the last one).
import {
  db, collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, writeBatch, serverTimestamp, deleteField,
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
const BATCH = 8; // scans per trip to the Drive script when copying
const CHECK = 20; // scans per trip when checking copies are still in Drive (the script takes up to 25)
const DRIVE_LAYOUT = 2; // bump when the Drive script files things differently, so the next backup re-files them
export const REPORT_NAME = "KeepTrack backup report";

export const fmtMB = (b) => {
  const m = b / MB;
  return (m < 10 ? m.toFixed(1) : Math.round(m).toLocaleString()) + " MB";
};
const fmtWhen = (ts) => (ts && ts.toDate ? ts.toDate().toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "just now");

const allDocs = async () => (await getDocs(collection(db, "documents"))).docs.map((d) => ({ id: d.id, ...d.data() }));

// Runs fn over items, a few at a time.
async function pool(items, size, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// Saves changes to several records; if one was deleted meanwhile, the rest are still saved.
async function saveUpdates(list) {
  if (!list.length) return;
  try {
    const b = writeBatch(db);
    list.forEach(([id, data]) => b.update(doc(db, "documents", id), data));
    await b.commit();
  } catch (e) {
    for (const [id, data] of list) {
      await updateDoc(doc(db, "documents", id), data).catch((x) => { if (x.code !== "not-found") throw x; });
    }
  }
}

// What the report shows changes when a paper with a Drive copy goes away, or a paper is rejected.
// Both are cheap to count, so the Settings card can tell when the report is out of date.
const reportKeyOf = (inDrive, rejected) => `${inDrive}|${rejected}`;
const reportKeyOfDocs = (docs) => reportKeyOf(docs.filter((d) => d.driveFileId != null).length, docs.filter((d) => d.status === "rejected").length);

// Scans: how many are still in KeepTrack and roughly how many bytes they take.
async function scanUsage() {
  const docsCol = collection(db, "documents");
  try {
    // Count on its own: an aggregate that also sums "size" can skip records that have no size
    // (papers saved before sizes were recorded), which would hide them from the meter.
    const [all, a, freed, cleared, measured, backed, inDrive, rejected] = await Promise.all([
      getCountFromServer(docsCol),
      getAggregateFromServer(docsCol, { bytes: sum("size") }),
      getCountFromServer(query(docsCol, where("fileFreed", "==", true))),
      getCountFromServer(query(docsCol, where("fileCleared", "==", true))),
      getCountFromServer(query(docsCol, where("size", ">", 0))),
      getCountFromServer(query(docsCol, where("backedUpAt", "!=", null))),
      getCountFromServer(query(docsCol, where("driveFileId", "!=", null))),
      getCountFromServer(query(docsCol, where("status", "==", "rejected"))),
    ]);
    const total = all.data().count, bytes = a.data().bytes || 0, f = freed.data().count, c = cleared.data().count;
    return {
      total, held: total - f - c, freed: f, cleared: c, measured: measured.data().count, bytes, backed: backed.data().count,
      reportKey: reportKeyOf(inDrive.data().count, rejected.data().count),
    };
  } catch (e) {
    // No aggregate queries available: add the records up here instead.
    const docs = await allDocs();
    const held = docs.filter((d) => !d.fileFreed && !d.fileCleared);
    const freed = docs.filter((d) => d.fileFreed).length;
    return {
      total: docs.length, held: held.length, freed, cleared: docs.length - held.length - freed,
      measured: held.filter((d) => d.size > 0).length, bytes: held.reduce((s, d) => s + (d.size || 0), 0),
      backed: held.filter((d) => d.backedUpAt).length, reportKey: reportKeyOfDocs(docs),
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

// ---------- The backup report ----------

let lastFailures = new Map(); // docId -> why it didn't reach Drive, from this session's last backup
const laneOf = (place) => String(place || "?").replace(/,/g, "").replace(/\s+/g, " ").trim();
const paperOf = (d) => [d.name || d.kind || "Document", d.note].filter(Boolean).join(" · ");
const statusOf = (d) => (STATUS[d.status] || [d.status || ""])[0];
const madeAt = (d) => (d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0);

// Builds the report from the records as they are now and saves it over the last one.
async function makeReport() {
  const [docs, loadSnap, carrierSnap] = await Promise.all([
    allDocs(),
    getDocs(collection(db, "loads")).catch(() => null),
    getDocs(collection(db, "carriers")).catch(() => null),
  ]);
  const loads = new Map(loadSnap ? loadSnap.docs.map((x) => [x.id, x.data()]) : []);
  const carriers = new Map(carrierSnap ? carrierSnap.docs.map((x) => [x.id, x.data().name || ""]) : []);
  const carrierOf = (d) => carriers.get(d.carrierId) || d.carrierId || "";
  // the load the way its Drive folder is named: broker load # and lane
  const loadOf = (d) => {
    if (!d.loadId) return "";
    const l = loads.get(d.loadId);
    return l ? `${l.loadNo || String(d.loadId).slice(0, 6).toUpperCase()} · ${laneOf(l.origin)} → ${laneOf(l.destination)}` : d.loadLabel || "";
  };
  const row = (d) => ({
    date: d.createdAt, carrier: carrierOf(d), paper: paperOf(d), load: loadOf(d),
    sentBy: d.uploaderName || "", amount: d.amount || 0, status: statusOf(d), url: d.driveUrl || "",
  });
  const live = docs.filter((d) => !d.fileCleared && d.status !== "rejected").sort((a, b) => madeAt(b) - madeAt(a));
  const rows = live.filter((d) => d.driveFileId && !d.driveMissing).map(row);
  const missing = live.filter((d) => d.driveFileId && d.driveMissing).map(row);
  const notIn = live.filter((d) => !d.driveFileId && !d.fileFreed);
  const failed = notIn.filter((d) => lastFailures.has(d.id)).map((d) => ({ paper: `${paperOf(d)} (${carrierOf(d)})`, why: lastFailures.get(d.id) }));
  const data = await backupPdf({
    title: "Backup report", sub: "Up to date as of " + new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" }),
    rows, missing, failed, notYet: notIn.length - failed.length,
  });
  const j = await driveCall({ savePdf: REPORT_NAME, data });
  const saved = {
    reportUrl: j.url || null, reportName: REPORT_NAME, reportAt: serverTimestamp(),
    reportCount: rows.length, reportMissing: missing.length, reportKey: reportKeyOfDocs(docs),
  };
  await setDoc(doc(db, "settings", "backup"), saved, { merge: true });
  return { url: saved.reportUrl, count: rows.length, missing: missing.length };
}

// One report at a time. Asked again while one is being made: one more is made right after it,
// so the last change is always in.
let reportRun = null, reportAgain = null;
export function refreshReport() {
  if (!reportRun) {
    reportRun = makeReport().finally(() => { reportRun = null; });
    return reportRun;
  }
  if (!reportAgain) reportAgain = reportRun.catch(() => {}).then(() => { reportAgain = null; return refreshReport(); });
  return reportAgain;
}

// After the owner deletes or rejects papers that are in the report: make it again a moment later
// (once for a whole batch of deletes). Only once there's a report to keep up to date.
let soon = null;
export function updateReportSoon(ms = 1500) {
  clearTimeout(soon);
  soon = setTimeout(async () => {
    soon = null;
    try {
      if (!(await driveUrl())) return;
      const b = await getDoc(doc(db, "settings", "backup"));
      if (!b.exists() || !(b.data().reportUrl || b.data().lastRunAt)) return;
      await refreshReport();
    } catch (e) { console.warn("Backup report not updated", e); }
  }, ms);
}

// ---------- Back up ----------

// 1) Checks the copies already in Drive are still there (someone may have deleted them in Drive):
//    a scan KeepTrack still has is copied again; one that only lived in Drive is flagged as missing.
// 2) Copies every new scan, and moves anything filed under an older Drive layout into place.
// 3) Makes the backup report again.
// Each copy is recorded on its document, so "Free up space" knows it's safe.
// A second tap (or the card drawn again mid-backup) joins the backup that's already running.
// The result pops up once per backup (not once per card that's waiting on it).
let job = null;
export const backupRunning = () => job && job.promise;
export function backupToDrive(onProgress = () => {}) {
  if (job) { job.listeners.add(onProgress); return job.promise; }
  const listeners = new Set([onProgress]);
  const progress = (...a) => listeners.forEach((fn) => { try { fn(...a); } catch (_) {} });
  const promise = runBackup(progress)
    .then((r) => { backupToast(r); return r; }, (e) => { toast(e.message, "bad"); throw e; })
    .finally(() => { job = null; });
  job = { listeners, promise };
  return promise;
}

const plural = (n) => (n === 1 ? "" : "s");
const backupProblem = (r) => r.failed || r.lost || r.unchecked || r.reportError;
function backupToast(r) {
  toast(r.done
    ? `Backed up ${r.done} scan${plural(r.done)} to Google Drive${r.failed ? `, ${r.failed} didn't make it` : ""}`
    : r.failed ? `${r.failed} scan${plural(r.failed)} didn't make it to Google Drive`
    : r.lost ? `${r.lost} scan${plural(r.lost)} missing from Google Drive`
    : "Everything is already backed up.", backupProblem(r) ? "bad" : "ok");
}

async function runBackup(progress) {
  if (!(await driveUrl())) throw new Error("Connect Google Drive first (below).");
  const docs = await allDocs();

  // 1) Still in Drive?
  const recorded = docs.filter((d) => d.driveFileId && !d.fileCleared && d.status !== "rejected");
  let checked = 0, recopy = 0, lost = 0, unchecked = 0, checkError = "";
  progress(0, recorded.length, "Checking Drive");
  await pool(chunks(recorded, CHECK), 3, async (part) => {
    let results = null;
    try { results = (await driveCall({ verify: true, docIds: part.map((d) => d.id) })).results || []; }
    catch (e) { unchecked += part.length; checkError = e.message; }
    if (results) {
      const there = new Map(results.map((r) => [r.docId, !!r.ok]));
      const updates = [];
      for (const d of part) {
        if (!there.has(d.id)) continue; // no answer about it: leave it as it is
        if (there.get(d.id)) {
          if (d.driveMissing) { updates.push([d.id, { driveMissing: deleteField() }]); d.driveMissing = false; } // put back from the Drive trash
        } else if (d.fileFreed) {
          // its only copy was in Drive: keep the record, and say it's missing (it may still be in the Drive trash)
          if (!d.driveMissing) updates.push([d.id, { driveMissing: true }]);
          d.driveMissing = true;
          lost++;
        } else {
          // KeepTrack still has the scan: it's copied to Drive again below
          updates.push([d.id, { driveFileId: deleteField(), driveUrl: deleteField(), driveLayout: deleteField(), backedUpAt: deleteField(), driveMissing: deleteField() }]);
          delete d.driveFileId; delete d.driveUrl; delete d.driveLayout; delete d.backedUpAt; d.driveMissing = false;
          recopy++;
        }
      }
      await saveUpdates(updates);
    }
    checked += part.length;
    progress(checked, recorded.length, "Checking Drive");
  });

  // 2) Copy. New scans, plus anything filed under an older Drive layout (moved into place, not copied again).
  const todo = docs.filter((d) => !d.fileCleared && d.status !== "rejected" && !d.driveMissing &&
    (d.fileFreed ? d.driveFileId && d.driveLayout !== DRIVE_LAYOUT : !d.backedUpAt || !d.driveFileId || d.driveLayout !== DRIVE_LAYOUT));
  const freedIds = new Set(todo.filter((d) => d.fileFreed).map((d) => d.id));
  const failures = new Map();
  let done = 0, failed = 0, lastError = "";
  progress(0, todo.length, "Backing up");
  for (const part of chunks(todo, BATCH)) {
    let j = null;
    try { j = await driveCall({ backup: true, docIds: part.map((d) => d.id) }); }
    catch (e) {
      lastError = e.message; failed += part.length;
      part.forEach((d) => failures.set(d.id, e.message));
      progress(done + failed, todo.length, "Backing up");
      continue;
    }
    const updates = [];
    for (const r of j.results || []) {
      if (r.ok && r.fileId) {
        updates.push([r.docId, {
          driveFileId: r.fileId, driveUrl: r.url || null, driveLayout: DRIVE_LAYOUT,
          ...(freedIds.has(r.docId) ? {} : { backedUpAt: serverTimestamp() }), ...(r.size ? { size: r.size } : {}),
        }]);
        done++;
      } else {
        failed++; lastError = r.error || lastError;
        failures.set(r.docId, r.error || "unknown");
      }
    }
    await saveUpdates(updates);
    progress(done + failed, todo.length, "Backing up");
  }
  lastFailures = failures;

  // 3) The report, from the records as they are now.
  progress(0, 0, "Making the report");
  let report = null, reportError = "";
  try { report = await refreshReport(); } catch (e) { reportError = e.message; }
  await setDoc(doc(db, "settings", "backup"), { lastRunAt: serverTimestamp(), count: done, failed }, { merge: true });
  return { done, failed, recopy, lost, unchecked, checkError, lastError, report, reportError };
}

// ---------- Free up space ----------

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
  for (let i = 0; i < plan.backed.length; i += CHECK) {
    const part = plan.backed.slice(i, i + CHECK);
    const j = await driveCall({ verify: true, docIds: part.map((d) => d.id) });
    const okIds = new Set((j.results || []).filter((r) => r.ok).map((r) => r.docId));
    const b = writeBatch(db);
    for (const d of part) {
      if (okIds.has(d.id)) free(b, d, true);
      else { // not in Drive after all: it stays here and is copied again with the next backup
        b.update(doc(db, "documents", d.id), { backedUpAt: deleteField(), driveFileId: deleteField(), driveUrl: deleteField(), driveLayout: deleteField() });
        missing++;
      }
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
  const tiles = h("div", { class: "stats stats-compact" }, stat("Storage used", "…", "Measuring"));
  const bar = h("div", { class: "meter-fill" });
  const meterText = h("p", { class: "small" });
  const last = h("p", { class: "muted small" });
  const reportLine = h("p", { class: "muted small report-line" });
  const msg = h("p", { class: "scanmsg", role: "status" });
  let busy = false, updating = false, reportError = "", bd = null;
  const s_ = plural;

  const drawReport = () => {
    if (updating) { reportLine.replaceChildren("Backup report: updating it to match Drive…"); return; }
    const parts = [];
    if (bd && bd.reportUrl) {
      parts.push("Backup report: ", bd.reportKey == null ? "from your last backup"
        : `${bd.reportCount || 0} scan${s_(bd.reportCount)} in Drive${bd.reportMissing ? `, ${bd.reportMissing} missing` : ""} · updated ${fmtWhen(bd.reportAt)}`,
        " · ", h("a", { href: bd.reportUrl, target: "_blank", rel: "noopener" }, "Open the backup report (PDF)"));
    }
    if (reportError) parts.push(h("span", { class: "bad-text" }, `${parts.length ? " " : "Backup report: "}couldn't update it (${reportError}). It's made again with your next backup.`));
    reportLine.replaceChildren(...parts);
  };

  // auto: if the report is out of date (papers deleted or rejected since), make it again, once per refresh
  const refresh = async ({ auto = true } = {}) => {
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
      bd = b && b.exists() ? b.data() : null;
      last.replaceChildren(bd && bd.lastRunAt
        ? `Last backup: ${fmtWhen(bd.lastRunAt)} · ${bd.count ? `${bd.count} scan${s_(bd.count)} copied` : "nothing new to copy"}${bd.failed ? `, ${bd.failed} didn't make it` : ""}`
        : "No backups yet.");
      drawReport();
      const stale = bd && (bd.reportUrl || bd.lastRunAt) && bd.reportKey !== s.reportKey;
      if (stale && auto && !busy && !updating && (await driveUrl())) {
        updating = true; reportError = ""; drawReport();
        try { await refreshReport(); } catch (e) { reportError = e.message; }
        updating = false;
        refresh({ auto: false });
      }
    } catch (e) { console.error(e); meterText.textContent = "Couldn't measure storage right now."; }
  };
  const lock = (on) => { busy = on; backupBtn.disabled = on; freeBtn.disabled = on; };
  const backupProgress = (n, t, phase) => { backupBtn.textContent = t ? `${phase}… ${n}/${t}` : `${phase}…`; };
  const showBackup = (r) => {
    msg.className = "scanmsg " + (backupProblem(r) ? "bad" : "ok");
    msg.replaceChildren(
      r.done ? `Backed up ${r.done} scan${s_(r.done)}.` : "Nothing new to copy.",
      r.recopy ? ` ${r.recopy} had been deleted in Drive, so ${r.recopy === 1 ? "it was" : "they were"} copied again.` : "",
      r.lost ? ` ${r.lost} scan${r.lost === 1 ? " that only lived in Drive was" : "s that only lived in Drive were"} deleted there: restore ${r.lost === 1 ? "it" : "them"} from the Drive trash, or delete ${r.lost === 1 ? "that paper" : "those papers"} in KeepTrack.` : "",
      r.failed ? ` ${r.failed} failed${r.lastError ? " (" + r.lastError + ")" : ""}; tap Back up again to retry them.` : "",
      r.unchecked ? ` Couldn't check ${r.unchecked} older cop${r.unchecked === 1 ? "y" : "ies"} in Drive (${r.checkError}); tap Back up again.` : "",
      r.reportError ? ` The backup report couldn't be saved (${r.reportError}).` : "",
      r.report && r.report.url ? " " : "",
      r.report && r.report.url ? h("a", { href: r.report.url, target: "_blank", rel: "noopener" }, "Open the backup report (PDF)") : "");
  };
  const runBackupNow = async (p) => {
    lock(true);
    try { showBackup(await p); } catch (e) { msg.className = "scanmsg bad"; msg.textContent = e.message; }
    backupBtn.textContent = "Back up to Drive";
    lock(false);
    reportError = "";
    refresh();
  };
  const backupBtn = btn("Back up to Drive", () => {
    if (busy) return;
    msg.className = "scanmsg"; msg.textContent = "";
    runBackupNow(backupToDrive(backupProgress));
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
        (n ? `Remove ${n} backed-up scan${s_(n)} from KeepTrack` : "") + (n && rej ? " and " : n ? "" : "Clear ") +
        (rej ? `${rej} rejected scan${s_(rej)}` : "") + ` (about ${fmtMB(plan.bytes)})?\n\n` +
        "Backed-up scans stay in your Google Drive and still open with View. Records, search and duplicate checks are kept." +
        (plan.notBacked ? `\n\n${plan.notBacked} scan${plan.notBacked === 1 ? " isn't" : "s aren't"} backed up yet and will stay.` : ""))) {
        const r = await freeUpSpace(plan, (d, t) => { freeBtn.textContent = `Freeing… ${d}/${t}`; });
        toast(`Freed about ${fmtMB(r.bytes)} (${r.freed} scan${s_(r.freed)})` + (r.missing ? `. ${r.missing} weren't found in Drive and were kept; back up again.` : ""), r.missing ? "bad" : "ok");
      }
    } catch (e) { toast(e.message, "bad"); }
    freeBtn.textContent = "Free up space";
    lock(false);
    refresh();
  }, "warn");
  // a backup started before this card was drawn (e.g. on an earlier visit to Settings) is still running
  const running = backupRunning();
  refresh(running ? { auto: false } : undefined);
  if (running) { backupToDrive(backupProgress); runBackupNow(running); }
  return card("Storage & backup", null,
    h("div", { class: "meter", role: "img", "aria-label": "Storage used" }, bar), meterText, tiles,
    h("div", { class: "row-inline" }, backupBtn, freeBtn), msg, last, reportLine,
    h("p", { class: "muted small" }, "Estimates. Back up to Drive copies new scans into your Drive folders and checks the ones already there. The backup report (KeepTrack / Backups) lists every scan in Drive with a link, and is made again after each backup and whenever papers are deleted, so it matches Drive. Delete papers here in KeepTrack, not in Drive. Free up space removes backed-up scans from KeepTrack once Drive confirms each copy. Rejected duplicates and bad photos are cleared too."));
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
