// End-to-end + volume stress test. Drives the real app in headless Chromium against local emulators,
// playing owner, carrier admin, dispatcher and driver at the same time.
// Run:  npx firebase emulators:exec --only firestore,auth --project demo-keeptrack "node e2e.mjs"
import { chromium } from "playwright";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, writeBatch, collection, getDocs } from "firebase/firestore";
import { PNG } from "pngjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { spawn } from "node:child_process";
import http from "node:http";
import { cpSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = fileURLToPath(new URL("./.site", import.meta.url));
const OUT = fileURLToPath(new URL("./out", import.meta.url));
const PROJECT = "demo-keeptrack";
const PORT = 5055;
const BASE = `http://localhost:${PORT}/index.html`;

// ---------- Serve a copy of the site wired to the emulators ----------
rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });
mkdirSync(OUT, { recursive: true });
for (const p of ["index.html", "manifest.webmanifest", "css", "js", "img"]) cpSync(ROOT + p, SITE + "/" + p, { recursive: true });
const cfgPath = SITE + "/js/firebase-config.js";
writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(/projectId: "[^"]+"/, `projectId: "${PROJECT}"`));
const fbPath = SITE + "/js/fb.js";
writeFileSync(fbPath, readFileSync(fbPath, "utf8") + `
import { connectAuthEmulator as __cae } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { connectFirestoreEmulator as __cfe } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
__cae(auth, "http://127.0.0.1:9099", { disableWarnings: true });
authHooks.push((a) => __cae(a, "http://127.0.0.1:9099", { disableWarnings: true }));
__cfe(db, "127.0.0.1", 8080);
`);
const server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", SITE], { stdio: "ignore" });

// A stand-in for the Google Drive Apps Script: it does exactly what the real script does to decide
// access (checks the Firebase token, then reads the document, its scan and the carrier AS THAT USER),
// and records where the file would be filed.
const driveCalls = [];
const DRIVE_PORT = 5066;
const fsGet = async (path, token) => {
  const r = await fetch(`http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) return null;
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, Object.values(v)[0]]));
};
// It also keeps the "Drive" in memory so backups, "free up space" checks and opening a freed scan
// behave like the real thing.
const driveFiles = new Map(); // fileId -> { id, docId, data, desc, trashed }
const backupPdfs = []; // { name, text } for each backup report saved
const existingCopy = (docId, meta) => {
  const f = meta && meta.driveFileId && driveFiles.get(meta.driveFileId);
  return f && !f.trashed && f.desc.startsWith("KeepTrack " + docId) ? f : null;
};
const copyOne = async (docId, token) => {
  const meta = await fsGet("documents/" + docId, token);
  const carrier = meta && (await fsGet("carriers/" + meta.carrierId, token));
  if (!meta || !carrier) return { out: { docId, ok: false, error: "no access" } };
  const file = await fsGet("docFiles/" + docId, token);
  let f;
  if (!file || !file.data) {
    f = existingCopy(docId, meta);
    if (!f) return { out: { docId, ok: false, error: "scan not found" }, meta, carrier };
  } else {
    f = [...driveFiles.values()].find((x) => x.docId === docId && !x.trashed);
    if (!f) { f = { id: "file_" + docId, docId, data: file.data, desc: "KeepTrack " + docId, trashed: false }; driveFiles.set(f.id, f); }
  }
  const folder = `${carrier.name} / ${meta.uploaderRole === "driver" ? "Drivers / " + meta.uploaderName : "Loads"}`;
  return { out: { docId, ok: true, fileId: f.id, url: "https://drive.test/" + f.id, folder, size: file && file.data ? file.data.length : 0 }, meta, carrier };
};
const driveServer = http.createServer(async (req, res) => {
  const send = (o) => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(o)); };
  if (req.method !== "POST") return send({ ok: true });
  let body = ""; for await (const c of req) body += c;
  const b = JSON.parse(body || "{}");
  if (b.ping) return send({ ok: true, ping: "pong" });
  const who = await (await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:lookup?key=fake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: b.idToken }) })).json();
  if (!who.users) { driveCalls.push({ docId: b.docId, ok: false, why: "token" }); return send({ ok: false, error: "not signed in" }); }
  const uid = who.users[0].localId;
  // password resets: same owner check as the real script, then the emulator's admin API (as the real one uses Google's)
  if (b.resetPassword || b.checkAdmin) {
    const me = await fsGet("users/" + uid, b.idToken);
    if (!me || me.role !== "owner") { driveCalls.push({ ok: false, why: "not owner", reset: true }); return send({ ok: false, error: "only the owner can do that" }); }
    const admin = (method, payload) => fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/${method}`, {
      method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer owner" }, body: JSON.stringify(payload) });
    if (b.checkAdmin) { const r = await admin("accounts:lookup", { localId: [uid] }); return send(r.ok ? { ok: true, account: "test-owner@gmail.com" } : { ok: false, error: "admin check failed" }); }
    const t = b.resetPassword || {};
    if (!t.uid || String(t.password || "").length < 6) return send({ ok: false, error: "The new password needs at least 6 characters." });
    if (!(await fsGet("users/" + t.uid, b.idToken))) return send({ ok: false, error: "That person isn't a KeepTrack account." });
    const r = await admin("accounts:update", { localId: t.uid, password: t.password });
    driveCalls.push({ ok: r.ok, reset: t.uid });
    return send(r.ok ? { ok: true } : { ok: false, error: "reset failed " + r.status });
  }
  if (b.backup || b.verify || b.savePdf) {
    const me = await fsGet("users/" + uid, b.idToken);
    if (!me || me.role !== "owner") { driveCalls.push({ ok: false, why: "not owner", backup: !!b.backup }); return send({ ok: false, error: "only the owner can do that" }); }
    if (b.savePdf) {
      const bytes = Buffer.from(String(b.data || ""), "base64");
      if (bytes.subarray(0, 4).toString() !== "%PDF") return send({ ok: false, error: "only PDF reports can be saved" });
      backupPdfs.push({ name: b.savePdf, text: bytes.toString("latin1") });
      return send({ ok: true, url: "https://drive.test/report/" + backupPdfs.length });
    }
    const ids = (b.docIds || []).slice(0, 25);
    if (b.verify) {
      const results = [];
      for (const id of ids) results.push({ docId: id, ok: !!existingCopy(id, await fsGet("documents/" + id, b.idToken)) });
      return send({ ok: true, results });
    }
    const results = [];
    for (const id of ids) results.push((await copyOne(id, b.idToken)).out);
    return send({ ok: true, results });
  }
  if (b.fetch) {
    const meta = await fsGet("documents/" + b.docId, b.idToken);
    if (!meta) { driveCalls.push({ docId: b.docId, ok: false, fetch: true }); return send({ ok: false, error: "no access to that document" }); }
    const file = await fsGet("docFiles/" + b.docId, b.idToken);
    const f = file && file.data ? { data: file.data } : existingCopy(b.docId, meta);
    driveCalls.push({ docId: b.docId, ok: !!f, fetch: true });
    return send(f ? { ok: true, data: f.data } : { ok: false, error: "not in Drive" });
  }
  if (b.remove) {
    const meta = await fsGet("documents/" + b.docId, b.idToken);
    if (!meta) return send({ ok: false, error: "no access to that document" });
    if (meta.status !== "rejected") {
      if (!b.deleting) return send({ ok: false, error: "only rejected documents are removed" });
      const me = (await fsGet("users/" + uid, b.idToken)) || {};
      const may = me.role === "owner" || (me.role === "carrierAdmin" && me.carrierId === meta.carrierId)
        || (me.role === "driver" && me.carrierId === meta.carrierId && meta.uploadedBy === uid && meta.status === "pending");
      if (!may) { driveCalls.push({ docId: b.docId, ok: false, deleting: true }); return send({ ok: false, error: "you can't delete that paper" }); }
    }
    let n = 0;
    driveFiles.forEach((f) => { if (f.docId === b.docId && !f.trashed) { f.trashed = true; n++; } });
    driveCalls.push({ docId: b.docId, ok: true, removed: n, deleting: !!b.deleting });
    return send({ ok: true, removed: n });
  }
  const r = await copyOne(b.docId, b.idToken);
  driveCalls.push({ docId: b.docId, ok: r.out.ok, role: r.meta && r.meta.uploaderRole, kind: r.meta && r.meta.kind, carrier: r.carrier && r.carrier.name, driver: r.meta && r.meta.uploaderName });
  send(r.out.ok ? r.out : { ok: false, error: r.out.error });
});
await new Promise((r) => driveServer.listen(DRIVE_PORT, "127.0.0.1", r));
await new Promise((r) => setTimeout(r, 1200));

const env = await initializeTestEnvironment({
  projectId: PROJECT,
  firestore: { rules: readFileSync(ROOT + "firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
});
await env.clearFirestore();
await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });

async function authUser(email, password) {
  const r = await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  return (await r.json()).localId;
}
const seed = (fn) => env.withSecurityRulesDisabled((c) => fn(c.firestore()));
const adminDocs = async (coll) => { let out = []; await seed(async (db) => { out = (await getDocs(collection(db, coll))).docs.map((d) => ({ id: d.id, ...d.data() })); }); return out; };

const ownerUid = await authUser("owner@test.dev", "owner-pass-1");
await seed((db) => setDoc(doc(db, "users", ownerUid), { role: "owner", name: "Test Owner", email: "owner@test.dev" }));

// ---------- Harness ----------
const results = [];
const problems = [];
const expectAuthFail = new Set(); // pages where a refused sign-in is the point of the step
const timings = [];
let step = 0;
async function run(name, fn) {
  step++;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ ok: true, name, ms: Date.now() - t0 });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ ok: false, name, err: String(e.message || e).split("\n")[0].slice(0, 220) });
    console.log(`FAIL  ${name}\n      ${String(e.message || e).split("\n").slice(0, 4).join("\n      ")}`);
    for (const [who, p] of Object.entries(pages)) {
      try { await p.screenshot({ path: `${OUT}/fail-${step}-${who}.png`, fullPage: true }); } catch (_) {}
    }
    const seen = pages[name.split(" ")[0].toLowerCase()];
    if (seen) { try { console.log("      on screen: " + (await seen.locator("#content").innerText()).replace(/\s+/g, " ").slice(0, 600)); } catch (_) {} }
  }
}

const browser = await chromium.launch();
const pages = {};
async function open(who, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  p.on("pageerror", (e) => problems.push(`[${who}] page error: ${e.message}`));
  p.on("console", (m) => {
    // people who are supposed to be turned away get 400/403 answers from sign-in; that's the point
    const expected = (["intruder", "denied", "copycat", "nina"].includes(who) || expectAuthFail.has(who)) && /status of 40[03]/.test(m.text());
    if (m.type() === "error" && !expected && !/favicon|ERR_FAILED.*fonts/.test(m.text())) problems.push(`[${who}] console: ${m.text().slice(0, 200)}`);
    if (/^\[dupe\]/.test(m.text())) console.log(`      [${who}] ${m.text().slice(0, 200)}`);
  });
  pages[who] = p;
  await p.goto(BASE);
  return p;
}
const toast = (p, text) => p.locator(".toast", { hasText: text }).first().waitFor();
const waitFor = async (fn, what, ms = 15000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error(what); await new Promise((r) => setTimeout(r, 200)); } };
// The backup report: always the one "KeepTrack backup report", replaced each time it's made.
const lastReport = () => (backupPdfs.length ? backupPdfs[backupPdfs.length - 1].text : "");
// What it should say: every paper with a copy in Drive (not rejected, not cleared, not missing).
const inDriveNow = async () => (await adminDocs("documents")).filter((d) => d.driveFileId && d.status !== "rejected" && !d.fileCleared && !d.driveMissing).length;
const reportSays = (n) => lastReport().includes(n ? `${n} scan${n === 1 ? "" : "s"} backed up in Google Drive` : "Nothing from KeepTrack is backed up in Google Drive right now");
const heading = (p, name) => p.getByRole("heading", { name, exact: true }).first().waitFor();
// Opens a page by its name: a main-menu section, or a tab inside one (open the section, then the tab).
const nav = async (p, label) => {
  const where = await p.evaluate((label) => {
    const links = [...document.querySelectorAll("nav.site-nav a")];
    const sec = links.find((a) => (a.dataset.pages || "").split("|").includes(label)) || links.find((a) => a.textContent.trim() === label);
    return sec ? { section: sec.textContent.trim(), tabbed: (sec.dataset.pages || "").split("|").length > 1, here: sec.classList.contains("on") } : null;
  }, label);
  if (!where) throw new Error(`No page called "${label}" in the menu`);
  // The page redraws on the hashchange that follows a click; wait for it so nothing is typed into the old page.
  const go = async (link) => {
    const href = await link.getAttribute("href");
    const changes = await p.evaluate((h) => location.hash !== h, href);
    if (changes) await p.evaluate(() => document.querySelector("#content .view")?.setAttribute("data-old", "1"));
    await link.click();
    if (changes) await p.waitForFunction(() => !document.querySelector("#content .view[data-old]"));
  };
  if (!(where.here && where.tabbed)) {
    const menu = p.locator(".menu-btn");
    if (await menu.isVisible()) { if ((await menu.getAttribute("aria-expanded")) !== "true") await menu.click(); }
    await go(p.locator("nav.site-nav").getByRole("link", { name: where.section, exact: true }));
    // like a person would: let the section's first page settle before switching tabs (leaving it the
    // instant it opened can make the database connection log a harmless error)
    if (where.tabbed && (await p.locator(".page-tabs a.on").innerText()) !== label) await p.waitForTimeout(400);
  }
  if (where.tabbed) await go(p.locator(".page-tabs").getByRole("link", { name: label, exact: true }));
};
const overflow = async (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const home = async (p) => { await p.evaluate(() => history.replaceState(null, "", location.pathname)); await p.reload(); };
async function pdfOpens(p) {
  const [popup] = await Promise.all([p.waitForEvent("popup", { timeout: 30000 }), p.getByRole("button", { name: "View PDF" }).click()]);
  await p.waitForFunction(() => !!window.jspdf, null, { timeout: 30000 });
  await popup.close().catch(() => {});
  const toasts = await p.locator(".toast-bad").allInnerTexts();
  if (toasts.some((t) => /PDF/.test(t))) throw new Error("PDF failed: " + toasts.join(" | "));
}
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

function noisyPng(w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    png.data[i] = v; png.data[i + 1] = (v + 40) & 255; png.data[i + 2] = (v * 3) & 255; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
// A real text PDF (what brokers email), for the rate con and receipt readers.
async function textPdf(lines) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => page.drawText(l, { x: 40, y: 750 - i * 18, size: 11, font }));
  return Buffer.from(await pdf.save());
}
const SAME_BOL = noisyPng(2400, 3200);
const tinyPdf = Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");

// ---------- 1. Owner signs in ----------
let owner, carrier, dispatcher, driver, driverCode;
await run("Owner signs in and lands on Overview", async () => {
  owner = await open("owner");
  await owner.getByLabel("Username").fill("owner@test.dev"); // older email accounts still sign in
  await owner.getByLabel("Password").fill("owner-pass-1");
  await owner.getByRole("button", { name: "Sign in" }).click();
  await heading(owner, "Overview");
});

await run("The KeepTrack logo shows in the header, and the tab icon, home-screen icons and manifest all load", async () => {
  const logo = owner.locator("header img.brand-logo");
  await logo.waitFor();
  if (!(await logo.evaluate((img) => img.complete && img.naturalWidth > 0))) throw new Error("Header logo didn't load");
  if ((await logo.getAttribute("alt")) !== "KeepTrack") throw new Error("Logo needs alt text");
  const bad = await owner.evaluate(async () => {
    const hrefs = [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')].map((l) => l.href);
    const m = await (await fetch(document.querySelector('link[rel="manifest"]').href)).json();
    hrefs.push(...m.icons.map((i) => new URL(i.src, document.querySelector('link[rel="manifest"]').href).href), new URL("img/keeptrack-logo-white.svg", location.href).href);
    const out = [];
    for (const h of hrefs) { const r = await fetch(h); if (!r.ok) out.push(h + " " + r.status); }
    return hrefs.length < 9 ? ["only " + hrefs.length + " icon links"] : out;
  });
  if (bad.length) throw new Error("Missing: " + bad.join(", "));
});

// ---------- 2. Carrier requests access, owner approves ----------
await run("Carrier requests access and sees the waiting screen", async () => {
  carrier = await open("carrier");
  await carrier.getByRole("tab", { name: "Request access" }).click();
  await carrier.getByLabel("Company name").fill("Test Carrier A");
  await carrier.getByLabel("MC #").fill("123456");
  await carrier.getByLabel("DOT #").fill("7654321");
  await carrier.getByLabel("Full name").fill("Carla Carrier");
  await carrier.getByLabel("Phone").fill("2085550100");
  await carrier.getByLabel("Pick a username").fill("carla.carrier");
  await carrier.getByLabel("Password").fill("carrier-pass-1");
  await carrier.getByRole("button", { name: "Request access" }).click();
  await heading(carrier, "Request received");
});

await run("Owner sees the request live on Overview and approves it with an 8% fee", async () => {
  const row = owner.locator(".row", { hasText: "Test Carrier A" }).first();
  await row.waitFor();
  await row.getByLabel("Dispatch fee %").fill("8");
  await row.getByRole("button", { name: "Approve carrier" }).click();
  await toast(owner, "Approved");
});

await run("Carrier's waiting screen opens into the carrier dashboard by itself", async () => {
  await heading(carrier, "Summary");
  await carrier.locator(".eyebrow", { hasText: "Test Carrier A" }).waitFor();
});

// ---------- 3. Dispatcher requests access, owner approves + assigns ----------
await run("Dispatcher requests access", async () => {
  dispatcher = await open("dispatcher");
  await dispatcher.getByRole("tab", { name: "Request access" }).click();
  await dispatcher.getByLabel("I'm signing up as").selectOption("dispatcher");
  await dispatcher.getByLabel("Full name").fill("Dana Dispatch");
  await dispatcher.getByLabel("Phone").fill("2085550101");
  await dispatcher.getByLabel("Pick a username").fill("dana.dispatch");
  await dispatcher.getByLabel("Password").fill("dispatch-pass-1");
  await dispatcher.getByRole("button", { name: "Request access" }).click();
  await heading(dispatcher, "Request received");
});

await run("Owner approves the dispatcher and gives them Test Carrier A", async () => {
  await nav(owner, "Access requests");
  const row = owner.locator(".row", { hasText: "Dana Dispatch" }).first();
  await row.getByRole("button", { name: "Approve dispatcher" }).click();
  await toast(owner, "Approved");
  await nav(owner, "Dispatchers");
  const trow = owner.locator(".row", { hasText: "Dana Dispatch" }).first();
  await trow.getByLabel("Test Carrier A").check();
  await trow.getByRole("button", { name: "Save access" }).click();
  await toast(owner, "Access saved");
});

await run("Dispatcher's screen opens with Test Carrier A assigned", async () => {
  await heading(dispatcher, "Tasks");
  await dispatcher.getByText("Your carriers: Test Carrier A").waitFor();
});

// ---------- 4. Carrier sets up trucks and invites a driver ----------
await run("Carrier adds a truck", async () => {
  await nav(carrier, "Drivers & trucks");
  await carrier.locator("summary", { hasText: "Add truck" }).click();
  await carrier.getByLabel("Unit #").fill("Unit 7");
  await carrier.locator('select[name="type"]').selectOption("Reefer");
  await carrier.getByRole("button", { name: "Add truck", exact: true }).click();
  await toast(carrier, "Truck added");
  await carrier.locator("td", { hasText: "Unit 7" }).first().waitFor();
});

await run("Carrier creates a driver invite code", async () => {
  await carrier.getByRole("button", { name: "Invite driver" }).click();
  driverCode = (await carrier.locator(".invite-code").first().innerText()).trim();
  if (!/^[A-Z0-9]{10}$/.test(driverCode)) throw new Error("Bad invite code: " + driverCode);
});

await run("A bad invite code is rejected and nobody gets in", async () => {
  const p = await open("intruder", { width: 390, height: 844 });
  await p.getByRole("tab", { name: "Invite code" }).click();
  await p.getByLabel("Invite code").fill("NOPE000000");
  await p.getByLabel("Full name").fill("Intruder");
  await p.getByLabel("Pick a username").fill("intruder");
  await p.getByLabel("Password").fill("intruder-1");
  await p.getByRole("button", { name: "Create account" }).click();
  await p.locator(".form-error", { hasText: /invite code|access/i }).waitFor();
  await p.context().close();
  delete pages.intruder;
});

await run("Driver signs up on a phone with the invite code", async () => {
  driver = await open("driver", { width: 390, height: 844 });
  await driver.getByRole("tab", { name: "Invite code" }).click();
  await driver.getByLabel("Invite code").fill(driverCode.toLowerCase());
  await driver.getByLabel("Full name").fill("Drew Driver");
  await driver.getByLabel("Phone").fill("2085550102");
  await driver.getByLabel("Pick a username").fill("Drew"); // usernames aren't case-sensitive
  await driver.getByLabel("Password").fill("driver-pass-1");
  await driver.getByRole("button", { name: "Create account" }).click();
  await heading(driver, "Loads");
  await driver.getByText("No active loads").waitFor();
});

await run("The same invite code can't be used twice", async () => {
  const p = await open("reuser", { width: 390, height: 844 });
  await p.getByRole("tab", { name: "Invite code" }).click();
  await p.getByLabel("Invite code").fill(driverCode);
  await p.getByLabel("Full name").fill("Second Person");
  await p.getByLabel("Pick a username").fill("second.person");
  await p.getByLabel("Password").fill("second-1");
  await p.getByRole("button", { name: "Create account" }).click();
  await p.locator(".form-error", { hasText: /invite code|access/i }).waitFor();
  await p.context().close();
  delete pages.reuser;
});

await run("A taken username is refused with a clear message, and no account is left behind", async () => {
  const p = await open("copycat", { width: 390, height: 844 });
  await p.getByRole("tab", { name: "Request access" }).click();
  await p.getByLabel("I'm signing up as").selectOption("dispatcher");
  await p.getByLabel("Full name").fill("Copy Cat");
  await p.getByLabel("Phone").fill("2085550111");
  await p.getByLabel("Pick a username").fill("Carla.Carrier");
  await p.getByLabel("Password").fill("copycat-1");
  await p.getByRole("button", { name: "Request access" }).click();
  await p.locator(".form-error", { hasText: "That username is already taken" }).waitFor();
  await p.getByLabel("Pick a username").fill("carla carrier");
  await p.getByLabel("Password").fill("copycat-1");
  await p.getByRole("button", { name: "Request access" }).click();
  await p.locator(".form-error", { hasText: "That username won't work" }).waitFor();
  await p.context().close();
  delete pages.copycat;
});

await run("Driver changes their password, signs out, and signs back in with username + new password", async () => {
  expectAuthFail.add("driver");
  await driver.getByRole("button", { name: "Change password" }).click();
  const dlg = driver.locator("dialog[open]");
  await dlg.locator('input[name="current"]').fill("wrong-one");
  const next = dlg.locator('input[name="next"]');
  await next.fill("driver-pass-2");
  // Show / Hide: see what you typed, without the cursor (or phone keyboard) leaving the box
  if ((await next.getAttribute("type")) !== "password") throw new Error("The new password should start hidden");
  const nextBox = dlg.locator(".pw-wrap", { has: driver.locator('input[name="next"]') });
  await nextBox.getByRole("button", { name: "Show" }).click();
  if ((await next.getAttribute("type")) !== "text") throw new Error("Show didn't show the password");
  if (!(await next.evaluate((el) => document.activeElement === el))) throw new Error("Tapping Show took the cursor out of the box");
  if ((await next.inputValue()) !== "driver-pass-2") throw new Error("Showing it changed what was typed");
  await nextBox.getByRole("button", { name: "Hide" }).click();
  if ((await next.getAttribute("type")) !== "password") throw new Error("Hide didn't hide it again");
  await dlg.locator('input[name="again"]').fill("driver-pass-2");
  await dlg.getByRole("button", { name: "Save" }).click();
  await dlg.getByText("Your current password isn't right.").waitFor();
  await dlg.locator('input[name="current"]').fill("driver-pass-1");
  await dlg.getByRole("button", { name: "Save" }).click();
  await toast(driver, "Password changed");
  const menu = driver.locator(".menu-btn");
  if (await menu.isVisible()) await menu.click();
  await driver.getByRole("button", { name: "Sign out" }).click();
  await driver.getByLabel("Username").fill("drew");
  await driver.getByLabel("Password").fill("driver-pass-1");
  await driver.getByRole("button", { name: "Sign in" }).click();
  await driver.locator(".form-error", { hasText: "Wrong username or password" }).waitFor();
  await driver.getByLabel("Password").fill("driver-pass-2");
  await driver.getByRole("button", { name: "Sign in" }).click();
  await heading(driver, "Loads");
  await driver.getByText("Signed in as drew").waitFor();
  expectAuthFail.delete("driver");
});

await run("Carrier sets the driver's pay to $0.60/mile on Unit 7", async () => {
  const row = carrier.locator(".row", { hasText: "Drew Driver" }).first();
  await row.waitFor();
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("Pay type").selectOption("perMile");
  await row.getByLabel("Rate").fill("0.6");
  await row.getByLabel("Truck").selectOption({ label: "Unit 7" });
  await row.getByRole("button", { name: "Save" }).click();
  await toast(carrier, "Driver saved");
  await row.getByText("$0.6 per mile").waitFor();
});

await run("Owner's Google Drive is connected (test stand-in for the Apps Script)", async () => {
  await seed((db) => setDoc(doc(db, "settings", "app"), { driveUrl: `http://127.0.0.1:${DRIVE_PORT}/exec` }));
});

// ---------- 5. Dispatcher books a load by scanning the rate con ----------
await run("Dispatcher scans a rate con PDF and the load fills itself in", async () => {
  await nav(dispatcher, "Loads");
  await dispatcher.getByRole("button", { name: "+ New load" }).click();
  const rc = await textPdf([
    "TQL Total Quality Logistics",
    "RATE CONFIRMATION        Load # 4471823",
    "Carrier: Test Carrier A LLC          Truck # 7",
    "Pickup 1        " + new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }),
    "Simplot Foods      Boise, ID 83706",
    "Delivery 1      " + new Date(Date.now() + 2 * 864e5).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }),
    "Walmart DC 6091      Denver, CO 80216",
    "Commodity: Frozen Potatoes        Weight: 42,500 lbs",
    "Total Miles: 500",
    "Total Carrier Pay      $2,000.00",
  ]);
  const t0 = Date.now();
  await dispatcher.locator('input[data-role="ratecon"]').setInputFiles({ name: "ratecon.pdf", mimeType: "application/pdf", buffer: rc });
  await dispatcher.locator(".scanmsg.ok").waitFor({ timeout: 60000 });
  timings.push(["Read a rate con PDF", Date.now() - t0]);
  const F = dispatcher.locator(".form-card");
  const val = (l) => F.getByLabel(l, { exact: true }).inputValue();
  const got = { origin: await val("Pickup (City, ST)"), dest: await val("Delivery (City, ST)"), rate: await val("Rate ($)"), miles: await val("Loaded miles"), broker: await val("Broker"), no: await val("Load #") };
  if (got.origin !== "Boise, ID" || got.dest !== "Denver, CO" || Number(got.rate) !== 2000 || got.miles !== "500" || got.broker !== "TQL" || got.no !== "4471823")
    throw new Error("Rate con read wrong: " + JSON.stringify(got));
  if ((await F.locator('select[name="truckId"]').inputValue()) === "") throw new Error("Truck # 7 on the rate con didn't pick Unit 7");
  const fee = await F.getByLabel("Dispatch fee ($)").inputValue();
  if (fee !== "160.00") throw new Error("Fee auto-fill was " + fee);
  await dispatcher.locator("select[name=driverId] option", { hasText: "Drew Driver" }).waitFor({ state: "attached" });
  await F.locator('select[name="driverId"]').selectOption({ label: "Drew Driver" });
  await F.getByRole("button", { name: "Save load", exact: true }).click();
  await toast(dispatcher, "Load booked with paperwork");
  await dispatcher.locator(".item-lane", { hasText: "Boise, ID → Denver, CO" }).first().waitFor();
});

await run("Driver sees the load appear live without refreshing, with no rate or fee shown", async () => {
  await driver.locator(".load-lane", { hasText: "Boise, ID → Denver, CO" }).waitFor();
  const body = await driver.locator("body").innerText();
  if (/\$2,000|\$160/.test(body)) throw new Error("Driver can see money on the load");
});

await run("Driver taps Picked up", async () => {
  await driver.getByRole("button", { name: "Picked up" }).click();
  await toast(driver, "Marked picked up");
});

await run("Driver snaps a BOL: a 7.7-megapixel photo gets shrunk and uploaded", async () => {
  const t0 = Date.now();
  await driver.locator("input[type=file]").first().setInputFiles({ name: "bol.png", mimeType: "image/png", buffer: SAME_BOL });
  await toast(driver, "Sent to dispatch");
  timings.push(["Shrink + upload a 7.7 MP worst-case photo", Date.now() - t0]);
});

await run("The driver's BOL is copied to Google Drive under their own folder", async () => {
  await toast(driver, "Copied 1 file to Google Drive");
  const call = driveCalls.find((c) => c.role === "driver" && c.kind === "BOL");
  if (!call || !call.ok) throw new Error("Drive copy for the driver's BOL failed: " + JSON.stringify(driveCalls));
  if (call.carrier !== "Test Carrier A" || call.driver !== "Drew Driver") throw new Error("Wrong folder info: " + JSON.stringify(call));
});

await run("Driver sends a $85 lumper receipt from the road", async () => {
  const R = driver.locator(".card", { hasText: "Lumpers, repairs, tolls" });
  await R.getByLabel("Type").selectOption("Lumper");
  await R.getByLabel("Amount ($)").fill("85");
  await R.locator('select[name="loadId"]').selectOption({ index: 1 });
  await R.getByLabel("Note").fill("Lumper at Walmart DC");
  await R.locator('input[data-role="camera"]').setInputFiles({ name: "lumper.png", mimeType: "image/png", buffer: noisyPng(800, 1100) });
  await R.locator(".scan-item").first().waitFor();
  await R.getByRole("button", { name: "Send receipt" }).click();
  await toast(driver, "Receipt sent to dispatch");
  await driver.waitForFunction(() => true);
  const t0 = Date.now();
  while (!driveCalls.some((c) => c.kind === "Lumper" && c.ok) && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 200));
  if (!driveCalls.some((c) => c.kind === "Lumper" && c.ok)) throw new Error("Lumper receipt didn't reach Drive");
});

await run("The driver's BOL reaches the carrier's review queue right away (not the vault yet)", async () => {
  await nav(carrier, "Documents");
  await carrier.getByRole("heading", { name: "Document vault" }).waitFor();
  const queue = carrier.locator(".card", { hasText: "Docs to review" });
  await queue.locator(".row", { hasText: "BOL · #" }).first().waitFor();
  const vault = carrier.locator(".card", { hasText: "Document vault" });
  if (await vault.getByText(/BOL · #/).count()) throw new Error("Unreviewed BOL already in the vault");
});

await run("Driver re-sends the same BOL photo: it isn't saved twice", async () => {
  const again = driver.locator("input[type=file]").first();
  await again.setInputFiles({ name: "bol.png", mimeType: "image/png", buffer: SAME_BOL });
  await toast(driver, "Already on file");
});

await run("Dispatcher sees the lumper receipt with its amount in the review queue", async () => {
  await nav(dispatcher, "Tasks");
  await dispatcher.locator(".row", { hasText: "Lumper receipt" }).filter({ hasText: "$85.00" }).first().waitFor();
});

await run("Driver sends the same $85 lumper again (new photo): it's flagged as a possible duplicate", async () => {
  await nav(driver, "Loads");
  const R = driver.locator(".card", { hasText: "Lumpers, repairs, tolls" });
  await R.getByLabel("Type").selectOption("Lumper");
  await R.getByLabel("Amount ($)").fill("85");
  await R.locator('input[data-role="camera"]').setInputFiles({ name: "lumper2.png", mimeType: "image/png", buffer: noisyPng(800, 1100) });
  await R.locator(".scan-item").first().waitFor();
  await R.getByRole("button", { name: "Send receipt" }).click();
  await toast(driver, "Receipt sent to dispatch");
  const queue = carrier.locator(".card", { hasText: "Docs to review" });
  try {
    await queue.locator(".row", { hasText: "Lumper receipt" }).filter({ hasText: "Possible duplicate" }).first().waitFor();
  } catch (e) {
    console.log("      carrier queue: " + (await queue.first().innerText()).replace(/\s+/g, " ").slice(0, 900));
    throw e;
  }
});

await run("Carrier rejects the duplicate, approves the real lumper, and it becomes an expense on the load", async () => {
  const queue = carrier.locator(".card", { hasText: "Docs to review" });
  const lumpers = queue.locator(".row", { hasText: "Lumper receipt" });
  const before = await lumpers.count();
  await lumpers.filter({ hasNotText: "Boise" }).filter({ hasText: "Possible duplicate" }).first().getByRole("button", { name: "Reject duplicate" }).click();
  await toast(carrier, "Duplicate rejected");
  const t0 = Date.now();
  while ((await lumpers.count()) >= before && Date.now() - t0 < 10000) await carrier.waitForTimeout(200);
  // with the copy gone, the real one shouldn't still be flagged
  const stillFlagged = () => lumpers.filter({ hasText: "Boise" }).filter({ hasText: "Possible duplicate" }).count();
  while ((await stillFlagged()) && Date.now() - t0 < 12000) await carrier.waitForTimeout(200);
  if (await stillFlagged()) throw new Error("The real lumper is still flagged after its duplicate was rejected");
  await lumpers.filter({ hasText: "Boise" }).first().getByRole("button", { name: "Approve + add expense" }).click();
  await toast(carrier, "Approved and added to expenses");
  await nav(carrier, "Expenses");
  await carrier.locator(".chip", { hasText: "All time" }).first().click();
  await carrier.locator(".items").first().locator(".item", { hasText: "Lumper" }).filter({ hasText: "Load #" }).first().waitFor();
  await nav(carrier, "Loads");
  await carrier.locator(".item", { hasText: "Boise, ID → Denver, CO" }).first().getByText("Load expenses $85.00").waitFor();
  await nav(carrier, "Documents"); // the next steps watch the carrier's document vault
  await carrier.getByRole("heading", { name: "Document vault" }).waitFor();
});

await run("Dispatcher sees the BOL in the review queue, opens the scan, and approves it", async () => {
  await nav(dispatcher, "Tasks");
  const row = dispatcher.locator(".row", { hasText: "BOL · #" }).first();
  await row.waitFor();
  const [popup] = await Promise.all([dispatcher.waitForEvent("popup"), row.getByRole("button", { name: "View" }).click()]);
  await popup.waitForLoadState().catch(() => {});
  await popup.waitForURL(/^blob:/, { timeout: 10000 });
  await popup.close();
  await row.getByRole("button", { name: "Approve" }).click();
  await toast(dispatcher, "Approved");
});

await run("Driver sees their own uploads: what's approved, waiting or not accepted, and can open them", async () => {
  // on the load itself
  const sent = driver.locator(".sent-box").first();
  await sent.locator(".row", { hasText: "BOL" }).filter({ hasText: "Approved" }).first().waitFor();
  await sent.locator(".row", { hasText: "Lumper" }).filter({ hasText: "Approved" }).first().waitFor();
  // the My uploads page
  await nav(driver, "My uploads");
  const list = driver.locator(".card", { hasText: "Everything you've sent" });
  await list.locator(".row", { hasText: "Lumper receipt" }).filter({ hasText: "Not accepted" }).getByText(/already on file/).waitFor();
  await driver.locator(".chip", { hasText: "Not accepted" }).click();
  if (await list.locator(".row", { hasText: "BOL" }).count()) throw new Error("Filter didn't hide approved papers");
  await driver.locator(".chip", { hasText: "All" }).click();
  await driver.getByLabel("Search my uploads").fill("walmart");
  await list.locator(".row", { hasText: "Lumper at Walmart DC" }).first().waitFor();
  await driver.getByLabel("Search my uploads").fill("");
  const row = list.locator(".row", { hasText: "BOL" }).first();
  const [popup] = await Promise.all([driver.waitForEvent("popup"), row.getByRole("button", { name: "View" }).click()]);
  await popup.waitForURL(/^blob:/, { timeout: 10000 });
  await popup.close();
  await nav(driver, "Loads");
});

await run("Approved BOL shows up in the carrier's vault and search finds it", async () => {
  await carrier.getByText(/BOL · #/).first().waitFor();
  const search = carrier.getByLabel("Search documents");
  await search.fill("bol");
  await carrier.getByText(/BOL · #/).first().waitFor();
  await search.fill("zzzz");
  await carrier.getByText("No matches.").waitFor();
  await search.fill("");
});

await run("Rate con scanned while booking shows up for the carrier (pre-approved)", async () => {
  await carrier.locator(".row", { hasText: "Rate con" }).first().waitFor();
});

await run("Dispatcher scans a lumper receipt onto the load from its Paperwork button", async () => {
  await nav(dispatcher, "Loads");
  const row = dispatcher.locator(".item", { hasText: "Boise, ID → Denver, CO" }).first();
  await row.getByRole("button", { name: /Scan paperwork/ }).click();
  const dlg = dispatcher.locator("dialog[open]");
  await dlg.getByLabel("Type").selectOption("Lumper");
  await dlg.locator('input[data-role="choose"]').setInputFiles([
    { name: "p1.png", mimeType: "image/png", buffer: noisyPng(900, 1200) },
    { name: "p2.png", mimeType: "image/png", buffer: noisyPng(900, 1200) }]);
  await dlg.locator(".scan-item").nth(1).waitFor();
  await dlg.getByRole("button", { name: "Save" }).click();
  await toast(dispatcher, "Paperwork saved");
  await carrier.locator(".row", { hasText: "p2/2" }).first().waitFor();
});

await run("Owner scans a W-9 from the Documents tab and can open it", async () => {
  await nav(owner, "Documents");
  await owner.getByLabel("Type").selectOption("W-9");
  await owner.getByLabel("Name (optional)").fill("W-9 Test Carrier A");
  await owner.locator('input[data-role="camera"]').first().setInputFiles({ name: "w9.png", mimeType: "image/png", buffer: noisyPng(1000, 1300) });
  await owner.getByRole("button", { name: "Save document" }).click();
  await toast(owner, "Saved");
  const row = owner.locator(".doc-row", { hasText: "W-9 Test Carrier A" }).first();
  const [popup] = await Promise.all([owner.waitForEvent("popup"), row.getByRole("button", { name: "View" }).click()]);
  await popup.waitForURL(/^blob:/, { timeout: 10000 });
  await popup.close();
  await carrier.locator(".row", { hasText: "W-9 Test Carrier A" }).first().waitFor();
});

await run("Carrier uploads an insurance PDF that expires in 10 days and it gets flagged", async () => {
  await carrier.locator('input[data-role="choose"]').first().setInputFiles({ name: "coi.pdf", mimeType: "application/pdf", buffer: tinyPdf });
  await carrier.locator(".scan-item").first().waitFor();
  await carrier.getByLabel("Name").fill("Insurance 2026");
  await carrier.getByLabel("Category").selectOption("Insurance");
  await carrier.getByLabel("Expires").fill(iso(10));
  await carrier.getByRole("button", { name: "Upload", exact: true }).click();
  await toast(carrier, "Uploaded");
  const row = carrier.locator(".row", { hasText: "Insurance 2026" }).first();
  await row.getByText(/Expires/).waitFor();
});

await run("Driver taps Delivered", async () => {
  await driver.getByRole("button", { name: "Delivered" }).click();
  await toast(driver, "Marked delivered");
});

await run("Carrier issues a paystub: 500 mi × $0.60 = $300", async () => {
  await nav(carrier, "Paystubs");
  await carrier.locator("select[name=driver] option", { hasText: "Drew Driver" }).waitFor({ state: "attached" });
  await carrier.locator("select[name=driver]").selectOption({ label: "Drew Driver" });
  await carrier.locator("input[name=from]").fill(iso(-7));
  await carrier.locator("input[name=to]").fill(iso(7));
  await carrier.locator("input[name=to]").dispatchEvent("change");
  await carrier.getByText("From loads: $300.00").waitFor();
  const pay = carrier.getByLabel("Driver pay ($)");
  if ((await pay.inputValue()) !== "300.00") throw new Error("Driver pay didn't fill in from the loads: " + (await pay.inputValue()));
  await carrier.getByText("Net $300.00").waitFor();
  await carrier.getByRole("button", { name: "Issue paystub" }).click();
  await toast(carrier, "Paystub issued");
});

await run("Carrier pays a different amount than the loads add up to (bonus + deduction)", async () => {
  await carrier.locator("select[name=driver]").selectOption({ label: "Drew Driver" });
  await carrier.locator("input[name=from]").fill(iso(-7));
  await carrier.locator("input[name=to]").fill(iso(7));
  await carrier.locator("input[name=to]").dispatchEvent("change");
  await carrier.getByText("From loads: $300.00").waitFor();
  await carrier.getByLabel("Driver pay ($)").fill("350");
  await carrier.getByLabel("Deductions ($)").fill("25");
  await carrier.getByText("Net $325.00").waitFor();
  await carrier.getByText("Changed from $300.00").waitFor();
  await carrier.getByLabel("Deduction note").fill("Advance");
  await carrier.getByRole("button", { name: "Issue paystub" }).click();
  await toast(carrier, "Paystub issued");
  await carrier.locator(".card", { hasText: "Issued paystubs" }).locator(".row", { hasText: "$325.00" }).first().waitFor();
  await nav(driver, "Pay");
  const stub = driver.locator("details.stub", { hasText: "$325.00" }).first();
  await stub.click();
  await stub.getByText("Added $50.00").waitFor();
  // take it back out so the rest of the run sees one paystub
  carrier.once("dialog", (d) => d.accept());
  await carrier.locator(".card", { hasText: "Issued paystubs" }).locator(".row", { hasText: "$325.00" }).first().getByRole("button", { name: "Delete" }).click();
  await toast(carrier, "Paystub deleted");
  await driver.locator("details.stub", { hasText: "$325.00" }).waitFor({ state: "detached" });
});

await run("Driver sees the $300 paystub", async () => {
  await nav(driver, "Pay");
  await driver.locator("details.stub", { hasText: "$300.00" }).first().waitFor();
});

await run("Carrier money adds up: $2,000 gross − $160 fee − $300 driver − $85 lumper = $1,455 profit", async () => {
  await nav(carrier, "Summary");
  for (const v of ["$2,000.00", "$160.00", "$300.00", "$1,455.00"]) await carrier.locator(".stat-value", { hasText: v }).first().waitFor();
});

await run("Owner marks the fee paid and the carrier's 'owed' drops to $0 live", async () => {
  await nav(owner, "Overview");
  await owner.locator("tr", { hasText: "Boise, ID → Denver, CO" }).getByRole("checkbox").check();
  const owed = carrier.locator(".stat", { hasText: "Owed to dispatch" }).locator(".stat-value");
  await owed.filter({ hasText: "$0.00" }).waitFor();
});

// ---------- 5b. Carrier bookkeeping (the Dijla ops system) ----------
await run("Carrier sets factoring to GAP at 2%", async () => {
  await nav(carrier, "Settings");
  await carrier.getByLabel("Factoring company").fill("GAP");
  await carrier.getByLabel("Factoring fee (%)").fill("2");
  await carrier.getByRole("button", { name: "Save settings" }).click();
  await toast(carrier, "Settings saved");
});

await run("Carrier marks the load Paid and records the $1,800 factoring deposit", async () => {
  await nav(carrier, "Loads");
  await carrier.locator('[aria-label="Stage"] .chip').nth(1).click(); // "All"
  const item = carrier.locator(".item", { hasText: "Boise, ID → Denver, CO" }).first();
  await item.getByRole("button", { name: "Paid", exact: true }).click();
  await toast(carrier, "Marked Paid");
  await item.getByLabel(/Deposit for load/).fill("1800");
  await item.getByRole("button", { name: "Save deposit" }).click();
  await toast(carrier, "Deposit saved");
  await item.getByText("fuel/advances kept back $160.00").waitFor();
});

await run("Carrier scans a fuel receipt and the expense fills itself in", async () => {
  await nav(carrier, "Expenses");
  await carrier.getByRole("button", { name: "+ Add expense" }).click();
  const receipt = await textPdf([
    "PILOT TRAVEL CENTER #412", "Boise, ID 83709", new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }),
    "Fuel type Diesel #2 ULSD    Pump 14", "TRKDS   Gallons 118.432   Price/Gal $3.899", "Total Sale $461.77", "Unit # 7    Odometer 452311",
    "GAP Factoring Fleet One   Card ending 4417", "Trans # 883402   Auth 552190", "Thank you for choosing Pilot Flying J. Driver signature on file."]);
  await carrier.locator('input[data-role="bill"]').setInputFiles({ name: "fuel.pdf", mimeType: "application/pdf", buffer: receipt });
  await carrier.locator(".scanmsg.ok").waitFor({ timeout: 60000 });
  const F = carrier.locator(".form-card");
  if ((await F.getByLabel("Amount ($)").inputValue()) !== "461.77") throw new Error("Amount not read");
  if ((await F.getByLabel("Gallons").inputValue()) !== "118.432") throw new Error("Gallons not read");
  if ((await F.getByLabel("Paid with").inputValue()) !== "factor") throw new Error("GAP fuel card not detected");
  await F.getByRole("button", { name: "Save expense" }).click();
  await toast(carrier, "Expense added");
  await carrier.locator(".item", { hasText: "$461.77" }).first().waitFor();
  await carrier.locator(".stat", { hasText: "On GAP card" }).locator(".stat-value", { hasText: "$461.77" }).waitFor();
  await carrier.locator(".item", { hasText: "$461.77" }).getByRole("button", { name: "Receipt" }).waitFor();
});

await run("Carrier adds monthly insurance and past-due charges post themselves once", async () => {
  await carrier.getByRole("button", { name: "Recurring", exact: true }).click();
  await carrier.getByRole("button", { name: "+ Add recurring charge" }).click();
  const f = carrier.locator(".form-card");
  await f.getByLabel("Name").fill("Progressive insurance");
  await f.getByLabel("Category").selectOption("Insurance");
  await f.getByLabel("Amount ($)").fill("1200");
  await f.getByLabel("First charge date").fill(iso(-45));
  await f.getByRole("button", { name: "Save", exact: true }).click();
  await toast(carrier, "Recurring charge added");
  await toast(carrier, "Added 2 recurring charges");
  await carrier.locator(".stat", { hasText: "Fixed costs / month" }).locator(".stat-value", { hasText: "$1,200.00" }).waitFor();
  await carrier.getByRole("button", { name: "All expenses", exact: true }).click();
  await carrier.locator(".chip", { hasText: "All time" }).first().click();
  await carrier.waitForTimeout(1500); // a second device/listener must not double-post
  const n = await carrier.locator(".items").first().locator(".item", { hasText: "Progressive insurance" }).count();
  if (n !== 2) throw new Error(`Expected 2 posted insurance charges, found ${n}`);
});

await run("Summary shows GAP fees and GAP fuel per truck and in total", async () => {
  await nav(carrier, "Summary");
  const row = (label) => carrier.locator("table.sum tr", { hasText: label }).first();
  await row("GAP fees").getByText("-$40").first().waitFor();
  await row("GAP fuel & deductions").getByText("-$462").first().waitFor();
  await carrier.locator("table.sum th", { hasText: "Unit 7" }).waitFor();
});

await run("1099 counts the load in the quarter it was paid, and the PDF opens", async () => {
  await nav(carrier, "1099");
  await carrier.locator(".stat", { hasText: "Gross paid" }).locator(".stat-value", { hasText: "$2,000.00" }).waitFor();
  await pdfOpens(carrier);
});

await run("Loads report PDF opens", async () => {
  await nav(carrier, "Loads");
  await carrier.getByRole("button", { name: "Loads report" }).click();
  await carrier.locator(".chip", { hasText: "All time" }).first().click();
  await pdfOpens(carrier);
});

await run("Carrier books its own load (no dispatcher, no dispatch fee)", async () => {
  await carrier.getByRole("button", { name: "+ New load" }).click();
  const F = carrier.locator(".form-card");
  await F.getByLabel("Pickup (City, ST)").fill("Nampa, ID");
  await F.getByLabel("Delivery (City, ST)").fill("Salt Lake City, UT");
  await F.getByLabel("Rate ($)").fill("1100");
  if (await F.getByLabel("Dispatch fee ($)").count()) throw new Error("Carrier should not see a dispatch fee field");
  await F.getByRole("button", { name: "Save load", exact: true }).click();
  await toast(carrier, "Load booked");
  await carrier.locator(".item-lane", { hasText: "Nampa, ID → Salt Lake City, UT" }).first().waitFor();
});

await run("Owner adds a truck and a hand-added driver for the carrier", async () => {
  await nav(owner, "Drivers & trucks");
  await owner.locator("summary", { hasText: "Add truck" }).click();
  await owner.getByLabel("Unit #").fill("Unit 9");
  await owner.getByRole("button", { name: "Add truck", exact: true }).click();
  await toast(owner, "Truck added");
  await owner.locator("summary", { hasText: "Add a driver by hand" }).click();
  const F = owner.locator("details", { hasText: "Add a driver by hand" });
  await F.getByLabel("Name").fill("Sam Owner-Op");
  await F.getByLabel("Rate").fill("0.65");
  await F.locator('select[name="truckId"]').selectOption({ label: "Unit 9" });
  await F.getByRole("button", { name: "Add driver" }).click();
  await toast(owner, "Driver added");
  await owner.locator(".row", { hasText: "Sam Owner-Op" }).getByText("No app login").waitFor();
  await carrier.locator(".row", { hasText: "Sam Owner-Op" }).first().waitFor({ state: "attached" }).catch(() => {});
});

await run("Owner sees every carrier or picks one: Summary, Expenses, Accounts", async () => {
  await nav(owner, "Summary");
  await owner.getByLabel("Carrier", { exact: true }).selectOption({ label: "Test Carrier A" });
  await owner.locator("table.sum th", { hasText: "Unit 7" }).waitFor();
  // the carrier's own factoring settings reach the owner's screen live
  await owner.locator("table.sum tr", { hasText: "GAP fees" }).first().getByText("-$40").first().waitFor();
  await nav(owner, "Expenses");
  await owner.locator(".chip", { hasText: "All time" }).first().click();
  await owner.locator(".item", { hasText: "$461.77" }).first().waitFor();
  await nav(owner, "Accounts");
  await owner.getByLabel("Role", { exact: true }).selectOption("driver");
  await owner.locator(".acct-row", { hasText: "Drew Driver" }).waitFor();
  if (await owner.locator(".acct-row", { hasText: "Carla Carrier" }).count()) throw new Error("Role filter didn't filter");
  await owner.getByLabel("Role", { exact: true }).selectOption("all");
});

// ---------- 5b. The owner adds people and resets passwords ----------
let ninaStart = "";
await run("Owner adds a driver with a username and starting password, without being signed out", async () => {
  await nav(owner, "Accounts");
  await owner.getByRole("button", { name: "+ Add a person" }).click();
  const F = owner.locator(".card", { has: owner.getByRole("heading", { name: "Add a person" }) });
  await F.locator("select[name=role]").selectOption("driver");
  await F.locator("select[name=carrierId]").selectOption({ label: "Test Carrier A" });
  await F.getByLabel("Full name").fill("Nina New");
  await F.getByLabel("Phone").fill("2085550177");
  await F.getByLabel("Username").fill("Nina.New");
  ninaStart = await F.locator("input[name=password]").inputValue();
  if (!/^[a-z]+-\d{4}-[a-z]+$/.test(ninaStart)) throw new Error("No starting password suggested: " + ninaStart);
  await F.getByRole("button", { name: "Add person" }).click();
  await toast(owner, "Nina New can sign in now");
  const share = owner.locator(".share-card");
  await share.getByText("Username: nina.new").waitFor();
  await share.getByText("Password: " + ninaStart).waitFor();
  await share.getByRole("link", { name: "Text it" }).waitFor();
  // the owner is still the owner
  await owner.getByText("Signed in as owner@test.dev").waitFor();
  await owner.locator(".acct-row", { hasText: "Nina New" }).getByText("Picks own password at next sign-in").waitFor();
  const p = (await adminDocs("users")).find((u) => u.username === "nina.new");
  if (!p || p.role !== "driver" || !p.carrierId || !p.tempPassword) throw new Error("Profile not saved right: " + JSON.stringify(p));
});

await run("A taken username is refused when adding, and no stray login is left behind", async () => {
  expectAuthFail.add("owner"); // Google refuses the duplicate login with a 400; that's the point
  await owner.getByRole("button", { name: "+ Add a person" }).click();
  const F = owner.locator(".card", { has: owner.getByRole("heading", { name: "Add a person" }) });
  await F.locator("select[name=carrierId]").selectOption({ label: "Test Carrier A" });
  await F.getByLabel("Full name").fill("Someone Else");
  await F.getByLabel("Username").fill("drew");
  await F.getByRole("button", { name: "Add person" }).click();
  await F.locator(".form-error", { hasText: "That username is already taken" }).waitFor();
  await F.getByRole("button", { name: "Cancel" }).click();
  if ((await adminDocs("users")).some((u) => u.name === "Someone Else")) throw new Error("A profile was saved anyway");
  expectAuthFail.delete("owner");
});

let nina;
await run("Nina signs in with what the owner sent and is asked to pick her own password first", async () => {
  nina = await open("nina", { width: 390, height: 844 });
  await nina.getByLabel("Username").fill("nina.new");
  await nina.getByLabel("Password").fill(ninaStart);
  await nina.getByRole("button", { name: "Show" }).click(); // check what she typed
  if ((await nina.getByLabel("Password").getAttribute("type")) !== "text") throw new Error("Show didn't work on the sign-in page");
  await nina.getByRole("button", { name: "Sign in" }).click();
  const dlg = nina.locator("dialog[open]");
  await dlg.getByRole("heading", { name: "Pick your own password" }).waitFor();
  if (await dlg.locator('input[name="current"]').count()) throw new Error("Shouldn't ask for the password she just typed");
  await dlg.locator('input[name="next"]').fill(ninaStart);
  await dlg.locator('input[name="again"]').fill(ninaStart);
  await dlg.getByRole("button", { name: "Save and continue" }).click();
  await dlg.getByText("Pick a password different").waitFor();
  await dlg.locator('input[name="next"]').fill("nina-own-77");
  await dlg.locator('input[name="again"]').fill("nina-own-77");
  await dlg.getByRole("button", { name: "Save and continue" }).click();
  await toast(nina, "You're all set");
  await heading(nina, "Loads");
  const t0 = Date.now();
  while ((await adminDocs("users")).find((u) => u.username === "nina.new").tempPassword && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 200));
  if ((await adminDocs("users")).find((u) => u.username === "nina.new").tempPassword) throw new Error("Flag not cleared");
});

await run("Owner checks password resets are set up, then resets Nina's password", async () => {
  await nav(owner, "Settings");
  const R = owner.locator(".card", { hasText: "Password resets" });
  await R.getByRole("button", { name: "Check" }).click();
  await R.getByText(/^Ready\./).waitFor();
  await nav(owner, "Accounts");
  await owner.locator(".acct-row", { hasText: "Nina New" }).getByRole("button", { name: "Reset password" }).click();
  const dlg = owner.locator("dialog[open]");
  // the new password is shown (it's about to be sent), with Hide for when someone's looking
  const pw = dlg.locator("input[name=password]");
  if ((await pw.getAttribute("type")) !== "text") throw new Error("The new password should be shown");
  await dlg.getByRole("button", { name: "Hide" }).click();
  if ((await pw.getAttribute("type")) !== "password") throw new Error("Hide didn't hide the new password");
  await dlg.getByRole("button", { name: "Show" }).click();
  await pw.fill("reset-5678");
  await dlg.locator("input[name=temp]").uncheck();
  await dlg.getByRole("button", { name: "Reset password" }).click();
  await toast(owner, "New password set for Nina New");
  await owner.locator(".share-card").getByText("Password: reset-5678").waitFor();
  if (await owner.locator(".acct-row", { hasText: "Nina New" }).getByText("Picks own password").count()) throw new Error("Shouldn't ask her to pick one this time");
});

await run("Nina's old password stops working and the new one works", async () => {
  expectAuthFail.add("nina");
  const menu = nina.locator(".menu-btn");
  if (await menu.isVisible()) await menu.click();
  await nina.getByRole("button", { name: "Sign out" }).click();
  await nina.getByLabel("Username").fill("nina.new");
  await nina.getByLabel("Password").fill("nina-own-77");
  await nina.getByRole("button", { name: "Sign in" }).click();
  await nina.locator(".form-error", { hasText: "Wrong username or password" }).waitFor();
  await nina.getByLabel("Password").fill("reset-5678");
  await nina.getByRole("button", { name: "Sign in" }).click();
  await heading(nina, "Loads");
  await nina.waitForTimeout(500);
  if (await nina.locator("dialog[open]").count()) throw new Error("Asked to pick a password even though the owner said not to");
  await nina.context().close();
  delete pages.nina;
});

await run("Nobody but the owner can reset a password through the Drive script", async () => {
  const r = await carrier.evaluate(async () => {
    const { auth } = await import("./js/fb.js");
    const res = await fetch("http://127.0.0.1:5066/", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ idToken: await auth.currentUser.getIdToken(), resetPassword: { uid: auth.currentUser.uid, password: "hijack-1" } }) });
    return res.json();
  });
  if (r.ok) throw new Error("A carrier admin reset a password");
});

// ---------- 6. Lane request round trip ----------
await run("Carrier sends a lane request, dispatcher replies, carrier sees the reply", async () => {
  await nav(carrier, "Requests");
  await carrier.getByLabel("Where do you want a truck to go?").fill("Unit 7 empty in Denver Friday, want to head back to Boise");
  await carrier.getByRole("button", { name: "Send request" }).click();
  await toast(carrier, "Request sent");
  await nav(dispatcher, "Truck requests");
  const row = dispatcher.locator(".row", { hasText: "empty in Denver" }).first();
  await row.getByLabel("Reply").fill("Got a Denver → Nampa reefer for Saturday");
  await row.getByRole("button", { name: "Send" }).click();
  await toast(dispatcher, "Reply sent");
  await carrier.getByText("Got a Denver → Nampa reefer").waitFor();
});

// ---------- 7. Denied request ----------
await run("Owner denies a sign-up and that person stays locked out", async () => {
  const p = await open("denied");
  await p.getByRole("tab", { name: "Request access" }).click();
  await p.getByLabel("Company name").fill("Sketchy Freight");
  await p.getByLabel("Full name").fill("Sam Sketchy");
  await p.getByLabel("Phone").fill("2085550199");
  await p.getByLabel("Pick a username").fill("sketchy");
  await p.getByLabel("Password").fill("sketchy-1");
  await p.getByRole("button", { name: "Request access" }).click();
  await heading(p, "Request received");
  await nav(owner, "Access requests");
  owner.once("dialog", (d) => d.accept());
  await owner.locator(".row", { hasText: "Sketchy Freight" }).getByRole("button", { name: "Deny" }).click();
  await toast(owner, "Request denied");
  await p.getByText(/doesn't have access/).waitFor();
  await p.context().close();
  delete pages.denied;
});

await run("The Drive script parses and has nothing a phone paste would mangle", async () => {
  const gs = readFileSync(ROOT + "drive/KeepTrackDrive.gs", "utf8");
  // Phone keyboards paste by "typing", and the editor then auto-closes /** comments with a stray */ at the end.
  if (gs.includes("/*")) throw new Error("Use // comments in the Drive script, not /* */");
  new Function(gs);
});

// ---------- 7b. Storage, backup to Drive, free up space ----------
const tile = (p, label) => p.locator(".stat", { has: p.locator(".stat-label", { hasText: label }) }).locator(".stat-value");
let scansBefore = 0;
await run("Owner sees roughly how much storage the scans take", async () => {
  await nav(owner, "Settings");
  const card = owner.locator(".card", { hasText: "Storage & backup" });
  await card.getByText(/About [\d.,]+ MB/).waitFor();
  const held = await tile(owner, "Scans in KeepTrack").innerText();
  scansBefore = Number(held.replace(/,/g, ""));
  const real = (await adminDocs("docFiles")).length;
  if (scansBefore !== real) throw new Error(`Meter says ${held} scans, the database holds ${real}`);
  if (!real) throw new Error("No scans to test with");
});

await run("Owner backs up every scan to Drive, with a PDF report listing each one", async () => {
  const card = owner.locator(".card", { hasText: "Storage & backup" });
  await card.getByRole("button", { name: "Back up to Drive" }).click();
  await toast(owner, /Backed up \d+ scans? to Google Drive$/);
  await card.getByRole("link", { name: "Open the backup report (PDF)" }).first().waitFor();
  const docs = await adminDocs("documents");
  const shouldBe = docs.filter((d) => d.status !== "rejected");
  const missing = shouldBe.filter((d) => !d.backedUpAt || !d.driveFileId);
  if (missing.length) throw new Error(`${missing.length} scans weren't marked as backed up`);
  if (backupPdfs.length !== 1) throw new Error(`Expected 1 backup report, got ${backupPdfs.length}`);
  if (backupPdfs[0].name !== "KeepTrack backup report") throw new Error("Report should be the one 'KeepTrack backup report', got " + backupPdfs[0].name);
  const pdf = backupPdfs[0].text;
  if (!reportSays(shouldBe.length)) throw new Error("Report doesn't say how many scans are in Drive");
  for (const want of ["Lumper receipt", "$85.00", "Test Carrier A", "Drew Driver", "W-9 Test Carrier A", "4471823 \xb7 Boise"]) if (!pdf.includes(want)) throw new Error("Report is missing: " + want);
  if (!/\/URI \(https:\/\/drive\.test\/file_/.test(pdf)) throw new Error("Report has no links to the files in Drive");
  if (!pdf.includes("/Subtype /Image")) throw new Error("Report header has no KeepTrack logo");
  await card.getByText(/Last backup:/).waitFor();
  await card.getByText(`Backup report: ${shouldBe.length} scans in Drive`).waitFor();
  // a second backup finds nothing new and copies nothing twice, but still checks Drive and makes the report
  // again (in case it was deleted in Drive), replacing the one before
  const copies = driveFiles.size;
  await card.getByRole("button", { name: "Back up to Drive" }).click();
  await toast(owner, "Everything is already backed up.");
  await waitFor(() => backupPdfs.length === 2, "The report wasn't made again");
  await card.getByRole("button", { name: "Back up to Drive", exact: true }).waitFor();
  if (backupPdfs[1].name !== backupPdfs[0].name) throw new Error("A second report file was made instead of replacing the first");
  if (!reportSays(shouldBe.length)) throw new Error("The new report doesn't list everything");
  if (driveFiles.size !== copies) throw new Error("Backing up again copied scans twice");
});

await run("The backup report stays current: a paper deleted in KeepTrack drops off it, one deleted in Drive is copied back", async () => {
  // two papers just for this check (removed again at the end, so later counts are unchanged)
  await seed(async (db) => {
    const cid = (await getDocs(collection(db, "carriers"))).docs.find((d) => d.data().name === "Test Carrier A").id;
    for (const k of ["A", "B"]) {
      await setDoc(doc(db, "documents", "reportCheck" + k), { carrierId: cid, kind: "Other", name: "Report check " + k, status: "approved", uploadedBy: ownerUid, uploaderName: "Test Owner", uploaderRole: "owner", createdAt: new Date() });
      await setDoc(doc(db, "docFiles", "reportCheck" + k), { carrierId: cid, uploadedBy: ownerUid, data: "data:image/jpeg;base64,AAAA" + k });
    }
  });
  const card = owner.locator(".card", { hasText: "Storage & backup" });
  await card.getByRole("button", { name: "Back up to Drive" }).click();
  await toast(owner, "Backed up 2 scans to Google Drive");
  await card.getByRole("button", { name: "Back up to Drive", exact: true }).waitFor();
  if (!lastReport().includes("Report check A") || !lastReport().includes("Report check B")) throw new Error("New papers aren't in the report");
  let n = await inDriveNow();
  if (!reportSays(n)) throw new Error(`Report should count ${n} scans`);
  // the owner deletes A in KeepTrack: its Drive copy goes, and the report is made again without it
  const made = backupPdfs.length;
  await nav(owner, "Documents");
  await owner.getByLabel("Search all documents").fill("Report check A");
  owner.once("dialog", (d) => d.accept());
  await owner.locator(".doc-row", { hasText: "Report check A" }).first().getByRole("button", { name: "Delete" }).click();
  await toast(owner, "Paper deleted");
  await waitFor(() => backupPdfs.length > made && !lastReport().includes("Report check A"), "The report still lists the deleted paper");
  if (!lastReport().includes("Report check B")) throw new Error("The report lost a paper that's still there");
  n = await inDriveNow();
  await waitFor(() => reportSays(n), `Report should count ${n} scans after the delete`);
  await owner.getByLabel("Search all documents").fill("");
  // B's copy is deleted straight in Drive: the next backup notices, copies it back, and the report links the new copy
  driveFiles.get("file_reportCheckB").trashed = true;
  await nav(owner, "Settings");
  await card.getByRole("button", { name: "Back up to Drive" }).click();
  await toast(owner, "Backed up 1 scan to Google Drive");
  await card.getByText("1 had been deleted in Drive, so it was copied again.").waitFor();
  if (driveFiles.get("file_reportCheckB").trashed) throw new Error("B wasn't copied back to Drive");
  if (!lastReport().includes("Report check B") || !reportSays(n)) throw new Error("Report doesn't list B again");
  // tidy up: B goes too (the report follows)
  const made2 = backupPdfs.length;
  await nav(owner, "Documents");
  await owner.getByLabel("Search all documents").fill("Report check B");
  owner.once("dialog", (d) => d.accept());
  await owner.locator(".doc-row", { hasText: "Report check B" }).first().getByRole("button", { name: "Delete" }).click();
  await toast(owner, "Paper deleted");
  await waitFor(() => backupPdfs.length > made2 && !lastReport().includes("Report check B"), "The report still lists B");
  await owner.getByLabel("Search all documents").fill("");
  await nav(owner, "Settings");
});

await run("A dispatcher can't run a backup through the Drive script", async () => {
  const r = await dispatcher.evaluate(async () => {
    const { auth } = await import("./js/fb.js");
    const res = await fetch("http://127.0.0.1:5066/", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ idToken: await auth.currentUser.getIdToken(), backup: "sneaky", docIds: [] }) });
    return res.json();
  });
  if (r.ok) throw new Error("Dispatcher was allowed to run a backup");
});

await run("Owner frees up space: scans leave KeepTrack, records stay, and View still opens them from Drive", async () => {
  const card = owner.locator(".card", { hasText: "Storage & backup" });
  owner.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: "Free up space" }).click();
  await toast(owner, /Freed about/);
  const left = await adminDocs("docFiles");
  if (left.length) throw new Error(`${left.length} scans are still in the database`);
  const docs = await adminDocs("documents");
  if (docs.some((d) => !d.fileFreed && !d.fileCleared)) throw new Error("A record wasn't marked as moved");
  if (docs.some((d) => d.status === "rejected" ? !d.fileCleared : !d.fileFreed)) throw new Error("Rejected scans should be cleared, the rest moved to Drive");
  const rejected = docs.filter((d) => d.status === "rejected").length;
  await owner.waitForFunction(() => {
    const t = [...document.querySelectorAll(".stat")].find((s) => s.querySelector(".stat-label")?.textContent === "Scans in KeepTrack");
    return t && t.querySelector(".stat-value").textContent === "0";
  });
  const moved = Number((await tile(owner, "Moved to Google Drive").innerText()).replace(/,/g, ""));
  if (moved !== scansBefore - rejected) throw new Error(`Moved ${moved}, expected ${scansBefore - rejected}`);
  // the carrier opens a moved scan from their vault: it comes back from Drive
  await nav(carrier, "Documents");
  const vault = carrier.locator(".card", { hasText: "Document vault" });
  const row = vault.locator(".row", { hasText: "W-9 Test Carrier A" }).first();
  const [popup] = await Promise.all([carrier.waitForEvent("popup"), row.getByRole("button", { name: "Open" }).click()]);
  await popup.waitForURL(/^blob:/, { timeout: 15000 });
  await popup.close();
  if (!driveCalls.some((c) => c.fetch && c.ok)) throw new Error("The scan didn't come back from Drive");
  // records still work: the owner's list marks them, search still finds them
  await nav(owner, "Documents");
  await owner.locator(".doc-row", { hasText: "W-9 Test Carrier A" }).first().getByText("In Drive only").waitFor();
});

await run("Rinse and repeat: a new scan after freeing is counted, backed up and freed again", async () => {
  await carrier.locator('input[data-role="choose"]').first().setInputFiles({ name: "reg.png", mimeType: "image/png", buffer: noisyPng(900, 1200) });
  await carrier.locator(".scan-item").first().waitFor();
  await carrier.getByLabel("Name").fill("Registration Unit 7");
  await carrier.getByLabel("Category").selectOption("Registrations");
  await carrier.getByRole("button", { name: "Upload", exact: true }).click();
  await toast(carrier, "Uploaded");
  await nav(owner, "Settings");
  await owner.waitForFunction(() => {
    const t = [...document.querySelectorAll(".stat")].find((s) => s.querySelector(".stat-label")?.textContent === "Scans in KeepTrack");
    return t && t.querySelector(".stat-value").textContent === "1";
  });
  const card = owner.locator(".card", { hasText: "Storage & backup" });
  const made = backupPdfs.length;
  await card.getByRole("button", { name: "Back up to Drive" }).click();
  await toast(owner, "Backed up 1 scan to Google Drive");
  await card.getByRole("button", { name: "Back up to Drive", exact: true }).waitFor();
  if (backupPdfs.length <= made || !lastReport().includes("Registration")) throw new Error("The new scan isn't in the backup report");
  if (!reportSays(await inDriveNow())) throw new Error("The report should list everything in Drive, old and new");
  owner.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: "Free up space" }).click();
  await toast(owner, /Freed about .* \(1 scan\)/);
  if ((await adminDocs("docFiles")).length) throw new Error("The new scan is still in the database");
});

await run("A moved scan deleted in Drive is reported as missing, and clears once it's put back", async () => {
  await seed(async (db) => {
    const cid = (await getDocs(collection(db, "carriers"))).docs.find((d) => d.data().name === "Test Carrier A").id;
    await setDoc(doc(db, "documents", "reportCheckC"), { carrierId: cid, kind: "Other", name: "Report check C", status: "approved", uploadedBy: ownerUid, uploaderName: "Test Owner", uploaderRole: "owner", createdAt: new Date() });
    await setDoc(doc(db, "docFiles", "reportCheckC"), { carrierId: cid, uploadedBy: ownerUid, data: "data:image/jpeg;base64,AAAC" });
  });
  const card = owner.locator(".card", { hasText: "Storage & backup" });
  await card.getByRole("button", { name: "Back up to Drive" }).click();
  await toast(owner, "Backed up 1 scan to Google Drive");
  await card.getByRole("button", { name: "Back up to Drive", exact: true }).waitFor();
  owner.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: "Free up space" }).click();
  await toast(owner, /Freed about .* \(1 scan\)/);
  // its only copy is in Drive now, and it gets deleted there
  driveFiles.get("file_reportCheckC").trashed = true;
  await card.getByRole("button", { name: "Back up to Drive" }).click();
  await toast(owner, "1 scan missing from Google Drive");
  await card.getByText("restore it from the Drive trash").waitFor();
  await card.getByRole("button", { name: "Back up to Drive", exact: true }).waitFor();
  if (!(await adminDocs("documents")).find((d) => d.id === "reportCheckC").driveMissing) throw new Error("Not flagged as missing");
  if (!lastReport().includes("Missing from Google Drive") || !lastReport().includes("Report check C")) throw new Error("The report doesn't list the missing scan");
  if (!reportSays(await inDriveNow())) throw new Error("The report's count should leave out the missing scan");
  await nav(owner, "Documents");
  await owner.getByLabel("Search all documents").fill("Report check C");
  await owner.locator(".doc-row", { hasText: "Report check C" }).first().getByText("Missing from Drive").waitFor();
  // put back from the Drive trash: the next backup sees it and the report stops calling it missing
  driveFiles.get("file_reportCheckC").trashed = false;
  await nav(owner, "Settings");
  await card.getByRole("button", { name: "Back up to Drive" }).click();
  await toast(owner, "Everything is already backed up.");
  await card.getByRole("button", { name: "Back up to Drive", exact: true }).waitFor();
  if ((await adminDocs("documents")).find((d) => d.id === "reportCheckC").driveMissing) throw new Error("Flag not cleared");
  if (lastReport().includes("Missing from Google Drive")) throw new Error("The report still says it's missing");
  // tidy up (the report follows)
  const made = backupPdfs.length;
  await nav(owner, "Documents");
  await owner.getByLabel("Search all documents").fill("Report check C");
  owner.once("dialog", (d) => d.accept());
  await owner.locator(".doc-row", { hasText: "Report check C" }).first().getByRole("button", { name: "Delete" }).click();
  await toast(owner, "Paper deleted");
  await waitFor(() => backupPdfs.length > made && !lastReport().includes("Report check C"), "The report still lists C");
  await owner.getByLabel("Search all documents").fill("");
});

// ---------- 7c. Editing and deleting papers and loads that are already backed up ----------
await run("Owner edits a paper that only lives in Drive now: the record changes and its Drive copy is re-filed", async () => {
  const w9 = (await adminDocs("documents")).find((d) => d.name === "W-9 Test Carrier A");
  if (!w9 || !w9.fileFreed) throw new Error("Expected the W-9 to be moved to Drive already");
  await nav(owner, "Documents");
  const calls = driveCalls.length;
  await owner.locator(".doc-row", { hasText: "W-9 Test Carrier A" }).first().getByRole("button", { name: "Edit" }).click();
  const dlg = owner.locator("dialog[open]");
  await dlg.getByLabel("Name").fill("W-9 2026 Test Carrier A");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await toast(owner, "Paper saved");
  await waitFor(async () => (await adminDocs("documents")).find((d) => d.id === w9.id)?.name === "W-9 2026 Test Carrier A", "Name didn't change");
  await waitFor(() => driveCalls.slice(calls).some((c) => c.docId === w9.id && c.ok), "Drive copy wasn't re-filed");
  await owner.locator(".doc-row", { hasText: "W-9 2026 Test Carrier A" }).first().getByText("In Drive only").waitFor();
});

await run("Carrier fixes a lumper's amount and the expense made from it follows", async () => {
  const lumper = (await adminDocs("documents")).find((d) => d.kind === "Lumper" && d.expenseId);
  await nav(carrier, "Documents");
  const vault = carrier.locator(".card", { hasText: "Document vault" });
  await vault.locator(".row", { hasText: "Lumper receipt" }).first().getByRole("button", { name: "Edit" }).click();
  const dlg = carrier.locator("dialog[open]");
  await dlg.getByLabel("Amount ($)").fill("95");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await toast(carrier, "Paper saved");
  await waitFor(async () => (await adminDocs("expenses")).find((e) => e.id === lumper.expenseId)?.amount === 95, "Expense amount didn't follow");
  if ((await adminDocs("documents")).find((d) => d.id === lumper.id).amount !== 95) throw new Error("Paper amount didn't change");
});

await run("Owner edits a load's broker #: its papers are re-filed in Drive", async () => {
  const L = (await adminDocs("loads")).find((l) => l.destination === "Denver, CO");
  const papers = (await adminDocs("documents")).filter((d) => d.loadId === L.id && !d.fileCleared && d.status !== "rejected");
  if (!papers.length) throw new Error("Expected papers on the load");
  const calls = driveCalls.length;
  await nav(owner, "Loads");
  await owner.locator('[aria-label="Stage"] .chip', { hasText: /^All/ }).first().click(); // it's paid, so not under Active
  await owner.locator(".item", { hasText: "Boise, ID → Denver, CO" }).first().getByRole("button", { name: "Edit", exact: true }).click();
  const F = owner.locator(".form-card");
  await F.getByLabel("Load #").fill("4471999");
  await F.getByRole("button", { name: "Save changes" }).click();
  await toast(owner, "Load saved");
  await waitFor(() => papers.every((d) => driveCalls.slice(calls).some((c) => c.docId === d.id && c.ok)), "Not every paper on the load was re-filed");
  if ((await adminDocs("loads")).find((l) => l.id === L.id).loadNo !== "4471999") throw new Error("Load # didn't save");
  await seed((db) => setDoc(doc(db, "loads", L.id), { loadNo: "4471823" }, { merge: true })); // later steps search for it
  await nav(owner, "Overview");
});

await run("Driver takes back a wrong upload before it's reviewed (and its Drive copy goes too)", async () => {
  await nav(driver, "Loads");
  const R = driver.locator(".card", { hasText: "Lumpers, repairs, tolls" });
  await R.getByLabel("Type").selectOption("Tolls");
  await R.getByLabel("Amount ($)").fill("12");
  await R.locator('input[data-role="camera"]').setInputFiles({ name: "toll.png", mimeType: "image/png", buffer: noisyPng(600, 800) });
  await R.locator(".scan-item").first().waitFor();
  await R.getByRole("button", { name: "Send receipt" }).click();
  await toast(driver, "Receipt sent to dispatch");
  const toll = await (async () => { let d; await waitFor(async () => (d = (await adminDocs("documents")).find((x) => x.name === "Tolls receipt · $12.00")), "Toll receipt not saved"); return d; })();
  await waitFor(() => driveFiles.has("file_" + toll.id), "Toll receipt not copied to Drive");
  await nav(driver, "My uploads");
  driver.once("dialog", (dl) => dl.accept());
  await driver.locator(".row", { hasText: "Tolls receipt" }).filter({ hasText: "Waiting for review" }).first().getByRole("button", { name: "Delete" }).click();
  await toast(driver, "Paper deleted");
  if ((await adminDocs("documents")).some((d) => d.id === toll.id)) throw new Error("Record still there");
  if ((await adminDocs("docFiles")).some((d) => d.id === toll.id)) throw new Error("Scan still there");
  if (!driveFiles.get("file_" + toll.id).trashed) throw new Error("Drive copy not trashed");
  // approved papers can't be deleted by the driver
  if (await driver.locator(".row", { hasText: "Approved" }).getByRole("button", { name: "Delete" }).count()) throw new Error("Driver can delete approved papers");
  await nav(driver, "Loads");
});

await run("Carrier deletes a paper that only lives in Drive: record and Drive copy both go, storage count drops", async () => {
  const reg = (await adminDocs("documents")).find((d) => d.name === "Registration Unit 7");
  await nav(carrier, "Documents");
  carrier.once("dialog", (dl) => dl.accept());
  await carrier.locator(".card", { hasText: "Document vault" }).locator(".row", { hasText: "Registration Unit 7" }).first().getByRole("button", { name: "Delete" }).click();
  await toast(carrier, "Paper deleted");
  if ((await adminDocs("documents")).some((d) => d.id === reg.id)) throw new Error("Record still there");
  if (!driveFiles.get(reg.driveFileId)?.trashed) throw new Error("Drive copy not trashed");
});

await run("Carrier deletes a load they booked, keeping its papers; they can't delete a dispatched load", async () => {
  await nav(carrier, "Loads");
  if (await carrier.locator(".item", { hasText: "Boise, ID → Denver, CO" }).first().getByRole("button", { name: "Delete" }).count()) throw new Error("Carrier can delete a dispatched load");
  await carrier.getByRole("button", { name: "+ New load" }).click();
  const F = carrier.locator(".form-card");
  await F.getByLabel("Pickup (City, ST)").fill("Nampa, ID");
  await F.getByLabel("Delivery (City, ST)").fill("Ogden, UT");
  await F.getByLabel("Rate ($)").fill("500");
  await F.getByRole("button", { name: "Save load", exact: true }).click();
  await toast(carrier, "Load booked");
  const item = carrier.locator(".item", { hasText: "Nampa, ID → Ogden, UT" }).first();
  await item.getByRole("button", { name: /Scan paperwork/ }).click();
  const dlg = carrier.locator("dialog[open]");
  await dlg.locator('input[data-role="choose"]').setInputFiles({ name: "bol.png", mimeType: "image/png", buffer: noisyPng(500, 700) });
  await dlg.locator(".scan-item").first().waitFor();
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await toast(carrier, "Paperwork saved");
  const L = (await adminDocs("loads")).find((l) => l.destination === "Ogden, UT");
  let paper;
  await waitFor(async () => (paper = (await adminDocs("documents")).find((d) => d.loadId === L.id)), "Paper not saved on the load");
  await item.getByRole("button", { name: "Delete" }).click();
  await carrier.locator("dialog[open]").getByRole("button", { name: "Delete load, keep the papers" }).click();
  await toast(carrier, "Load deleted");
  await waitFor(async () => !(await adminDocs("loads")).some((l) => l.id === L.id), "Load still there");
  if ((await adminDocs("loadMoney")).some((m) => m.id === L.id)) throw new Error("Load money record left behind");
  const kept = (await adminDocs("documents")).find((d) => d.id === paper.id);
  if (!kept || kept.loadId) throw new Error("Paper should be kept and unlinked");
  await nav(carrier, "Summary");
});

await run("Pop-ups never cover the page: at most two at once, repeats roll into one", async () => {
  await owner.evaluate(async () => {
    const { toast } = await import("./js/ui.js");
    for (let i = 0; i < 12; i++) toast("Paper deleted", "ok");
    for (let i = 0; i < 5; i++) toast((n) => `Copied ${n} file${n === 1 ? "" : "s"} to Google Drive`, "ok", { key: "drive-ok", add: 2 });
    toast("Saved", "ok");
  });
  let n = await owner.locator("#toasts .toast").count();
  if (n > 1) throw new Error(`${n} pop-ups on screen for good news`);
  await owner.locator("#toasts .toast", { hasText: "Saved" }).waitFor(); // the newest message is the one showing
  await owner.evaluate(async () => {
    const { toast } = await import("./js/ui.js");
    toast("Couldn't reach Google Drive", "bad");
    for (let i = 0; i < 3; i++) toast((n) => `Copied ${n} file${n === 1 ? "" : "s"} to Google Drive`, "ok", { key: "drive-ok", add: 2 });
  });
  n = await owner.locator("#toasts .toast").count();
  if (n !== 2) throw new Error(`Expected one good + one problem pop-up, saw ${n}`);
  await owner.locator("#toasts .toast", { hasText: "Copied 16 files to Google Drive" }).waitFor(); // counts carry over
  await owner.locator("#toasts .toast-bad").click(); // tap to dismiss
  await owner.locator("#toasts .toast-bad").waitFor({ state: "detached" });
});

await run("Owner selects several papers and deletes them in one go", async () => {
  const ids = [];
  await seed(async (db) => {
    const cid = (await getDocs(collection(db, "carriers"))).docs.find((d) => d.data().name === "Test Carrier A").id;
    for (let i = 0; i < 6; i++) {
      const id = "bulkPick" + i; ids.push(id);
      await setDoc(doc(db, "documents", id), { carrierId: cid, kind: "Other", name: `Bulk test paper ${i}`, status: "approved", uploadedBy: ownerUid, uploaderName: "Test Owner", uploaderRole: "owner", createdAt: new Date() });
      await setDoc(doc(db, "docFiles", id), { carrierId: cid, uploadedBy: ownerUid, data: "data:image/jpeg;base64,AAAA" });
    }
  });
  await nav(owner, "Documents");
  const card = owner.locator(".card", { hasText: "All documents" });
  await owner.getByLabel("Search all documents").fill("Bulk test paper");
  await card.locator(".doc-row").nth(5).waitFor();
  await card.getByRole("button", { name: "Select", exact: true }).click();
  await card.getByRole("button", { name: "Select all 6 shown" }).click();
  await card.locator(".doc-row", { hasText: "Bulk test paper 5" }).getByRole("checkbox").uncheck();
  await card.getByText("5 selected").waitFor();
  owner.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: "Delete 5" }).click();
  await toast(owner, "Deleted 5 papers");
  const left = (await adminDocs("documents")).filter((d) => ids.includes(d.id));
  if (left.length !== 1 || left[0].id !== "bulkPick5") throw new Error("Wrong papers deleted: " + left.map((d) => d.id).join(","));
  if ((await adminDocs("docFiles")).filter((f) => ids.includes(f.id)).length !== 1) throw new Error("Scans left behind");
  if ((await owner.locator("#toasts .toast").count()) > 2) throw new Error("Pop-ups piled up during the bulk delete");
  await owner.getByLabel("Search all documents").fill("");
});

// ---------- 8. Phone layout ----------
await run("Driver screens fit a phone with no sideways scrolling", async () => {
  for (const view of ["Loads", "My uploads", "Pay"]) {
    await nav(driver, view);
    await driver.waitForTimeout(400);
    const o = await overflow(driver);
    if (o > 2) throw new Error(`${view} page is ${o}px too wide on a phone`);
  }
});

await run("Owner, carrier and dispatcher pages fit a phone", async () => {
  for (const [who, p, views] of [["owner", owner, ["Overview", "Summary", "Loads", "Expenses", "Accounts", "Carriers"]], ["carrier", carrier, ["Summary", "Loads", "Expenses", "1099", "Drivers & trucks", "Documents", "Paystubs"]], ["dispatcher", dispatcher, ["Tasks", "Loads"]]]) {
    await p.setViewportSize({ width: 390, height: 844 });
    for (const v of views) {
      await nav(p, v);
      await p.waitForTimeout(400);
      const o = await overflow(p);
      if (o > 2) throw new Error(`${who} → ${v} is ${o}px too wide on a phone`);
    }
    await p.setViewportSize({ width: 1280, height: 900 });
  }
});

for (const [who, p] of Object.entries(pages)) await p.screenshot({ path: `${OUT}/flow-${who}.png`, fullPage: true }).catch(() => {});

// ---------- 9. Volume ----------
const CARRIERS = 40, LOADS = 2000, PENDING_DOCS = 300, REQUESTS = 150;
await run(`Seed volume: ${CARRIERS} carriers, ${LOADS} loads, ${PENDING_DOCS} docs awaiting review, ${REQUESTS} requests`, async () => {
  const t0 = Date.now();
  await seed(async (db) => {
    const cids = [];
    let b = writeBatch(db), n = 0;
    const flush = async () => { if (n) { await b.commit(); b = writeBatch(db); n = 0; } };
    const add = async (ref, data) => { b.set(ref, data); if (++n >= 450) await flush(); };
    for (let i = 0; i < CARRIERS; i++) {
      const r = doc(collection(db, "carriers"));
      cids.push(r.id);
      await add(r, { name: `Volume Carrier ${String(i + 1).padStart(2, "0")}`, feePercent: 8 });
    }
    const statuses = ["booked", "in_transit", "delivered", "delivered", "delivered"];
    for (let i = 0; i < LOADS; i++) {
      const r = doc(collection(db, "loads"));
      const cid = cids[i % CARRIERS];
      const created = new Date(Date.now() - (i % 120) * 86400000);
      await add(r, { carrierId: cid, origin: `City ${i % 50}, ID`, destination: `Town ${i % 37}, UT`, miles: 200 + (i % 900), status: statuses[i % 5], driverName: `Driver ${i % 90}`, truckUnit: `Unit ${i % 60}`, dispatcherName: "Volume", createdAt: created, pickupDate: created.toISOString().slice(0, 10) });
      await add(doc(db, "loadMoney", r.id), { carrierId: cid, rate: 1000 + (i % 3000), fee: 80 + (i % 240), feePaid: i % 3 === 0 });
    }
    for (let i = 0; i < PENDING_DOCS; i++) {
      await add(doc(collection(db, "documents")), { carrierId: cids[i % CARRIERS], status: "pending", kind: "BOL", name: `BOL · VOL${i}`, uploaderName: `Driver ${i % 90}`, createdAt: new Date() });
    }
    for (let i = 0; i < REQUESTS; i++) {
      await add(doc(collection(db, "requests")), { carrierId: cids[i % CARRIERS], status: "open", text: `Truck ${i} empty, want reefer freight west`, createdBy: "seed", createdAt: new Date() });
    }
    await flush();
  });
  timings.push(["Seed volume data (server side)", Date.now() - t0]);
});

await run("Owner Overview loads with the full volume", async () => {
  const t0 = Date.now();
  await home(owner);
  await heading(owner, "Overview");
  await owner.locator(".stat-value", { hasText: String(CARRIERS + 1) }).first().waitFor({ timeout: 60000 });
  await owner.locator(".more", { hasText: /of 30\d/ }).first().waitFor({ timeout: 60000 });
  await owner.locator(".more", { hasText: `of ${LOADS + 2}` }).first().waitFor({ timeout: 60000 });
  await owner.locator("table tbody tr").nth(99).waitFor({ timeout: 60000 });
  timings.push([`Owner Overview with ${LOADS} loads, ${PENDING_DOCS} pending docs, ${REQUESTS} requests`, Date.now() - t0]);
  const rows = await owner.locator("table tbody tr").count();
  const dom = await owner.evaluate(() => document.getElementsByTagName("*").length);
  timings.push([`→ table rows rendered: ${rows}, page elements: ${dom}`, 0]);
});

await run("Owner switches to the Loads page with the full volume", async () => {
  const t0 = Date.now();
  await nav(owner, "Loads");
  await owner.locator(".items .item").nth(49).waitFor({ timeout: 60000 });
  timings.push(["Owner Loads page (volume)", Date.now() - t0]);
});

await run("Loads search finds one load among 2,000", async () => {
  const t0 = Date.now();
  await owner.locator('[aria-label="Stage"] .chip').nth(1).click(); // "All"
  await owner.getByLabel("Search loads").fill("4471823");
  await owner.waitForFunction(() => document.querySelectorAll(".items .item").length === 1, null, { timeout: 15000 });
  timings.push(["Search 2,000 loads", Date.now() - t0]);
  await owner.getByLabel("Search loads").fill("");
});

await run("Loads stage filter responds quickly at volume", async () => {
  const t0 = Date.now();
  await owner.locator('[aria-label="Stage"] .chip', { hasText: "In transit" }).click();
  await owner.waitForFunction(() => { const it = [...document.querySelectorAll(".items .item")]; return it.length && it.every((x) => x.classList.contains("st-in_transit")); }, null, { timeout: 30000 });
  timings.push(["Filter loads to In transit (volume)", Date.now() - t0]);
});

await run("Owner Summary across 41 carriers at volume", async () => {
  const t0 = Date.now();
  await nav(owner, "Summary");
  await owner.getByLabel("Carrier", { exact: true }).selectOption("all");
  await owner.locator(".chip", { hasText: "All time" }).first().click();
  await owner.locator("table.sum th", { hasText: "Volume Carrier 40" }).waitFor({ timeout: 60000 });
  timings.push(["Owner Summary, all carriers, all time (volume)", Date.now() - t0]);
});

await run("An all-carriers dispatcher loads Tasks across 41 carriers", async () => {
  await seed(async (db) => {
    const { getDocs, query, collection: col, where: w } = await import("firebase/firestore");
    const snap = await getDocs(query(col(db, "users"), w("username", "==", "dana.dispatch")));
    await setDoc(snap.docs[0].ref, { allCarriers: true }, { merge: true });
  });
  const t0 = Date.now();
  await home(dispatcher);
  await heading(dispatcher, "Tasks");
  await dispatcher.locator(".more", { hasText: /of 30\d/ }).first().waitFor({ timeout: 60000 });
  await dispatcher.locator("table tbody tr").nth(99).waitFor({ timeout: 60000 });
  timings.push(["All-carriers dispatcher Tasks page (volume)", Date.now() - t0]);
});

await run("Carrier's own dashboard is unaffected by other carriers' volume", async () => {
  const t0 = Date.now();
  await home(carrier);
  await heading(carrier, "Summary");
  await carrier.locator(".stat-value", { hasText: "$3,100.00" }).first().waitFor(); // their two loads, nobody else's
  timings.push(["Carrier Overview while system holds volume", Date.now() - t0]);
  const body = await carrier.locator("body").innerText();
  if (/Volume Carrier|City \d+, ID/.test(body)) throw new Error("Carrier can see other carriers' data");
});

// ---------- 9. Stress: editing and deleting at volume, races and double taps ----------
const stress = {};
await run("Stress: seed a 40-paper load and 30 company papers (with scans) for the carrier", async () => {
  const users = await adminDocs("users"), carriers = await adminDocs("carriers");
  stress.cid = carriers.find((c) => c.name === "Test Carrier A").id;
  const adm = users.find((u) => u.role === "carrierAdmin" && u.carrierId === stress.cid);
  const drv = users.find((u) => u.name === "Drew Driver");
  const disp = users.find((u) => u.role === "dispatcher" && u.name === "Dana Dispatch") || users.find((u) => u.role === "dispatcher");
  const data = "data:image/jpeg;base64," + Buffer.from("x".repeat(3000)).toString("base64");
  await seed(async (db) => {
    let b = writeBatch(db), n = 0;
    const add = async (ref, d) => { b.set(ref, d); if (++n >= 400) { await b.commit(); b = writeBatch(db); n = 0; } };
    await add(doc(db, "loads", "STRESSLOAD01"), { carrierId: stress.cid, loadNo: "STRESS-1", origin: "Boise, ID", destination: "Reno, NV", pickupDate: "2026-10-05", status: "booked", dispatcherId: disp.id, dispatcherName: disp.name || "", createdAt: new Date() });
    await add(doc(db, "loadMoney", "STRESSLOAD01"), { carrierId: stress.cid, rate: 1500, fee: 120, feePaid: false });
    const kinds = ["BOL", "POD", "Lumper", "Receipt"];
    for (let i = 0; i < 40; i++) {
      const id = `stressPaper${String(i).padStart(3, "0")}`, kind = kinds[i % 4];
      await add(doc(db, "documents", id), { carrierId: stress.cid, loadId: "STRESSLOAD01", loadLabel: "#STRESS Boise, ID → Reno, NV", kind, name: `${kind} stress ${i}`, status: i === 0 ? "pending" : "approved", uploadedBy: drv.id, uploaderName: "Drew Driver", uploaderRole: "driver", amount: kind === "Lumper" ? 40 + i : null, size: data.length, hash: "stress" + i, createdAt: i === 0 ? new Date("2020-01-02") : new Date() }); // the pending one sorts first in review queues
      await add(doc(db, "docFiles", id), { carrierId: stress.cid, uploadedBy: drv.id, data });
    }
    for (let i = 0; i < 30; i++) {
      const id = `stressCompany${String(i).padStart(3, "0")}`;
      await add(doc(db, "documents", id), { carrierId: stress.cid, kind: "Insurance", category: "Insurance", name: `Stress company paper ${String(i + 1).padStart(2, "0")}`, status: "filed", uploadedBy: adm.id, uploaderName: adm.name || "", uploaderRole: "carrierAdmin", size: data.length, hash: "stressc" + i, createdAt: new Date() });
      await add(doc(db, "docFiles", id), { carrierId: stress.cid, uploadedBy: adm.id, data });
    }
    if (n) await b.commit();
  });
});

await run("Stress: back up 70 new scans at volume; the 300 volume records with no scan are reported, not fatal", async () => {
  const t0 = Date.now();
  await nav(owner, "Settings");
  const card = owner.locator(".card", { hasText: "Storage & backup" });
  // (opening Settings may update the report first: the carrier deleted a backed-up paper since)
  await card.getByRole("button", { name: "Back up to Drive" }).click();
  await owner.locator(".toast", { hasText: /Backed up \d+ scans to Google Drive, \d+ didn't make it/ }).first().waitFor({ timeout: 240000 });
  await card.getByRole("button", { name: "Back up to Drive", exact: true }).waitFor({ timeout: 60000 });
  timings.push(["Back up 70 scans while 300 records have no scan", Date.now() - t0]);
  const missing = (await adminDocs("documents")).filter((d) => d.id.startsWith("stress") && !d.backedUpAt);
  if (missing.length) throw new Error(`${missing.length} stress papers weren't backed up`);
  if (!backupPdfs[backupPdfs.length - 1].text.includes("didn't make it")) throw new Error("Report should list the records that have no scan");
});

await run("Stress: owner gives the 40-paper load a new broker #; every paper is re-filed in Drive", async () => {
  const t0 = Date.now(), calls = driveCalls.length;
  await nav(owner, "Loads");
  await owner.locator('[aria-label="Stage"] .chip', { hasText: /^All/ }).first().click();
  await owner.getByLabel("Search loads").fill("STRESS-1");
  await owner.locator(".item", { hasText: "Boise, ID → Reno, NV" }).first().getByRole("button", { name: "Edit", exact: true }).click();
  const F = owner.locator(".form-card");
  await F.getByLabel("Load #").fill("STRESS-2");
  await F.getByRole("button", { name: "Save changes" }).click();
  await toast(owner, "Load saved");
  await waitFor(() => new Set(driveCalls.slice(calls).filter((c) => c.ok && String(c.docId).startsWith("stressPaper")).map((c) => c.docId)).size === 40, "Not all 40 papers were re-filed", 120000);
  timings.push(["Re-file 40 papers after a load edit", Date.now() - t0]);
  await owner.getByLabel("Search loads").fill("");
});

await run("Stress: owner and carrier edit the same paper at the same moment; one wins cleanly, one Drive copy", async () => {
  await nav(owner, "Documents");
  await owner.getByLabel("Search all documents").fill("Stress company paper 01");
  await nav(carrier, "Documents");
  await carrier.getByLabel("Search documents").fill("Stress company paper 01");
  await owner.locator(".doc-row", { hasText: "Stress company paper 01" }).first().getByRole("button", { name: "Edit" }).click();
  await carrier.locator(".card", { hasText: "Document vault" }).locator(".row", { hasText: "Stress company paper 01" }).first().getByRole("button", { name: "Edit" }).click();
  await owner.locator("dialog[open]").getByLabel("Note").fill("owner's note");
  await carrier.locator("dialog[open]").getByLabel("Note").fill("carrier's note");
  // watch both screens at once: each confirmation is on screen for a moment, then the next message takes its turn
  await Promise.all([
    toast(owner, "Paper saved"),
    toast(carrier, "Paper saved"),
    owner.locator("dialog[open]").getByRole("button", { name: "Save", exact: true }).click(),
    carrier.locator("dialog[open]").getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  const d = (await adminDocs("documents")).find((x) => x.id === "stressCompany000");
  if (!["owner's note", "carrier's note"].includes(d.note)) throw new Error("Unexpected note: " + d.note);
  await waitFor(() => [...driveFiles.values()].filter((f) => f.docId === "stressCompany000" && !f.trashed).length === 1, "Should be exactly one Drive copy");
  await owner.getByLabel("Search all documents").fill("");
});

await run("Stress: a paper deleted while waiting in dispatch's queue vanishes there; a stale Approve says so plainly", async () => {
  await nav(dispatcher, "Tasks");
  const row = dispatcher.locator(".row", { hasText: "BOL stress 0" }).first();
  await row.waitFor({ timeout: 30000 });
  await nav(carrier, "Loads");
  await carrier.getByLabel("Search loads").fill("STRESS-2");
  await carrier.locator(".item", { hasText: "Boise, ID → Reno, NV" }).first().getByRole("button", { name: /Scan paperwork/ }).click();
  const dlg = carrier.locator("dialog[open]");
  carrier.once("dialog", (x) => x.accept());
  await dlg.locator(".row", { hasText: "BOL stress 0" }).first().getByRole("button", { name: "Delete" }).click();
  await toast(carrier, "Paper deleted");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await row.waitFor({ state: "detached", timeout: 15000 });
  await dispatcher.evaluate(async () => {
    const { db, doc, updateDoc } = await import("./js/fb.js");
    const { guardDoc } = await import("./js/components.js");
    await guardDoc("stressPaper000", () => updateDoc(doc(db, "documents", "stressPaper000"), { status: "approved" }), "Approved");
  });
  await toast(dispatcher, "Someone else just deleted that paper.");
  if ((await adminDocs("docFiles")).some((f) => f.id === "stressPaper000")) throw new Error("Scan left behind");
  await carrier.getByLabel("Search loads").fill("");
});

await run("Stress: double-tapping Delete asks once and deletes once", async () => {
  await nav(carrier, "Documents");
  await carrier.getByLabel("Search documents").fill("Stress company paper 02");
  let asked = 0;
  const accept = (x) => { asked++; x.accept(); };
  carrier.on("dialog", accept);
  await carrier.locator(".card", { hasText: "Document vault" }).locator(".row", { hasText: "Stress company paper 02" }).first().getByRole("button", { name: "Delete" }).dblclick();
  await toast(carrier, "Paper deleted");
  await carrier.waitForTimeout(1500);
  carrier.off("dialog", accept);
  if (asked !== 1) throw new Error(`Asked ${asked} times`);
  if ((await adminDocs("documents")).some((d) => d.id === "stressCompany001")) throw new Error("Not deleted");
  const removes = driveCalls.filter((c) => c.docId === "stressCompany001" && c.deleting);
  if (removes.length !== 1) throw new Error(`Drive was asked to remove it ${removes.length} times`);
});

await run("Stress: carrier deletes 20 papers back to back", async () => {
  const t0 = Date.now();
  await carrier.getByLabel("Search documents").fill("Stress company paper");
  const vault = carrier.locator(".card", { hasText: "Document vault" });
  const rows = vault.locator(".row", { hasText: "Stress company paper" });
  const accept = (x) => x.accept();
  carrier.on("dialog", accept);
  try {
    for (let i = 0; i < 20; i++) {
      const before = await rows.count();
      await rows.first().getByRole("button", { name: "Delete" }).click();
      await waitFor(async () => (await rows.count()) < before, `Delete ${i + 1} didn't finish`);
    }
  } finally { carrier.off("dialog", accept); }
  timings.push(["Carrier deletes 20 papers one after another", Date.now() - t0]);
  const left = (await adminDocs("documents")).filter((d) => d.id.startsWith("stressCompany"));
  if (left.length !== 9) throw new Error(`Expected 9 company papers left, found ${left.length}`);
  await carrier.getByLabel("Search documents").fill("");
});

await run("Stress: owner deletes the 40-paper load together with all its papers", async () => {
  const t0 = Date.now();
  await nav(owner, "Loads");
  await owner.locator('[aria-label="Stage"] .chip', { hasText: /^All/ }).first().click();
  await owner.getByLabel("Search loads").fill("STRESS-2");
  await owner.locator(".item", { hasText: "Boise, ID → Reno, NV" }).first().getByRole("button", { name: "Delete" }).click();
  await owner.locator("dialog[open]").getByRole("button", { name: /Delete load and its 39 papers/ }).click();
  await toast(owner, "Load deleted");
  timings.push(["Delete a load with 39 papers (and their Drive copies)", Date.now() - t0]);
  const docs = await adminDocs("documents");
  if (docs.some((d) => d.loadId === "STRESSLOAD01" || d.id.startsWith("stressPaper"))) throw new Error("Papers left behind");
  if ((await adminDocs("docFiles")).some((f) => f.id.startsWith("stressPaper"))) throw new Error("Scans left behind");
  if ((await adminDocs("loads")).some((l) => l.id === "STRESSLOAD01") || (await adminDocs("loadMoney")).some((m) => m.id === "STRESSLOAD01")) throw new Error("Load left behind");
  const live = [...driveFiles.values()].filter((f) => !f.trashed && f.docId.startsWith("stressPaper"));
  if (live.length) throw new Error(`${live.length} Drive copies left behind`);
  // the backup report is made again without them (and without the carrier's deletes before this)
  const n = await inDriveNow();
  await waitFor(() => reportSays(n) && !lastReport().includes("BOL stress") && !lastReport().includes("Stress company paper 02"), "The backup report still lists deleted papers", 60000);
  await owner.getByLabel("Search loads").fill("");
});

await run("Stress: free up space at volume, then no orphans anywhere and the storage meter matches the records", async () => {
  await nav(owner, "Settings");
  const card = owner.locator(".card", { hasText: "Storage & backup" });
  owner.once("dialog", (x) => x.accept());
  await card.getByRole("button", { name: "Free up space" }).click();
  await toast(owner, /Freed about/);
  const docs = await adminDocs("documents"), scans = await adminDocs("docFiles");
  const ids = new Set(docs.map((d) => d.id));
  const orphanScans = scans.filter((f) => !ids.has(f.id));
  if (orphanScans.length) throw new Error(`${orphanScans.length} scans without a record`);
  const orphanDrive = [...driveFiles.values()].filter((f) => !f.trashed && !ids.has(f.docId));
  if (orphanDrive.length) throw new Error(`${orphanDrive.length} Drive copies of deleted papers, e.g. ${orphanDrive[0].docId}`);
  const lost = docs.filter((d) => d.fileFreed && !(driveFiles.get(d.driveFileId) && !driveFiles.get(d.driveFileId).trashed));
  if (lost.length) throw new Error(`${lost.length} moved scans missing from Drive`);
  const backedStillHere = docs.filter((d) => d.backedUpAt && !d.fileFreed && scans.some((f) => f.id === d.id));
  if (backedStillHere.length) throw new Error(`${backedStillHere.length} backed-up scans weren't freed`);
  const held = docs.filter((d) => !d.fileFreed && !d.fileCleared).length;
  try {
    await owner.waitForFunction((n) => {
      const t = [...document.querySelectorAll(".stat")].find((x) => x.querySelector(".stat-label")?.textContent === "Scans in KeepTrack");
      return t && t.querySelector(".stat-value").textContent.replace(/,/g, "") === String(n);
    }, held, { timeout: 30000 });
  } catch (e) {
    const meter = await card.innerText().catch(() => "?");
    const freed = docs.filter((d) => d.fileFreed).length, cleared = docs.filter((d) => d.fileCleared).length;
    throw new Error(`Meter doesn't match: records say ${held} held (${docs.length} total, ${freed} freed, ${cleared} cleared); card says: ${meter.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  await waitFor(async () => reportSays(await inDriveNow()), "The backup report doesn't match what's in Drive", 60000);
  const n = await inDriveNow();
  await card.getByText(`Backup report: ${n} scan${n === 1 ? "" : "s"} in Drive`).waitFor({ timeout: 30000 });
});

for (const [who, p] of Object.entries(pages)) await p.screenshot({ path: `${OUT}/volume-${who}.png` }).catch(() => {});

// ---------- Report ----------
await browser.close();
server.kill();
driveServer.close();
console.log(`Drive copies: ${driveCalls.filter((c) => c.ok).length} ok, ${driveCalls.filter((c) => !c.ok).length} refused`);
await env.cleanup();

const failed = results.filter((r) => !r.ok);
const uniqueProblems = [...new Set(problems)];
console.log(`\n${results.length - failed.length}/${results.length} end-to-end steps passed`);
console.log("\nTimings:");
for (const [n, ms] of timings) console.log(`  ${n}${ms ? ": " + (ms / 1000).toFixed(1) + " s" : ""}`);
if (uniqueProblems.length) { console.log("\nBrowser errors:"); uniqueProblems.forEach((p) => console.log("  " + p)); }

for (const f of failed.slice(0, 8)) console.log(`::error title=E2E failed::${f.name} — ${f.err}`);
for (const p of uniqueProblems.slice(0, 2)) console.log(`::warning title=Browser error::${p.slice(0, 300)}`);
console.log(`::notice title=End-to-end::${results.length - failed.length}/${results.length} steps passed, ${uniqueProblems.length} browser errors`);
console.log(`::notice title=Timings::${timings.map(([n, ms]) => n + (ms ? " " + (ms / 1000).toFixed(1) + "s" : "")).join(" | ")}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## End-to-end: ${results.length - failed.length}/${results.length} passed\n\n` +
    results.map((r) => `- ${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : " — " + r.err}`).join("\n") +
    `\n\n### Timings\n` + timings.map(([n, ms]) => `- ${n}${ms ? ": " + (ms / 1000).toFixed(1) + " s" : ""}`).join("\n") +
    (uniqueProblems.length ? `\n\n### Browser errors\n` + uniqueProblems.map((p) => "- " + p).join("\n") : "") + "\n");
}
process.exit(failed.length ? 1 : 0);
