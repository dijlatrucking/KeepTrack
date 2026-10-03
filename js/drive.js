// Copies saved scans into Google Drive through the owner's Apps Script (drive/KeepTrackDrive.gs).
// Only the user's sign-in token and the document id are sent; the script reads the file from
// Firestore as that user, so the security rules decide what can be copied.
import { db, auth, doc, getDoc } from "./fb.js";
import { toast } from "./ui.js";

let urlPromise = null;
export function driveUrl() {
  // Remember the link once found; if Drive isn't connected yet, look again next time (the owner may connect it meanwhile).
  if (!urlPromise) urlPromise = getDoc(doc(db, "settings", "app")).then((s) => (s.exists() ? s.data().driveUrl || "" : "")).catch(() => "")
    .then((u) => { if (!u) urlPromise = null; return u; });
  return urlPromise;
}
export function forgetDriveUrl() { urlPromise = null; }

async function post(url, payload) {
  // text/plain keeps this a "simple" request, which Apps Script web apps accept from any site
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Google Drive refused the file");
  return j;
}

export async function pingDrive(url) {
  return post(url, { ping: true });
}

// One friendly toast per burst of uploads ("Copied 3 files to Google Drive").
let sent = 0, failed = 0, timer = null;
const report = () => {
  timer = null;
  if (sent) toast((n) => `Copied ${n} file${n === 1 ? "" : "s"} to Google Drive`, "ok", { key: "drive-ok", add: sent });
  if (failed) toast((n) => `Saved in KeepTrack, but ${n} file${n === 1 ? "" : "s"} didn't reach Google Drive. Open Documents and tap "To Drive" to retry.`, "bad", { key: "drive-bad", add: failed });
  sent = failed = 0;
};

export async function sendToDrive(docId, { quiet = false } = {}) {
  const url = await driveUrl();
  if (!url || !auth.currentUser) return null;
  try {
    const j = await post(url, { idToken: await auth.currentUser.getIdToken(), docId });
    sent++;
    return j;
  } catch (e) {
    console.warn("Drive copy failed", e);
    failed++;
    return null;
  } finally {
    if (!quiet) { clearTimeout(timer); timer = setTimeout(report, 1200); } else { sent = failed = 0; }
  }
}

// A rejected duplicate (or bad photo) is moved to the Drive trash too, so the folders stay clean.
// The script only does this for documents that really are marked rejected.
// A paper being deleted (by someone allowed to delete it) goes to the Drive trash the same way.
export async function removeFromDrive(docId, { deleting = false } = {}) {
  const url = await driveUrl();
  if (!url || !auth.currentUser) return null;
  try { return await post(url, { idToken: await auth.currentUser.getIdToken(), docId, remove: true, ...(deleting ? { deleting: true } : {}) }); }
  catch (e) { console.warn("Drive remove failed", e); return null; }
}

// Any Drive script call that needs the signed-in user (backup, verify, fetch).
export async function driveCall(payload) {
  const url = await driveUrl();
  if (!url) throw new Error("Connect Google Drive first (Settings → Google Drive).");
  if (!auth.currentUser) throw new Error("Sign in again.");
  return post(url, { ...payload, idToken: await auth.currentUser.getIdToken() });
}

// A scan whose space was freed lives only in Drive; the script checks this user may see it, then sends it back.
export async function fetchFromDrive(docId) {
  const url = await driveUrl();
  if (!url) throw new Error("This scan was moved to Google Drive, and Drive isn't connected right now.");
  return driveCall({ docId, fetch: true });
}
