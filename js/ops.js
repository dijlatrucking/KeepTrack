// The Dijla Ops system, rebuilt for many carriers: loads with stages and factoring, expenses and
// recurring charges, the profit summary, 1099 by quarter and PDF reports. Carrier admins see their own
// company; the owner can look at every carrier at once or pick one; dispatchers see their carriers' loads.
import { db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, query, where, getDocs } from "./fb.js";
import { h, card, table, money, num, field, input, select, btn, guard, toast, pill, fmtDate, toDate, stat } from "./ui.js";
import { watchMany, scoped, byNewest, driverPayFor } from "./data.js";
import { scanPicker, saveScans, openDoc, openScanDialog, lane, shortId, DOC_KINDS } from "./components.js";
import { RateCon, BillReader } from "./readers.js";
import { loadsPdf, expensesPdf, taxPdf } from "./reports.js";

// ---------- Constants and small helpers ----------

export const STAGES = [["booked", "Booked"], ["in_transit", "In transit"], ["delivered", "Delivered"], ["paid", "Paid"]];
const OPEN = ["booked", "in_transit", "delivered"];
const stageLabel = (s) => (STAGES.find((x) => x[0] === s) || [0, s === "cancelled" ? "Cancelled" : s])[1];
export const CATS = ["Fuel", "DEF", "Tolls", "Repairs", "Tires", "Maintenance", "Insurance", "Truck payment", "Trailer", "Permits & plates", "IFTA tax", "IFTA service fee", "Parking", "Lumper", "Scale", "Phone & ELD", "Subscriptions", "Driver pay", "Other"];
const FREQ = { m1: "Monthly", w1: "Weekly", w2: "Every 2 weeks", m3: "Every 3 months", m6: "Every 6 months", m12: "Yearly" };
const PER_MONTH = { m1: 1, w1: 52 / 12, w2: 26 / 12, m3: 1 / 3, m6: 1 / 6, m12: 1 / 12 };

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
const isoOf = (v) => { if (!v) return ""; if (typeof v === "string") return v.slice(0, 10); const d = toDate(v); return d && !isNaN(d) ? ymd(d) : ""; };
const daysSince = (d) => (d ? Math.max(0, Math.round((new Date(today() + "T12:00:00") - new Date(d + "T12:00:00")) / 864e5)) : 0);
const rpm = (g, m) => (m ? "$" + (g / m).toFixed(2) : "–");
const money0 = (n) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
const role = (ctx) => ctx.profile.role;

export const PERIODS = [["week", "This week"], ["lastweek", "Last week"], ["month", "This month"], ["last", "Last month"], ["year", "This year"], ["all", "All time"]];
export function range(p, from, to) {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  if (p === "custom") return [from || "0000-01-01", to || "9999-12-31"];
  if (p === "week" || p === "lastweek") {
    const s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7) - (p === "lastweek" ? 7 : 0));
    const e = new Date(s); e.setDate(s.getDate() + 6);
    return [ymd(s), ymd(e)];
  }
  if (p === "month") return [ymd(new Date(y, m, 1)), ymd(new Date(y, m + 1, 0))];
  if (p === "last") return [ymd(new Date(y, m - 1, 1)), ymd(new Date(y, m, 0))];
  if (p === "year") return [`${y}-01-01`, `${y}-12-31`];
  return ["0000-01-01", "9999-12-31"];
}
const inRange = (d, r) => !!d && d >= r[0] && d <= r[1];

// A row of period chips plus a custom from/to. state: { per, from, to }
function periodBar(state, onChange) {
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Period" });
  const from = input("from", { type: "date", "aria-label": "From date", class: "input input-sm" });
  const to = input("to", { type: "date", "aria-label": "To date", class: "input input-sm" });
  const clear = btn("Clear", () => { state.per = "month"; state.from = state.to = ""; draw(); onChange(); }, "ghost", { class: "btn btn-ghost btn-sm" });
  const draw = () => {
    chips.replaceChildren(...PERIODS.map(([id, l]) => h("button", { type: "button", class: "chip" + (state.per === id ? " on" : ""), "aria-pressed": String(state.per === id), onClick: () => { state.per = id; state.from = state.to = ""; draw(); onChange(); } }, l)));
    const r = range(state.per, state.from, state.to);
    from.value = state.per === "all" ? "" : state.per === "custom" ? state.from : r[0];
    to.value = state.per === "all" ? "" : state.per === "custom" ? state.to : r[1];
    clear.hidden = state.per !== "custom";
  };
  const onRange = () => {
    state.from = from.value; state.to = to.value;
    if (state.from && state.to && state.from > state.to) [state.from, state.to] = [state.to, state.from];
    state.per = state.from || state.to ? "custom" : "all";
    draw(); onChange();
  };
  from.addEventListener("change", onRange); to.addEventListener("change", onRange);
  draw();
  return h("div", { class: "periodbar" }, chips, h("div", { class: "rangebar" }, from, h("span", { class: "muted small" }, "to"), to, clear));
}

// ---------- Carrier picker: "All carriers" or one (owner, multi-carrier dispatchers) ----------

const picks = {}; // remembered per page for the session
export function pickerPage(ctx, root, key, render, { allowAll = true, requireOne = false } = {}) {
  const multi = ctx.carriers.length > 1 || role(ctx) === "owner";
  const body = h("div", { class: "view" });
  let local = [];
  const sub = { ...ctx, sub: (u) => local.push(u) };
  const show = () => {
    local.forEach((u) => { try { u(); } catch (_) {} });
    local = [];
    let v = picks[key] ?? (requireOne || !allowAll ? (ctx.carriers[0] || {}).id : "all");
    if (v !== "all" && !ctx.carriers.some((c) => c.id === v)) v = allowAll && !requireOne ? "all" : (ctx.carriers[0] || {}).id;
    picks[key] = v;
    const ids = v === "all" ? ctx.carriers.map((c) => c.id) : v ? [v] : [];
    sub.global = v === "all" ? ctx.global : false;
    sub.oneCarrier = ids.length === 1 ? ctx.carriers.find((c) => c.id === ids[0]) : null;
    body.replaceChildren();
    if (!ids.length) { body.append(card(null, null, h("p", { class: "empty" }, "No carriers yet."))); return; }
    render(sub, body, ids);
  };
  ctx.sub(() => local.forEach((u) => { try { u(); } catch (_) {} }));
  if (multi && ctx.carriers.length) {
    const sel = h("select", { class: "input picker-select", "aria-label": "Carrier", onChange: (e) => { picks[key] = e.target.value; show(); } },
      allowAll && !requireOne ? h("option", { value: "all" }, "All carriers") : null,
      ctx.carriers.map((c) => h("option", { value: c.id }, c.name)));
    sel.value = picks[key] ?? (allowAll && !requireOne ? "all" : (ctx.carriers[0] || {}).id);
    root.append(h("div", { class: "picker" }, h("label", { class: "picker-label" }, h("span", null, "Carrier"), sel)));
  }
  root.append(body);
  show();
}

// ---------- Live data + money math ----------

export function watchOps(ctx, ids, cb, { expenses = true, drivers = false } = {}) {
  const st = { loads: [], money: new Map(), trucks: [], expenses: [], recurring: [], drivers: [], ready: 0 };
  const need = 3 + (expenses ? 2 : 0) + (drivers ? 1 : 0);
  let t = null;
  const seen = new Set();
  const fire = (k) => { seen.add(k); st.ready = seen.size >= need; clearTimeout(t); t = setTimeout(() => cb(st), 40); };
  ctx.sub(watchMany(scoped(ctx, "loads", ids), (r) => { st.loads = r; fire("l"); }));
  ctx.sub(watchMany(scoped(ctx, "loadMoney", ids), (r) => { st.money = new Map(r.map((m) => [m.id, m])); fire("m"); }));
  ctx.sub(watchMany(scoped(ctx, "trucks", ids), (r) => { st.trucks = r.sort((a, b) => String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true })); fire("t"); }));
  if (expenses) {
    ctx.sub(watchMany(scoped(ctx, "expenses", ids), (r) => { st.expenses = r; fire("e"); }));
    ctx.sub(watchMany(scoped(ctx, "recurring", ids), (r) => { st.recurring = r; fire("r"); }));
  }
  if (drivers) ctx.sub(watchMany(scoped(ctx, "users", ids, where("role", "==", "driver")), (r) => { st.drivers = r; fire("d"); }));
  ctx.sub(() => clearTimeout(t));
}

const carrierOf = (ctx, id) => ctx.carriers.find((c) => c.id === id) || {};
const factorName = (c) => c.factorName || "Factoring";

export function loadMath(ctx, l, m) {
  const c = carrierOf(ctx, l.carrierId);
  const rate = num(m && m.rate);
  const factored = !!m && m.factored !== false && num(c.factorPct) > 0;
  const factorFee = factored ? (rate * num(c.factorPct)) / 100 : 0;
  const dispatchFee = num(m && m.fee);
  const hasDep = !!m && m.deposit !== undefined && m.deposit !== null && m.deposit !== "";
  const deposit = hasDep ? num(m.deposit) : 0;
  // what the factoring company kept back on this load (fuel advances on their card, etc.)
  const kept = hasDep ? Math.max(0, rate - factorFee - deposit) : 0;
  const miles = num(l.miles) + num(l.emptyMiles);
  return { rate, factored, factorFee, dispatchFee, net: rate - factorFee - dispatchFee, hasDep, deposit, kept, miles };
}
const loadDate = (ctx, l) => {
  const by = carrierOf(ctx, l.carrierId).countBy;
  return (by === "delivery" ? l.deliverBy || l.pickupDate : l.pickupDate || l.deliverBy) || isoOf(l.createdAt);
};
const isCard = (e) => (e.paidWith || (["Fuel", "DEF"].includes(e.cat) ? "factor" : "own")) === "factor";

// ---------- Recurring charges post themselves on their due dates (same id everywhere, so never twice) ----------

function nthDate(start, freq, k) {
  const s = new Date(start + "T12:00:00");
  if (freq[0] === "w") { const d = new Date(s); d.setDate(s.getDate() + 7 * Number(freq.slice(1)) * k); return ymd(d); }
  const mo = s.getMonth() + Number(freq.slice(1)) * k, y = s.getFullYear() + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12;
  return ymd(new Date(y, mm, Math.min(s.getDate(), new Date(y, mm + 1, 0).getDate()), 12));
}
function dueDates(it, upTo) {
  const out = [], end = it.end && it.end < upTo ? it.end : upTo;
  if (!it.start) return out;
  for (let k = 0; k < 1000; k++) { const d = nthDate(it.start, it.freq || "m1", k); if (d > end) break; out.push(d); }
  return out;
}
const recExpId = (it, d) => `rc-${it.id}-${d}`;
function nextDue(it, expenses) {
  if (it.end) return "";
  const t = today();
  for (let k = 0; k < 1000; k++) { const d = nthDate(it.start, it.freq || "m1", k); if (d >= t && !(it.skip || []).includes(d) && !expenses.some((e) => e.id === recExpId(it, d))) return d; }
  return "";
}
const posting = new Set();
async function postRecurring(ctx, st) {
  if (!["owner", "carrierAdmin"].includes(role(ctx)) || !st.ready) return;
  const have = new Set(st.expenses.map((e) => e.id));
  let n = 0;
  for (const it of st.recurring) {
    for (const d of dueDates(it, today())) {
      const id = recExpId(it, d);
      if (have.has(id) || posting.has(id) || (it.skip || []).includes(d)) continue;
      posting.add(id);
      try {
        await setDoc(doc(db, "expenses", id), { carrierId: it.carrierId, rec: it.id, cat: it.cat, amount: num(it.amount), truckId: it.truckId || null,
          date: d, paidWith: it.paidWith || "own", gallons: 0, state: "", note: it.name + (it.note ? " · " + it.note : ""), createdAt: serverTimestamp() });
        n++;
      } catch (e) { console.error(e); }
    }
  }
  if (n) toast(`Added ${n} recurring charge${n === 1 ? "" : "s"}`, "ok");
}

// ---------- Summary (the Dijla dashboard) ----------

export function summaryView(ctx, root, ids) {
  const per = { per: "month", from: "", to: "" };
  const tiles = h("div", { class: "stats" });
  const alertBox = h("div", { class: "notice", hidden: true });
  const sumBody = h("div", { class: "table-wrap" });
  const sumTitle = h("h2", null, "Summary");
  const bars = h("div", { class: "bars" });
  const brokers = h("div");
  let last = null;
  const draw = () => {
    const st = last; if (!st) return;
    const r = range(per.per, per.from, per.to);
    const L = st.loads.filter((l) => l.status !== "cancelled" && inRange(loadDate(ctx, l), r));
    const E = st.expenses.filter((e) => inRange(e.date, r));
    const drivers = new Map(st.drivers.map((d) => [d.id, d]));
    const one = ids.length === 1;
    const trucks = one ? st.trucks.filter((t) => t.carrierId === ids[0]) : [];
    // columns: each truck of the carrier (or each carrier when looking at all), plus Total
    const cols = one ? [...trucks.map((t) => [t.id, t.unit]), ["all", "Total"]] : [...ctx.carriers.filter((c) => ids.includes(c.id)).map((c) => [c.id, c.name]), ["all", "Total"]];
    const calc = (id) => {
      const ls = id === "all" ? L : L.filter((l) => (one ? l.truckId === id : l.carrierId === id));
      const share = (e) => {
        if (id === "all") return num(e.amount);
        if (!one) return e.carrierId === id ? num(e.amount) : 0;
        if (e.truckId === id) return num(e.amount);
        return e.truckId ? 0 : num(e.amount) / Math.max(1, trucks.length); // company-wide costs split across trucks
      };
      let gross = 0, ff = 0, df = 0, kept = 0, miles = 0, dpay = 0, wsum = 0, wn = 0, wmax = 0, owed = 0;
      ls.forEach((l) => {
        const m = loadMath(ctx, l, st.money.get(l.id));
        gross += m.rate; ff += m.factorFee; df += m.dispatchFee; kept += m.kept; miles += m.miles;
        if (!(st.money.get(l.id) || {}).feePaid) owed += m.dispatchFee;
        dpay += driverPayFor(l, m.rate, drivers.get(l.driverId));
        const w = num(l.weight); if (w > 0) { wsum += w; wn++; wmax = Math.max(wmax, w); }
      });
      const cardSpend = E.filter(isCard).reduce((s, e) => s + share(e), 0);
      const other = E.filter((e) => !isCard(e)).reduce((s, e) => s + share(e), 0);
      const factorOut = Math.max(cardSpend, kept); // same money, counted once
      const costs = ff + df + factorOut + other + dpay;
      return { n: ls.length, gross, ff, df, owed, factorOut, paid: gross - ff - factorOut, other, dpay, profit: gross - costs, miles, costs, wavg: wn ? wsum / wn : 0, wmax };
    };
    const c = cols.map(([id]) => calc(id));
    const T = c[c.length - 1];
    const fn = one ? factorName(carrierOf(ctx, ids[0])) : "Factoring";
    tiles.replaceChildren(
      stat("Gross", money(T.gross), `${T.n} load${T.n === 1 ? "" : "s"}`),
      stat("Dispatch fees", money(T.df)),
      stat("Owed to dispatch", money(T.owed), "Unpaid fees"),
      stat("Driver pay", money(T.dpay), "From each driver's pay setup"),
      stat("Profit", money(T.profit), "After fees, fuel, expenses and driver pay"));
    const rows = [
      ["Loads", (x) => String(x.n)], ["Gross", (x) => money0(x.gross)], [`${fn} fees`, (x) => money0(-x.ff)],
      [`${fn} fuel & deductions`, (x) => money0(-x.factorOut)], ["Paid to you (after fuel)", (x) => h("b", null, money0(x.paid)), "key"],
      ["Dispatch fees", (x) => money0(-x.df)], ["Driver pay", (x) => money0(-x.dpay)], ["Other expenses", (x) => money0(-x.other)],
      ["Profit", (x) => h("b", { class: x.profit >= 0 ? "pos" : "neg" }, money0(x.profit)), "key"],
      ["Miles", (x) => x.miles.toLocaleString("en-US")], ["Revenue / mile", (x) => rpm(x.gross, x.miles)], ["Cost / mile", (x) => rpm(x.costs, x.miles)],
      ["Avg weight", (x) => (x.wavg ? Math.round(x.wavg).toLocaleString("en-US") + " lb" : "–")], ["Heaviest", (x) => (x.wmax ? x.wmax.toLocaleString("en-US") + " lb" : "–")],
    ];
    const nd = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    sumTitle.textContent = per.per === "all" ? "Summary · All time" : `Summary · ${per.per === "custom" ? "" : (PERIODS.find((p) => p[0] === per.per) || [0, ""])[1] + " · "}${nd(r[0])} – ${nd(r[1])}`;
    sumBody.replaceChildren(h("table", { class: "table sum" },
      h("thead", null, h("tr", null, h("th", null, ""), cols.map(([, n]) => h("th", { class: "r" }, n)))),
      h("tbody", null, rows.map(([lab, f, cls]) => h("tr", { class: cls || null }, h("td", null, lab), c.map((x) => h("td", { class: "r mono" }, f(x))))))));
    // delivered but not paid yet (any date)
    const wait = st.loads.filter((l) => l.status === "delivered");
    const ageDays = (l) => num(carrierOf(ctx, l.carrierId).ageDays) || 30;
    const late = wait.filter((l) => daysSince(l.deliverBy || l.pickupDate || isoOf(l.createdAt)) >= ageDays(l));
    alertBox.hidden = !wait.length;
    alertBox.replaceChildren(h("b", null, money(wait.reduce((s, l) => s + loadMath(ctx, l, st.money.get(l.id)).net, 0))),
      ` still to be paid on ${wait.length} delivered load${wait.length === 1 ? "" : "s"}.`,
      late.length ? h("span", { class: "neg" }, ` ${late.length} older than ${ageDays(late[0])} days.`) : null);
    // categories
    const cats = {};
    E.forEach((e) => (cats[e.cat] = (cats[e.cat] || 0) + num(e.amount)));
    const top = Object.entries(cats).sort((a, b) => b[1] - a[1]), max = top.length ? top[0][1] : 1;
    bars.replaceChildren(...(top.length ? top.map(([k, v]) => h("div", { class: "bar" }, h("span", null, k), h("span", { class: "bar-track" }, h("i", { style: `width:${Math.max(3, (v / max) * 100)}%` })), h("span", { class: "mono" }, money0(v))))
      : [h("p", { class: "empty" }, "No expenses in this period.")]));
    // brokers
    const br = {};
    L.forEach((l) => { const k = (l.broker || "(no broker)").trim(); const m = loadMath(ctx, l, st.money.get(l.id)); br[k] = br[k] || { n: 0, g: 0, mi: 0 }; br[k].n++; br[k].g += m.rate; br[k].mi += m.miles; });
    const bl = Object.entries(br).sort((a, b) => b[1].g - a[1].g).slice(0, 8);
    brokers.replaceChildren(table([
      { label: "Broker", cell: ([k]) => h("span", { class: "strong" }, k) },
      { label: "Loads", cell: ([, v]) => String(v.n), align: "right" },
      { label: "Gross", cell: ([, v]) => h("span", { class: "mono" }, money0(v.g)), align: "right" },
      { label: "$/mile", cell: ([, v]) => h("span", { class: "mono" }, rpm(v.g, v.mi)), align: "right" },
    ], bl, "No loads in this period."));
  };
  watchOps(ctx, ids, (st) => { last = st; draw(); postRecurring(ctx, st); }, { drivers: true });
  root.append(
    periodBar(per, draw), alertBox, tiles,
    card(null, null, sumTitle, sumBody, h("p", { class: "muted small" }, ids.length === 1 ? "Company-wide expenses (no truck picked) are split evenly across trucks." : "Columns are carriers. Pick one carrier above to see it truck by truck.")),
    h("div", { class: "grid-2" }, card("Expenses by category", null, bars), card("Top brokers", null, brokers)));
}

// ---------- Loads (Dijla-style list with stages, deposit and the rate con scanner) ----------

function truckOptions(trucks, carrierId, cur, allowNone = true) {
  return [...(allowNone ? [{ value: "", label: "No truck" }] : []), ...trucks.filter((t) => t.carrierId === carrierId).map((t) => ({ value: t.id, label: t.unit, selected: t.id === cur }))];
}

// The load form: new or edit. Shown inline at the top of the Loads page.
function loadForm(ctx, st, ids, existing, onDone) {
  const isStaff = ["owner", "dispatcher"].includes(role(ctx));
  const isCarrier = role(ctx) === "carrierAdmin";
  const m0 = existing ? st.money.get(existing.id) || {} : {};
  const carriers = ctx.carriers.filter((c) => ids.includes(c.id));
  const carrierSel = select("carrierId", carriers.map((c) => ({ value: c.id, label: c.name, selected: existing && existing.carrierId === c.id })), { disabled: !!existing });
  const truckSel = select("truckId", []);
  const driverSel = select("driverId", []);
  let drivers = [];
  const fillPeople = async () => {
    const cid = carrierSel.value;
    truckSel.replaceChildren(...truckOptions(st.trucks, cid, existing && existing.truckId).map((o) => h("option", { value: o.value, selected: o.selected }, o.label)));
    const ds = await getDocs(query(collection(db, "users"), where("carrierId", "==", cid), where("role", "==", "driver"))).catch(() => null);
    drivers = ds ? ds.docs.map((d) => ({ id: d.id, ...d.data() })) : [];
    driverSel.replaceChildren(h("option", { value: "" }, "No driver"), ...drivers.map((d) => h("option", { value: d.id, selected: existing && existing.driverId === d.id }, d.name || d.email)));
  };
  carrierSel.addEventListener("change", () => { fillPeople(); calc(); feeAuto(); });
  driverSel.addEventListener("change", () => { const d = drivers.find((x) => x.id === driverSel.value); if (d && d.truckId) truckSel.value = d.truckId; });

  const v = existing || {};
  const I = (name, attrs = {}) => input(name, attrs);
  const rateIn = I("rate", { type: "number", min: "0", step: "0.01", inputmode: "decimal", placeholder: "0.00", value: m0.rate ?? "" });
  const feeIn = I("fee", { type: "number", min: "0", step: "0.01", inputmode: "decimal", value: m0.fee ?? "" });
  const brokerIn = I("broker", { list: "broker-list", placeholder: "Broker name", value: v.broker || "" });
  const brokerList = h("datalist", { id: "broker-list" }, [...new Set(st.loads.map((l) => l.broker).filter(Boolean))].sort().map((b) => h("option", { value: b })));
  const f = {
    loadNo: I("loadNo", { class: "input mono", placeholder: "Optional", value: v.loadNo || "" }),
    origin: I("origin", { placeholder: "Boise, ID", required: true, value: v.origin || "" }),
    pickupDate: I("pickupDate", { type: "date", value: v.pickupDate || (existing ? "" : today()) }),
    destination: I("destination", { placeholder: "Denver, CO", required: true, value: v.destination || "" }),
    deliverBy: I("deliverBy", { type: "date", value: v.deliverBy || "" }),
    miles: I("miles", { type: "number", min: "0", inputmode: "numeric", placeholder: "0", value: v.miles || "" }),
    emptyMiles: I("emptyMiles", { type: "number", min: "0", inputmode: "numeric", placeholder: "0", value: v.emptyMiles || "" }),
    weight: I("weight", { type: "number", min: "0", max: "200000", inputmode: "numeric", placeholder: "e.g. 42000", value: v.weight || "" }),
    commodity: I("commodity", { placeholder: "e.g. Onions", value: v.commodity || "" }),
    notes: I("notes", { placeholder: "Reefer temp, appointment #, etc.", value: v.notes || "" }),
  };
  const factoredIn = h("input", { type: "checkbox", name: "factored", checked: existing ? m0.factored !== false : true });
  const factoredLbl = h("span");
  const depositIn = I("deposit", { type: "number", min: "0", step: "0.01", inputmode: "decimal", placeholder: "Leave blank until paid", value: m0.deposit ?? "" });
  const calcLine = h("div", { class: "calc" });
  const calc = () => {
    const c = carrierOf(ctx, carrierSel.value);
    factoredLbl.textContent = num(c.factorPct) ? `Factored with ${factorName(c)} (${num(c.factorPct)}%)` : "Factored (set the factoring % in Settings)";
    const fake = { carrierId: carrierSel.value, miles: f.miles.value, emptyMiles: f.emptyMiles.value };
    const m = loadMath(ctx, fake, { rate: rateIn.value, fee: feeIn.value, factored: factoredIn.checked, deposit: depositIn.value });
    calcLine.replaceChildren(m.rate ? `${m.miles.toLocaleString()} mi · ${rpm(m.rate, m.miles)}/mi` : "Enter the rate to see the math",
      m.factorFee ? ` · ${factorName(carrierOf(ctx, carrierSel.value))} −${money(m.factorFee)}` : "",
      m.dispatchFee ? ` · dispatch −${money(m.dispatchFee)}` : "",
      m.rate ? h("b", null, ` · Carrier keeps ${money(m.net)}`) : "");
  };
  const feeAuto = () => {
    const c = carrierOf(ctx, carrierSel.value);
    if (isStaff && !existing && !feeIn.dataset.touched && c.feePercent && rateIn.value) feeIn.value = ((num(rateIn.value) * num(c.feePercent)) / 100).toFixed(2);
    calc();
  };
  rateIn.addEventListener("input", feeAuto);
  feeIn.addEventListener("input", () => { feeIn.dataset.touched = "1"; calc(); });
  [f.miles, f.emptyMiles, depositIn].forEach((x) => x.addEventListener("input", calc));
  factoredIn.addEventListener("change", calc);

  // Rate con scanner: reads the paper and fills in the form, then keeps the file as the load's rate con.
  const scans = scanPicker("Other paperwork (BOL, POD, receipts)");
  const kindSel = select("docKind", DOC_KINDS.slice(0, 5));
  const rcMsg = h("p", { class: "scanmsg", role: "status" }, "Fills in the load for you from a PDF, a scan or a photo. The rate con is also saved with the load.");
  let rcFile = null;
  const rcInput = h("input", { type: "file", accept: "application/pdf,.pdf,image/*", class: "visually-hidden", id: "rc-file", "data-role": "ratecon" });
  rcInput.addEventListener("change", async () => {
    const file = rcInput.files[0]; rcInput.value = "";
    if (!file) return;
    rcFile = file;
    const say = (t, cls) => { rcMsg.textContent = t; rcMsg.className = "scanmsg " + (cls || ""); };
    say("Reading…");
    try {
      const c = carrierOf(ctx, carrierSel.value);
      const { text } = await RateCon.readFile(file, (t) => say(t));
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const r = RateCon.parse(text, { self: c.name ? new RegExp(esc(c.name.split(/\s+/)[0]), "i") : undefined });
      const set = (el, val) => { if (val === undefined || val === null || val === "") return; el.value = val; el.classList.add("filled"); };
      set(brokerIn, r.broker); set(rateIn, r.rate); set(f.loadNo, r.loadNo); set(f.origin, r.from); set(f.pickupDate, r.fromDate);
      set(f.destination, r.to); set(f.deliverBy, r.toDate); set(f.miles, r.miles); set(f.weight, r.weight); set(f.commodity, r.commodity);
      if (r.truckNo) { const t = st.trucks.find((x) => x.carrierId === carrierSel.value && String(x.unit).replace(/\D/g, "").replace(/^0+/, "") === String(r.truckNo).replace(/^0+/, "")); if (t) { truckSel.value = t.id; truckSel.classList.add("filled"); } }
      feeAuto();
      const n = ["broker", "rate", "loadNo", "from", "to", "fromDate", "toDate", "miles"].filter((k) => r[k]).length;
      say(n ? `Filled in ${n} field${n === 1 ? "" : "s"}. Check the highlighted fields before saving.` : "Couldn't read much from that one. Fill it in by hand; the file will still be saved.", n ? "ok" : "bad");
    } catch (e) {
      console.warn(e);
      say("Couldn't read that file. Check your connection, or fill it in by hand. The file will still be saved.", "bad");
    }
  });

  const form = h("form", { class: "stack", autocomplete: "off", onSubmit: async (e) => {
    e.preventDefault();
    const cid = carrierSel.value;
    const truck = st.trucks.find((t) => t.id === truckSel.value);
    const driver = drivers.find((d) => d.id === driverSel.value);
    const data = {
      broker: brokerIn.value.trim(), loadNo: f.loadNo.value.trim(),
      origin: f.origin.value.trim(), destination: f.destination.value.trim(),
      pickupDate: f.pickupDate.value || null, deliverBy: f.deliverBy.value || null,
      miles: Math.round(num(f.miles.value)), emptyMiles: Math.round(num(f.emptyMiles.value)),
      weight: Math.round(num(f.weight.value)), commodity: f.commodity.value.trim(), notes: f.notes.value.trim(),
      truckId: truck ? truck.id : null, truckUnit: truck ? truck.unit : null,
      driverId: driver ? driver.id : null, driverName: driver ? driver.name || driver.email : null,
      updatedAt: serverTimestamp(),
    };
    const money2 = { rate: Math.round(num(rateIn.value) * 100) / 100, factored: factoredIn.checked };
    // dispatchers don't see the deposit field, so they never touch it
    if (role(ctx) !== "dispatcher" && (depositIn.value !== "" || existing)) money2.deposit = depositIn.value === "" ? null : Math.round(num(depositIn.value) * 100) / 100;
    const ok = await guard(async () => {
      let id;
      if (existing) {
        id = existing.id;
        await updateDoc(doc(db, "loads", id), data);
        const mUpd = { ...money2 };
        if (isStaff) mUpd.fee = Math.round(num(feeIn.value) * 100) / 100;
        if (isCarrier && num(m0.fee) > 0) delete mUpd.rate; // a dispatched load's rate is set by dispatch
        await updateDoc(doc(db, "loadMoney", id), mUpd);
      } else {
        const ref = await addDoc(collection(db, "loads"), {
          ...data, carrierId: cid, status: "booked", stageAt: today(), createdAt: serverTimestamp(),
          dispatcherId: isStaff ? ctx.uid : null, dispatcherName: isStaff ? ctx.profile.name || "" : null, selfBooked: isCarrier,
        });
        id = ref.id;
        await setDoc(doc(db, "loadMoney", id), { carrierId: cid, ...money2, fee: isStaff ? Math.round(num(feeIn.value) * 100) / 100 : 0, feePaid: false });
      }
      const label = `${shortId(id)} ${data.origin} → ${data.destination}`;
      const status = isCarrier ? "filed" : "approved";
      if (rcFile) await saveScans(ctx, [rcFile], { carrierId: cid, loadId: id, loadLabel: label, kind: "Rate con", category: "Rate cons", status });
      if (scans.files().length) await saveScans(ctx, scans.files(), { carrierId: cid, loadId: id, loadLabel: label, kind: kindSel.value, status });
      return true;
    }, existing ? "Load saved" : (rcFile || scans.files().length ? "Load booked with paperwork" : "Load booked"));
    if (ok) onDone();
  } },
    h("h2", null, existing ? `Edit load ${shortId(existing.id)}` : "New load"),
    h("div", { class: "scanner" },
      h("label", { for: "rc-file", class: "btn btn-dark scanbtn" }, "Scan rate con"),
      rcInput, rcMsg),
    h("div", { class: "form-grid" },
      carriers.length > 1 ? field("Carrier", carrierSel) : null,
      field("Truck", truckSel), field("Driver", driverSel),
      field("Rate ($)", rateIn),
      isStaff ? field("Dispatch fee ($)", feeIn, "Auto-fills from the carrier's fee %") : null,
      field("Broker", brokerIn), field("Load #", f.loadNo),
      field("Pickup (City, ST)", f.origin), field("Pickup date", f.pickupDate),
      field("Delivery (City, ST)", f.destination), field("Delivery date", f.deliverBy),
      field("Loaded miles", f.miles), field("Empty miles (deadhead)", f.emptyMiles),
      field("Weight (lb)", f.weight), field("Commodity", f.commodity),
      role(ctx) !== "dispatcher" ? field("Factoring deposit ($)", depositIn, "What actually hit the bank, after fuel. Leave blank until paid.") : null),
    brokerList,
    h("label", { class: "check" }, factoredIn, factoredLbl),
    calcLine,
    field("Notes", f.notes),
    h("div", { class: "scan-block" }, h("div", { class: "form-grid" }, field("Paperwork type", kindSel)), scans.el),
    h("div", { class: "row-inline" }, btn(existing ? "Save changes" : "Save load", null, "primary", { type: "submit" }), btn("Cancel", onDone, "ghost")));
  fillPeople().then(calc);
  calc();
  return h("section", { class: "card form-card" }, form);
}

export function loadsView(ctx, root, ids) {
  const isOwner = role(ctx) === "owner", canDeposit = ["owner", "carrierAdmin"].includes(role(ctx));
  const showFee = role(ctx) !== "driver";
  const state = { stage: "open", truck: "all", q: "", limit: 50 };
  const formSlot = h("div");
  const stats = h("div", { class: "stats" });
  const truckChips = h("div", { class: "chips", role: "group", "aria-label": "Truck" });
  const stageChips = h("div", { class: "chips", role: "group", "aria-label": "Stage" });
  const search = input("q", { type: "search", placeholder: "Search broker, load #, city, driver…", "aria-label": "Search loads" });
  const list = h("div", { class: "list items" });
  const report = h("div");
  let st = null;
  search.addEventListener("input", () => { state.q = search.value.trim().toLowerCase(); state.limit = 50; draw(); });
  const closeForm = () => formSlot.replaceChildren();
  const openForm = (l) => { formSlot.replaceChildren(loadForm(ctx, st, ids, l, closeForm)); formSlot.scrollIntoView({ block: "start", behavior: "smooth" }); };

  const setStage = (l, s) => guard(() => updateDoc(doc(db, "loads", l.id), { status: s, stageAt: today(), ...(s === "paid" ? { paidAt: today() } : {}), ...(s === "delivered" && !l.deliverBy ? { deliverBy: today() } : {}), updatedAt: serverTimestamp() }), `Marked ${stageLabel(s)}`);

  const draw = () => {
    if (!st) return;
    const one = ids.length === 1;
    const byTruck = st.loads.filter((l) => state.truck === "all" || l.truckId === state.truck);
    const counts = Object.fromEntries(STAGES.map(([id]) => [id, byTruck.filter((l) => l.status === id).length]));
    const openN = byTruck.filter((l) => OPEN.includes(l.status)).length;
    stageChips.replaceChildren(...[["open", "Active", openN], ["all", "All", byTruck.length], ...STAGES.map(([id, lab]) => [id, lab, counts[id]]), ["cancelled", "Cancelled", byTruck.filter((l) => l.status === "cancelled").length]]
      .map(([id, lab, n]) => h("button", { type: "button", class: "chip" + (state.stage === id ? " on" : ""), "aria-pressed": String(state.stage === id), onClick: () => { state.stage = id; state.limit = 50; draw(); } }, lab, h("span", { class: "chip-n" }, String(n)))));
    const trucks = one ? st.trucks.filter((t) => t.carrierId === ids[0]) : [];
    truckChips.hidden = !trucks.length;
    truckChips.replaceChildren(...[["all", "All trucks"], ...trucks.map((t) => [t.id, t.unit])].map(([id, lab]) => h("button", { type: "button", class: "chip" + (state.truck === id ? " on" : ""), "aria-pressed": String(state.truck === id), onClick: () => { state.truck = id; draw(); } }, lab)));
    // stats
    const mr = range("month");
    const monthNet = st.loads.filter((l) => l.status !== "cancelled" && inRange(loadDate(ctx, l), mr)).reduce((s, l) => s + loadMath(ctx, l, st.money.get(l.id)).net, 0);
    const waiting = st.loads.filter((l) => l.status === "delivered");
    stats.replaceChildren(
      stat("Active loads", String(st.loads.filter((l) => OPEN.includes(l.status)).length)),
      stat("Waiting on pay", money(waiting.reduce((s, l) => s + loadMath(ctx, l, st.money.get(l.id)).net, 0)), `${waiting.length} delivered`),
      stat("Net this month", money(monthNet)));
    const shown = byTruck.filter((l) => (state.stage === "all" ? true : state.stage === "open" ? OPEN.includes(l.status) : l.status === state.stage))
      .filter((l) => !state.q || [l.broker, l.loadNo, l.origin, l.destination, l.driverName, l.truckUnit, l.commodity, shortId(l.id), ctx.carrierName(l.carrierId)].filter(Boolean).join(" ").toLowerCase().includes(state.q))
      .sort((a, b) => String(b.pickupDate || isoOf(b.createdAt)).localeCompare(String(a.pickupDate || isoOf(a.createdAt))) || byNewest(a, b));
    list.replaceChildren(...(shown.length ? shown.slice(0, state.limit).map((l) => loadItem(l)) : [h("p", { class: "empty" }, st.loads.length ? "No loads match." : "No loads yet. Tap “+ New load”.")]),
      shown.length > state.limit ? h("div", { class: "more" }, h("span", { class: "muted small" }, `Showing ${state.limit} of ${shown.length}`), btn("Show more", () => { state.limit += 50; draw(); }, "ghost")) : null);
  };

  const loadItem = (l) => {
    const mon = st.money.get(l.id);
    const m = loadMath(ctx, l, mon);
    const c = carrierOf(ctx, l.carrierId);
    const meta = [ids.length > 1 ? ctx.carrierName(l.carrierId) : null, l.truckUnit, l.driverName, `${fmtDate(l.pickupDate)} → ${fmtDate(l.deliverBy)}`,
      m.miles ? `${m.miles.toLocaleString()} mi` : null, m.rate && m.miles ? `${rpm(m.rate, m.miles)}/mi` : null,
      l.weight ? `${num(l.weight).toLocaleString()} lb` : null, l.commodity || null,
      m.factored ? `net ${money(m.net)}` : m.rate ? "not factored" : null].filter(Boolean).join(" · ");
    const depIn = input("dep", { type: "number", min: "0", step: "0.01", inputmode: "decimal", placeholder: `${factorName(c)} deposit $`, "aria-label": "Deposit for load " + shortId(l.id), value: m.hasDep ? m.deposit : "" });
    const depRow = canDeposit && (m.hasDep || l.status === "paid") ? h("div", { class: "deprow" },
      m.hasDep ? h("span", { class: "small" }, `${factorName(c)} deposit `, h("b", { class: "pos" }, money(m.deposit)), m.kept ? ` · fuel/advances kept back ${money(m.kept)}` : "") : null,
      h("form", { class: "inline-form", onSubmit: (e) => { e.preventDefault(); guard(() => updateDoc(doc(db, "loadMoney", l.id), { deposit: depIn.value === "" ? null : Math.round(num(depIn.value) * 100) / 100 }), "Deposit saved"); } },
        depIn, btn(m.hasDep ? "Update" : "Save deposit", null, "ghost", { type: "submit", class: "btn btn-ghost btn-sm" }))) : null;
    const days = OPEN.includes(l.status) && l.stageAt ? daysSince(l.stageAt) : null;
    return h("article", { class: "item st-" + l.status },
      h("div", { class: "item-top" },
        h("div", { class: "grow" },
          h("div", { class: "muted small" }, [l.broker, l.loadNo ? "#" + l.loadNo : null, shortId(l.id)].filter(Boolean).join(" · ")),
          h("div", { class: "item-lane" }, lane(l))),
        h("div", { class: "item-right" }, pill(l.status, stageLabel(l.status)), showFee ? h("b", { class: "mono" }, money(m.rate)) : null)),
      h("div", { class: "muted small" }, meta),
      showFee && m.dispatchFee ? h("div", { class: "muted small" }, `Dispatch fee ${money(m.dispatchFee)}${mon && mon.feePaid ? " · paid" : ""}`) : null,
      l.notes ? h("div", { class: "quote small" }, l.notes) : null,
      depRow,
      days !== null ? h("div", { class: "muted small" }, `${days} day${days === 1 ? "" : "s"} in this stage`) : null,
      h("div", { class: "steps", role: "group", "aria-label": "Set stage" },
        STAGES.map(([id, lab]) => h("button", { type: "button", class: "step", "aria-pressed": String(l.status === id), onClick: () => l.status !== id && setStage(l, id) }, lab))),
      h("div", { class: "acts" },
        btn("Edit", () => openForm(l), "ghost", { class: "btn btn-ghost btn-sm" }),
        btn("Paperwork", () => openScanDialog(ctx, l), "ghost", { class: "btn btn-ghost btn-sm", "aria-label": "Scan paperwork for load " + shortId(l.id) }),
        l.status !== "cancelled" ? btn("Cancel load", () => confirm("Mark this load cancelled?") && setStage(l, "cancelled"), "ghost", { class: "btn btn-ghost btn-sm" }) : null,
        isOwner ? btn("Delete", async () => { if (!confirm("Delete this load for good?")) return; await guard(async () => { await deleteDoc(doc(db, "loadMoney", l.id)); await deleteDoc(doc(db, "loads", l.id)); }, "Load deleted"); }, "ghost", { class: "btn btn-ghost btn-sm danger" }) : null));
  };

  // Loads report → PDF
  const reportCard = () => {
    const per = { per: "month", from: "", to: "" };
    const trucks = ids.length === 1 ? st.trucks.filter((t) => t.carrierId === ids[0]) : [];
    const truckSel = select("truck", [{ value: "all", label: "All trucks" }, ...trucks.map((t) => ({ value: t.id, label: t.unit }))]);
    const stSel = select("status", [{ value: "all", label: "All" }, { value: "open", label: "Not paid yet" }, ...STAGES.map(([v, label]) => ({ value: v, label }))]);
    const brokers = [...new Set(st.loads.map((l) => l.broker).filter(Boolean))].sort();
    const brSel = select("broker", [{ value: "", label: "All brokers" }, ...brokers]);
    const count = h("p", { class: "muted small" });
    const pick = () => {
      const r = range(per.per, per.from, per.to);
      return st.loads.filter((l) => l.status !== "cancelled" && inRange(loadDate(ctx, l), r))
        .filter((l) => truckSel.value === "all" || l.truckId === truckSel.value)
        .filter((l) => stSel.value === "all" || (stSel.value === "open" ? OPEN.includes(l.status) : l.status === stSel.value))
        .filter((l) => !brSel.value || l.broker === brSel.value)
        .sort((a, b) => String(loadDate(ctx, a)).localeCompare(String(loadDate(ctx, b))));
    };
    const upd = () => { count.textContent = `${pick().length} loads match`; };
    [truckSel, stSel, brSel].forEach((x) => x.addEventListener("change", upd));
    upd();
    return card("Loads report", btn("Close", () => report.replaceChildren(), "ghost", { class: "btn btn-ghost btn-sm" }),
      periodBar(per, upd),
      h("div", { class: "form-grid" }, trucks.length ? field("Truck", truckSel) : null, field("Status", stSel), field("Broker", brSel)),
      count,
      h("div", null, btn("View PDF", () => {
        const rows = pick().map((l) => { const m = loadMath(ctx, l, st.money.get(l.id)); return { ...l, ...m, id: shortId(l.id), carrier: ctx.carrierName(l.carrierId), truck: l.truckUnit, status: stageLabel(l.status) }; });
        const r = range(per.per, per.from, per.to);
        loadsPdf({ title: ids.length === 1 ? `${ctx.carrierName(ids[0])} · Loads` : "All carriers · Loads", sub: per.per === "all" ? "All time" : `${fmtDate(r[0])} – ${fmtDate(r[1])}`, rows, showFee: true });
      }, "primary")));
  };

  watchOps(ctx, ids, (s) => { st = s; draw(); }, { expenses: false });
  root.append(
    stats,
    h("div", { class: "row-inline" }, btn("+ New load", () => st && openForm(null), "primary"), btn("Loads report", () => st && report.replaceChildren(reportCard()), "ghost")),
    report, formSlot, truckChips, stageChips, search, list);
}

// ---------- Expenses + recurring ----------

export function expensesView(ctx, root, ids) {
  const state = { view: "all", truck: "all", cat: "", per: { per: "month", from: "", to: "" } };
  let st = null;
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Expenses view" });
  const main = h("div", { class: "view" });
  const rec = h("div", { class: "view" });
  const stats = h("div", { class: "stats" });
  const formSlot = h("div");
  const report = h("div");
  const truckChips = h("div", { class: "chips", role: "group", "aria-label": "Truck" });
  const catSel = h("select", { class: "input", "aria-label": "Category", onChange: (e) => { state.cat = e.target.value; draw(); } });
  const list = h("div", { class: "list items" });
  const recStats = h("div", { class: "stats" });
  const recForm = h("div");
  const recList = h("div", { class: "list items" });
  const fn = () => (ids.length === 1 ? factorName(carrierOf(ctx, ids[0])) : "Factoring");
  const truckName = (e) => (e.truckId ? (st.trucks.find((t) => t.id === e.truckId) || {}).unit || "Truck" : "Whole company");
  const trucksOf = () => (ids.length === 1 ? st.trucks.filter((t) => t.carrierId === ids[0]) : []);
  const share = (e) => (state.truck === "all" || e.truckId === state.truck ? num(e.amount) : !e.truckId ? num(e.amount) / Math.max(1, trucksOf().length) : 0);

  const closeForm = () => formSlot.replaceChildren();
  const openForm = (x) => { formSlot.replaceChildren(expenseForm(x)); formSlot.scrollIntoView({ block: "start", behavior: "smooth" }); };

  const expenseForm = (x) => {
    const carriers = ctx.carriers.filter((c) => ids.includes(c.id));
    const carrierSel = select("carrierId", carriers.map((c) => ({ value: c.id, label: c.name, selected: x && x.carrierId === c.id })), { disabled: !!x });
    const truckSel = select("truckId", []);
    const fillTrucks = () => truckSel.replaceChildren(h("option", { value: "" }, "Whole company (split across trucks)"),
      ...st.trucks.filter((t) => t.carrierId === carrierSel.value).map((t) => h("option", { value: t.id, selected: x ? x.truckId === t.id : state.truck === t.id }, t.unit)));
    carrierSel.addEventListener("change", () => { fillTrucks(); payLabels(); });
    fillTrucks();
    const v = x || { cat: "Fuel", date: today() };
    const catIn = select("cat", CATS.map((c) => ({ value: c, label: c, selected: c === v.cat })));
    const amt = input("amount", { type: "number", min: "0", step: "0.01", inputmode: "decimal", placeholder: "0.00", required: true, value: v.amount ?? "" });
    const date = input("date", { type: "date", value: v.date || today() });
    const paid = select("paidWith", [{ value: "factor", label: "" }, { value: "own", label: "Own card / cash" }]);
    const payLabels = () => { paid.options[0].textContent = `${factorName(carrierOf(ctx, carrierSel.value))} fuel card (taken out of load pay)`; };
    payLabels();
    let paidTouched = !!x;
    paid.value = v.paidWith || (["Fuel", "DEF"].includes(v.cat) ? "factor" : "own");
    paid.addEventListener("change", () => (paidTouched = true));
    const gal = input("gallons", { type: "number", min: "0", step: "0.001", inputmode: "decimal", value: v.gallons || "" });
    const stIn = input("state", { maxlength: "2", placeholder: "ID", style: "text-transform:uppercase", value: v.state || "" });
    const fuelRow = h("div", { class: "form-grid" }, field("Gallons", gal), field("State", stIn));
    const note = input("note", { placeholder: "e.g. Pilot #123, oil change", value: v.note || "" });
    const fuelToggle = () => { const fuel = ["Fuel", "DEF"].includes(catIn.value); fuelRow.hidden = !fuel; if (!paidTouched) paid.value = fuel ? "factor" : "own"; };
    catIn.addEventListener("change", fuelToggle);
    fuelToggle();
    // Bill / receipt scanner: fuel receipts and IFTA bills fill the form; the scan is kept as the receipt.
    const msg = h("p", { class: "scanmsg", role: "status" }, "Fuel receipts, IFTA service bills and statements. The scan is saved as the receipt.");
    const plan = h("div", { class: "billplan", hidden: true });
    let billFile = null;
    const billIn = h("input", { type: "file", accept: "application/pdf,.pdf,image/*", class: "visually-hidden", id: "bill-file", "data-role": "bill" });
    billIn.addEventListener("change", async () => {
      const file = billIn.files[0]; billIn.value = ""; if (!file) return;
      billFile = file;
      const say = (t, cls) => { msg.textContent = t; msg.className = "scanmsg " + (cls || ""); };
      const set = (el, val) => { if (val === undefined || val === "" || val === null) return; el.value = val; el.classList.add("filled"); };
      const truckByUnit = (u) => { const n = String(u || "").replace(/^0+/, ""); return st.trucks.find((t) => t.carrierId === carrierSel.value && String(t.unit).replace(/\D/g, "").replace(/^0+/, "") === n); };
      say("Reading…"); plan.hidden = true;
      try {
        const c = carrierOf(ctx, carrierSel.value);
        const { text } = await RateCon.readFile(file, (t) => say(t));
        const b = BillReader.parse(text, { self: c.name ? new RegExp(c.name.split(/\s+/)[0], "i") : undefined });
        if (b.fuel) {
          const fu = b.fuel;
          catIn.value = "Fuel"; catIn.classList.add("filled"); fuelToggle();
          set(amt, fu.total); set(date, fu.date); set(gal, fu.gallons); set(stIn, fu.state);
          paidTouched = true; paid.value = fu.factorCard ? "factor" : "own"; paid.classList.add("filled");
          const t = truckByUnit(fu.unit); if (t) { truckSel.value = t.id; truckSel.classList.add("filled"); }
          set(note, [[fu.vendor, fu.store ? "#" + fu.store : ""].filter(Boolean).join(" "), fu.city && fu.state ? `${fu.city}, ${fu.state}` : "", fu.ticket ? "Tkt #" + fu.ticket : "", fu.ppg ? `$${fu.ppg}/gal` : "", fu.def ? `incl. DEF ${money(fu.def)}` : ""].filter(Boolean).join(" · "));
          const dup = fu.ticket && st.expenses.find((e) => (e.note || "").includes("Tkt #" + fu.ticket));
          say(`Filled in ${money(fu.total || 0)} · ${fu.gallons} gal${fu.state ? " in " + fu.state : ""}${t ? " · " + t.unit : " · pick the truck"}. Check the highlighted fields and save.` + (dup ? ` Heads up: ticket #${fu.ticket} is already saved.` : ""), dup ? "bad" : "ok");
          return;
        }
        const label = [b.vendor || (b.ifta ? "IFTA service" : ""), b.month, b.period].filter(Boolean).join(" · ");
        if (b.units.length >= 1 && b.ifta) {
          // one expense per truck on the bill
          const units = b.units.map((u) => ({ ...u, truck: (truckByUnit(u.unit) || {}).id || "" }));
          const sels = units.map((u, i) => h("select", { class: "input input-sm", "aria-label": `Truck for unit ${u.unit}`, onChange: (e) => (units[i].truck = e.target.value) },
            h("option", { value: "" }, "Pick truck…"), st.trucks.filter((t) => t.carrierId === carrierSel.value).map((t) => h("option", { value: t.id, selected: t.id === u.truck }, t.unit))));
          plan.replaceChildren(h("b", null, label || "Breakdown"),
            ...units.map((u, i) => h("div", { class: "bp" }, h("span", null, `Unit ${u.unit} · `, h("b", null, money(u.total)), h("br"), h("span", { class: "muted small" }, `tax reporting ${money(u.tax)} + licensing ${money(u.lic)}`)), sels[i])),
            btn(`Add ${units.length} expense${units.length === 1 ? "" : "s"}`, async () => {
              if (units.some((u) => !u.truck)) return toast("Pick a truck for each unit", "bad");
              const ok = await guard(async () => {
                const [docId] = billFile ? await saveScans(ctx, [billFile], { carrierId: carrierSel.value, kind: "Receipt", category: "Receipts", status: "filed", name: label || "IFTA bill" }) : [null];
                for (const u of units) await addDoc(collection(db, "expenses"), { carrierId: carrierSel.value, cat: "IFTA service fee", amount: u.total, truckId: u.truck, date: b.date || today(), paidWith: "own", gallons: 0, state: "", note: `${label} · unit ${u.unit} · tax reporting ${money(u.tax)} + licensing ${money(u.lic)}`, docId: docId || null, createdAt: serverTimestamp() });
              }, `Added ${units.length} expense${units.length === 1 ? "" : "s"}`);
              if (ok !== null) closeForm();
            }, "primary"));
          plan.hidden = false;
          say(`Found ${units.length} truck${units.length === 1 ? "" : "s"} on this bill. Check the trucks and tap Add.`, "ok");
          return;
        }
        if (!b.total) return say("Couldn't find a total. Fill it in by hand; the scan will still be saved.", "bad");
        set(amt, b.total); set(date, b.date);
        if (b.ifta) { catIn.value = "IFTA service fee"; catIn.classList.add("filled"); fuelToggle(); paidTouched = true; paid.value = "own"; truckSel.value = ""; }
        set(note, [b.vendor, b.invoice ? "INV #" + b.invoice : "", b.items.map((i) => `${i.desc} ${money(i.amt)}`).join(" + ")].filter(Boolean).join(" · "));
        say(`Filled in ${money(b.total)}. Check the highlighted fields and save.`, "ok");
      } catch (e) { console.warn(e); say("Couldn't read that file. Fill it in by hand; the scan will still be saved.", "bad"); }
    });
    const form = h("form", { class: "stack", autocomplete: "off", onSubmit: async (e) => {
      e.preventDefault();
      const fuel = ["Fuel", "DEF"].includes(catIn.value);
      const data = { cat: catIn.value, amount: Math.round(num(amt.value) * 100) / 100, truckId: truckSel.value || null, date: date.value || today(), paidWith: paid.value,
        gallons: fuel ? num(gal.value) : 0, state: fuel ? stIn.value.trim().toUpperCase().slice(0, 2) : "", note: note.value.trim() };
      const ok = await guard(async () => {
        if (billFile) [data.docId] = await saveScans(ctx, [billFile], { carrierId: carrierSel.value, kind: "Receipt", category: "Receipts", status: "filed", name: `${data.cat} receipt · ${data.date}` });
        if (x) await updateDoc(doc(db, "expenses", x.id), data);
        else await addDoc(collection(db, "expenses"), { carrierId: carrierSel.value, ...data, createdAt: serverTimestamp() });
      }, x ? "Expense saved" : "Expense added");
      if (ok !== null) closeForm();
    } },
      h("h2", null, x ? "Edit expense" : "New expense"),
      h("div", { class: "scanner" }, h("label", { for: "bill-file", class: "btn btn-dark scanbtn" }, "Scan bill / receipt"), billIn, msg, plan),
      h("div", { class: "form-grid" },
        carriers.length > 1 ? field("Carrier", carrierSel) : null,
        field("Category", catIn), field("Amount ($)", amt), field("Truck", truckSel), field("Date", date), field("Paid with", paid)),
      fuelRow,
      field("Where / note", note),
      h("div", { class: "row-inline" }, btn(x ? "Save changes" : "Save expense", null, "primary", { type: "submit" }), btn("Cancel", closeForm, "ghost")));
    return h("section", { class: "card form-card" }, form);
  };

  const draw = () => {
    if (!st) return;
    seg.replaceChildren(...[["all", "All expenses"], ["rec", "Recurring"]].map(([v, l]) => h("button", { type: "button", class: "seg-btn", "aria-pressed": String(state.view === v), onClick: () => { state.view = v; draw(); } }, l)));
    main.hidden = state.view !== "all"; rec.hidden = state.view !== "rec";
    const trucks = trucksOf();
    truckChips.hidden = !trucks.length;
    truckChips.replaceChildren(...[["all", "All trucks"], ...trucks.map((t) => [t.id, t.unit])].map(([id, lab]) => h("button", { type: "button", class: "chip" + (state.truck === id ? " on" : ""), "aria-pressed": String(state.truck === id), onClick: () => { state.truck = id; draw(); } }, lab)));
    const used = [...new Set([...CATS, ...st.expenses.map((e) => e.cat)])];
    catSel.replaceChildren(h("option", { value: "" }, "All categories"), ...used.map((c) => h("option", { value: c, selected: c === state.cat }, c)));
    const r = range(state.per.per, state.per.from, state.per.to);
    const E = st.expenses.filter((e) => inRange(e.date, r) && share(e) > 0 && (!state.cat || e.cat === state.cat));
    const tot = E.reduce((s, e) => s + share(e), 0), card$ = E.filter(isCard).reduce((s, e) => s + share(e), 0);
    const fuel = E.filter((e) => e.cat === "Fuel"), galT = fuel.reduce((s, e) => s + num(e.gallons) * (share(e) / (num(e.amount) || 1)), 0), fuelAmt = fuel.reduce((s, e) => s + share(e), 0);
    stats.replaceChildren(stat("Total", money(tot), state.cat || null), stat(`On ${fn()} card`, money(card$)), stat("Own card / cash", money(tot - card$)),
      stat("Fuel $/gallon", galT ? "$" + (fuelAmt / galT).toFixed(2) : "–", galT ? `${Math.round(galT).toLocaleString()} gal` : null));
    const sorted = [...E].sort((a, b) => String(b.date).localeCompare(String(a.date)) || byNewest(a, b));
    list.replaceChildren(...(sorted.length ? sorted.slice(0, 200).map((e) => {
      const confirmRow = h("div", { class: "confirm", hidden: true }, h("span", null, "Delete this expense?"),
        btn("Keep", () => (confirmRow.hidden = true), "ghost", { class: "btn btn-ghost btn-sm" }),
        btn("Delete", async () => {
          await guard(async () => {
            await deleteDoc(doc(db, "expenses", e.id));
            const it = e.rec && st.recurring.find((r2) => r2.id === e.rec); // don't re-add a deleted recurring charge
            if (it && !(it.skip || []).includes(e.date)) await updateDoc(doc(db, "recurring", it.id), { skip: [...(it.skip || []), e.date] });
          }, "Expense deleted");
        }, "ghost", { class: "btn btn-ghost btn-sm danger" }));
      return h("article", { class: "item " + (e.cat === "Fuel" ? "st-fuel" : "st-exp") },
        h("div", { class: "item-top" },
          h("div", { class: "grow" }, h("div", { class: "item-lane" }, e.cat),
            h("div", { class: "muted small" }, [fmtDate(e.date), ids.length > 1 ? ctx.carrierName(e.carrierId) : null, truckName(e), e.cat === "Fuel" && e.gallons ? `${num(e.gallons)} gal${e.state ? " in " + e.state : ""}` : null, isCard(e) ? `${factorName(carrierOf(ctx, e.carrierId))} card` : null, e.rec ? "recurring" : null].filter(Boolean).join(" · "))),
          h("b", { class: "mono" }, money(num(e.amount)))),
        e.note ? h("div", { class: "small" }, e.note) : null,
        h("div", { class: "acts" },
          btn("Edit", () => openForm(e), "ghost", { class: "btn btn-ghost btn-sm" }),
          e.docId ? btn("Receipt", () => openDoc({ id: e.docId }), "ghost", { class: "btn btn-ghost btn-sm" }) : null,
          btn("Delete", () => (confirmRow.hidden = false), "ghost", { class: "btn btn-ghost btn-sm danger" })),
        confirmRow);
    }) : [h("p", { class: "empty" }, st.expenses.length ? "No expenses match these filters." : "No expenses yet. Tap “+ Add expense” for fuel, repairs and the rest.")]));
    drawRec();
  };

  // ---- recurring ----
  const drawRec = () => {
    const live = st.recurring.filter((it) => !it.end);
    const perMonth = (it) => num(it.amount) * (PER_MONTH[it.freq || "m1"] || 1);
    recStats.replaceChildren(stat("Fixed costs / month", money(live.reduce((s, it) => s + perMonth(it), 0))), stat("Active charges", String(live.length)));
    const sorted = [...st.recurring].sort((a, b) => (!!a.end - !!b.end) || String(nextDue(a, st.expenses)).localeCompare(String(nextDue(b, st.expenses))));
    recList.replaceChildren(...(sorted.length ? sorted.map((it) => h("article", { class: "item st-exp" + (it.end ? " ended" : "") },
      h("div", { class: "item-top" },
        h("div", { class: "grow" }, h("div", { class: "item-lane" }, it.name),
          h("div", { class: "muted small" }, [it.cat, FREQ[it.freq || "m1"], ids.length > 1 ? ctx.carrierName(it.carrierId) : null, it.truckId ? (st.trucks.find((t) => t.id === it.truckId) || {}).unit : "Whole company", it.end ? `Stopped ${fmtDate(it.end)}` : nextDue(it, st.expenses) ? `Next ${fmtDate(nextDue(it, st.expenses))}` : null].filter(Boolean).join(" · "))),
        h("b", { class: "mono" }, money(num(it.amount)))),
      h("div", { class: "acts" },
        btn("Edit", () => openRec(it), "ghost", { class: "btn btn-ghost btn-sm" }),
        !it.end ? btn("Stop", () => guard(() => updateDoc(doc(db, "recurring", it.id), { end: today() }), "Stopped. Past charges stay in expenses."), "ghost", { class: "btn btn-ghost btn-sm" }) : null,
        btn("Delete", () => confirm(`Delete “${it.name}”? Charges already posted stay in expenses.`) && guard(() => deleteDoc(doc(db, "recurring", it.id)), "Recurring charge removed"), "ghost", { class: "btn btn-ghost btn-sm danger" }))))
      : [h("p", { class: "empty" }, "No recurring charges yet. Add insurance, ELD, phones, truck payments and other fixed bills once, and they post themselves every period.")]));
  };
  const openRec = (it) => {
    const carriers = ctx.carriers.filter((c) => ids.includes(c.id));
    const carrierSel = select("carrierId", carriers.map((c) => ({ value: c.id, label: c.name, selected: it && it.carrierId === c.id })), { disabled: !!it });
    const truckSel = select("truckId", []);
    const fill = () => truckSel.replaceChildren(h("option", { value: "" }, "Whole company"), ...st.trucks.filter((t) => t.carrierId === carrierSel.value).map((t) => h("option", { value: t.id, selected: it && it.truckId === t.id }, t.unit)));
    carrierSel.addEventListener("change", fill); fill();
    const v = it || { cat: "Insurance", freq: "m1", start: today(), paidWith: "own" };
    const name = input("name", { required: true, placeholder: "e.g. Progressive insurance, Motive ELD", value: v.name || "" });
    const cat = select("cat", CATS.map((c) => ({ value: c, label: c, selected: c === v.cat })));
    const amt = input("amount", { type: "number", min: "0", step: "0.01", inputmode: "decimal", required: true, value: v.amount ?? "" });
    const freq = select("freq", Object.entries(FREQ).map(([value, label]) => ({ value, label, selected: value === v.freq })));
    const start = input("start", { type: "date", required: true, value: v.start || today() });
    const paid = select("paidWith", [{ value: "own", label: "Own card / bank", selected: v.paidWith !== "factor" }, { value: "factor", label: "Factoring (out of load pay)", selected: v.paidWith === "factor" }]);
    const note = input("note", { placeholder: "Optional, e.g. policy #", value: v.note || "" });
    const form = h("form", { class: "stack", onSubmit: async (e) => {
      e.preventDefault();
      const data = { name: name.value.trim(), cat: cat.value, amount: Math.round(num(amt.value) * 100) / 100, truckId: truckSel.value || null, freq: freq.value, start: start.value, paidWith: paid.value, note: note.value.trim() };
      const ok = await guard(() => (it ? updateDoc(doc(db, "recurring", it.id), data) : addDoc(collection(db, "recurring"), { carrierId: carrierSel.value, ...data, skip: [], createdAt: serverTimestamp() })), it ? "Saved" : "Recurring charge added");
      if (ok !== null) recForm.replaceChildren();
    } },
      h("h2", null, it ? "Edit recurring charge" : "New recurring charge"),
      h("div", { class: "form-grid" },
        carriers.length > 1 ? field("Carrier", carrierSel) : null,
        field("Name", name), field("Category", cat), field("Amount ($)", amt), field("Truck", truckSel), field("How often", freq), field("First charge date", start), field("Paid with", paid), field("Note", note)),
      h("p", { class: "muted small" }, "Each charge is added to expenses on its due date. Delete one from the expenses list if a month didn't get charged; it won't come back."),
      h("div", { class: "row-inline" }, btn("Save", null, "primary", { type: "submit" }), btn("Cancel", () => recForm.replaceChildren(), "ghost")));
    recForm.replaceChildren(h("section", { class: "card form-card" }, form));
  };

  // ---- report ----
  const reportCard = () => {
    const per = { per: "month", from: "", to: "" };
    const trucks = trucksOf();
    const truckSel = select("truck", [{ value: "all", label: "All trucks" }, ...trucks.map((t) => ({ value: t.id, label: t.unit }))]);
    const catR = select("cat", [{ value: "", label: "All categories" }, ...CATS]);
    const paidR = select("paid", [{ value: "all", label: "All" }, { value: "factor", label: "Factoring card" }, { value: "own", label: "Own card / cash" }]);
    const count = h("p", { class: "muted small" });
    const pick = () => { const r = range(per.per, per.from, per.to); return st.expenses.filter((e) => inRange(e.date, r) && (truckSel.value === "all" || e.truckId === truckSel.value) && (!catR.value || e.cat === catR.value) && (paidR.value === "all" || (paidR.value === "factor") === isCard(e))).sort((a, b) => String(a.date).localeCompare(String(b.date))); };
    const upd = () => (count.textContent = `${pick().length} expenses match`);
    [truckSel, catR, paidR].forEach((x) => x.addEventListener("change", upd));
    upd();
    return card("Expenses report", btn("Close", () => report.replaceChildren(), "ghost", { class: "btn btn-ghost btn-sm" }),
      periodBar(per, upd),
      h("div", { class: "form-grid" }, trucks.length ? field("Truck", truckSel) : null, field("Category", catR), field("Paid with", paidR)),
      count,
      h("div", null, btn("View PDF", () => {
        const r = range(per.per, per.from, per.to);
        expensesPdf({ title: ids.length === 1 ? `${ctx.carrierName(ids[0])} · Expenses` : "All carriers · Expenses", sub: per.per === "all" ? "All time" : `${fmtDate(r[0])} – ${fmtDate(r[1])}`, factorName: fn(),
          rows: pick().map((e) => ({ ...e, amount: num(e.amount), carrier: ctx.carrierName(e.carrierId), truck: truckName(e), card: isCard(e) })) });
      }, "primary")));
  };

  main.append(stats,
    h("div", { class: "row-inline" }, btn("+ Add expense", () => st && openForm(null), "primary"), btn("Expenses report", () => st && report.replaceChildren(reportCard()), "ghost")),
    report, formSlot, truckChips, periodBar(state.per, draw), catSel, list);
  rec.append(recStats, h("div", null, btn("+ Add recurring charge", () => st && openRec(null), "primary")), recForm, recList);
  watchOps(ctx, ids, (s) => { st = s; draw(); postRecurring(ctx, s); });
  root.append(seg, main, rec);
}

// ---------- 1099 / tax year (cash basis: a load counts when it was paid) ----------

export function taxView(ctx, root, ids) {
  const cid = ids[0];
  const c = carrierOf(ctx, cid);
  let year = new Date().getFullYear(), truck = "all", st = null;
  const yearChips = h("div", { class: "chips", role: "group", "aria-label": "Year" });
  const truckChips = h("div", { class: "chips", role: "group", "aria-label": "Truck" });
  const head = h("div");
  const qBody = h("div", { class: "table-wrap" });
  const catBody = h("div", { class: "table-wrap" });
  const unpaidNote = h("p", { class: "muted small" });
  const paidDate = (l) => l.paidAt || (l.status === "paid" ? l.stageAt : "") || "";
  let last = null;
  const compute = () => {
    const inYear = (d) => !!d && d.slice(0, 4) === String(year);
    const qOf = (d) => Math.floor((+d.slice(5, 7) - 1) / 3);
    const trucks = st.trucks.filter((t) => t.carrierId === cid);
    const share = (e) => (truck === "all" || e.truckId === truck ? num(e.amount) : !e.truckId ? num(e.amount) / Math.max(1, trucks.length) : 0);
    const mine = (l) => truck === "all" || l.truckId === truck;
    const paid = st.loads.filter((l) => l.status === "paid" && mine(l) && inYear(paidDate(l)));
    const unpaid = st.loads.filter((l) => mine(l) && !["paid", "cancelled"].includes(l.status) && inYear(loadDate(ctx, l)));
    const exps = st.expenses.filter((e) => inYear(e.date) && share(e) > 0);
    const Q = [0, 1, 2, 3].map((q) => {
      const ls = paid.filter((l) => qOf(paidDate(l)) === q), es = exps.filter((e) => qOf(e.date) === q);
      let gross = 0, ff = 0, df = 0, kept = 0;
      ls.forEach((l) => { const m = loadMath(ctx, l, st.money.get(l.id)); gross += m.rate; ff += m.factorFee; df += m.dispatchFee; kept += m.kept; });
      const cardSpend = es.filter(isCard).reduce((s, e) => s + share(e), 0), other = es.filter((e) => !isCard(e)).reduce((s, e) => s + share(e), 0);
      const factorOut = Math.max(cardSpend, kept);
      return { n: ls.length, gross, ff, df, factorOut, paid: gross - ff - factorOut, other, profit: gross - ff - df - factorOut - other, unlogged: Math.max(0, kept - cardSpend) };
    });
    const T = Q.reduce((a, q) => { Object.keys(q).forEach((k) => (a[k] = (a[k] || 0) + q[k])); return a; }, {});
    const cats = {};
    exps.forEach((e) => (cats[e.cat] = (cats[e.cat] || 0) + share(e)));
    const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    if (T.unlogged > 0.005) catRows.push([`Fuel/advances kept by ${factorName(c)} (not itemized)`, T.unlogged]);
    if (T.ff) catRows.push([`${factorName(c)} fees${num(c.factorPct) ? ` (${num(c.factorPct)}%)` : ""}`, T.ff]);
    if (T.df) catRows.push(["Dispatch fees", T.df]);
    return { Q, T, catRows, unpaid, trucks };
  };
  const draw = () => {
    if (!st) return;
    const years = [...new Set([new Date().getFullYear(), ...st.loads.map((l) => +String(paidDate(l) || loadDate(ctx, l)).slice(0, 4)), ...st.expenses.map((e) => +String(e.date).slice(0, 4))].filter((y) => y > 2000))].sort((a, b) => b - a);
    yearChips.replaceChildren(...years.map((y) => h("button", { type: "button", class: "chip" + (y === year ? " on" : ""), "aria-pressed": String(y === year), onClick: () => { year = y; draw(); } }, String(y))));
    const d = compute(); last = d;
    truckChips.hidden = !d.trucks.length;
    truckChips.replaceChildren(...[["all", "Whole company"], ...d.trucks.map((t) => [t.id, t.unit])].map(([id, lab]) => h("button", { type: "button", class: "chip" + (truck === id ? " on" : ""), "aria-pressed": String(truck === id), onClick: () => { truck = id; draw(); } }, lab)));
    const tName = truck === "all" ? "Whole company" : (d.trucks.find((t) => t.id === truck) || {}).unit;
    head.replaceChildren(h("h2", null, `${c.name || "Carrier"} · ${tName} · ${year}`),
      h("div", { class: "stats" }, stat("Gross paid", money(d.T.gross || 0)), stat("Expenses", money((d.T.ff || 0) + (d.T.df || 0) + (d.T.factorOut || 0) + (d.T.other || 0))), stat("Profit", money(d.T.profit || 0)), stat("Loads paid", String(d.T.n || 0))));
    const rows = [["Loads paid", (q) => String(q.n)], ["Gross", (q) => money0(q.gross)], [`${factorName(c)} fees`, (q) => money0(-q.ff)], ["Dispatch fees", (q) => money0(-q.df)],
      [`${factorName(c)} fuel & deductions`, (q) => money0(-q.factorOut)], ["Paid to company", (q) => h("b", null, money0(q.paid)), "key"], ["Other expenses", (q) => money0(-q.other)],
      ["Profit", (q) => h("b", { class: q.profit >= 0 ? "pos" : "neg" }, money0(q.profit)), "key"]];
    const cols = [...d.Q, d.T];
    qBody.replaceChildren(h("table", { class: "table sum" },
      h("thead", null, h("tr", null, h("th", null, ""), ["Q1 Jan–Mar", "Q2 Apr–Jun", "Q3 Jul–Sep", "Q4 Oct–Dec", "Year"].map((n) => h("th", { class: "r" }, n)))),
      h("tbody", null, rows.map(([lab, f, cls]) => h("tr", { class: cls || null }, h("td", null, lab), cols.map((q) => h("td", { class: "r mono" }, f(q))))))));
    catBody.replaceChildren(table([{ label: "Category", cell: ([k]) => k }, { label: "Amount", cell: ([, v]) => h("span", { class: "mono" }, money(v)), align: "right" }], d.catRows, "No expenses this year."));
    const un = d.unpaid.reduce((s, l) => s + loadMath(ctx, l, st.money.get(l.id)).rate, 0);
    unpaidNote.textContent = d.unpaid.length ? `${d.unpaid.length} load${d.unpaid.length === 1 ? "" : "s"} from ${year} not marked Paid yet (${money(un)}) aren't counted until they are.` : "";
  };
  watchOps(ctx, [cid], (s) => { st = s; draw(); });
  root.append(yearChips, truckChips, card(null, null, head),
    card("Income by quarter", null, qBody, h("p", { class: "muted small" }, "Counted when paid (the date a load was marked Paid)."), unpaidNote),
    card("Expenses by category", null, catBody, h("p", { class: "muted small" }, "Company-wide expenses are split evenly across trucks when you pick one truck. Truck payments: your accountant may only deduct the interest part, plus depreciation.")),
    h("div", null, btn("View PDF", () => {
      if (!last) return;
      const d = last;
      const tName = truck === "all" ? "Whole company" : (d.trucks.find((t) => t.id === truck) || {}).unit;
      const R = (f) => [...d.Q, d.T].map(f);
      taxPdf({ title: `${c.name || "Carrier"} · ${year} tax summary`, sub: tName, quarters: ["Q1", "Q2", "Q3", "Q4", "Year"],
        qRows: [["Loads paid", ...R((q) => String(q.n || 0))], ["Gross", ...R((q) => money(q.gross || 0))], [`${factorName(c)} fees`, ...R((q) => money(-(q.ff || 0)))], ["Dispatch fees", ...R((q) => money(-(q.df || 0)))],
          [`${factorName(c)} fuel & deductions`, ...R((q) => money(-(q.factorOut || 0)))], ["Paid to company", ...R((q) => money(q.paid || 0))], ["Other expenses", ...R((q) => money(-(q.other || 0)))], ["Profit", ...R((q) => money(q.profit || 0))]],
        cats: d.catRows, note: "Cash basis: loads count in the year and quarter they were marked Paid. " + (unpaidNote.textContent || "") + " This is a record-keeping summary, not tax advice. Have your accountant check it before filing." });
    }, "primary")),
    h("p", { class: "muted small" }, "This is a record-keeping summary, not tax advice. Have your accountant check it before filing."));
}

// ---------- Carrier settings (factoring, alerts) ----------

export function carrierSettingsCard(ctx, carrier, { full = false } = {}) {
  const v = carrier || {};
  const f = {
    name: input("name", { value: v.name || "", required: true }),
    mc: input("mc", { value: v.mc || "" }), dot: input("dot", { value: v.dot || "" }), phone: input("phone", { type: "tel", value: v.phone || "" }),
    feePercent: input("feePercent", { type: "number", step: "0.1", min: "0", max: "100", value: v.feePercent ?? "" }),
    factorName: input("factorName", { placeholder: "e.g. GAP, RTS, Triumph", value: v.factorName || "" }),
    factorPct: input("factorPct", { type: "number", step: "0.01", min: "0", max: "20", inputmode: "decimal", value: v.factorPct ?? "" }),
    ageDays: input("ageDays", { type: "number", min: "1", inputmode: "numeric", value: v.ageDays ?? 30 }),
    countBy: select("countBy", [{ value: "pickup", label: "Pickup date", selected: v.countBy !== "delivery" }, { value: "delivery", label: "Delivery date", selected: v.countBy === "delivery" }]),
  };
  const form = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    const data = { factorName: f.factorName.value.trim(), factorPct: num(f.factorPct.value), ageDays: Math.max(1, Math.round(num(f.ageDays.value) || 30)), countBy: f.countBy.value, phone: f.phone.value.trim() };
    if (full) Object.assign(data, { name: f.name.value.trim(), mc: f.mc.value.trim(), dot: f.dot.value.trim(), feePercent: num(f.feePercent.value) });
    const ok = await guard(() => updateDoc(doc(db, "carriers", carrier.id), data), "Settings saved");
    if (ok !== null) ctx.reload();
  } },
    h("div", { class: "form-grid" },
      full ? field("Company name", f.name) : null, full ? field("MC #", f.mc) : null, full ? field("DOT #", f.dot) : null,
      field("Phone", f.phone),
      full ? field("Dispatch fee %", f.feePercent) : null,
      field("Factoring company", f.factorName), field("Factoring fee (%)", f.factorPct, "Leave blank or 0 if you don't factor"),
      field("Unpaid alert after (days)", f.ageDays), field("Count loads by", f.countBy)),
    h("div", null, btn("Save settings", null, "primary", { type: "submit" })));
  return card(full ? `Edit ${v.name || "carrier"}` : "Company settings", null,
    !full ? h("p", { class: "muted small" }, `${v.name || ""}${v.mc ? " · MC " + v.mc : ""}${v.dot ? " · DOT " + v.dot : ""}${v.feePercent ? ` · Dispatch fee ${v.feePercent}%` : ""}`) : null,
    form);
}
