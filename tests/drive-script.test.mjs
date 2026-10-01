// Runs the real Google Drive Apps Script (drive/KeepTrackDrive.gs) against a fake Drive and
// Firestore, so where files go, what they're called, de-duplication, moving older copies, backups,
// "free up space" checks and opening moved scans are all checked without a Google account.
// Run: node drive-script.test.mjs
import { readFileSync, appendFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../drive/KeepTrackDrive.gs", import.meta.url), "utf8");

// ---------- fake Google Drive ----------
let nextId = 1;
const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
const files = new Map(), folders = new Map();
class FFolder {
  constructor(name, parent) { this.id = "fo" + nextId++; this.name = name; this.parent = parent; this.trashed = false; folders.set(this.id, this); }
  getId() { return this.id; } getName() { return this.name; } getUrl() { return "https://drive.test/folders/" + this.id; }
  isTrashed() { return this.trashed; } setTrashed(t) { this.trashed = t; return this; }
  getParents() { return iter(this.parent ? [this.parent] : []); }
  kids() { return [...folders.values()].filter((f) => f.parent === this); }
  docs() { return [...files.values()].filter((f) => f.parent === this); }
  getFoldersByName(n) { return iter(this.kids().filter((f) => f.name === n)); }
  getFilesByName(n) { return iter(this.docs().filter((f) => f.name === n)); }
  createFolder(n) { return new FFolder(n, this); }
  createFile(blob) { return new FFile(blob, this); }
  searchFiles(q) { return iter(this.docs().filter((f) => matches(f, q))); }
  searchFolders(q) { return iter(this.kids().filter((f) => matches(f, q))); }
}
class FFile {
  constructor(blob, parent) { this.id = "fi" + nextId++; this.name = blob.name; this.blob = blob; this.parent = parent; this.desc = ""; this.trashed = false; files.set(this.id, this); }
  getId() { return this.id; } getName() { return this.name; } setName(n) { this.name = n; return this; }
  getDescription() { return this.desc; } setDescription(d) { this.desc = d; return this; }
  isTrashed() { return this.trashed; } setTrashed(t) { this.trashed = t; return this; }
  getUrl() { return "https://drive.test/file/" + this.id; }
  getParents() { return iter([this.parent]); }
  moveTo(f) { this.parent = f; return this; }
  getBlob() { return this.blob; }
}
function matches(item, q) {
  if (/trashed = false/.test(q) && item.trashed) return false;
  const m = /fullText contains "([^"]+)"/.exec(q);
  if (m && !(`${item.name} ${item.desc || ""}`.includes(m[1]))) return false;
  return true;
}
const myDrive = new FFolder("My Drive", null);
const blobOf = (bytes, type, name) => ({ bytes: Buffer.from(bytes), type, name, setName(n) { this.name = n; return this; }, getContentType() { return this.type; }, getBytes() { return [...this.bytes]; } });
const DriveApp = {
  getFoldersByName: (n) => iter([...folders.values()].filter((f) => f.name === n)),
  createFolder: (n) => myDrive.createFolder(n),
  getFileById: (id) => { const f = files.get(id); if (!f) throw new Error("not found"); return f; },
  searchFiles: (q) => iter([...files.values()].filter((f) => matches(f, q))),
};

// ---------- fake Firebase (sign-in + Firestore REST, with simple access rules) ----------
const users = { "tok-owner": "owner1", "tok-driver": "drv1", "tok-disp": "disp1", "tok-stranger": "nobody" };
const db = {};
const put = (path, data) => { db[path] = data; };
const canRead = (uid, path) => uid !== "nobody" || path.startsWith("users/");
const toFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k,
  v === null ? { nullValue: null } : typeof v === "boolean" ? { booleanValue: v } : Number.isInteger(v) ? { integerValue: String(v) }
    : typeof v === "number" ? { doubleValue: v } : /^\d{4}-\d\d-\d\dT/.test(v) ? { timestampValue: v } : { stringValue: v }]));
const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
const UrlFetchApp = {
  fetch(url, opts) {
    if (url.includes("accounts:lookup")) {
      const uid = users[JSON.parse(opts.payload).idToken];
      return uid ? res(200, { users: [{ localId: uid }] }) : res(400, { error: "bad token" });
    }
    const path = url.split("/documents/")[1];
    const uid = users[(opts.headers.Authorization || "").replace("Bearer ", "")];
    if (!uid) return res(401, {});
    if (!canRead(uid, path)) return res(403, {});
    return db[path] ? res(200, { fields: toFields(db[path]) }) : res(404, {});
  },
};

const ctx = vm.createContext({
  DriveApp, UrlFetchApp,
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: {
    newBlob: (bytes, type, name) => blobOf(bytes, type, name),
    base64Decode: (s) => Buffer.from(s, "base64"),
    base64Encode: (b) => Buffer.from(b).toString("base64"),
    formatDate: (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d),
  },
  Session: { getScriptTimeZone: () => "America/Boise" },
  ContentService: { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: "json" } },
  JSON, Object, String, Number, Date, Error, Math, RegExp,
});
vm.runInContext(SRC, ctx);
const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).s);

// ---------- helpers ----------
const results = [];
function check(name, fn) {
  try { fn(); results.push({ ok: true, name }); console.log("PASS  " + name); }
  catch (e) { results.push({ ok: false, name, err: e.message }); console.log("FAIL  " + name + "\n      " + e.message); }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const pathOf = (f) => { const out = []; for (let p = f.parent; p && p !== myDrive; p = p.parent) out.unshift(p.name); return out.join(" / "); };
const fileFor = (id) => [...files.values()].find((f) => !f.trashed && f.desc.startsWith("KeepTrack " + id));
const JPG = "data:image/jpeg;base64," + Buffer.from("jpeg-bytes").toString("base64");
const PDF = "data:application/pdf;base64," + Buffer.from("%PDF-1.4").toString("base64");
function scan(id, meta, data = JPG) {
  put("documents/" + id, { carrierId: "A", createdAt: "2026-10-01T18:00:00Z", status: "pending", ...meta });
  if (data) put("docFiles/" + id, { carrierId: "A", data });
}

put("users/owner1", { role: "owner" });
put("users/drv1", { role: "driver", carrierId: "A" });
put("users/disp1", { role: "dispatcher" });
put("carriers/A", { name: "Test Carrier A" });
put("loads/L1", { carrierId: "A", loadNo: "4471823", pickupDate: "2026-10-01", origin: "Boise, ID", destination: "Denver, CO", createdAt: "2026-09-30T20:00:00Z" });
put("loads/L2", { carrierId: "A", pickupDate: "2026-11-03", origin: "Nampa, ID", destination: "Reno, NV" });

const LOAD = "KeepTrack / Test Carrier A / Loads / 2026-10 / Oct 01 · 4471823 · Boise ID → Denver CO";

check("A driver's BOL goes in its load's folder, named date · type · broker load #", () => {
  scan("docBOL1abcdefghijklm", { kind: "BOL", loadId: "L1", uploaderRole: "driver", uploaderName: "Drew Driver", name: "BOL · #L1" });
  const r = call({ idToken: "tok-driver", docId: "docBOL1abcdefghijklm" });
  eq(r.ok, true, "ok");
  const f = fileFor("docBOL1abcdefghijklm");
  eq(pathOf(f), LOAD, "folder");
  eq(f.name, "2026-10-01 · BOL · 4471823.jpg", "name");
  eq(r.fileId, f.id, "file id returned");
});

check("Sending the same document again doesn't make a second copy", () => {
  const before = files.size;
  call({ idToken: "tok-driver", docId: "docBOL1abcdefghijklm" });
  eq(files.size, before, "file count");
});

check("A second BOL the same day gets '(2)' instead of overwriting", () => {
  scan("docBOL2abcdefghijklm", { kind: "BOL", loadId: "L1", uploaderRole: "driver", uploaderName: "Drew Driver" });
  call({ idToken: "tok-driver", docId: "docBOL2abcdefghijklm" });
  eq(fileFor("docBOL2abcdefghijklm").name, "2026-10-01 · BOL · 4471823 (2).jpg", "name");
  eq(fileFor("docBOL1abcdefghijklm").name, "2026-10-01 · BOL · 4471823.jpg", "first one untouched");
});

check("Dispatch's rate con and the driver's lumper land in the same load folder", () => {
  scan("docRCabcdefghijklmno", { kind: "Rate con", loadId: "L1", uploaderRole: "dispatcher", uploaderName: "Dana", status: "approved" }, PDF);
  scan("docLUMPabcdefghijklm", { kind: "Lumper", loadId: "L1", uploaderRole: "driver", uploaderName: "Drew Driver", amount: 85, receiptType: "Lumper", category: "Receipts" });
  call({ idToken: "tok-disp", docId: "docRCabcdefghijklmno" });
  call({ idToken: "tok-driver", docId: "docLUMPabcdefghijklm" });
  const rc = fileFor("docRCabcdefghijklmno"), lu = fileFor("docLUMPabcdefghijklm");
  eq(pathOf(rc), LOAD, "rate con folder"); eq(rc.name, "2026-10-01 · Rate con · 4471823.pdf", "rate con name");
  eq(pathOf(lu), LOAD, "lumper folder"); eq(lu.name, "2026-10-01 · Lumper $85 · 4471823.jpg", "lumper name");
  if (!lu.desc.includes("$85")) throw new Error("amount missing from the file description");
});

check("A driver's fuel receipt with no load goes to Driver receipts / their name", () => {
  scan("docFUELabcdefghijklm", { kind: "Receipt", receiptType: "Fuel", amount: 412.5, category: "Receipts", uploaderRole: "driver", uploaderName: "Drew Driver", createdAt: "2026-10-02T15:00:00Z" });
  call({ idToken: "tok-driver", docId: "docFUELabcdefghijklm" });
  const f = fileFor("docFUELabcdefghijklm");
  eq(pathOf(f), "KeepTrack / Test Carrier A / Driver receipts / Drew Driver", "folder");
  eq(f.name, "2026-10-02 · Fuel $412.50.jpg", "name");
});

check("Company papers go to Company / category, keeping the name the carrier gave them", () => {
  scan("docINSabcdefghijklmn", { kind: "Insurance", category: "Insurance", name: "Insurance 2026", uploaderRole: "carrierAdmin", status: "filed" }, PDF);
  scan("docW9abcdefghijklmno", { kind: "W-9", category: "W-9", name: "W-9", uploaderRole: "owner", status: "approved" });
  call({ idToken: "tok-owner", docId: "docINSabcdefghijklmn" });
  call({ idToken: "tok-owner", docId: "docW9abcdefghijklmno" });
  eq(pathOf(fileFor("docINSabcdefghijklmn")), "KeepTrack / Test Carrier A / Company / Insurance", "folder");
  eq(fileFor("docINSabcdefghijklmn").name, "2026-10-01 · Insurance · Insurance 2026.pdf", "name with custom title");
  eq(fileFor("docW9abcdefghijklmno").name, "2026-10-01 · W-9.jpg", "plain name when nothing to add");
});

check("Multi-page scans are numbered 'p1 of 2', 'p2 of 2'", () => {
  scan("docPG1abcdefghijklmn", { kind: "POD", loadId: "L1", name: "POD · #L1 p1/2", uploaderRole: "dispatcher" });
  scan("docPG2abcdefghijklmn", { kind: "POD", loadId: "L1", name: "POD · #L1 p2/2", uploaderRole: "dispatcher" });
  call({ idToken: "tok-disp", docId: "docPG1abcdefghijklmn" });
  call({ idToken: "tok-disp", docId: "docPG2abcdefghijklmn" });
  eq(fileFor("docPG1abcdefghijklmn").name, "2026-10-01 · POD · 4471823 p1 of 2.jpg", "page 1");
  eq(fileFor("docPG2abcdefghijklmn").name, "2026-10-01 · POD · 4471823 p2 of 2.jpg", "page 2");
});

check("No broker load # yet: KeepTrack's own # is used", () => {
  scan("docNOLNabcdefghijklm", { kind: "BOL", loadId: "L2", uploaderRole: "dispatcher", createdAt: "2026-11-03T16:00:00Z" });
  call({ idToken: "tok-disp", docId: "docNOLNabcdefghijklm" });
  const f = fileFor("docNOLNabcdefghijklm");
  eq(pathOf(f), "KeepTrack / Test Carrier A / Loads / 2026-11 / Nov 03 · L2 · Nampa ID → Reno NV", "folder");
  eq(f.name, "2026-11-03 · BOL · L2.jpg", "name");
});

check("When the broker # is added later, the copy moves to the renamed load folder (no duplicate)", () => {
  const f = fileFor("docNOLNabcdefghijklm"), id = f.id, before = [...files.values()].filter((x) => !x.trashed).length;
  put("loads/L2", { ...db["loads/L2"], loadNo: "9917" });
  call({ idToken: "tok-disp", docId: "docNOLNabcdefghijklm" });
  const g = fileFor("docNOLNabcdefghijklm");
  eq(g.id, id, "same file");
  eq(pathOf(g), "KeepTrack / Test Carrier A / Loads / 2026-11 / Nov 03 · 9917 · Nampa ID → Reno NV", "new folder");
  eq(g.name, "2026-11-03 · BOL · 9917.jpg", "new name");
  eq([...files.values()].filter((x) => !x.trashed).length, before, "file count");
  const old = [...folders.values()].find((x) => x.name === "Nov 03 · L2 · Nampa ID → Reno NV");
  eq(old.trashed, true, "old empty load folder cleaned up");
});

check("Copies saved by the first version of the script are moved into the new layout", () => {
  const root = [...folders.values()].find((x) => x.name === "KeepTrack" && !x.trashed);
  const carrier = root.kids().find((x) => x.name === "Test Carrier A");
  const oldFolder = carrier.createFolder("Drivers").createFolder("Drew Driver").createFolder("Load #OLD123 Boise, ID → Denver, CO".replace(/#/g, " ").replace(/\s+/g, " "));
  const old = oldFolder.createFile(blobOf([1, 2, 3], "image/jpeg", "BOL · OLD123 · docOLD.jpg"));
  old.setDescription("$85"); // the very first version didn't mark files, so it's found by its old name and place
  scan("docOLDabcdefghijklm", { kind: "BOL", loadId: "L1", loadLabel: "#OLD123 Boise, ID → Denver, CO", name: "BOL · OLD123", uploaderRole: "driver", uploaderName: "Drew Driver" });
  call({ idToken: "tok-driver", docId: "docOLDabcdefghijklm" });
  const f = fileFor("docOLDabcdefghijklm");
  eq(f.id, old.id, "same file moved");
  eq(pathOf(f), LOAD, "new folder");
  eq(f.name, "2026-10-01 · BOL · 4471823 (3).jpg", "new name");
  eq(oldFolder.trashed, true, "old empty folder cleaned up");
  eq(carrier.trashed, false, "carrier folder kept");
});

check("Back up: owner only; confirms every scan in the batch without copying anything twice", () => {
  const denied = call({ idToken: "tok-disp", backup: "KeepTrack backup 2026-10-01 00.10", docIds: ["docBOL1abcdefghijklm"] });
  eq(denied.ok, false, "dispatcher refused");
  const ids = ["docBOL1abcdefghijklm", "docLUMPabcdefghijklm", "docFUELabcdefghijklm"];
  const before = files.size;
  const r = call({ idToken: "tok-owner", backup: "KeepTrack backup 2026-10-01 00.10", docIds: ids });
  eq(r.ok, true, "ok");
  eq(r.results.every((x) => x.ok && x.fileId), true, "every scan confirmed");
  eq(files.size, before, "nothing new (scans were already in Drive)");
  eq(r.results[1].load, "4471823 · Boise ID → Denver CO", "load title for the report");
});

check("The backup report PDF is saved in KeepTrack / Backups (owner only, PDFs only)", () => {
  const pdf = Buffer.from("%PDF-1.3 backup report").toString("base64");
  eq(call({ idToken: "tok-disp", savePdf: "KeepTrack backup 2026-10-01 00.10", data: pdf }).ok, false, "dispatcher refused");
  eq(call({ idToken: "tok-owner", savePdf: "Sneaky", data: Buffer.from("<script>").toString("base64") }).ok, false, "non-PDF refused");
  const r = call({ idToken: "tok-owner", savePdf: "KeepTrack backup 2026-10-01 00.10", data: pdf });
  eq(r.ok, true, "saved");
  const f = files.get(r.fileId);
  eq(pathOf(f), "KeepTrack / Backups", "folder");
  eq(f.name, "KeepTrack backup 2026-10-01 00.10.pdf", "name");
  eq(f.blob.type, "application/pdf", "type");
  const again = call({ idToken: "tok-owner", savePdf: "KeepTrack backup 2026-10-01 00.10", data: pdf });
  eq(f.trashed, true, "a re-run in the same minute replaces the report");
  eq(files.get(again.fileId).trashed, false, "new report kept");
});

check("Verify only confirms copies that are really there and really this document's", () => {
  put("documents/docBOL1abcdefghijklm", { ...db["documents/docBOL1abcdefghijklm"], driveFileId: fileFor("docBOL1abcdefghijklm").id });
  put("documents/docFUELabcdefghijklm", { ...db["documents/docFUELabcdefghijklm"], driveFileId: fileFor("docBOL1abcdefghijklm").id }); // points at someone else's file
  const r = call({ idToken: "tok-owner", verify: true, docIds: ["docBOL1abcdefghijklm", "docFUELabcdefghijklm"] });
  eq(r.results[0].ok, true, "real copy");
  eq(r.results[1].ok, false, "wrong file refused");
  put("documents/docFUELabcdefghijklm", { ...db["documents/docFUELabcdefghijklm"], driveFileId: fileFor("docFUELabcdefghijklm").id });
});

check("After space is freed, the scan opens from Drive, and a forged file id can't open another paper", () => {
  delete db["docFiles/docBOL1abcdefghijklm"];
  const r = call({ idToken: "tok-driver", docId: "docBOL1abcdefghijklm", fetch: true });
  eq(r.ok, true, "fetched");
  eq(r.data, "data:image/jpeg;base64," + Buffer.from("jpeg-bytes").toString("base64"), "same bytes");
  put("documents/docW9abcdefghijklmno", { ...db["documents/docW9abcdefghijklmno"], driveFileId: fileFor("docINSabcdefghijklmn").id });
  delete db["docFiles/docW9abcdefghijklmno"];
  eq(call({ idToken: "tok-owner", docId: "docW9abcdefghijklmno", fetch: true }).ok, false, "forged id refused");
  eq(call({ idToken: "tok-stranger", docId: "docBOL1abcdefghijklm", fetch: true }).ok, false, "no access, no scan");
});

check("Backing up a freed scan still works (it's already in Drive) and doesn't duplicate it", () => {
  const before = files.size;
  const r = call({ idToken: "tok-owner", backup: "KeepTrack backup 2026-10-02 08.00", docIds: ["docBOL1abcdefghijklm"] });
  eq(r.results[0].ok, true, "ok");
  eq(files.size, before, "no new copy");
});

check("A rejected duplicate is trashed in Drive; non-rejected papers can't be removed", () => {
  eq(call({ idToken: "tok-owner", docId: "docBOL2abcdefghijklm", remove: true }).ok, false, "pending paper kept");
  put("documents/docBOL2abcdefghijklm", { ...db["documents/docBOL2abcdefghijklm"], status: "rejected" });
  const r = call({ idToken: "tok-owner", docId: "docBOL2abcdefghijklm", remove: true });
  eq(r.removed, 1, "removed");
  eq(fileFor("docBOL2abcdefghijklm"), undefined, "trashed");
  eq(fileFor("docBOL1abcdefghijklm") !== undefined, true, "the real BOL stays");
});

check("A freed scan with no copy in Drive reports 'not found' and leaves no empty folders behind", () => {
  scan("docGONEabcdefghijklm", { kind: "BOL", loadId: "L2", uploaderRole: "dispatcher", createdAt: "2026-12-05T16:00:00Z" }, null);
  put("loads/L2", { ...db["loads/L2"], pickupDate: "2026-12-05" });
  const before = folders.size;
  eq(call({ idToken: "tok-owner", backup: "KeepTrack backup 2026-12-05", docIds: ["docGONEabcdefghijklm"] }).results[0].ok, false, "not found");
  eq([...folders.values()].some((f) => f.name === "2026-12"), false, "no empty month folder made");
  if (folders.size > before + 0 && [...folders.values()].some((f) => f.name.startsWith("Dec 05"))) throw new Error("empty load folder made");
});

check("Deleting a paper trashes its Drive copy, but only for people allowed to delete it", () => {
  put("users/admA", { role: "carrierAdmin", carrierId: "A" });
  put("users/admB", { role: "carrierAdmin", carrierId: "B" });
  users["tok-adminA"] = "admA"; users["tok-adminB"] = "admB";
  // an approved rate con: dispatch and another carrier's admin can't; this carrier's admin can
  eq(call({ idToken: "tok-disp", docId: "docRCabcdefghijklmno", remove: true, deleting: true }).ok, false, "dispatcher refused");
  eq(call({ idToken: "tok-adminB", docId: "docRCabcdefghijklmno", remove: true, deleting: true }).ok, false, "other carrier refused");
  const r = call({ idToken: "tok-adminA", docId: "docRCabcdefghijklmno", remove: true, deleting: true });
  eq(r.ok, true, "carrier admin allowed");
  eq(fileFor("docRCabcdefghijklmno"), undefined, "rate con copy trashed");
  // a driver can take back their own paper only while it's waiting for review
  put("documents/docLUMPabcdefghijklm", { ...db["documents/docLUMPabcdefghijklm"], uploadedBy: "drv1" });
  put("documents/docFUELabcdefghijklm", { ...db["documents/docFUELabcdefghijklm"], uploadedBy: "drv1" });
  eq(call({ idToken: "tok-disp", docId: "docLUMPabcdefghijklm", remove: true, deleting: true }).ok, false, "someone else's pending paper refused");
  eq(call({ idToken: "tok-driver", docId: "docLUMPabcdefghijklm", remove: true, deleting: true }).ok, true, "own pending lumper");
  put("documents/docFUELabcdefghijklm", { ...db["documents/docFUELabcdefghijklm"], status: "approved" });
  eq(call({ idToken: "tok-driver", docId: "docFUELabcdefghijklm", remove: true, deleting: true }).ok, false, "approved receipt refused");
  eq(fileFor("docFUELabcdefghijklm") !== undefined, true, "approved receipt kept");
  // the owner can delete anything
  eq(call({ idToken: "tok-owner", docId: "docFUELabcdefghijklm", remove: true, deleting: true }).ok, true, "owner");
  // without "deleting", only rejected papers are removed (unchanged)
  eq(call({ idToken: "tok-owner", docId: "docINSabcdefghijklmn", remove: true }).ok, false, "plain remove still needs rejected");
});

check("Bad sign-ins are refused", () => {
  eq(call({ idToken: "forged", docId: "docBOL1abcdefghijklm" }).ok, false, "forged token");
  eq(call({ docId: "docBOL1abcdefghijklm" }).ok, false, "no token");
});

// ---------- Stress: a busy month of paperwork ----------
check("Stress: 750 papers across 30 loads, drivers and company files each land in exactly one place", () => {
  const t0 = Date.now();
  const kinds = ["BOL", "POD", "Rate con", "Lumper", "Receipt"];
  for (let l = 0; l < 30; l++) put(`loads/SL${l}`, { carrierId: "A", loadNo: `S${1000 + l}`, pickupDate: `2026-${l < 15 ? "10" : "11"}-${String((l % 28) + 1).padStart(2, "0")}`, origin: `City ${l}, ID`, destination: `Town ${l}, UT` });
  const ids = [];
  for (let i = 0; i < 600; i++) {
    const id = `stressLoadPaper${String(i).padStart(4, "0")}`;
    const kind = kinds[i % 5];
    scan(id, { kind, loadId: `SL${i % 30}`, uploaderRole: i % 2 ? "driver" : "dispatcher", uploaderName: `Driver ${i % 7}`, uploadedBy: "drv1", amount: kind === "Lumper" || kind === "Receipt" ? 50 + (i % 40) : null, receiptType: kind === "Receipt" ? "Fuel" : null, createdAt: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T18:00:00Z` });
    ids.push(id);
  }
  for (let i = 0; i < 100; i++) { const id = `stressReceipt${String(i).padStart(4, "0")}`; scan(id, { kind: "Receipt", receiptType: "Tolls", amount: 5 + i, category: "Receipts", uploaderRole: "driver", uploaderName: `Driver ${i % 7}`, uploadedBy: "drv1" }); ids.push(id); }
  for (let i = 0; i < 50; i++) { const id = `stressCompany${String(i).padStart(4, "0")}`; scan(id, { kind: "Insurance", category: "Insurance", name: `Policy ${i}`, uploaderRole: "carrierAdmin", status: "filed" }, PDF); ids.push(id); }
  for (const id of ids) { const r = call({ idToken: "tok-owner", docId: id }); if (!r.ok) throw new Error(id + ": " + r.error); }
  const live = [...files.values()].filter((f) => !f.trashed && f.desc.startsWith("KeepTrack stress"));
  eq(live.length, 750, "one copy per paper");
  const places = new Set(live.map((f) => pathOf(f) + " / " + f.name));
  eq(places.size, 750, "no two files share a folder and name");
  for (const id of ids) eq(live.filter((f) => f.desc.startsWith("KeepTrack " + id)).length, 1, "copies of " + id);
  const loadFolders = [...folders.values()].filter((f) => !f.trashed && /· S1\d{3} ·/.test(f.name));
  eq(loadFolders.length, 30, "one folder per load");
  console.log(`      750 papers filed in ${Date.now() - t0} ms`);
});

check("Stress: 10 loads get new broker numbers; their 200 papers move, nothing is duplicated, old folders are cleaned up", () => {
  const t0 = Date.now();
  for (let l = 0; l < 10; l++) put(`loads/SL${l}`, { ...db[`loads/SL${l}`], loadNo: `NEW${l}` });
  const moved = Object.keys(db).filter((k) => k.startsWith("documents/stressLoadPaper") && /^SL\d$/.test(db[k].loadId)).map((k) => k.slice(10));
  eq(moved.length, 200, "papers on renamed loads");
  for (const id of moved) call({ idToken: "tok-owner", docId: id });
  const live = [...files.values()].filter((f) => !f.trashed && f.desc.startsWith("KeepTrack stress"));
  eq(live.length, 750, "still one copy per paper");
  for (const id of moved) { const f = fileFor(id); if (!/· NEW\d ·/.test(f.parent.name)) throw new Error(id + " not moved: " + pathOf(f)); if (!/· NEW\d(\.| \()/.test(f.name)) throw new Error(id + " not renamed: " + f.name); }
  const stale = [...folders.values()].filter((f) => !f.trashed && /· S100\d ·/.test(f.name));
  eq(stale.length, 0, "old load folders cleaned up");
  console.log(`      200 papers re-filed in ${Date.now() - t0} ms`);
});

check("Stress: 60 papers with the same name never collide (and never error)", () => {
  put("loads/SAME", { carrierId: "A", loadNo: "SAME1", pickupDate: "2026-12-01", origin: "A, ID", destination: "B, UT" });
  for (let i = 0; i < 60; i++) scan(`samePaper${String(i).padStart(3, "0")}xxxxxxxx`, { kind: "BOL", loadId: "SAME", uploaderRole: "dispatcher", createdAt: "2026-12-01T18:00:00Z" });
  for (let i = 0; i < 60; i++) { const r = call({ idToken: "tok-owner", docId: `samePaper${String(i).padStart(3, "0")}xxxxxxxx` }); if (!r.ok) throw new Error(r.error); }
  const names = [...files.values()].filter((f) => !f.trashed && f.desc.startsWith("KeepTrack samePaper")).map((f) => f.name);
  eq(names.length, 60, "60 copies");
  eq(new Set(names).size, 60, "60 different names");
  for (let i = 0; i < 60; i++) call({ idToken: "tok-owner", docId: `samePaper${String(i).padStart(3, "0")}xxxxxxxx` });
  const again = [...files.values()].filter((f) => !f.trashed && f.desc.startsWith("KeepTrack samePaper")).map((f) => f.name);
  eq(again.length, 60, "sending them all again makes no extra copies");
  eq(again.sort().join("|"), names.sort().join("|"), "and doesn't rename anything");
});

check("Stress: deleting 375 papers trashes exactly their copies and leaves the rest alone", () => {
  const t0 = Date.now();
  const all = Object.keys(db).filter((k) => k.startsWith("documents/stress")).map((k) => k.slice(10)).sort();
  const gone = all.filter((_, i) => i % 2 === 0);
  for (const id of gone) {
    const r = call({ idToken: "tok-owner", docId: id, remove: true, deleting: true });
    if (!r.ok || r.removed !== 1) throw new Error(`${id}: ${JSON.stringify(r)}`);
    delete db["documents/" + id]; delete db["docFiles/" + id];
  }
  const live = [...files.values()].filter((f) => !f.trashed && f.desc.startsWith("KeepTrack stress"));
  eq(live.length, all.length - gone.length, "remaining copies");
  for (const id of gone) if (fileFor(id)) throw new Error(id + " still in Drive");
  const emptyAlive = [...folders.values()].filter((f) => !f.trashed && f.parent && f.parent.name !== "My Drive" && f.parent.parent && f.parent.parent.name === "KeepTrack" ? false : !f.trashed && f.kids().filter((k) => !k.trashed).length === 0 && f.docs().filter((d) => !d.trashed).length === 0 && f.name !== "KeepTrack" && f.name !== "My Drive" && f.parent && f.parent.name !== "KeepTrack");
  eq(emptyAlive.length, 0, "no empty folders left behind: " + emptyAlive.map((f) => f.name).join(", "));
  console.log(`      375 deletes in ${Date.now() - t0} ms`);
});

check("Stress: after freeing space, 100 scans still open from Drive byte-for-byte", () => {
  const left = Object.keys(db).filter((k) => k.startsWith("documents/stress")).map((k) => k.slice(10)).slice(0, 100);
  for (const id of left) {
    const before = db["docFiles/" + id].data;
    put("documents/" + id, { ...db["documents/" + id], driveFileId: fileFor(id).id, fileFreed: true });
    delete db["docFiles/" + id];
    const r = call({ idToken: "tok-owner", docId: id, fetch: true });
    if (!r.ok || r.data !== before) throw new Error(id + " didn't come back intact");
  }
});

check("The script has nothing a phone paste would mangle (no /* comments)", () => {
  if (SRC.includes("/*")) throw new Error("Use // comments only: phone keyboards paste by typing, and the editor auto-closes /** with a stray */");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} Drive script checks passed`);
console.log(`::notice title=Drive script::${results.length - failed.length}/${results.length} Drive script checks passed`);
for (const f of failed) console.log(`::error title=Drive script::${f.name}: ${f.err}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Drive script: ${results.length - failed.length}/${results.length} passed\n\n`);
process.exit(failed.length ? 1 : 0);
