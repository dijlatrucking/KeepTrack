import { db, collection, doc, getDoc, getDocs, onSnapshot, query, where } from "./fb.js";
import { toast, friendlyError } from "./ui.js";

const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// Live query → callback(rows). Returns unsubscribe.
// A listener that errors is dead for good in Firestore, so retry a few times (e.g. a profile that was
// still saving when the page first asked) before telling the user.
export function watch(q, cb) {
  let unsub = () => {}, stopped = false, tries = 0;
  const start = () => {
    unsub = onSnapshot(q, (s) => { tries = 0; cb(rows(s)); }, (err) => {
      if (stopped) return;
      if (++tries <= 4) {
        setTimeout(() => !stopped && start(), 600 * tries);
        return;
      }
      console.error(err);
      toast(friendlyError(err), "bad");
    });
  };
  start();
  return () => { stopped = true; unsub(); };
}

// Several live queries merged by document id. Updates are batched so a burst of changes
// (a big first load, many people saving at once) redraws the screen once, not hundreds of times.
export function watchMany(queries, cb) {
  if (!queries.length) {
    cb([]);
    return () => {};
  }
  const results = queries.map(() => []);
  const seen = queries.map(() => false);
  let timer = null;
  const flush = () => {
    timer = null;
    const merged = new Map();
    results.flat().forEach((x) => merged.set(x.id, x));
    cb([...merged.values()]);
  };
  const unsubs = queries.map((q, i) =>
    watch(q, (r) => {
      results[i] = r;
      const first = !seen[i];
      seen[i] = true;
      if (first && seen.every(Boolean)) { clearTimeout(timer); flush(); return; }
      if (!timer) timer = setTimeout(flush, 80);
    }));
  return () => { clearTimeout(timer); unsubs.forEach((u) => u()); };
}

// One query per carrier, each constrained by carrierId (what the rules require).
export function perCarrier(coll, carrierIds, ...wheres) {
  return carrierIds.map((cid) => query(collection(db, coll), where("carrierId", "==", cid), ...wheres));
}

// Owner and all-carrier dispatchers can use one query for everything; everyone else gets one per carrier.
export function scoped(ctx, coll, carrierIds, ...wheres) {
  return ctx.global ? [query(collection(db, coll), ...wheres)] : perCarrier(coll, carrierIds, ...wheres);
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
