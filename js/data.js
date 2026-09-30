import { db, collection, doc, getDoc, getDocs, onSnapshot, query, where } from "./fb.js";
import { toast, friendlyError } from "./ui.js";

const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// Live query → callback(rows). Returns unsubscribe.
export function watch(q, cb) {
  return onSnapshot(q, (s) => cb(rows(s)), (err) => {
    console.error(err);
    toast(friendlyError(err), "bad");
  });
}

// Several live queries merged by document id. Used to respect per-carrier security walls.
export function watchMany(queries, cb) {
  if (!queries.length) {
    cb([]);
    return () => {};
  }
  const results = queries.map(() => []);
  const unsubs = queries.map((q, i) =>
    watch(q, (r) => {
      results[i] = r;
      const merged = new Map();
      results.flat().forEach((x) => merged.set(x.id, x));
      cb([...merged.values()]);
    }));
  return () => unsubs.forEach((u) => u());
}

// One query per carrier, each constrained by carrierId (what the rules require).
export function perCarrier(coll, carrierIds, ...wheres) {
  return carrierIds.map((cid) => query(collection(db, coll), where("carrierId", "==", cid), ...wheres));
}

// Carriers this profile may see.
export async function loadCarriers(profile) {
  if (profile.role === "owner" || (profile.role === "dispatcher" && profile.allCarriers)) {
    return rows(await getDocs(collection(db, "carriers"))).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  const ids = profile.role === "dispatcher" ? profile.assignedCarriers || [] : profile.carrierId ? [profile.carrierId] : [];
  const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, "carriers", id)).catch(() => null)));
  return snaps.filter((s) => s && s.exists()).map((s) => ({ id: s.id, ...s.data() }));
}

export function driverPayFor(load, loadRate, driver) {
  if (!driver) return 0;
  const r = Number(driver.payRate) || 0;
  if (driver.payType === "percent") return ((Number(loadRate) || 0) * r) / 100;
  if (driver.payType === "flat") return r;
  return (Number(load.miles) || 0) * r;
}

export const byNewest = (a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
