// Security-rule attack tests. Every role tries to read and write what it should, and what it shouldn't.
// Run inside the Firestore emulator:  npx firebase emulators:exec --only firestore --project demo-keeptrack "node rules.test.mjs"
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, writeBatch, getCountFromServer,
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
const MATRIX_ROLES = ["owner", "dispA", "dispZero", "adminA", "adminB", "drvA1", "drvA2", "drvB1", "anon"];
const MATRIX_STATUSES = ["pending", "approved", "filed", "rejected"];
const MATRIX_ACTIONS = ["read", "edit", "moveOwnLoad", "moveOtherCarrier", "changeCarrier", "delete", "deleteScanOnly"];
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
  await put("documents/D5", { carrierId: "A", uploadedBy: "drvA2", status: "pending", name: "Lumper", kind: "Lumper", amount: 85 });
  // for editing / deleting
  await put("loads/L4", { carrierId: "A", status: "booked", dispatcherId: null, origin: "Nampa", destination: "Reno" });
  await put("loadMoney/L4", { carrierId: "A", rate: 900, fee: 0, feePaid: false });
  await put("loads/L5", { carrierId: "A", status: "booked", dispatcherId: "dispA", origin: "Boise", destination: "Denver" });
  await put("loadMoney/L5", { carrierId: "A", rate: 2000, fee: 160, feePaid: false });
  await put("documents/D6", { carrierId: "A", uploadedBy: "drvA1", status: "pending", name: "Wrong photo" });
  await put("documents/D7", { carrierId: "A", uploadedBy: "drvA1", status: "approved", name: "POD", kind: "POD", loadId: "L1" });
  await put("documents/D8", { carrierId: "A", uploadedBy: "dispA", status: "approved", name: "Rate con", kind: "Rate con", loadId: "L4" });
  for (const id of ["D6", "D7", "D8"]) await put(`docFiles/${id}`, { carrierId: "A", uploadedBy: "x", data: "data:image/jpeg;base64,AAAA" });
  // Permission matrix: a fresh paper (and scan) for every role × status × action, and a fresh load per delete check
  await put("users/dispZero", { role: "dispatcher", name: "Disp Zero", assignedCarriers: [] }); // stays unassigned
  for (const r of MATRIX_ROLES) for (const st of MATRIX_STATUSES) for (const act of MATRIX_ACTIONS) {
    const id = `M_${r}_${st}_${act}`;
    const by = st === "filed" ? "adminA" : "drvA1";
    await put(`documents/${id}`, { carrierId: "A", uploadedBy: by, status: st, name: id, kind: "BOL", loadId: "L1" });
    await put(`docFiles/${id}`, { carrierId: "A", uploadedBy: by, data: "data:image/jpeg;base64,AAAA" });
  }
  for (const r of MATRIX_ROLES) for (const kind of ["self", "dispatched"]) {
    const id = `ML_${r}_${kind}`;
    await put(`loads/${id}`, { carrierId: "A", status: "booked", dispatcherId: kind === "self" ? null : "dispA" });
    await put(`loadMoney/${id}`, { carrierId: "A", rate: 1000, fee: kind === "self" ? 0 : 80, feePaid: false });
  }
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
// usernames: the username on the profile must be the one they actually sign in with
const asLogin = (uid, email) => env.authenticatedContext(uid, { email }).firestore();
const UD = "@keeptrack-6426e.firebaseapp.com";
await allow("request access with a username", () => setDoc(doc(asLogin("u1", "acme.trucking" + UD), "users/u1"), { name: "Acme", username: "acme.trucking", phone: "1", role: "pending", requestedRole: "carrierAdmin", company: "Acme", mc: "", dot: "", note: "", createdAt: new Date() }));
await deny("request access claiming someone else's username", () => setDoc(doc(asLogin("u2", "sneaky" + UD), "users/u2"), { name: "x", username: "acme.trucking", phone: "1", role: "pending", requestedRole: "dispatcher", createdAt: new Date() }));
await deny("an email account claiming a username", () => setDoc(doc(asLogin("u3", "real@gmail.com"), "users/u3"), { name: "x", username: "boss", phone: "1", role: "pending", requestedRole: "dispatcher", createdAt: new Date() }));
await deny("a username that isn't text", () => setDoc(doc(asLogin("u4", "x" + UD), "users/u4"), { name: "x", username: 5, phone: "1", role: "pending", requestedRole: "dispatcher", createdAt: new Date() }));
await deny("user renames their own username afterwards", () => updateDoc(doc(asLogin("u1", "acme.trucking" + UD), "users/u1"), { username: "owner" }));
// the owner adds people directly (their login is made in a second session, then the owner saves the profile)
await allow("owner adds a driver with a login", () => setDoc(doc(as("owner"), "users/added1"), { name: "Nina", username: "nina", phone: "1", role: "driver", carrierId: "A", tempPassword: true, addedBy: "owner", createdAt: new Date() }));
await allow("owner adds a dispatcher with carriers", () => setDoc(doc(as("owner"), "users/added2"), { name: "Dex", username: "dex", role: "dispatcher", allCarriers: false, assignedCarriers: ["A"], tempPassword: true, addedBy: "owner" }));
await deny("carrier admin adds someone with a login (not theirs to make)", () => setDoc(doc(as("adminA"), "users/added3"), { name: "x", username: "x", role: "driver", carrierId: "A" }));
await deny("dispatcher adds someone", () => setDoc(doc(as("dispA"), "users/added4"), { name: "x", username: "x", role: "driver", carrierId: "A" }));
await deny("someone signs themselves up as a dispatcher without an invite", () => setDoc(doc(asLogin("added5", "sneak" + UD), "users/added5"), { name: "x", username: "sneak", role: "dispatcher" }));
await allow("person clears 'pick your own password' after picking one", () => updateDoc(doc(asLogin("added1", "nina" + UD), "users/added1"), { tempPassword: false }));
await deny("person turns 'pick your own password' back on for themselves", () => updateDoc(doc(asLogin("added1", "nina" + UD), "users/added1"), { tempPassword: true }));
await deny("person changes their own role while clearing the flag", () => updateDoc(doc(asLogin("added1", "nina" + UD), "users/added1"), { tempPassword: false, role: "owner" }));
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
await allow("carrier admin sees driver uploads waiting for review", () => getDocs(q(a, "documents", eq("carrierId", "A"), eq("status", "pending"))));
await allow("carrier admin opens a driver's pending scan", () => getDoc(doc(a, "docFiles/D1")));
await allow("carrier admin opens an approved scan", () => getDoc(doc(a, "docFiles/D2")));
await allow("carrier admin looks for duplicates by fingerprint (app query)", () => getDocs(q(a, "documents", eq("carrierId", "A"), eq("hash", "abc"))));
await deny("carrier admin changes who uploaded a pending doc", () => updateDoc(doc(a, "documents/D5"), { uploadedBy: "adminA" }));
await deny("carrier admin re-labels a pending doc while approving", () => updateDoc(doc(a, "documents/D5"), { status: "approved", kind: "BOL" }));
await allow("carrier admin rejects a driver's duplicate", () => updateDoc(doc(a, "documents/D5"), { status: "rejected", rejectReason: "duplicate", reviewedBy: "adminA" }));
await deny("carrier admin flips a rejected doc back", () => updateDoc(doc(a, "documents/D5"), { status: "approved" }));
await allow("carrier admin approves a driver's doc", () => updateDoc(doc(a, "documents/D1"), { status: "approved", reviewedBy: "adminA" }));
await deny("carrier admin un-approves an approved driver doc", () => updateDoc(doc(a, "documents/D2"), { status: "rejected" }));
await deny("carrier admin approves carrier B's doc", () => updateDoc(doc(a, "documents/D3"), { status: "approved" }));
await deny("carrier admin reads carrier B's pending docs", () => getDocs(q(a, "documents", eq("carrierId", "B"), eq("status", "pending"))));
await allow("carrier admin adds a driver by hand (no login)", () => setDoc(doc(a, "users/manual_abc12345xyz"), { role: "driver", manual: true, carrierId: "A", name: "Owner-op Sam", payType: "perMile", payRate: 0.65 }));
await deny("carrier admin creates a hand-added profile with a real-looking id", () => setDoc(doc(a, "users/Zx81kQ2mN0pL4sT7vW9yB3cD5eF6"), { role: "driver", manual: true, carrierId: "A", name: "X" }));
await deny("carrier admin hand-adds a carrier admin", () => setDoc(doc(a, "users/manual_abc12345zzz"), { role: "carrierAdmin", manual: true, carrierId: "A", name: "X" }));
await deny("carrier admin hand-adds a driver to carrier B", () => setDoc(doc(a, "users/manual_abc12345yyy"), { role: "driver", manual: true, carrierId: "B", name: "X" }));
await deny("carrier admin sneaks extra powers onto a hand-added driver", () => setDoc(doc(a, "users/manual_abc12345www"), { role: "driver", manual: true, carrierId: "A", name: "X", allCarriers: true }));
await deny("driver hand-adds another driver", () => setDoc(doc(d, "users/manual_abc12345vvv"), { role: "driver", manual: true, carrierId: "A", name: "X" }));
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
await allow("owner adds a driver by hand for any carrier", () => setDoc(doc(o, "users/manual_owner12345"), { role: "driver", manual: true, carrierId: "B", name: "Hand-added" }));
await allow("owner connects Google Drive", () => setDoc(doc(o, "settings/app"), { driveUrl: "https://script.google.com/macros/s/x/exec" }));
await allow("driver reads app settings (to know where Drive is)", () => getDoc(doc(d, "settings/app")));
await deny("carrier admin changes the Drive connection", () => setDoc(doc(a, "settings/app"), { driveUrl: "https://evil.example/exec" }));
await deny("dispatcher changes the Drive connection", () => setDoc(doc(s, "settings/app"), { driveUrl: "https://evil.example/exec" }));
await deny("signed-out visitor reads app settings", () => getDoc(doc(anon(), "settings/app")));
await allow("owner reads any scan", () => getDoc(doc(o, "docFiles/D3")));

// Storage meter, Drive backup and "free up space"
await allow("owner counts every document for the storage meter", () => getCountFromServer(collection(o, "documents")));
await allow("owner records a backup", () => setDoc(doc(o, "settings/backup"), { count: 3, sheetUrl: "https://docs.google.com/x" }));
await deny("carrier admin fakes a backup record", () => setDoc(doc(a, "settings/backup"), { count: 0 }));
await deny("driver deletes their own scan but keeps the record", () => deleteDoc(doc(d, "docFiles/D1")));
await deny("carrier admin deletes a scan but keeps the record", () => deleteDoc(doc(a, "docFiles/D2")));
await deny("dispatcher deletes an assigned scan", () => deleteDoc(doc(s, "docFiles/D1")));
await deny("driver marks their own upload as moved to Drive", () => updateDoc(doc(d, "documents/D1"), { fileFreed: true, driveFileId: "x" }));
await deny("carrier admin marks an approved scan as moved", () => updateDoc(doc(a, "documents/D2"), { fileFreed: true, size: 0 }));
await allow("owner frees a backed-up scan (deletes the scan, keeps the record)", () => {
  const b = writeBatch(o);
  b.delete(doc(o, "docFiles/D3"));
  b.update(doc(o, "documents/D3"), { fileFreed: true, size: 0, driveFileId: "abc", driveUrl: "https://drive.google.com/x" });
  return b.commit();
});
await allow("carrier B can still read the freed record", () => getDoc(doc(as("adminB"), "documents/D3")));

// Editing and deleting papers and loads
const delPaper = (db, id) => { const b = writeBatch(db); b.delete(doc(db, "docFiles/" + id)); b.delete(doc(db, "documents/" + id)); return b.commit(); };
const delLoad = (db, id) => { const b = writeBatch(db); b.delete(doc(db, "loadMoney/" + id)); b.delete(doc(db, "loads/" + id)); return b.commit(); };
await deny("driver deletes the scan of their pending upload but keeps the record", () => deleteDoc(doc(d, "docFiles/D6")));
await deny("another driver deletes someone's pending upload", () => delPaper(as("drvA2"), "D6"));
await deny("driver deletes their approved upload", () => delPaper(d, "D7"));
await deny("dispatcher deletes a paper", () => delPaper(s, "D7"));
await deny("carrier B admin deletes carrier A's paper", () => delPaper(as("adminB"), "D7"));
await allow("driver takes back their own upload before it's reviewed (record + scan)", () => delPaper(d, "D6"));
await allow("carrier admin fixes a paper's type, amount and note", () => updateDoc(doc(a, "documents/D7"), { kind: "Lumper", category: "Receipts", amount: 120, note: "fixed" }));
await allow("carrier admin moves a paper to another of their loads", () => updateDoc(doc(a, "documents/D7"), { loadId: "L2", loadLabel: "#L2 ? to ?" }));
await deny("carrier admin moves a paper onto carrier B's load", () => updateDoc(doc(a, "documents/D7"), { loadId: "L3", loadLabel: "#L3" }));
await deny("dispatcher moves a paper onto another carrier's load", () => updateDoc(doc(s, "documents/D7"), { loadId: "L3" }));
await deny("carrier admin changes a paper's status while editing", () => updateDoc(doc(a, "documents/D7"), { status: "filed", note: "x" }));
await deny("carrier admin edits who uploaded a paper", () => updateDoc(doc(a, "documents/D7"), { uploaderName: "Someone" }));
await allow("dispatcher fixes a paper's type", () => updateDoc(doc(s, "documents/D7"), { kind: "POD", category: "BOLs" }));
await allow("carrier admin deletes their company's approved paper (record + scan)", () => delPaper(a, "D7"));
await allow("carrier admin unlinks a paper from a load they're deleting", () => updateDoc(doc(a, "documents/D8"), { loadId: null, loadLabel: null }));
await deny("carrier admin deletes a load dispatch booked (it carries the dispatch fee)", () => delLoad(a, "L5"));
await deny("dispatcher deletes a load", () => delLoad(s, "L4"));
await deny("driver deletes a load", () => delLoad(d, "L4"));
await allow("carrier admin deletes a load they booked themselves", () => delLoad(a, "L4"));
await allow("owner deletes a dispatched load", () => delLoad(o, "L5"));

// ---------- Permission matrix (stress): every role × paper status × action, against the intended policy ----------
{
  const ctxOf = (r) => (r === "anon" ? anon() : as(r));
  const policy = (r, st, act) => {
    const own = st !== "filed"; // drvA1 uploaded every non-filed paper
    switch (act) {
      case "read": return ["owner", "dispA", "adminA"].includes(r) || (r === "drvA1" && own);
      case "edit": case "moveOwnLoad": return ["owner", "dispA", "adminA"].includes(r);
      case "moveOtherCarrier": case "changeCarrier": return false;
      case "delete": return r === "owner" || r === "adminA" || (r === "drvA1" && st === "pending");
      case "deleteScanOnly": return r === "owner";
    }
  };
  const doIt = (db, id, act) => {
    const ref = doc(db, "documents", id);
    switch (act) {
      case "read": return getDoc(ref);
      case "edit": return updateDoc(ref, { note: "fixed", amount: 10, kind: "POD", category: "BOLs" });
      case "moveOwnLoad": return updateDoc(ref, { loadId: "L2", loadLabel: "#L2" });
      case "moveOtherCarrier": return updateDoc(ref, { loadId: "L3", loadLabel: "#L3" });
      case "changeCarrier": return updateDoc(ref, { carrierId: "B" });
      case "delete": { const b = writeBatch(db); b.delete(doc(db, "docFiles", id)); b.delete(ref); return b.commit(); }
      case "deleteScanOnly": return deleteDoc(doc(db, "docFiles", id));
    }
  };
  for (const r of MATRIX_ROLES) for (const st of MATRIX_STATUSES) for (const act of MATRIX_ACTIONS) {
    const want = policy(r, st, act);
    await check(want ? "allow" : "deny", `matrix: ${r} · ${act} · ${st} paper`, () => doIt(ctxOf(r), `M_${r}_${st}_${act}`, act));
  }
  // loads: only the owner deletes a dispatched load; a carrier admin may delete one they booked
  for (const r of MATRIX_ROLES) for (const kind of ["self", "dispatched"]) {
    const want = r === "owner" || (r === "adminA" && kind === "self");
    const id = `ML_${r}_${kind}`;
    await check(want ? "allow" : "deny", `matrix: ${r} · delete ${kind === "self" ? "self-booked" : "dispatched"} load`, () => {
      const db = ctxOf(r); const b = writeBatch(db); b.delete(doc(db, "loadMoney", id)); b.delete(doc(db, "loads", id)); return b.commit();
    });
  }
  // new papers can only be filed under an existing load of the same carrier
  const upload = (db, by, extra) => { const b = writeBatch(db); const r = doc(collection(db, "documents")); b.set(r, { carrierId: "A", uploadedBy: by, status: by.startsWith("drv") ? "pending" : "approved", name: "x", ...extra }); b.set(doc(db, "docFiles", r.id), { carrierId: "A", uploadedBy: by, data: "x" }); return b.commit(); };
  await allow("driver uploads to their carrier's load", () => upload(as("drvA1"), "drvA1", { loadId: "L2" }));
  await deny("driver uploads onto carrier B's load", () => upload(as("drvA1"), "drvA1", { loadId: "L3" }));
  await deny("driver uploads onto a load that was deleted", () => upload(as("drvA1"), "drvA1", { loadId: "GONE" }));
  await allow("dispatcher files paperwork on an assigned carrier's load", () => upload(as("dispA"), "dispA", { loadId: "L2" }));
  await deny("dispatcher files carrier A paperwork under carrier B's load", () => upload(as("dispA"), "dispA", { loadId: "L3" }));
}

// ---------- Truck & driver files (registration, insurance, IFTA… / CDL, med card…) ----------
{
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    const put = (p, d) => setDoc(doc(db, p), d);
    await put("trucks/tA2", { carrierId: "A", unit: "Unit 2" });
    await put("users/drvT1", { role: "driver", carrierId: "A", name: "Truck Driver", truckId: "tA1", truckUnit: "Unit 1" });
    await put("users/drvT2", { role: "driver", carrierId: "A", name: "Other Truck", truckId: "tA2", truckUnit: "Unit 2" });
    await put("users/drvNoTruck", { role: "driver", carrierId: "A", name: "No Truck", truckId: null });
    await put("users/drvBT", { role: "driver", carrierId: "B", name: "B Driver", truckId: "tA1" });   // wrong carrier, same truck id
    const file = (id, d) => Promise.all([put(`documents/${id}`, { carrierId: "A", uploadedBy: "adminA", status: "filed", ...d }), put(`docFiles/${id}`, { carrierId: "A", uploadedBy: "adminA", data: "data:image/jpeg;base64,AAAA" })]);
    await file("TF1", { kind: "Registration / cab card", category: "Truck files", truckId: "tA1", truckUnit: "Unit 1" });
    await file("TF2", { kind: "Insurance card", category: "Truck files", truckId: "tA2", truckUnit: "Unit 2" });
    await file("TF3", { kind: "IFTA license", category: "Truck files", truckId: "tA1", truckUnit: "Unit 1", status: "rejected" });
    await file("DF1", { kind: "CDL", category: "Driver files", driverId: "drvT1", driverName: "Truck Driver" });
    await file("DF2", { kind: "Medical card", category: "Driver files", driverId: "drvT2", driverName: "Other Truck" });
  });
  const ON = where("status", "in", ["filed", "approved"]);
  // the assigned driver sees (and can open the scan of) their truck's papers
  await allow("driver lists their assigned truck's papers", () => getDocs(q(as("drvT1"), "documents", eq("carrierId", "A"), eq("truckId", "tA1"), ON)));
  await allow("driver opens their truck's registration", () => getDoc(doc(as("drvT1"), "documents/TF1")));
  await allow("driver opens the scan of their truck's registration", () => getDoc(doc(as("drvT1"), "docFiles/TF1")));
  await deny("driver lists another truck's papers", () => getDocs(q(as("drvT1"), "documents", eq("carrierId", "A"), eq("truckId", "tA2"), ON)));
  await deny("driver opens another truck's insurance", () => getDoc(doc(as("drvT1"), "documents/TF2")));
  await deny("driver opens the scan of another truck's insurance", () => getDoc(doc(as("drvT1"), "docFiles/TF2")));
  await deny("driver opens a rejected paper on their truck", () => getDoc(doc(as("drvT1"), "documents/TF3")));
  await deny("driver lists truck papers without saying 'on file'", () => getDocs(q(as("drvT1"), "documents", eq("carrierId", "A"), eq("truckId", "tA1"))));
  await deny("driver with no truck lists truck papers", () => getDocs(q(as("drvNoTruck"), "documents", eq("carrierId", "A"), eq("truckId", "tA1"), ON)));
  await deny("driver from carrier B with a matching truck id opens A's paper", () => getDoc(doc(as("drvBT"), "documents/TF1")));
  await deny("driver from carrier B opens A's scan", () => getDoc(doc(as("drvBT"), "docFiles/TF1")));
  // a driver's own papers
  await allow("driver lists their own papers on file", () => getDocs(q(as("drvT1"), "documents", eq("carrierId", "A"), eq("driverId", "drvT1"), ON)));
  await allow("driver opens their own CDL scan", () => getDoc(doc(as("drvT1"), "docFiles/DF1")));
  await deny("driver opens another driver's med card", () => getDoc(doc(as("drvT1"), "documents/DF2")));
  await deny("driver lists another driver's papers", () => getDocs(q(as("drvT1"), "documents", eq("carrierId", "A"), eq("driverId", "drvT2"), ON)));
  // who adds them
  const addFile = (db, by, extra) => { const b = writeBatch(db); const r = doc(collection(db, "documents")); b.set(r, { carrierId: "A", uploadedBy: by, name: "x", kind: "Registration / cab card", category: "Truck files", ...extra }); b.set(doc(db, "docFiles", r.id), { carrierId: "A", uploadedBy: by, data: "x" }); return b.commit(); };
  await allow("carrier admin adds a truck paper", () => addFile(as("adminA"), "adminA", { status: "filed", truckId: "tA1", truckUnit: "Unit 1" }));
  await allow("carrier admin adds a driver paper", () => addFile(as("adminA"), "adminA", { status: "filed", category: "Driver files", kind: "CDL", driverId: "drvA1" }));
  await allow("owner adds a truck paper", () => addFile(as("owner"), "owner", { status: "approved", truckId: "tA2" }));
  await allow("assigned dispatcher adds a truck paper", () => addFile(as("dispA"), "dispA", { status: "approved", truckId: "tA2" }));
  await deny("carrier admin files a paper under carrier B's truck", () => addFile(as("adminA"), "adminA", { status: "filed", truckId: "tB1" }));
  await deny("carrier admin files a paper under carrier B's driver", () => addFile(as("adminA"), "adminA", { status: "filed", driverId: "drvB1" }));
  await deny("carrier admin files a paper under a truck that doesn't exist", () => addFile(as("adminA"), "adminA", { status: "filed", truckId: "NOPE" }));
  await deny("driver adds a paper to a truck", () => addFile(as("drvT1"), "drvT1", { status: "pending", truckId: "tA1" }));
  await deny("driver adds a paper to themselves", () => addFile(as("drvT1"), "drvT1", { status: "pending", driverId: "drvT1" }));
  await deny("carrier B admin adds to carrier A's truck", () => addFile(as("adminB"), "adminB", { status: "filed", truckId: "tA1" }));
  await deny("driver edits their truck's paper", () => updateDoc(doc(as("drvT1"), "documents/TF1"), { expiresAt: "2099-01-01" }));
  await deny("driver deletes their truck's paper", () => deleteDoc(doc(as("drvT1"), "documents/TF1")));
  await allow("carrier admin updates a truck paper's expiry", () => updateDoc(doc(as("adminA"), "documents/TF1"), { expiresAt: "2027-01-31" }));
  await deny("carrier admin moves a truck paper to another truck", () => updateDoc(doc(as("adminA"), "documents/TF1"), { truckId: "tA2" }));
  await deny("dispatcher moves a truck paper to carrier B's truck", () => updateDoc(doc(as("dispA"), "documents/TF2"), { truckId: "tB1" }));
  await allow("dispatcher moves a truck paper to another of the same carrier's trucks", () => updateDoc(doc(as("dispA"), "documents/TF2"), { truckId: "tA1", truckUnit: "Unit 1" }));
  await allow("carrier admin lists all truck files", () => getDocs(q(as("adminA"), "documents", eq("carrierId", "A"), eq("category", "Truck files"))));
  await deny("carrier B admin lists carrier A truck files", () => getDocs(q(as("adminB"), "documents", eq("carrierId", "A"), eq("category", "Truck files"))));
  // existing driver uploads still work
  await allow("driver still uploads a BOL to their load", () => upload2(as("drvT1"), "drvT1", { loadId: "L2" }));
}
async function upload2(db, by, extra) { const b = writeBatch(db); const r = doc(collection(db, "documents")); b.set(r, { carrierId: "A", uploadedBy: by, status: "pending", name: "x", ...extra }); b.set(doc(db, "docFiles", r.id), { carrierId: "A", uploadedBy: by, data: "x" }); return b.commit(); }

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
