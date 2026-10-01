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
      const path = folderPath(meta, carrier);
      const folder = path.reduce(function (f, name) { return child(f, name); }, rootFolder());
      let n = 0;
      [".jpg", ".pdf"].forEach(function (ext) {
        const it = folder.getFilesByName(fileName(body.docId, meta, ext));
        while (it.hasNext()) { it.next().setTrashed(true); n++; }
      });
      const f = existingCopy(body.docId, meta);
      if (f) { f.setTrashed(true); n++; }
      return reply({ ok: true, removed: n, folder: path.join(" / ") });
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

// Saves one scan into its folder (once: the document id is in the file name and description, so a
// retry never makes a second copy). Returns the reply for KeepTrack and a row for the backup sheet.
function copyOne(docId, idToken, carrierCache) {
  const meta = firestoreGet("documents/" + docId, idToken);
  if (!meta) return { out: { docId: docId, ok: false, error: "no access to that document" } };
  if (!(meta.carrierId in carrierCache)) carrierCache[meta.carrierId] = firestoreGet("carriers/" + meta.carrierId, idToken) || {};
  const carrier = carrierCache[meta.carrierId];
  const path = folderPath(meta, carrier);
  const file = firestoreGet("docFiles/" + docId, idToken);
  let saved, size = 0;
  if (!file || !file.data) {
    // Space already freed in KeepTrack: fine, as long as the Drive copy is still there.
    saved = existingCopy(docId, meta);
    if (!saved) return { out: { docId: docId, ok: false, error: "scan not found" } };
  } else {
    const m = /^data:([^;]+);base64,(.*)$/.exec(file.data);
    if (!m) return { out: { docId: docId, ok: false, error: "unreadable scan" } };
    const folder = path.reduce(function (f, name) { return child(f, name); }, rootFolder());
    const name = fileName(docId, meta, m[1] === "application/pdf" ? ".pdf" : ".jpg");
    const existing = folder.getFilesByName(name);
    saved = existing.hasNext() ? existing.next() : folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name));
    size = file.data.length;
  }
  saved.setDescription(["KeepTrack " + docId, meta.amount ? "$" + meta.amount : "", meta.note || ""].filter(String).join(" · "));
  const row = [
    meta.createdAt ? new Date(meta.createdAt) : "", carrier.name || "", meta.kind || meta.category || "", meta.name || "",
    meta.loadLabel || "", meta.uploaderName || "", meta.uploaderRole || "", meta.amount || "", meta.note || "",
    meta.status || "", meta.tags || "", '=HYPERLINK("' + saved.getUrl() + '","Open")', path.join(" / "), docId,
  ];
  return { out: { docId: docId, ok: true, url: saved.getUrl(), fileId: saved.getId(), folder: path.join(" / "), size: size }, row: row };
}

// The Drive copy KeepTrack recorded for this document, if it's still there and really is this document's.
function existingCopy(docId, meta) {
  if (!meta.driveFileId) return null;
  try {
    const f = DriveApp.getFileById(meta.driveFileId);
    if (f.isTrashed()) return null;
    if (String(f.getDescription() || "").indexOf("KeepTrack " + docId) !== 0) return null;
    return f;
  } catch (e) { return null; }
}

function folderPath(meta, carrier) {
  const carrierName = clean(carrier.name || "Carrier " + String(meta.carrierId).slice(0, 6));
  const kind = String(meta.kind || meta.category || "Document");
  const isReceipt = /receipt|lumper|fuel|repair|toll|scale|expense/i.test(kind) || /receipt/i.test(String(meta.category || ""));
  const loadFolder = meta.loadLabel ? clean("Load " + meta.loadLabel) : "";
  if (meta.uploaderRole === "driver") return [carrierName, "Drivers", clean(meta.uploaderName || "Driver"), isReceipt ? "Receipts" : (loadFolder || "Other")];
  if (loadFolder) return [carrierName, "Loads", loadFolder];
  if (isReceipt) return [carrierName, "Receipts"];
  return [carrierName, "Company", clean(meta.category || kind)];
}

function fileName(docId, meta, ext) {
  return clean(meta.name || meta.kind || "Document") + " · " + docId.slice(0, 6) + ext;
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

function rootFolder() {
  const it = DriveApp.getFoldersByName(ROOT_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER);
}

function child(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
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
