// Security-rule attack tests. Every role tries to read and write what it should, and what it shouldn't.
// Run inside the Firestore emulator:  npx firebase emulators:exec --only firestore --project demo-keeptrack "node rules.test.mjs"
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, writeBatch,
} from "firebase/firestore";
import { readFileSync, appendFileSync } from "node:fs";

const env = await initializeTestEnvironment({
  projectId: "demo-keeptrack",
  firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
});
await env.clearFirestore();

// ---------- Seed: two carriers (A, B) and one of every role ----------
const U = {
  owner: { role: "owner", name: "Owner" },
  dispA: { role: "dispatcher", name: "Disp A", assignedCarriers: ["A"], allCarriers: false },
  dispAll: { role: "dispatcher", name: "Disp All", assignedCarriers: [], allCarriers: true },
  dispNone: { role: "dispatcher", name: "Disp None", assignedCarriers: [] },
  adminA: { role: "carrierAdmin", carrierId: "A", name: "Admin A" },
  adminB: { role: "carrierAdmin", carrierId: "B", name: "Admin B" },
  drvA1: { role: "driver", carrierId: "A", name: "Driver A1" },
  drvA2: { role: "driver", carrierId: "A", name: "Driver A2" },
  drvB1: { role: "driver", carrierId: "B", name: "Driver B1" },
  pend1: { role: "pending", requestedRole: "carrierAdmin", name: "Pending" },
};
await env.withSecurityRulesDisabled(async (c) => {
  const db = c.firestore();
  const put = (p, d) => setDoc(doc(db, p), d);
  for (const [id, d] of Object.entries(U)) await put(`users/${id}`, d);
  await put("carriers/A", { name: "Carrier A", feePercent: 8 });
  await put("carriers/B", { name: "Carrier B", feePercent: 10 });
  await put("trucks/tA1", { carrierId: "A", unit: "Unit 1" });
  await put("trucks/tB1", { carrierId: "B", unit: "Unit 9" });
  await put("loads/L1", { carrierId: "A", driverId: "drvA1", status: "booked", origin: "Boise", destination: "Reno" });
  await put("loads/L2", { carrierId: "A", driverId: "drvA2", status: "booked" });
  await put("loads/L3", { carrierId: "B", driverId: "drvB1", status: "booked" });
  await put("loadMoney/L1", { carrierId: "A", rate: 2000, fee: 160, feePaid: false });
  await put("loadMoney/L3", { carrierId: "B", rate: 1500, fee: 150, feePaid: false });
  await put("documents/D1", { carrierId: "A", uploadedBy: "drvA1", status: "pending", name: "BOL" });
  await put("documents/D2", { carrierId: "A", uploadedBy: "drvA1", status: "approved", name: "BOL ok" });
  await put("documents/D3", { carrierId: "B", uploadedBy: "drvB1", status: "pending", name: "BOL B" });
  await put("documents/D4", { carrierId: "A", uploadedBy: "adminA", status: "filed", name: "Insurance" });
  for (const d of ["D1", "D2", "D3", "D4"]) {
    const src = { D1: ["A", "drvA1"], D2: ["A", "drvA1"], D3: ["B", "drvB1"], D4: ["A", "adminA"] }[d];
    await put(`docFiles/${d}`, { carrierId: src[0], uploadedBy: src[1], data: "data:image/jpeg;base64,AAAA" });
  }
  await put("invites/DRVA", { role: "driver", carrierId: "A", used: false, createdBy: "adminA" });
  await put("invites/USED", { role: "driver", carrierId: "A", used: true, createdBy: "adminA" });
  await put("invites/CAB", { role: "carrierAdmin", carrierId: "B", used: false, createdBy: "owner" });
  await put("invites/DISP", { role: "dispatcher", carrierId: null, used: false, createdBy: "owner" });
  await put("invites/OWN2", { role: "driver", carrierId: "A", used: false, createdBy: "adminA" });
  await put("requests/R1", { carrierId: "A", createdBy: "adminA", status: "open", text: "Reno to Boise" });
  await put("requests/R2", { carrierId: "B", createdBy: "adminB", status: "open", text: "Denver" });
  await put("expenses/EA", { carrierId: "A", cat: "Insurance", amount: 1200 });
  await put("expenses/EB", { carrierId: "B", cat: "Fuel", amount: 300 });
  await put("paystubs/P1", { carrierId: "A", driverId: "drvA1", net: 500 });
  await put("paystubs/P2", { carrierId: "A", driverId: "drvA2", net: 600 });
});

const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const q = (db, coll, ...w) => query(collection(db, coll), ...w);
const eq = (f, v) => where(f, "==", v);

const results = [];
async function check(expect, name, fn) {
  try {
    await (expect === "allow" ? assertSucceeds(fn()) : assertFails(fn()));
    results.push({ ok: true, name: `${expect.toUpperCase()}: ${name}` });
  } catch (e) {
    results.push({ ok: false, name: `${expect.toUpperCase()}: ${name}`, err: String(e.message || e).slice(0, 200) });
  }
}
const allow = (n, f) => check("allow", n, f);
const deny = (n, f) => check("deny", n, f);

// ---------- Anonymous / no profile ----------
await deny("signed-out visitor reads a carrier", () => getDoc(doc(anon(), "carriers/A")));
await deny("signed-out visitor lists loads", () => getDocs(collection(anon(), "loads")));
await deny("signed-in user with no profile reads carrier A", () => getDoc(doc(as("stranger"), "carriers/A")));
await deny("no-profile user lists invites", () => getDocs(collection(as("stranger"), "invites")));
await allow("no-profile user looks up one invite code they hold", () => getDoc(doc(as("stranger"), "invites/DRVA")));

// ---------- Sign-up tricks ----------
await deny("sign up as owner with no invite", () => setDoc(doc(as("new1"), "users/new1"), { name: "x", email: "x", role: "owner" }));
await deny("request access asking to be owner", () => setDoc(doc(as("new2"), "users/new2"), { name: "x", email: "x", role: "pending", requestedRole: "owner" }));
await deny("request access sneaking in a carrierId", () => setDoc(doc(as("new3"), "users/new3"), { name: "x", email: "x", role: "pending", requestedRole: "carrierAdmin", carrierId: "A" }));
await deny("request access sneaking in allCarriers", () => setDoc(doc(as("new4"), "users/new4"), { name: "x", email: "x", role: "pending", requestedRole: "dispatcher", allCarriers: true }));
await allow("request access as a carrier", () => setDoc(doc(as("new5"), "users/new5"), { name: "x", email: "x", phone: "1", role: "pending", requestedRole: "carrierAdmin", company: "C", mc: "1", dot: "2", note: "", createdAt: new Date() }));
await deny("create a profile for someone else's uid", () => setDoc(doc(as("new6"), "users/other"), { name: "x", role: "pending", requestedRole: "dispatcher" }));
{
  const db = as("new7");
  const b = writeBatch(db);
  b.set(doc(db, "users/new7"), { name: "x", email: "x", role: "driver", carrierId: "A", invite: "USED" });
  b.update(doc(db, "invites/USED"), { used: true, usedBy: "new7" });
  await deny("sign up with an already-used invite", () => b.commit());
}
{
  const db = as("new8");
  const b = writeBatch(db);
  b.set(doc(db, "users/new8"), { name: "x", email: "x", role: "carrierAdmin", carrierId: "A", invite: "DRVA" });
  b.update(doc(db, "invites/DRVA"), { used: true, usedBy: "new8" });
  await deny("driver invite used to become carrier admin", () => b.commit());
}
{
  const db = as("new9");
  const b = writeBatch(db);
  b.set(doc(db, "users/new9"), { name: "x", email: "x", role: "driver", carrierId: "B", invite: "DRVA" });
  b.update(doc(db, "invites/DRVA"), { used: true, usedBy: "new9" });
  await deny("carrier A driver invite used to join carrier B", () => b.commit());
}
await deny("burn someone's invite without signing up", () => updateDoc(doc(as("new10"), "invites/DRVA"), { used: true, usedBy: "new10" }));
{
  const db = as("new11");
  const b = writeBatch(db);
  b.set(doc(db, "users/new11"), { name: "x", email: "x", role: "driver", carrierId: "A", invite: "DRVA", createdAt: new Date() });
  b.update(doc(db, "invites/DRVA"), { used: true, usedBy: "new11", usedAt: new Date() });
  await allow("sign up with a valid driver invite", () => b.commit());
}
{
  const db = as("new12");
  const b = writeBatch(db);
  b.set(doc(db, "users/new12"), { name: "x", email: "x", role: "driver", carrierId: "A", invite: "DRVA" });
  b.update(doc(db, "invites/DRVA"), { used: true, usedBy: "new12" });
  await deny("reuse that same invite a second time", () => b.commit());
}

// ---------- Pending users ----------
await deny("pending user reads carriers", () => getDoc(doc(as("pend1"), "carriers/A")));
await deny("pending user promotes themselves", () => updateDoc(doc(as("pend1"), "users/pend1"), { role: "carrierAdmin", carrierId: "A" }));
await allow("pending user reads own profile", () => getDoc(doc(as("pend1"), "users/pend1")));

// ---------- Driver ----------
const d = as("drvA1");
await allow("driver reads own load", () => getDoc(doc(d, "loads/L1")));
await allow("driver lists own loads (app query)", () => getDocs(q(d, "loads", eq("carrierId", "A"), eq("driverId", "drvA1"))));
await deny("driver reads another driver's load", () => getDoc(doc(d, "loads/L2")));
await deny("driver lists every load in the company", () => getDocs(q(d, "loads", eq("carrierId", "A"))));
await deny("driver reads the load rate", () => getDoc(doc(d, "loadMoney/L1")));
await deny("driver lists load money", () => getDocs(q(d, "loadMoney", eq("carrierId", "A"))));
await allow("driver marks own load picked up", () => updateDoc(doc(d, "loads/L1"), { status: "in_transit", updatedAt: new Date() }));
await deny("driver reassigns the load to someone else", () => updateDoc(doc(d, "loads/L1"), { driverId: "drvA2" }));
await deny("driver sets load back to booked", () => updateDoc(doc(d, "loads/L1"), { status: "booked" }));
await deny("driver changes another driver's load status", () => updateDoc(doc(d, "loads/L2"), { status: "delivered" }));
await deny("driver creates a load", () => addDoc(collection(d, "loads"), { carrierId: "A", driverId: "drvA1" }));
await allow("driver reads own paystubs (app query)", () => getDocs(q(d, "paystubs", eq("carrierId", "A"), eq("driverId", "drvA1"))));
await deny("driver reads a coworker's paystub", () => getDoc(doc(d, "paystubs/P2")));
await deny("driver lists all company paystubs", () => getDocs(q(d, "paystubs", eq("carrierId", "A"))));
await deny("driver gives themselves a raise", () => updateDoc(doc(d, "users/drvA1"), { payRate: 5 }));
await deny("driver makes themselves owner", () => updateDoc(doc(d, "users/drvA1"), { role: "owner" }));
await allow("driver updates own phone", () => updateDoc(doc(d, "users/drvA1"), { phone: "555" }));
await deny("driver reads coworker's profile", () => getDoc(doc(d, "users/drvA2")));
await allow("driver reads company trucks", () => getDocs(q(d, "trucks", eq("carrierId", "A"))));
await deny("driver reads truck requests", () => getDocs(q(d, "requests", eq("carrierId", "A"))));
await deny("driver reads another carrier", () => getDoc(doc(d, "carriers/B")));
{
  const b = writeBatch(d);
  const r = doc(collection(d, "documents"));
  b.set(r, { carrierId: "A", uploadedBy: "drvA1", status: "pending", name: "BOL" });
  b.set(doc(d, "docFiles", r.id), { carrierId: "A", uploadedBy: "drvA1", data: "x" });
  await allow("driver uploads a BOL scan (pending)", () => b.commit());
}
await deny("driver uploads a doc pre-approved", () => addDoc(collection(d, "documents"), { carrierId: "A", uploadedBy: "drvA1", status: "approved" }));
await deny("driver uploads into carrier B", () => addDoc(collection(d, "documents"), { carrierId: "B", uploadedBy: "drvA1", status: "pending" }));
await deny("driver uploads pretending to be someone else", () => addDoc(collection(d, "documents"), { carrierId: "A", uploadedBy: "drvA2", status: "pending" }));
await deny("driver writes a scan with no document record", () => setDoc(doc(d, "docFiles/ORPHAN"), { carrierId: "A", uploadedBy: "drvA1", data: "x" }));
await allow("driver lists own uploads (app query)", () => getDocs(q(d, "documents", eq("carrierId", "A"), eq("uploadedBy", "drvA1"))));
await allow("driver opens own scan", () => getDoc(doc(d, "docFiles/D1")));
await deny("driver opens a coworker-invisible scan (company insurance)", () => getDoc(doc(d, "docFiles/D4")));
await deny("driver approves own doc", () => updateDoc(doc(d, "documents/D1"), { status: "approved" }));
await deny("carrier B driver opens carrier A scan", () => getDoc(doc(as("drvB1"), "docFiles/D1")));

// ---------- Carrier admin ----------
const a = as("adminA");
await allow("carrier admin reads own carrier", () => getDoc(doc(a, "carriers/A")));
await deny("carrier admin reads carrier B", () => getDoc(doc(a, "carriers/B")));
await deny("carrier admin edits own fee %", () => updateDoc(doc(a, "carriers/A"), { feePercent: 0 }));
await allow("carrier admin lists own loads (app query)", () => getDocs(q(a, "loads", eq("carrierId", "A"))));
await deny("carrier admin lists carrier B loads", () => getDocs(q(a, "loads", eq("carrierId", "B"))));
await deny("carrier admin lists ALL loads", () => getDocs(collection(a, "loads")));
await allow("carrier admin reads own load money", () => getDocs(q(a, "loadMoney", eq("carrierId", "A"))));
await deny("carrier admin lowers the dispatch fee", () => updateDoc(doc(a, "loadMoney/L1"), { fee: 0 }));
await deny("carrier admin marks own fee as paid", () => updateDoc(doc(a, "loadMoney/L1"), { feePaid: true }));
await allow("carrier admin books their own load (no dispatcher)", () => addDoc(collection(a, "loads"), { carrierId: "A", status: "booked" }));
await deny("carrier admin books a load posing as a dispatcher", () => addDoc(collection(a, "loads"), { carrierId: "A", dispatcherId: "dispA" }));
await deny("carrier admin books a load for carrier B", () => addDoc(collection(a, "loads"), { carrierId: "B" }));
await allow("carrier admin records money on their own load with no dispatch fee", () => setDoc(doc(a, "loadMoney/SELF1"), { carrierId: "A", rate: 1100, fee: 0, feePaid: false, factored: true }));
await deny("carrier admin creates load money with a dispatch fee", () => setDoc(doc(a, "loadMoney/SELF2"), { carrierId: "A", rate: 1100, fee: 50, feePaid: false }));
await allow("carrier admin changes the rate on their self-booked load", () => updateDoc(doc(a, "loadMoney/SELF1"), { rate: 1150 }));
await deny("carrier admin changes the rate on a dispatched load", () => updateDoc(doc(a, "loadMoney/L1"), { rate: 9999 }));
await allow("carrier admin records the factoring deposit", () => updateDoc(doc(a, "loadMoney/L1"), { deposit: 1800, factored: true }));
await allow("carrier admin marks their load Paid", () => updateDoc(doc(a, "loads/L2"), { status: "paid", paidAt: "2026-10-01" }));
await deny("carrier admin re-assigns a load's dispatcher", () => updateDoc(doc(a, "loads/L2"), { dispatcherId: "adminA" }));
await deny("carrier admin moves a load to carrier B", () => updateDoc(doc(a, "loads/L2"), { carrierId: "B" }));
await deny("carrier admin edits carrier B's load", () => updateDoc(doc(a, "loads/L3"), { status: "paid" }));
await allow("carrier admin sets their factoring company and %", () => updateDoc(doc(a, "carriers/A"), { factorName: "GAP", factorPct: 2 }));
await deny("carrier admin renames their company record", () => updateDoc(doc(a, "carriers/A"), { name: "Renamed" }));
await deny("carrier admin edits carrier B's factoring", () => updateDoc(doc(a, "carriers/B"), { factorPct: 0 }));
await allow("carrier admin adds an expense", () => addDoc(collection(a, "expenses"), { carrierId: "A", cat: "Fuel", amount: 461.77 }));
await allow("carrier admin lists own expenses (app query)", () => getDocs(q(a, "expenses", eq("carrierId", "A"))));
await deny("carrier admin adds an expense to carrier B", () => addDoc(collection(a, "expenses"), { carrierId: "B", cat: "Fuel", amount: 1 }));
await deny("carrier admin reads carrier B's expenses", () => getDocs(q(a, "expenses", eq("carrierId", "B"))));
await allow("carrier admin adds a recurring charge", () => addDoc(collection(a, "recurring"), { carrierId: "A", name: "Insurance", amount: 1200, freq: "m1" }));
await deny("carrier admin reads carrier B's recurring charges", () => getDocs(q(a, "recurring", eq("carrierId", "B"))));
await allow("carrier admin lists own drivers (app query)", () => getDocs(q(a, "users", eq("carrierId", "A"), eq("role", "driver"))));
await deny("carrier admin lists carrier B drivers", () => getDocs(q(a, "users", eq("carrierId", "B"), eq("role", "driver"))));
await deny("carrier admin lists every user", () => getDocs(collection(a, "users")));
await allow("carrier admin sets a driver's pay", () => updateDoc(doc(a, "users/drvA2"), { payType: "perMile", payRate: 0.6 }));
await deny("carrier admin promotes a driver to carrier admin", () => updateDoc(doc(a, "users/drvA2"), { role: "carrierAdmin" }));
await deny("carrier admin moves a driver to carrier B", () => updateDoc(doc(a, "users/drvA2"), { carrierId: "B" }));
await deny("carrier admin edits carrier B's driver", () => updateDoc(doc(a, "users/drvB1"), { payRate: 9 }));
await deny("carrier admin removes carrier B's driver", () => deleteDoc(doc(a, "users/drvB1")));
await deny("carrier admin deletes a dispatcher", () => deleteDoc(doc(a, "users/dispA")));
await deny("carrier admin makes themselves owner", () => updateDoc(doc(a, "users/adminA"), { role: "owner" }));
await allow("carrier admin creates a driver invite", () => setDoc(doc(a, "invites/NEWDRV"), { role: "driver", carrierId: "A", used: false, createdBy: "adminA" }));
await deny("carrier admin creates a carrier-admin invite", () => setDoc(doc(a, "invites/NEWCA"), { role: "carrierAdmin", carrierId: "A", used: false, createdBy: "adminA" }));
await deny("carrier admin creates a dispatcher invite", () => setDoc(doc(a, "invites/NEWDI"), { role: "dispatcher", carrierId: null, used: false, createdBy: "adminA" }));
await deny("carrier admin creates a driver invite for carrier B", () => setDoc(doc(a, "invites/NEWB"), { role: "driver", carrierId: "B", used: false, createdBy: "adminA" }));
await allow("carrier admin adds a truck", () => addDoc(collection(a, "trucks"), { carrierId: "A", unit: "Unit 2" }));
await deny("carrier admin adds a truck to carrier B", () => addDoc(collection(a, "trucks"), { carrierId: "B", unit: "Unit X" }));
await deny("carrier admin deletes carrier B's truck", () => deleteDoc(doc(a, "trucks/tB1")));
await deny("carrier admin moves own truck to carrier B", () => updateDoc(doc(a, "trucks/tA1"), { carrierId: "B" }));
await allow("carrier admin sees approved docs (app query)", () => getDocs(q(a, "documents", eq("carrierId", "A"), eq("status", "approved"))));
await allow("carrier admin sees filed docs (app query)", () => getDocs(q(a, "documents", eq("carrierId", "A"), eq("status", "filed"))));
await deny("carrier admin peeks at pending (unreviewed) docs", () => getDocs(q(a, "documents", eq("carrierId", "A"), eq("status", "pending"))));
await deny("carrier admin opens a pending scan", () => getDoc(doc(a, "docFiles/D1")));
await allow("carrier admin opens an approved scan", () => getDoc(doc(a, "docFiles/D2")));
await deny("carrier admin approves a driver's doc", () => updateDoc(doc(a, "documents/D1"), { status: "approved" }));
await deny("carrier admin opens carrier B's scan", () => getDoc(doc(a, "docFiles/D3")));
await allow("carrier admin sends a lane request", () => addDoc(collection(a, "requests"), { carrierId: "A", createdBy: "adminA", status: "open", text: "x" }));
await deny("carrier admin sends a request as carrier B", () => addDoc(collection(a, "requests"), { carrierId: "B", createdBy: "adminA", status: "open", text: "x" }));
await deny("carrier admin reads carrier B's requests", () => getDocs(q(a, "requests", eq("carrierId", "B"))));
await deny("carrier admin answers own request", () => updateDoc(doc(a, "requests/R1"), { status: "answered", reply: "ok" }));
await allow("carrier admin issues a paystub", () => addDoc(collection(a, "paystubs"), { carrierId: "A", driverId: "drvA1", net: 100 }));
await deny("carrier admin issues a paystub for carrier B", () => addDoc(collection(a, "paystubs"), { carrierId: "B", driverId: "drvB1", net: 100 }));
await deny("carrier admin reads pending sign-ups", () => getDocs(q(a, "users", eq("role", "pending"))));

// ---------- Expenses walls ----------
await deny("driver reads company expenses", () => getDocs(q(d, "expenses", eq("carrierId", "A"))));
await deny("driver adds an expense", () => addDoc(collection(d, "expenses"), { carrierId: "A", cat: "Fuel", amount: 1 }));
await deny("carrier B admin deletes carrier A's expense", () => deleteDoc(doc(as("adminB"), "expenses/EA")));
await deny("carrier admin moves an expense to carrier B", () => updateDoc(doc(a, "expenses/EA"), { carrierId: "B" }));
await allow("carrier admin deletes own expense", () => deleteDoc(doc(a, "expenses/EA")));

// ---------- Dispatcher ----------
const s = as("dispA");
await allow("dispatcher reads assigned carrier", () => getDoc(doc(s, "carriers/A")));
await deny("dispatcher reads unassigned carrier", () => getDoc(doc(s, "carriers/B")));
await allow("dispatcher lists assigned loads (app query)", () => getDocs(q(s, "loads", eq("carrierId", "A"))));
await deny("dispatcher lists unassigned carrier's loads", () => getDocs(q(s, "loads", eq("carrierId", "B"))));
await deny("dispatcher lists every load", () => getDocs(collection(s, "loads")));
await allow("dispatcher books a load for assigned carrier", () => addDoc(collection(s, "loads"), { carrierId: "A", status: "booked" }));
await deny("dispatcher books a load for unassigned carrier", () => addDoc(collection(s, "loads"), { carrierId: "B", status: "booked" }));
await deny("dispatcher moves a load to another carrier", () => updateDoc(doc(s, "loads/L1"), { carrierId: "B" }));
await allow("dispatcher sees rates for assigned carrier", () => getDocs(q(s, "loadMoney", eq("carrierId", "A"))));
await deny("dispatcher sees rates for unassigned carrier", () => getDoc(doc(s, "loadMoney/L3")));
await allow("dispatcher approves a driver doc", () => updateDoc(doc(s, "documents/D1"), { status: "approved" }));
await deny("dispatcher approves an unassigned carrier's doc", () => updateDoc(doc(s, "documents/D3"), { status: "approved" }));
await allow("dispatcher lists pending docs (app query)", () => getDocs(q(s, "documents", eq("carrierId", "A"), eq("status", "pending"))));
await allow("dispatcher opens assigned scan", () => getDoc(doc(s, "docFiles/D1")));
await deny("dispatcher opens unassigned scan", () => getDoc(doc(s, "docFiles/D3")));
await allow("dispatcher answers a truck request", () => updateDoc(doc(s, "requests/R1"), { status: "answered", reply: "On it" }));
await deny("dispatcher answers another carrier's request", () => updateDoc(doc(s, "requests/R2"), { status: "answered", reply: "x" }));
await deny("dispatcher rewrites the request text", () => updateDoc(doc(s, "requests/R1"), { text: "changed" }));
await deny("dispatcher assigns themselves all carriers", () => updateDoc(doc(s, "users/dispA"), { allCarriers: true }));
await deny("dispatcher adds carrier B to their list", () => updateDoc(doc(s, "users/dispA"), { assignedCarriers: ["A", "B"] }));
await deny("dispatcher reads a carrier's expenses", () => getDocs(q(s, "expenses", eq("carrierId", "A"))));
await deny("dispatcher reads a carrier's recurring charges", () => getDocs(q(s, "recurring", eq("carrierId", "A"))));
await deny("dispatcher reads driver paystubs", () => getDocs(q(s, "paystubs", eq("carrierId", "A"))));
await deny("dispatcher creates invites", () => setDoc(doc(s, "invites/DX"), { role: "driver", carrierId: "A", used: false, createdBy: "dispA" }));
await deny("dispatcher creates a carrier", () => addDoc(collection(s, "carriers"), { name: "Fake" }));
await allow("dispatcher lists assigned carrier's drivers (load form)", () => getDocs(q(s, "users", eq("carrierId", "A"), eq("role", "driver"))));
await deny("dispatcher lists unassigned carrier's drivers", () => getDocs(q(s, "users", eq("carrierId", "B"), eq("role", "driver"))));
await deny("dispatcher with no carriers reads carrier A", () => getDoc(doc(as("dispNone"), "carriers/A")));
await allow("all-carriers dispatcher reads carrier B loads", () => getDocs(q(as("dispAll"), "loads", eq("carrierId", "B"))));
await allow("all-carriers dispatcher lists every load in one query", () => getDocs(collection(as("dispAll"), "loads")));
await allow("all-carriers dispatcher lists all pending docs in one query", () => getDocs(q(as("dispAll"), "documents", eq("status", "pending"))));
await deny("assigned-only dispatcher can't use the all-loads query", () => getDocs(collection(as("dispA"), "loadMoney")));
await allow("all-carriers dispatcher lists carriers (app query)", () => getDocs(collection(as("dispAll"), "carriers")));

// ---------- Owner ----------
const o = as("owner");
await allow("owner lists all loads", () => getDocs(collection(o, "loads")));
await allow("owner lists all money", () => getDocs(collection(o, "loadMoney")));
await allow("owner lists pending sign-ups", () => getDocs(q(o, "users", eq("role", "pending"))));
await allow("owner approves a carrier sign-up", async () => {
  const b = writeBatch(o);
  const c = doc(collection(o, "carriers"));
  b.set(c, { name: "C", feePercent: 8 });
  b.update(doc(o, "users/pend1"), { role: "carrierAdmin", carrierId: c.id });
  return b.commit();
});
await allow("owner assigns carriers to a dispatcher", () => updateDoc(doc(o, "users/dispNone"), { assignedCarriers: ["A"], allCarriers: false }));
await allow("owner creates a carrier-admin invite", () => setDoc(doc(o, "invites/OWNCA"), { role: "carrierAdmin", carrierId: "A", used: false, createdBy: "owner" }));
await allow("owner lists open invites (app query)", () => getDocs(q(o, "invites", eq("used", false))));
await allow("owner marks a fee paid", () => updateDoc(doc(o, "loadMoney/L1"), { feePaid: true }));
await allow("owner lists every carrier's expenses", () => getDocs(collection(o, "expenses")));
await allow("owner lists every recurring charge", () => getDocs(collection(o, "recurring")));
await allow("owner edits any carrier's settings", () => updateDoc(doc(o, "carriers/B"), { factorName: "RTS", factorPct: 2.5, feePercent: 7 }));
await allow("owner connects Google Drive", () => setDoc(doc(o, "settings/app"), { driveUrl: "https://script.google.com/macros/s/x/exec" }));
await allow("driver reads app settings (to know where Drive is)", () => getDoc(doc(d, "settings/app")));
await deny("carrier admin changes the Drive connection", () => setDoc(doc(a, "settings/app"), { driveUrl: "https://evil.example/exec" }));
await deny("dispatcher changes the Drive connection", () => setDoc(doc(s, "settings/app"), { driveUrl: "https://evil.example/exec" }));
await deny("signed-out visitor reads app settings", () => getDoc(doc(anon(), "settings/app")));
await allow("owner reads any scan", () => getDoc(doc(o, "docFiles/D3")));

// ---------- Report ----------
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.err}`);
console.log(`\n${results.length - failed.length}/${results.length} security checks passed`);
for (const f of failed.slice(0, 10)) console.log(`::error title=Security rule gap::${f.name}`);
console.log(`::notice title=Security rules::${results.length - failed.length}/${results.length} attack checks passed`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Security rules: ${results.length - failed.length}/${results.length} passed\n\n` +
    results.map((r) => `- ${r.ok ? "✅" : "❌"} ${r.name}`).join("\n") + "\n\n");
}
await env.cleanup();
process.exit(failed.length ? 1 : 0);
