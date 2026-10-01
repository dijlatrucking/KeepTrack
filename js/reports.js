// PDF reports (loads, expenses, 1099 year summary). Built in the browser with jsPDF; opened in a new tab
// where it can be downloaded, printed or shared.
import { money, num, fmtDate, toast } from "./ui.js";

const JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const AUTOTABLE = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";
const loaded = {};
const script = (src) => loaded[src] || (loaded[src] = new Promise((ok, bad) => {
  const s = document.createElement("script");
  s.src = src; s.onload = ok;
  s.onerror = () => { delete loaded[src]; bad(new Error("Couldn't load the PDF tools. Check your connection.")); };
  document.head.append(s);
}));

async function newDoc(landscape) {
  await script(JSPDF);
  await script(AUTOTABLE);
  const { jsPDF } = window.jspdf;
  return new jsPDF({ unit: "pt", format: "letter", orientation: landscape ? "landscape" : "portrait" });
}

function header(doc, title, sub) {
  const W = doc.internal.pageSize.getWidth();
  doc.setFillColor(21, 23, 28); doc.rect(0, 0, W, 54, "F");
  doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(15);
  doc.text(title, 36, 33);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
  doc.text(sub, W - 36, 33, { align: "right" });
  doc.setTextColor(21, 23, 28);
}

function footer(doc, note) {
  const n = doc.internal.getNumberOfPages(), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFontSize(8); doc.setTextColor(110, 114, 122);
    doc.text(`KeepTrack · ${note || ""}`, 36, H - 20);
    doc.text(`Page ${i} of ${n}`, W - 36, H - 20, { align: "right" });
  }
}

const TABLE = {
  theme: "grid",
  styles: { fontSize: 8.5, cellPadding: 4, lineColor: [222, 219, 211], lineWidth: 0.5, textColor: [21, 23, 28] },
  headStyles: { fillColor: [243, 242, 238], textColor: [21, 23, 28], fontStyle: "bold" },
  footStyles: { fillColor: [243, 242, 238], textColor: [21, 23, 28], fontStyle: "bold" },
  margin: { left: 36, right: 36, bottom: 40 },
};

function open(doc, name) {
  const url = doc.output("bloburl");
  const w = window.open(url, "_blank");
  if (!w) {
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
  }
}

export async function loadsPdf({ title, sub, rows, showFee }) {
  try {
    const doc = await newDoc(true);
    header(doc, title, sub);
    const head = ["Load", "Carrier", "Truck", "Broker", "Load #", "Pickup", "Delivery", "Dates", "Miles", "Rate", "Factoring", ...(showFee ? ["Dispatch fee"] : []), "Net", "Status"];
    const tot = { miles: 0, rate: 0, ff: 0, df: 0, net: 0 };
    const body = rows.map((r) => {
      tot.miles += r.miles; tot.rate += r.rate; tot.ff += r.factorFee; tot.df += r.dispatchFee; tot.net += r.net;
      return [r.id, r.carrier, r.truck || "", r.broker || "", r.loadNo || "", r.origin || "", r.destination || "",
        `${fmtDate(r.pickupDate)} – ${fmtDate(r.deliverBy)}`, r.miles.toLocaleString(), money(r.rate), money(r.factorFee),
        ...(showFee ? [money(r.dispatchFee)] : []), money(r.net), r.status];
    });
    const foot = [`${rows.length} loads`, "", "", "", "", "", "", "", tot.miles.toLocaleString(), money(tot.rate), money(tot.ff), ...(showFee ? [money(tot.df)] : []), money(tot.net), ""];
    doc.autoTable({ ...TABLE, startY: 70, head: [head], body, foot: [foot], showFoot: "lastPage" });
    footer(doc, "Net = rate minus factoring and dispatch fees.");
    open(doc, "loads-report.pdf");
  } catch (e) { toast(e.message, "bad"); }
}

export async function expensesPdf({ title, sub, rows, factorName }) {
  try {
    const doc = await newDoc(false);
    header(doc, title, sub);
    let tot = 0, card = 0;
    const body = rows.map((r) => {
      tot += r.amount; if (r.card) card += r.amount;
      return [fmtDate(r.date), r.carrier, r.truck, r.cat, r.card ? `${factorName || "Factoring"} card` : "Own", r.gallons ? `${r.gallons} gal${r.state ? " " + r.state : ""}` : "", r.note || "", money(r.amount)];
    });
    doc.autoTable({ ...TABLE, startY: 70, head: [["Date", "Carrier", "Truck", "Category", "Paid with", "Fuel", "Note", "Amount"]], body,
      foot: [[`${rows.length} expenses`, "", "", "", `Card ${money(card)}`, "", `Own ${money(tot - card)}`, money(tot)]], showFoot: "lastPage",
      columnStyles: { 6: { cellWidth: 150 }, 7: { halign: "right" } } });
    footer(doc, "Expenses report");
    open(doc, "expenses-report.pdf");
  } catch (e) { toast(e.message, "bad"); }
}

export async function taxPdf({ title, sub, quarters, qRows, cats, note }) {
  try {
    const doc = await newDoc(false);
    header(doc, title, sub);
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("Income by quarter (cash basis: counted when paid)", 36, 80);
    doc.autoTable({ ...TABLE, startY: 88, head: [["", ...quarters]], body: qRows });
    let y = doc.lastAutoTable.finalY + 26;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("Expenses by category", 36, y);
    doc.autoTable({ ...TABLE, startY: y + 8, head: [["Category", "Amount"]], body: cats.map(([k, v]) => [k, money(v)]),
      foot: [["Total", money(cats.reduce((s, c) => s + num(c[1]), 0))]], columnStyles: { 1: { halign: "right" } } });
    y = doc.lastAutoTable.finalY + 20;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(90, 95, 105);
    doc.text(doc.splitTextToSize(note, doc.internal.pageSize.getWidth() - 72), 36, y);
    footer(doc, "Record-keeping summary, not tax advice.");
    open(doc, "tax-summary.pdf");
  } catch (e) { toast(e.message, "bad"); }
}

// The index that goes into Google Drive with each backup: every scan copied, its details and a link
// to the file in Drive. Returned as base64 (it's saved to Drive, not opened).
const latin = (v) => String(v ?? "").replace(/→/g, "to").replace(/[^\x00-\xFF]/g, "");
export async function backupPdf({ title, sub, rows, failed = [] }) {
  const doc = await newDoc(true);
  header(doc, latin(title), latin(sub));
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  doc.text(latin(`${rows.length} scan${rows.length === 1 ? "" : "s"} copied to Google Drive${failed.length ? ` · ${failed.length} didn't make it (listed at the end)` : ""}. Tap "Open" to see a file in Drive.`), 36, 74);
  const head = ["Sent", "Carrier", "Paper", "Load", "Sent by", "Amount", "Status", "File"];
  const body = rows.map((r) => [fmtDate(r.date), r.carrier, r.paper, r.load || "—", r.sentBy || "—", r.amount ? money(r.amount) : "", r.status, r.url ? "Open" : ""].map(latin));
  doc.autoTable({
    ...TABLE, startY: 86, head: [head], body,
    columnStyles: { 7: { textColor: [161, 74, 18], fontStyle: "bold" } },
    didDrawCell: (c) => { if (c.section === "body" && c.column.index === 7 && rows[c.row.index].url) doc.link(c.cell.x, c.cell.y, c.cell.width, c.cell.height, { url: rows[c.row.index].url }); },
  });
  if (failed.length) {
    doc.autoTable({ ...TABLE, startY: doc.lastAutoTable.finalY + 18, head: [["Didn't make it to Drive", "Why"]], body: failed.map((f) => [latin(f.paper), latin(f.why || "unknown")]) });
  }
  footer(doc, "Backup report. The scans themselves are in your KeepTrack folder in Google Drive.");
  return doc.output("datauristring").split("base64,")[1];
}
