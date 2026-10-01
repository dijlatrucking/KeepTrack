// KeepTrack → Google Drive
//
// Paste this whole file into a new Apps Script project (script.google.com), then
// Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone → Deploy.
// Copy the Web app URL into KeepTrack → Settings → Google Drive.
// Updating later: paste the new version, save, then Deploy → Manage deployments → edit (pencil)
// → Version: New version → Deploy. The URL stays the same.
//
// How it stays safe:
// - KeepTrack sends only the signed-in user's Firebase ID token and document ids. No file data.
// - This script checks the token with Firebase, then reads each document and its scan from Firestore
//   *as that user*, so KeepTrack's security rules decide what they're allowed to send or open.
// - Backups and "free up space" checks only run for the KeepTrack owner.
// - Files land in your Drive under KeepTrack/<Carrier>/...; nobody else gets Drive access.
//
// Where files go:
//   KeepTrack / Carrier / Loads / 2026-10 / Oct 01 · 4471823 · Boise ID → Denver CO / 2026-10-01 · BOL · 4471823.jpg
//   KeepTrack / Carrier / Driver receipts / Driver name / 2026-10-02 · Fuel $412.jpg
//   KeepTrack / Carrier / Company / Insurance / 2026-10-01 · Insurance · Policy 2026.pdf
//   KeepTrack / Backups / one sheet per backup

const FIREBASE_API_KEY = "AIzaSyAD09pk9OyApPn6f8OCiCFr-PpYT17sEHU";
const PROJECT_ID = "keeptrack-6426e";
const ROOT_FOLDER = "KeepTrack";
const SHEET_HEADERS = ["Sent", "Carrier", "Type", "Name", "Load", "Sent by", "Role", "Amount", "Note", "Status", "Tags", "Drive file", "Folder", "KeepTrack ID"];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    if (body.ping) return reply({ ok: true, ping: "pong", root: rootFolder().getUrl() });
    if (!body.idToken) return reply({ ok: false, error: "missing sign-in" });

    // 1) Who is this? (rejects expired or fake tokens)
    const who = fetchJson("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_API_KEY,
      { method: "post", contentType: "application/json", payload: JSON.stringify({ idToken: body.idToken }) });
    if (!who || !who.users || !who.users.length) return reply({ ok: false, error: "not signed in" });
    const uid = who.users[0].localId;

    // 2) Owner-only jobs: back up a batch of scans, or confirm copies exist before KeepTrack deletes its own.
    if (body.backup || body.verify) {
      const me = firestoreGet("users/" + uid, body.idToken);
      if (!me || me.role !== "owner") return reply({ ok: false, error: "only the owner can do that" });
      const ids = (body.docIds || []).slice(0, 25);
      if (body.verify) {
        return reply({ ok: true, results: ids.map(function (id) {
          const meta = firestoreGet("documents/" + id, body.idToken);
          const f = meta && existingCopy(id, meta);
          return { docId: id, ok: !!f };
        }) });
      }
      const carriers = {};
      const results = [], rows = [];
      ids.forEach(function (id) {
        const r = copyOne(id, body.idToken, carriers);
        results.push(r.out);
        if (r.row) rows.push(r.row);
      });
      const ss = backupSheet(String(body.backup));
      if (rows.length) {
        const sh = ss.getSheets()[0];
        sh.getRange(sh.getLastRow() + 1, 1, rows.length, SHEET_HEADERS.length).setValues(rows);
      }
      return reply({ ok: true, sheet: ss.getUrl(), results: results });
    }

    if (!body.docId) return reply({ ok: false, error: "missing document" });

    // 3) Open a scan that now lives only in Drive (anyone KeepTrack lets see the document).
    if (body.fetch) {
      const meta = firestoreGet("documents/" + body.docId, body.idToken);
      if (!meta) return reply({ ok: false, error: "no access to that document" });
      const file = firestoreGet("docFiles/" + body.docId, body.idToken);
      if (file && file.data) return reply({ ok: true, data: file.data });
      const f = existingCopy(body.docId, meta);
      if (!f) return reply({ ok: false, error: "That scan isn't in Google Drive anymore" });
      const blob = f.getBlob();
      return reply({ ok: true, data: "data:" + blob.getContentType() + ";base64," + Utilities.base64Encode(blob.getBytes()) });
    }

    // 4) A rejected duplicate: move its Drive copy to the trash.
    if (body.remove) {
      const meta = firestoreGet("documents/" + body.docId, body.idToken);
      if (!meta) return reply({ ok: false, error: "no access to that document" });
      if (meta.status !== "rejected") return reply({ ok: false, error: "only rejected documents are removed" });
      const carrier = firestoreGet("carriers/" + meta.carrierId, body.idToken) || {};
      const place = placeFor(meta, carrier, body.idToken);
      const found = ourCopies(body.docId, meta, carrier, place);
      found.forEach(function (f) { const parent = parentOf(f); f.setTrashed(true); cleanupEmpty(parent); });
      return reply({ ok: true, removed: found.length, folder: place.path.join(" / ") });
    }

    // 5) Copy one new scan (sent automatically after every upload).
    return reply(copyOne(body.docId, body.idToken, {}).out);
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return reply({ ok: true, service: "KeepTrack Drive", root: rootFolder().getUrl() });
}

// ---------- copying ----------

// Saves one scan in its place (once: every copy is marked with its KeepTrack document id, so a retry
// never makes a second copy, and a copy filed under an older layout is moved, not duplicated).
// Returns the reply for KeepTrack and a row for the backup sheet.
function copyOne(docId, idToken, carrierCache) {
  const meta = firestoreGet("documents/" + docId, idToken);
  if (!meta) return { out: { docId: docId, ok: false, error: "no access to that document" } };
  if (!(meta.carrierId in carrierCache)) carrierCache[meta.carrierId] = firestoreGet("carriers/" + meta.carrierId, idToken) || {};
  const carrier = carrierCache[meta.carrierId];
  const place = placeFor(meta, carrier, idToken);
  const file = firestoreGet("docFiles/" + docId, idToken);
  const m = file && file.data ? /^data:([^;]+);base64,(.*)$/.exec(file.data) : null;
  if (file && file.data && !m) return { out: { docId: docId, ok: false, error: "unreadable scan" } };
  const ext = m ? (m[1] === "application/pdf" ? ".pdf" : ".jpg") : null;
  const there = findPath(place.path);
  // Already in Drive? (recorded copy, a copy in its place, an older layout, or anywhere else we marked it)
  let saved = existingCopy(docId, meta) || (ext && there && findInPlace(there, place.base, ext, docId)) || legacyCopy(docId, meta, carrier) || searchCopy(docId);
  // No scan in KeepTrack (space freed) and no copy in Drive: nothing to save.
  if (!saved && !m) return { out: { docId: docId, ok: false, error: "scan not found" } };
  const folder = there || makePath(place.path);
  if (saved) saved = relocate(saved, folder, place.base, ext || extOf(saved.getName()), docId);
  else saved = createIn(folder, place.base, ext, docId, Utilities.newBlob(Utilities.base64Decode(m[2]), m[1]));
  const size = m ? file.data.length : 0;
  saved.setDescription([MARK + docId, meta.amount ? "$" + money(meta.amount) : "", meta.note || ""].filter(String).join(" · "));
  const row = [
    meta.createdAt ? new Date(meta.createdAt) : "", carrier.name || "", meta.kind || meta.category || "", meta.name || "",
    place.loadTitle || meta.loadLabel || "", meta.uploaderName || "", meta.uploaderRole || "", meta.amount || "", meta.note || "",
    meta.status || "", meta.tags || "", '=HYPERLINK("' + saved.getUrl() + '","Open")', place.path.join(" / "), docId,
  ];
  return { out: { docId: docId, ok: true, url: saved.getUrl(), fileId: saved.getId(), folder: place.path.join(" / "), size: size }, row: row };
}

const MARK = "KeepTrack ";
function isOurs(f, docId) { return !f.isTrashed() && String(f.getDescription() || "").indexOf(MARK + docId) === 0; }

// The Drive copy KeepTrack recorded for this document, if it's still there and really is this document's.
function existingCopy(docId, meta) {
  if (!meta.driveFileId) return null;
  try {
    const f = DriveApp.getFileById(meta.driveFileId);
    return isOurs(f, docId) ? f : null;
  } catch (e) { return null; }
}

// A copy saved by the first version of this script (Drivers / Loads folders, "name · abc123.jpg").
function legacyCopy(docId, meta, carrier) {
  const carrierName = clean(carrier.name || "Carrier " + String(meta.carrierId).slice(0, 6));
  const kind = String(meta.kind || meta.category || "Document");
  const loadFolder = meta.loadLabel ? clean("Load " + meta.loadLabel) : "";
  let path;
  if (meta.uploaderRole === "driver") path = [carrierName, "Drivers", clean(meta.uploaderName || "Driver"), isReceipt(meta) ? "Receipts" : (loadFolder || "Other")];
  else if (loadFolder) path = [carrierName, "Loads", loadFolder];
  else if (isReceipt(meta)) path = [carrierName, "Receipts"];
  else path = [carrierName, "Company", clean(meta.category || kind)];
  const folder = findPath(path);
  if (!folder) return null;
  const exts = [".jpg", ".pdf"];
  for (let i = 0; i < exts.length; i++) {
    const it = folder.getFilesByName(clean(meta.name || meta.kind || "Document") + " · " + docId.slice(0, 6) + exts[i]);
    while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  }
  return null;
}

// Every copy of this document we can find (current place, recorded id, older layout).
function ourCopies(docId, meta, carrier, place) {
  const out = [];
  const add = function (f) { if (f && !out.some(function (x) { return x.getId() === f.getId(); })) out.push(f); };
  add(existingCopy(docId, meta));
  add(legacyCopy(docId, meta, carrier));
  const folder = findPath(place.path);
  if (folder) [".jpg", ".pdf"].forEach(function (ext) {
    for (let i = 1; i <= 20; i++) {
      const it = folder.getFilesByName(place.base + (i > 1 ? " (" + i + ")" : "") + ext);
      while (it.hasNext()) { const f = it.next(); if (isOurs(f, docId)) add(f); }
    }
  });
  return out;
}

// Where a document goes and what it's called.
function placeFor(meta, carrier, idToken) {
  const carrierName = clean(carrier.name || "Carrier " + String(meta.carrierId).slice(0, 6));
  const date = dayOf(meta.createdAt) || "undated";
  const type = typeLabel(meta);
  const page = pageOf(meta.name);
  if (meta.loadId) {
    const load = firestoreGet("loads/" + meta.loadId, idToken);
    const num = load && load.loadNo ? clean(load.loadNo) : String(meta.loadId).slice(0, 6).toUpperCase();
    if (load) {
      const day = load.pickupDate || dayOf(load.createdAt) || date;
      const lane = laneOf(load.origin) + " → " + laneOf(load.destination);
      return {
        path: [carrierName, "Loads", day.slice(0, 7), clean(shortDay(day) + " · " + num + " · " + lane)],
        base: clean(date + " · " + type + " · " + num + page), loadTitle: num + " · " + lane,
      };
    }
    return { path: [carrierName, "Loads", "Other loads", clean("Load " + (meta.loadLabel || num))], base: clean(date + " · " + type + " · " + num + page) };
  }
  if (meta.uploaderRole === "driver") {
    return { path: [carrierName, isReceipt(meta) ? "Driver receipts" : "Driver uploads", clean(meta.uploaderName || "Driver")], base: clean(date + " · " + type + page) };
  }
  if (isReceipt(meta)) return { path: [carrierName, "Receipts"], base: clean(date + " · " + type + page) };
  const named = String(meta.name || "").replace(/\s*p\d+\/\d+$/, "").trim();
  const extra = named && clean(named) !== clean(meta.kind || meta.category || "") ? " · " + named : "";
  return { path: [carrierName, "Company", clean(meta.category || meta.kind || "Other")], base: clean(date + " · " + type + extra + page) };
}

function isReceipt(meta) {
  return /receipt|lumper|fuel|repair|toll|scale|expense/i.test(String(meta.kind || "")) || /receipt/i.test(String(meta.category || ""));
}

// "BOL", "Rate con", "Lumper $85", "Fuel $412.50"…
function typeLabel(meta) {
  let t = String(meta.kind || meta.category || "Document");
  if (t === "Receipt" && meta.receiptType && meta.receiptType !== "Other") t = meta.receiptType;
  if (isReceipt(meta) && meta.amount) t += " $" + money(meta.amount);
  return t;
}

function money(n) { n = Number(n); return n % 1 ? n.toFixed(2) : String(n); }
function pageOf(name) { const m = /p(\d+)\/(\d+)$/.exec(String(name || "")); return m ? " p" + m[1] + " of " + m[2] : ""; }
function laneOf(place) { return String(place || "?").replace(/,/g, "").replace(/\s+/g, " ").trim(); }
function extOf(name) { const m = /\.[a-z0-9]+$/i.exec(String(name)); return m ? m[0] : ".jpg"; }
function dayOf(ts) { return ts ? Utilities.formatDate(new Date(ts), Session.getScriptTimeZone(), "yyyy-MM-dd") : ""; }
function shortDay(day) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months[Number(day.slice(5, 7)) - 1] + " " + day.slice(8, 10);
}

// This document's copy in its folder ("…", "… (2)", …), if it's there.
function findInPlace(folder, base, ext, docId) {
  for (let i = 1; i <= 50; i++) {
    const it = folder.getFilesByName(base + (i > 1 ? " (" + i + ")" : "") + ext);
    let any = false;
    while (it.hasNext()) { const f = it.next(); if (isOurs(f, docId)) return f; any = true; }
    if (!any) return null;
  }
  return null;
}

// Saves a new copy under the first free name ("…", then "… (2)" if two papers share a name).
function createIn(folder, base, ext, docId, blob) {
  for (let i = 1; i <= 50; i++) {
    const name = base + (i > 1 ? " (" + i + ")" : "") + ext;
    const it = folder.getFilesByName(name);
    let taken = false;
    while (it.hasNext()) { if (!it.next().isTrashed()) taken = true; }
    if (!taken) {
      const f = folder.createFile(blob.setName(name));
      f.setDescription(MARK + docId);
      return f;
    }
  }
  throw new Error("too many files named " + base);
}

// Anywhere else in Drive (for example a load folder whose name changed since the copy was made).
function searchCopy(docId) {
  try {
    const it = DriveApp.searchFiles('fullText contains "' + docId + '" and trashed = false');
    while (it.hasNext()) { const f = it.next(); if (isOurs(f, docId)) return f; }
  } catch (e) {}
  return null;
}

// Moves a copy into its place and gives it the current name (used when the layout or the load changes).
function relocate(f, folder, base, ext, docId) {
  const parent = parentOf(f);
  const name = f.getName();
  const inPlace = parent && parent.getId() === folder.getId();
  if (inPlace && (name === base + ext || name.indexOf(base + " (") === 0)) return f;
  for (let i = 1; i <= 50; i++) {
    const want = base + (i > 1 ? " (" + i + ")" : "") + ext;
    if (want === name && inPlace) return f;
    const it = folder.getFilesByName(want);
    let taken = false;
    while (it.hasNext()) { const g = it.next(); if (!g.isTrashed() && g.getId() !== f.getId()) taken = true; }
    if (!taken) {
      f.setName(want);
      if (!inPlace) { f.moveTo(folder); cleanupEmpty(parent); }
      return f;
    }
  }
  return f;
}

function parentOf(f) { const it = f.getParents(); return it.hasNext() ? it.next() : null; }

// After a move, trash folders left empty (never the KeepTrack folder or a carrier's folder).
function cleanupEmpty(folder) {
  const root = rootFolder();
  for (let i = 0; folder && i < 6; i++) {
    if (folder.getId() === root.getId()) return;
    const up = parentOf(folder);
    if (!up || up.getId() === root.getId()) return;
    if (folder.searchFiles("trashed = false").hasNext() || folder.searchFolders("trashed = false").hasNext()) return;
    folder.setTrashed(true);
    folder = up;
  }
}

// One sheet per backup run, in KeepTrack / Backups.
function backupSheet(name) {
  const folder = child(rootFolder(), "Backups");
  const title = clean(name);
  const it = folder.getFilesByName(title);
  if (it.hasNext()) return SpreadsheetApp.open(it.next());
  const ss = SpreadsheetApp.create(title);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  const sh = ss.getSheets()[0];
  sh.setName("Scans");
  sh.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]).setFontWeight("bold");
  sh.setFrozenRows(1);
  return ss;
}

// ---------- helpers ----------

let rootCache = null;
function rootFolder() {
  if (rootCache) return rootCache;
  const it = DriveApp.getFoldersByName(ROOT_FOLDER);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return (rootCache = f); }
  return (rootCache = DriveApp.createFolder(ROOT_FOLDER));
}

function findChild(parent, name) {
  const it = parent.getFoldersByName(name);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return null;
}

function child(parent, name) {
  return findChild(parent, name) || parent.createFolder(name);
}

function makePath(path) { return path.reduce(function (f, name) { return child(f, name); }, rootFolder()); }

function findPath(path) {
  let f = rootFolder();
  for (let i = 0; i < path.length && f; i++) f = findChild(f, path[i]);
  return f;
}

function clean(s) {
  return String(s).replace(/[\\/:*?"<>|#%]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "Untitled";
}

function fetchJson(url, opts) {
  const res = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, opts || {}));
  if (res.getResponseCode() >= 300) return null;
  return JSON.parse(res.getContentText());
}

// Reads one Firestore document with the user's own token (security rules apply) and flattens its fields.
function firestoreGet(path, idToken) {
  const doc = fetchJson("https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/" + path,
    { headers: { Authorization: "Bearer " + idToken } });
  if (!doc || !doc.fields) return null;
  const out = {};
  Object.keys(doc.fields).forEach(function (k) { out[k] = value(doc.fields[k]); });
  return out;
}

function value(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  return null;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
