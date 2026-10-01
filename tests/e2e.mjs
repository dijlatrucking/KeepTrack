// End-to-end + volume stress test. Drives the real app in headless Chromium against local emulators,
// playing owner, carrier admin, dispatcher and driver at the same time.
// Run:  npx firebase emulators:exec --only firestore,auth --project demo-keeptrack "node e2e.mjs"
import { chromium } from "playwright";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, writeBatch, collection } from "firebase/firestore";
import { PNG } from "pngjs";
import { spawn } from "node:child_process";
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
for (const p of ["index.html", "css", "js"]) cpSync(ROOT + p, SITE + "/" + p, { recursive: true });
const cfgPath = SITE + "/js/firebase-config.js";
writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(/projectId: "[^"]+"/, `projectId: "${PROJECT}"`));
const fbPath = SITE + "/js/fb.js";
writeFileSync(fbPath, readFileSync(fbPath, "utf8") + `
import { connectAuthEmulator as __cae } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { connectFirestoreEmulator as __cfe } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
__cae(auth, "http://127.0.0.1:9099", { disableWarnings: true });
__cfe(db, "127.0.0.1", 8080);
`);
const server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", SITE], { stdio: "ignore" });
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

const ownerUid = await authUser("owner@test.dev", "owner-pass-1");
await seed((db) => setDoc(doc(db, "users", ownerUid), { role: "owner", name: "Test Owner", email: "owner@test.dev" }));

// ---------- Harness ----------
const results = [];
const problems = [];
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
    if (m.type() === "error" && !/favicon|ERR_FAILED.*fonts/.test(m.text())) problems.push(`[${who}] console: ${m.text().slice(0, 200)}`);
  });
  pages[who] = p;
  await p.goto(BASE);
  return p;
}
const toast = (p, text) => p.locator(".toast", { hasText: text }).first().waitFor();
const heading = (p, name) => p.getByRole("heading", { name, exact: true }).first().waitFor();
const nav = (p, label) => p.locator("nav.side a", { hasText: label }).first().click();
const overflow = async (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const home = async (p) => { await p.evaluate(() => history.replaceState(null, "", location.pathname)); await p.reload(); };
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

function noisyPng(w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    png.data[i] = v; png.data[i + 1] = (v + 40) & 255; png.data[i + 2] = (v * 3) & 255; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
const tinyPdf = Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");

// ---------- 1. Owner signs in ----------
let owner, carrier, dispatcher, driver, driverCode;
await run("Owner signs in and lands on Overview", async () => {
  owner = await open("owner");
  await owner.getByLabel("Email").fill("owner@test.dev");
  await owner.getByLabel("Password").fill("owner-pass-1");
  await owner.getByRole("button", { name: "Sign in" }).click();
  await heading(owner, "Overview");
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
  await carrier.getByLabel("Email").fill("carrier@test.dev");
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
  await heading(carrier, "Overview");
  await carrier.locator(".eyebrow", { hasText: "Test Carrier A" }).waitFor();
});

// ---------- 3. Dispatcher requests access, owner approves + assigns ----------
await run("Dispatcher requests access", async () => {
  dispatcher = await open("dispatcher");
  await dispatcher.getByRole("tab", { name: "Request access" }).click();
  await dispatcher.getByLabel("I'm signing up as").selectOption("dispatcher");
  await dispatcher.getByLabel("Full name").fill("Dana Dispatch");
  await dispatcher.getByLabel("Phone").fill("2085550101");
  await dispatcher.getByLabel("Email").fill("dispatch@test.dev");
  await dispatcher.getByLabel("Password").fill("dispatch-pass-1");
  await dispatcher.getByRole("button", { name: "Request access" }).click();
  await heading(dispatcher, "Request received");
});

await run("Owner approves the dispatcher and gives them Test Carrier A", async () => {
  await nav(owner, "Access requests");
  const row = owner.locator(".row", { hasText: "Dana Dispatch" }).first();
  await row.getByRole("button", { name: "Approve dispatcher" }).click();
  await toast(owner, "Approved");
  await nav(owner, "Team");
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
  await carrier.getByLabel("Type").selectOption("Reefer");
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
  await p.getByLabel("Email").fill("intruder@test.dev");
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
  await driver.getByLabel("Email").fill("driver@test.dev");
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
  await p.getByLabel("Email").fill("second@test.dev");
  await p.getByLabel("Password").fill("second-1");
  await p.getByRole("button", { name: "Create account" }).click();
  await p.locator(".form-error", { hasText: /invite code|access/i }).waitFor();
  await p.context().close();
  delete pages.reuser;
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

// ---------- 5. Dispatcher books a load ----------
await run("Dispatcher books a 500-mile, $2,000 load and the 8% fee fills in", async () => {
  await nav(dispatcher, "Loads");
  await dispatcher.getByRole("button", { name: "+ Book load" }).click();
  await dispatcher.locator("select[name=driver] option", { hasText: "Drew Driver" }).waitFor({ state: "attached" });
  await dispatcher.getByLabel("Driver").selectOption({ label: "Drew Driver" });
  if ((await dispatcher.getByLabel("Truck").inputValue()) === "") throw new Error("Truck didn't auto-fill from the driver");
  await dispatcher.getByLabel("Origin").fill("Boise, ID");
  await dispatcher.getByLabel("Destination").fill("Denver, CO");
  await dispatcher.getByLabel("Loaded miles").fill("500");
  await dispatcher.getByLabel("Load rate ($)").fill("2000");
  const fee = await dispatcher.getByLabel("Dispatch fee ($)").inputValue();
  if (fee !== "160.00") throw new Error("Fee auto-fill was " + fee);
  await dispatcher.getByRole("button", { name: "Book load", exact: true }).click();
  await toast(dispatcher, "Load booked");
  await dispatcher.locator("td", { hasText: "Boise, ID → Denver, CO" }).first().waitFor();
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
  await driver.locator("input[type=file]").first().setInputFiles({ name: "bol.png", mimeType: "image/png", buffer: noisyPng(2400, 3200) });
  await toast(driver, "Sent to dispatch");
  timings.push(["Shrink + upload a 7.7 MP worst-case photo", Date.now() - t0]);
});

await run("Carrier can NOT see the BOL yet (it hasn't been reviewed)", async () => {
  await nav(carrier, "Documents");
  await carrier.getByRole("heading", { name: "Document vault" }).waitFor();
  await carrier.waitForTimeout(1500);
  if (await carrier.getByText(/BOL · #/).count()) throw new Error("Unreviewed BOL visible to carrier");
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

await run("Approved BOL shows up in the carrier's vault and search finds it", async () => {
  await carrier.getByText(/BOL · #/).first().waitFor();
  const search = carrier.getByLabel("Search documents");
  await search.fill("bol");
  await carrier.getByText(/BOL · #/).first().waitFor();
  await search.fill("zzzz");
  await carrier.getByText("No matches.").waitFor();
  await search.fill("");
});

await run("Carrier uploads an insurance PDF that expires in 10 days and it gets flagged", async () => {
  await carrier.getByLabel("File (PDF or photo)").setInputFiles({ name: "coi.pdf", mimeType: "application/pdf", buffer: tinyPdf });
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
  await carrier.getByLabel("Driver").selectOption({ label: "Drew Driver" });
  await carrier.getByLabel("From").fill(iso(-7));
  await carrier.getByLabel("To").fill(iso(7));
  await carrier.getByLabel("To").dispatchEvent("change");
  await carrier.getByText("Gross pay: $300.00").waitFor();
  await carrier.getByRole("button", { name: "Issue paystub" }).click();
  await toast(carrier, "Paystub issued");
});

await run("Driver sees the $300 paystub", async () => {
  await nav(driver, "Pay");
  await driver.locator("details.stub", { hasText: "$300.00" }).first().waitFor();
});

await run("Carrier money adds up: $2,000 gross − $160 fee − $300 driver = $1,540 net", async () => {
  await nav(carrier, "Overview");
  for (const v of ["$2,000.00", "$160.00", "$300.00", "$1,540.00"]) await carrier.locator(".stat-value", { hasText: v }).first().waitFor();
});

await run("Owner marks the fee paid and the carrier's 'owed' drops to $0 live", async () => {
  await nav(owner, "Loads");
  await owner.locator("tr", { hasText: "Boise, ID → Denver, CO" }).getByRole("checkbox").check();
  const owed = carrier.locator(".stat", { hasText: "Owed to dispatch" }).locator(".stat-value");
  await owed.filter({ hasText: "$0.00" }).waitFor();
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
  await p.getByLabel("Email").fill("sketchy@test.dev");
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

// ---------- 8. Phone layout ----------
await run("Driver screens fit a phone with no sideways scrolling", async () => {
  for (const view of ["Loads", "Uploads", "Pay"]) {
    await nav(driver, view);
    await driver.waitForTimeout(400);
    const o = await overflow(driver);
    if (o > 2) throw new Error(`${view} page is ${o}px too wide on a phone`);
  }
});

await run("Owner, carrier and dispatcher pages fit a phone", async () => {
  for (const [who, p, views] of [["owner", owner, ["Overview", "Loads", "Carriers", "Team"]], ["carrier", carrier, ["Overview", "Drivers & trucks", "Documents", "Paystubs"]], ["dispatcher", dispatcher, ["Tasks", "Loads"]]]) {
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
  await owner.locator(".more", { hasText: "of 300" }).first().waitFor({ timeout: 60000 });
  await owner.locator(".more", { hasText: `of ${LOADS + 1}` }).first().waitFor({ timeout: 60000 });
  await owner.locator("table tbody tr").nth(99).waitFor({ timeout: 60000 });
  timings.push([`Owner Overview with ${LOADS} loads, ${PENDING_DOCS} pending docs, ${REQUESTS} requests`, Date.now() - t0]);
  const rows = await owner.locator("table tbody tr").count();
  const dom = await owner.evaluate(() => document.getElementsByTagName("*").length);
  timings.push([`→ table rows rendered: ${rows}, page elements: ${dom}`, 0]);
});

await run("Owner switches to the Loads page with the full volume", async () => {
  const t0 = Date.now();
  await nav(owner, "Loads");
  await owner.locator("table tbody tr").nth(99).waitFor({ timeout: 60000 });
  timings.push(["Owner Loads page (volume)", Date.now() - t0]);
});

await run("Load board search finds one load among 2,000", async () => {
  const t0 = Date.now();
  await owner.getByLabel("Search loads").fill("Boise, ID → Denver");
  await owner.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 1, null, { timeout: 15000 });
  timings.push(["Search 2,000 loads", Date.now() - t0]);
  await owner.getByLabel("Search loads").fill("");
});

await run("Load board filter responds quickly at volume", async () => {
  const t0 = Date.now();
  await owner.getByRole("button", { name: "In transit" }).click();
  await owner.waitForFunction(() => [...document.querySelectorAll("table tbody tr td:last-child select")].every((s) => s.value === "in_transit"), null, { timeout: 30000 });
  timings.push(["Filter load board to In transit (volume)", Date.now() - t0]);
});

await run("An all-carriers dispatcher loads Tasks across 41 carriers", async () => {
  await seed(async (db) => {
    const { getDocs, query, collection: col, where: w } = await import("firebase/firestore");
    const snap = await getDocs(query(col(db, "users"), w("email", "==", "dispatch@test.dev")));
    await setDoc(snap.docs[0].ref, { allCarriers: true }, { merge: true });
  });
  const t0 = Date.now();
  await home(dispatcher);
  await heading(dispatcher, "Tasks");
  await dispatcher.locator(".more", { hasText: "of 300" }).first().waitFor({ timeout: 60000 });
  await dispatcher.locator("table tbody tr").nth(99).waitFor({ timeout: 60000 });
  timings.push(["All-carriers dispatcher Tasks page (volume)", Date.now() - t0]);
});

await run("Carrier's own dashboard is unaffected by other carriers' volume", async () => {
  const t0 = Date.now();
  await home(carrier);
  await heading(carrier, "Overview");
  await carrier.locator(".stat-value", { hasText: "$2,000.00" }).first().waitFor();
  timings.push(["Carrier Overview while system holds volume", Date.now() - t0]);
  const body = await carrier.locator("body").innerText();
  if (/Volume Carrier|City \d+, ID/.test(body)) throw new Error("Carrier can see other carriers' data");
});

for (const [who, p] of Object.entries(pages)) await p.screenshot({ path: `${OUT}/volume-${who}.png` }).catch(() => {});

// ---------- Report ----------
await browser.close();
server.kill();
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
