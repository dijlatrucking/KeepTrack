/**
 * KeepTrack → Google Drive
 *
 * Paste this whole file into a new Apps Script project (script.google.com), then
 * Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone → Deploy.
 * Copy the Web app URL into KeepTrack → Settings → Google Drive.
 *
 * How it stays safe:
 *  - KeepTrack sends only the signed-in user's Firebase ID token and a document id. No file data.
 *  - This script checks the token with Firebase, then reads that document and its scan from Firestore
 *    *as that user*, so KeepTrack's security rules decide what they're allowed to send.
 *  - Files land in your Drive under KeepTrack/<Carrier>/...; nobody else gets Drive access.
 */

const FIREBASE_API_KEY = "AIzaSyAD09pk9OyApPn6f8OCiCFr-PpYT17sEHU";
const PROJECT_ID = "keeptrack-6426e";
const ROOT_FOLDER = "KeepTrack";

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    if (body.ping) return reply({ ok: true, ping: "pong", root: rootFolder().getUrl() });
    if (!body.idToken || !body.docId) return reply({ ok: false, error: "missing token or document" });

    // 1) Who is this? (rejects expired or fake tokens)
    const who = fetchJson("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_API_KEY,
      { method: "post", contentType: "application/json", payload: JSON.stringify({ idToken: body.idToken }) });
    if (!who || !who.users || !who.users.length) return reply({ ok: false, error: "not signed in" });

    // 2) Read the document + scan as that user. If the rules don't let them see it, we stop here.
    const meta = firestoreGet("documents/" + body.docId, body.idToken);
    if (!meta) return reply({ ok: false, error: "no access to that document" });
    const file = firestoreGet("docFiles/" + body.docId, body.idToken);
    if (!file || !file.data) return reply({ ok: false, error: "scan not found" });
    const carrier = firestoreGet("carriers/" + meta.carrierId, body.idToken) || {};

    // 3) Work out the folder (same place the file was first saved).
    const carrierName = clean(carrier.name || "Carrier " + String(meta.carrierId).slice(0, 6));
    const kind = String(meta.kind || meta.category || "Document");
    const isReceipt = /receipt|lumper|fuel|repair|toll|scale|expense/i.test(kind) || /receipt/i.test(String(meta.category || ""));
    const loadFolder = meta.loadLabel ? clean("Load " + meta.loadLabel) : "";
    let path;
    if (meta.uploaderRole === "driver") {
      const driver = clean(meta.uploaderName || "Driver");
      path = [carrierName, "Drivers", driver, isReceipt ? "Receipts" : (loadFolder || "Other")];
    } else if (loadFolder) {
      path = [carrierName, "Loads", loadFolder];
    } else if (isReceipt) {
      path = [carrierName, "Receipts"];
    } else {
      path = [carrierName, "Company", clean(meta.category || kind)];
    }
    const folder = path.reduce((f, name) => child(f, name), rootFolder());

    // 4) Save it once (the document id is in the file name, so a retry never makes a copy).
    const m = /^data:([^;]+);base64,(.*)$/.exec(file.data);
    if (!m) return reply({ ok: false, error: "unreadable scan" });
    const ext = m[1] === "application/pdf" ? ".pdf" : ".jpg";
    const name = clean(meta.name || kind) + " · " + body.docId.slice(0, 6) + ext;
    const existing = folder.getFilesByName(name);
    if (body.remove) {
      // Only documents that were actually rejected in KeepTrack get trashed.
      if (meta.status !== "rejected") return reply({ ok: false, error: "only rejected documents are removed" });
      let n = 0;
      while (existing.hasNext()) { existing.next().setTrashed(true); n++; }
      return reply({ ok: true, removed: n, folder: path.join(" / ") });
    }
    const saved = existing.hasNext() ? existing.next() : folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name));
    if (meta.note || meta.amount) saved.setDescription([meta.amount ? "$" + meta.amount : "", meta.note || ""].filter(String).join(" · "));
    return reply({ ok: true, url: saved.getUrl(), folder: path.join(" / ") });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return reply({ ok: true, service: "KeepTrack Drive", root: rootFolder().getUrl() });
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
