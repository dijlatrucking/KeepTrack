// Copies saved scans into Google Drive through the owner's Apps Script (drive/KeepTrackDrive.gs).
// Only the user's sign-in token and the document id are sent; the script reads the file from
// Firestore as that user, so the security rules decide what can be copied.
import { db, auth, doc, getDoc } from "./fb.js";
import { toast } from "./ui.js";

let urlPromise = null;
export function driveUrl() {
  if (!urlPromise) urlPromise = getDoc(doc(db, "settings", "app")).then((s) => (s.exists() ? s.data().driveUrl || "" : "")).catch(() => "");
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
  if (sent) toast(`Copied ${sent} file${sent === 1 ? "" : "s"} to Google Drive`, "ok");
  if (failed) toast(`Saved in KeepTrack, but ${failed} file${failed === 1 ? "" : "s"} didn't reach Google Drive. Open Documents and tap "To Drive" to retry.`, "bad");
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
