// Paperwork readers, ported from Dijla Ops. They run in the browser: a digital PDF is read as text,
// a scan or photo goes through on-device OCR (Tesseract). Nothing is sent anywhere to be read.
// RateCon: rate confirmation → broker, rate, load #, pickup/delivery city + date, miles, weight, commodity, truck #.
// BillReader: fuel receipts (gallons, state, total, unit #, factoring fuel card) and IFTA/service bills (per-unit lines).

const RateCon = (() => {
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  const TESS_OPTS = {
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1",
    langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0"
  };
  const loaded = {};
  const script = src => loaded[src] || (loaded[src] = new Promise((ok, bad) => {
    const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => { delete loaded[src]; bad(new Error("load " + src)); };
    document.head.appendChild(s);
  }));

  // ---- text out of a digital PDF, rebuilt into lines ----
  async function pdfText(pdf){
    let out = [];
    for (let n = 1; n <= Math.min(pdf.numPages, 6); n++) {
      const page = await pdf.getPage(n), tc = await page.getTextContent();
      const rows = [];
      tc.items.forEach(it => {
        if (!it.str || !it.str.trim()) return;
        const x = it.transform[4], y = it.transform[5], w = it.width || 0;
        let r = rows.find(r => Math.abs(r.y - y) < 3);
        if (!r) { r = { y, items: [] }; rows.push(r); }
        r.items.push({ x, w, s: it.str });
      });
      rows.sort((a, b) => b.y - a.y).forEach(r => {
        r.items.sort((a, b) => a.x - b.x);
        let line = "", end = null;
        r.items.forEach(i => { line += (end === null ? "" : (i.x - end > 12 ? "   " : i.x - end > 1.5 ? " " : "")) + i.s; end = i.x + i.w; });
        out.push(line);
      });
      out.push("");
    }
    return out.join("\n");
  }
  // ---- OCR for scans and photos ----
  let worker = null;
  async function ocr(images, progress){
    await script(TESS);
    if (!worker) worker = await Tesseract.createWorker("eng", 1, TESS_OPTS);
    let text = "";
    for (let i = 0; i < images.length; i++) {
      progress && progress(`Reading page ${i + 1} of ${images.length}…`);
      const r = await worker.recognize(images[i]);
      text += r.data.text + "\n";
    }
    return text;
  }
  async function pageImages(pdf, max){
    const imgs = [];
    for (let n = 1; n <= Math.min(pdf.numPages, max); n++) {
      const page = await pdf.getPage(n), vp = page.getViewport({ scale: 2.2 });
      const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      imgs.push(c);
    }
    return imgs;
  }
  async function readFile(file, progress){
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!isPdf) { progress && progress("Reading photo (first time takes ~20 sec)…"); return { text: await ocr([file], progress), how: "photo" }; }
    progress && progress("Opening PDF…");
    await script(PDFJS);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const text = await pdfText(pdf);
    if (text.replace(/\s/g, "").length > 200 && /\$|rate|total|pay/i.test(text)) return { text, how: "pdf" };
    progress && progress("This one is a scan. Reading it (first time takes ~20 sec)…");
    return { text: await ocr(await pageImages(pdf, 4), progress), how: "scan" };
  }

  // ---- turn text into load fields ----
  const STATES = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ");
  const BROKERS = [["TQL", /\bTQL\b|Total Quality Logistics/i], ["Scotlynn", /scotl[yv]nn/i], ["MegaCorp Logistics", /mega\s?corp/i], ["American Diamond Logistics", /american diamond/i], ["Silo", /shipsilo|simple\s*logistics/i], ["DMX Logistics", /DMX\s+LOGISTICS/i],
    ["CH Robinson", /C\.?\s?H\.?\s+Robinson|chrobinson/i], ["Coyote", /\bcoyote\b/i], ["Echo Global", /echo global/i], ["RXO", /\bRXO\b/],
    ["Uber Freight", /uber freight/i], ["Arrive Logistics", /arrive logistics/i], ["Landstar", /landstar/i], ["JB Hunt", /j\.?\s?b\.?\s+hunt/i],
    ["Schneider", /schneider/i], ["Werner", /werner/i], ["Mode Transportation", /mode (global|transportation)/i], ["Nolan Transportation", /nolan transportation/i],
    ["Allen Lund", /allen lund/i], ["Sunset Transportation", /sunset transportation/i], ["BlueGrace", /bluegrace/i], ["GlobalTranz", /globaltranz/i],
    ["Worldwide Express", /worldwide express/i], ["Axle Logistics", /axle logistics/i], ["Integrity Express", /integrity express/i], ["England Logistics", /england logistics/i],
    ["Covenant Logistics", /covenant logistics/i], ["Kirsch Transportation", /kirsch/i], ["Redwood", /redwood logistics/i], ["Transplace", /transplace|uber freight/i]];
  const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  const MONEY = /\$?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.\d{2})?|[0-9]{3,6}(?:\.\d{2})?)/;
  const DATE = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/;
  function toISO(m){ let [, mo, d, y] = m; y = y.length === 2 ? "20" + y : y; if (+mo > 12 || +d > 31) return ""; return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  function cityIn(line, skip){
    const tries = [
      /([A-Za-z][A-Za-z .'-]{1,30}?),\s*([A-Z]{2})\b/g,                          // Katy, TX
      /([A-Za-z][A-Za-z .'-]{1,30}?)\s+([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g          // HOUSTON TX 77028
    ];
    for (const re of tries) {
      let m;
      while ((m = re.exec(line))) {
        const st = m[2], city = m[1].replace(/^.*\b(address|name|location|city)\s*:?\s*/i, "").split(/\s{2,}/).pop().trim();   // "Simplot Foods   Caldwell, ID" → Caldwell
        if (!STATES.includes(st) || city.length < 2 || /\d/.test(city)) continue;
        const words = city.split(/\s+/); const c = titleCase(words.slice(-3).join(" "));
        const val = `${c}, ${st}`;
        if (skip && skip.test(val)) continue;
        return val;
      }
    }
    return "";
  }
  function parse(raw, opts = {}){
    const self = opts.self || /^\b$/;   // the carrier's own name, so it isn't mistaken for the broker
    const text = raw.replace(/\r/g, "").replace(/[‐-―]/g, "-").replace(/[“”]/g, '"');
    const lines = text.split("\n").map(l => l.replace(/\s+$/, ""));
    const f = {}, found = [];
    // broker
    for (const [name, re] of BROKERS) if (re.test(text)) { f.broker = name; break; }
    if (!f.broker) { const l = lines.find(l => /\b(logistics|brokerage|freight|transport(ation)?)\b/i.test(l) && !self.test(l) && l.trim().length < 60); if (l) f.broker = titleCase(l.trim().replace(/\s{2,}.*/, "").replace(/[,.]?\s*(llc|inc|corp)\.?$/i, "").replace(/[,.]$/, "")); }
    // rate: the most specific "total" wins
    const RATE_KEYS = [/total\s+carrier\s+pay/i, /carrier\s+(freight\s+)?pay/i, /total\s+rate/i, /total\s+(amount|charges?|pay|comp)/i, /\btotal\s*:/i, /agreed\s+rate/i, /line\s*haul(\s+rate)?/i, /\brate\b/i];
    const AMT = /\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})(?:\.\d{2})?|(?<![\d\/.:,])([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})\.\d{2}(?![\d\/])/;
    const LEGAL = /not to exceed|advance|limited|\bfees?\b|penalt|\blate\b|per day|detention|deduct|\bfine|up to|reduction|quick\s*pay|\d+%/i;
    const amountIn = str => { const m = str.match(AMT); if (!m) return 0; const v = parseFloat((m[1] || m[2]).replace(/,/g, "") + (m[0].match(/\.\d{2}$/) || [""])[0]); return v >= 100 && v <= 50000 ? v : 0; };
    for (const key of RATE_KEYS) {
      for (let i = 0; i < lines.length && !f.rate; i++) {
        const l = lines[i], k = l.search(key); if (k < 0 || LEGAL.test(l)) continue;
        let v = amountIn(l.slice(k));
        if (!v && l.trim().length < 45) for (let j = i + 1; j <= i + 3 && j < lines.length && !v; j++) if (!LEGAL.test(lines[j])) v = amountIn(lines[j]);
        if (v) f.rate = v;
      }
      if (f.rate) break;
    }
    // load / order number
    // most specific first; a customer's own PO is not the broker's load number
    const NO_KEYS = [/\border\s*:\s*([0-9]{5,})/i, /rate confirmation\s+(?:for\s+\w+#?\s*)?([0-9]{5,})/i,
      /\b(?:load|order|pro|confirmation|shipment|trip)\s*(?:#|no\.?|number)\s*:?\s*([A-Z0-9-]*\d[A-Z0-9-]{3,})/i,
      /(?<!customer\s)\bPO\s*#\s*([0-9]{5,})/i, /\b([0-9]{5,})\s*\n\s*(?:trip|load|order)\s*(?:number|#|no)/i];
    for (const re of NO_KEYS) { const m = text.match(re); if (m) { f.loadNo = m[1]; break; } }
    // pickup / delivery: find a section keyword, then the first City, ST and date after it
    // the carrier's own mailing address and common broker/factoring offices are not pickup or delivery stops
    const SKIP = opts.skip || /ogden, ut|milford, oh|exeter, nh|fort myers, fl/i;
    const PU = /(pick[\s-]*up\b|\bpickup\b|\bshipper\b|\borigin\b|^\s*PU\s+\d|\bPICK\s+\d|\bload at\b)/i;
    const DEL = /(\bdelivery\b|\bdeliver to\b|\bconsignee\b|\breceiver\b|\bdestination\b|^\s*SO\s+\d|\bSTOP\s+\d|\bDEL\s+\d|\bdrop\b|\bunload at\b)/i;
    const grab = (start, span) => {
      let city = "", date = "";
      for (let i = start; i < Math.min(lines.length, start + span); i++) {
        if (!city) city = cityIn(lines[i], SKIP);
        if (!date) { const m = lines[i].match(DATE); if (m) date = toISO(m); }
        if (city && date) break;
      }
      return { city, date };
    };
    let puAt = -1;
    for (let i = 0; i < lines.length; i++) if (PU.test(lines[i]) && grab(i, 8).city) { puAt = i; break; }
    if (puAt >= 0) { const g = grab(puAt, 8); f.from = g.city; if (g.date) f.fromDate = g.date; }
    for (let i = Math.max(puAt + 1, 0); i < lines.length; i++) {
      if (DEL.test(lines[i])) { const g = grab(i, 8); if (g.city && g.city !== f.from) { f.to = g.city; if (g.date) f.toDate = g.date; break; } }
    }
    if (!f.to && puAt >= 0) {           // no delivery label found (blurry scan): take the next different city after the pickup
      const head = new Set(lines.slice(0, puAt).map(l => cityIn(l)).filter(Boolean));
      let seenPu = false;
      for (let i = puAt; i < Math.min(lines.length, puAt + 30); i++) {
        const c = cityIn(lines[i], SKIP); if (!c) continue;
        if (c === f.from && !seenPu) { seenPu = true; continue; }
        if (c !== f.from && !head.has(c)) { f.to = c; const g = grab(i - 1, 3); if (g.date && g.date !== f.fromDate) f.toDate = g.date; else { const g2 = grab(i, 2); if (g2.date) f.toDate = g2.date; } break; }
      }
    }
    const tr = text.match(/\btruck\s*(?:#|no\.?|number|unit)\s*:?\s*(\d{1,5})\b/i) || text.match(/\bunit\s*#?\s*:?\s*(\d{1,5})\b/i);
    if (tr) f.truckNo = tr[1];
    else {   // table style: "... Truck #   Trailer #" with the numbers on the next line
      const i = lines.findIndex(l => /truck\s*#/i.test(l) && /trailer\s*#/i.test(l));
      if (i >= 0 && lines[i + 1]) { const n = lines[i + 1].match(/\b\d{1,5}\b/g); if (n && n.length >= 2) f.truckNo = n[n.length - 2]; else if (n) f.truckNo = n[0]; }
    }
    // miles, weight, commodity (nice to have)
    const mi = text.match(/\b(?:total\s+)?miles?\s*:?\s*([0-9,]{2,6})\b/i)
      || text.match(/\b(?:distance|total|loaded)\s*:?\s*([0-9,]{2,6})(?:\.\d+)?\s*(?:mi|miles)\b/i);   // "Distance 2195.07 Miles"
    if (mi) f.miles = parseInt(mi[1].replace(/,/g, ""), 10);
    const wt = text.match(/\b(?:estimated\s+)?weight\s*:?\s*([0-9,]{3,6}(?:\.\d+)?)/i); if (wt) f.weight = Math.round(parseFloat(wt[1].replace(/,/g, "")));
    const cm = text.match(/commodit(?:y|ies)\s*:?\s*([A-Za-z][A-Za-z &/-]{2,30})/i) || text.match(/description\s*:\s*([A-Za-z][A-Za-z &/-]{2,30})/i);
    const cleanC = s => s.trim().replace(/\s{2,}.*/, "").replace(/\s+(trailer|temp|weight|pieces|pcs|hazmat|size|type|mode|reefer|van|miles)\b.*$/i, "");
    const junk = c => /\b(must|if|the|shall|will|be|of|to|any|all)\b/i.test(c) || /^(pick|quantity|unit|notes)/i.test(c);
    const pr = text.match(/product\s*:\s*([A-Za-z][A-Za-z &/-]{2,30})/i);
    if (cm && !junk(cleanC(cm[1]))) f.commodity = titleCase(cleanC(cm[1]));
    else if (pr && !junk(cleanC(pr[1]))) f.commodity = titleCase(cleanC(pr[1]));
    if (!f.commodity) { const m = text.match(/Truckload\s+([A-Za-z][A-Za-z ]{2,25})/); if (m) f.commodity = titleCase(m[1].trim().replace(/\s{2,}.*/, "")); }
    if (!f.commodity) { const m = text.match(/^\s*item\s*:\s*(.{3,40}?)\s*$/im); if (m && !junk(m[1])) f.commodity = m[1].replace(/\s{2,}.*/, "").trim(); }   // Echo: "Item: ..."
    return f;
  }
  return { readFile, parse };
})();

// ===== Bill / statement reader (IFTA service bills, receipts). Runs on this device; nothing uploaded. =====
const BillReader = (() => {
  const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const DEC = /\d{1,3}(?:,\d{3})*\.\d{2}/g;
  const toNum = s => parseFloat(String(s).replace(/,/g, ""));
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  function parse(raw, opts = {}){
    const self = opts.self || /^\b$/;
    const text = raw.replace(/\r/g, "").replace(/[§]/g, "$");
    const lines = text.split("\n");
    const out = { units: [], items: [] };
    if (/truckers\s*reporting/i.test(text)) out.vendor = "Truckers Reporting Service";
    else { const m = [...text.matchAll(/^\W*([A-Z][A-Za-z&.' ]{3,40}(?:inc|llc|services?|company|co)\.?)\s*$/gim)].find(x => !self.test(x[1])); if (m) out.vendor = m[1].trim(); }
    const inv = text.match(/\bINV(?:OICE)?\s*#?\s*(\d{3,})/i); if (inv) out.invoice = inv[1];
    // month breakdown: "BREAKDOWN FOR THE MONTH OF AUGUST 2026"
    const mo = text.match(/month\s*of\W{0,6}([A-Za-z]{3,9})\W{0,6}(\d{4})/i);
    if (mo) { const i = MONTHS.findIndex(x => x.startsWith(mo[1].toLowerCase().slice(0, 3))); if (i >= 0) { out.month = MONTHS[i][0].toUpperCase() + MONTHS[i].slice(1) + " " + mo[2]; out.date = iso(+mo[2], i + 1, new Date(+mo[2], i + 1, 0).getDate()); } }
    const q = text.match(/\b(1ST|2ND|3RD|4TH)\s*Q(?:TR|UARTER)\b/i); if (q) out.period = q[1].toUpperCase() + " quarter";
    // statement date: first full date in the text
    const dt = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/); if (dt) out.date = iso(+dt[3], +dt[1], +dt[2]);
    // per-unit rows: "#5 $ 122.50 $ 22.50 $ - $ 145.00" (first amount = tax/reporting, last = unit total)
    lines.forEach(l => {
      const m = l.match(/^\W{0,4}#?\s*(\d{1,4})(\s+\$?\s*[\d,]+\.\d{2}.*)$/); if (!m || /total/i.test(l)) return;
      if (+m[1] >= 1900 && +m[1] <= 2100) return;
      const nums = (m[2].match(DEC) || []).map(toNum); if (nums.length < 2) return;
      const total = nums[nums.length - 1], tax = nums[0];
      out.units.push({ unit: m[1], tax, lic: Math.max(0, Math.round((total - tax) * 100) / 100), total });
    });
    // grand total: "TOTAL ... 290.00" / "Amount Due $290.00"
    const totLine = lines.find(l => /^\W*total\b/i.test(l) && /\d\.\d{2}/.test(l));
    const due = text.match(/amount\s+due[^0-9$]{0,40}\$?\s*([\d,]+\.\d{2})/i);
    const grand = /grand\s+total[^0-9$]{0,30}\$?\s*([\d,]+\.\d{2})/i.exec(text);
    if (grand) out.total = toNum(grand[1]);
    else if (due) out.total = toNum(due[1]);
    else if (totLine) { const n = totLine.match(DEC); if (n) out.total = toNum(n[n.length - 1]); }
    else if (out.units.length) out.total = out.units.reduce((s, u) => s + u.total, 0);
    // itemized lines: "--- Licensing services $45.00"
    lines.forEach(l => { const m = l.match(/^\W*-{2,}\s*([A-Za-z][A-Za-z /&]+?)\s+\$\s*([\d,]+\.\d{2})/); if (m) out.items.push({ desc: m[1].trim(), amt: toNum(m[2]) }); });
    out.ifta = /ifta|truckers\s*reporting|fuel\s*tax|tax\s*reporting|operations\s*tax/i.test(text) || (out.units.length > 0 && /licens/i.test(text));
    out.fuel = parseFuel(text, lines);
    if (out.fuel) out.ifta = false;
    return out;
  }
  // ---- fuel receipts (Love's, Pilot/Flying J, TA/Petro, etc.) ----
  const STATES = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
  const STOPS = [["Love's", /\blove'?s\b|\bloves\b/i], ["Pilot Flying J", /\bpilot\b|flying\s*j/i], ["TA Petro", /travel\s*centers|\bpetro\b|\bTA\s+(express|travel)/i],
    ["Sapp Bros", /sapp\s*bros/i], ["Maverik", /maverik/i], ["Town Pump", /town\s*pump/i], ["Kwik Trip", /kwik\s*trip/i], ["Road Ranger", /road\s*ranger/i],
    ["Petro-Canada", /petro-?canada/i], ["Speedway", /speedway/i], ["Chevron", /chevron/i], ["Shell", /\bshell\b/i], ["Sinclair", /sinclair/i], ["Casey's", /casey'?s/i]];
  function parseFuel(text, lines){
    const gm = text.match(/\bgal(?:lon)?s?\.?\s*:?\s*([\d,]+\.\d{1,3})\b/i) || text.match(/\b([\d,]+\.\d{1,3})\s*gal/i) || text.match(/\bqty\s*:?\s*([\d,]+\.\d{3})\b/i);
    const fuelWords = /diesel|trkds|ulsd|\bdsl\b|reefer|price\s*\/\s*gal|ppg|\bpump\b|gallons/i.test(text);
    if (!gm || !fuelWords) return null;
    const f = { gallons: toNum(gm[1]) };
    const pg = text.match(/(?:price\s*\/?\s*gal\w*|ppg|\$\s*\/\s*gal)\s*:?\s*\$?\s*(\d+\.\d{2,4})/i) || text.match(/gal\w*\s*@\s*\$?\s*(\d+\.\d{2,4})/i); if (pg) f.ppg = toNum(pg[1]);
    const ts = text.match(/total\s*sale\s*:?\s*\$?\s*([\d,]+\.\d{2})/i) || text.match(/^\W*total\b[^\n\d$]{0,20}\$?\s*([\d,]+\.\d{2})/im) || text.match(/amount\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
    if (ts) f.total = toNum(ts[1]); else if (f.ppg) f.total = Math.round(f.ppg * f.gallons * 100) / 100;
    const dt = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/); if (dt) { let y = dt[3]; if (y.length === 2) y = "20" + y; f.date = iso(+y, +dt[1], +dt[2]); }
    // state: from the store's "City, ST 12345" line (first address on the receipt)
    for (const l of lines) { const m = l.match(/([A-Za-z .'-]{2,}),?\s+([A-Z]{2})\s+\d{5}\b/); if (m && STATES.includes(m[2])) { f.state = m[2]; f.city = m[1].trim().replace(/^.*\d\s+/, ""); break; } }
    for (const [n, re] of STOPS) if (re.test(text)) { f.vendor = n; break; }
    const st = text.match(/\b(?:store|station|site)\s*#?\s*(\d{1,6})/i); if (st) f.store = st[1];
    const tk = text.match(/\b(?:tkt|ticket|trans(?:action)?|receipt)\s*#?\s*:?\s*(\d{4,})/i); if (tk) f.ticket = tk[1];
    const un = text.match(/\b(?:vehicle\s*id|veh(?:icle)?\s*#|unit(?:\s*(?:#|no\.?|number))?|truck\s*(?:#|no\.?|number))\s*:?\s*(\d{1,5})\b/i); if (un) f.unit = un[1];
    const od = text.match(/\b(?:hub\s*)?odometer\s*:?\s*(\d{3,7})/i); if (od) f.odometer = od[1];
    // paid on a factoring company's fuel card (taken out of load pay)
    f.factorCard = /fleet\s*one|gap\s*services|gap\s*factoring|comdata|\bEFS\b|\bWEX\b|t-?chek|rts\s*fuel|triumph|otr\s*solutions/i.test(text);
    const def = text.match(/\bDEF\b[^\n]*?([\d,]+\.\d{2})\s*$/im); if (def) f.def = toNum(def[1]);
    return f;
  }
  return { parse };
})();

export { RateCon, BillReader };
