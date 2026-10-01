import { db, collection, query, where } from "../fb.js";
import { h, stat } from "../ui.js";
import { watchMany, scoped } from "../data.js";
import { loadsTable, loadForm, docsReviewQueue, requestsList } from "../components.js";

const ids = (ctx) => ctx.carriers.map((c) => c.id);

function tasks(ctx, root) {
  const counts = { idle: 0, docs: 0, reqs: 0 };
  let trucks = [], loads = [];
  const stats = h("div", { class: "stats" });
  const draw = () => {
    const busy = new Set(loads.filter((l) => l.status === "booked" || l.status === "in_transit").map((l) => l.truckId).filter(Boolean));
    counts.idle = trucks.filter((t) => !busy.has(t.id) && t.status !== "out_of_service").length;
    stats.replaceChildren(
      stat("Trucks needing a load", String(counts.idle)),
      stat("Docs to review", String(counts.docs)),
      stat("Open truck requests", String(counts.reqs)),
      stat("Active loads", String(busy.size)));
  };
  ctx.sub(watchMany(scoped(ctx, "trucks", ids(ctx)), (r) => { trucks = r; draw(); }));
  draw();
  root.append(
    h("p", { class: "muted" }, ctx.carriers.length ? `Your carriers: ${ctx.carriers.map((c) => c.name).join(", ")}` : "No carriers assigned yet. Ask the owner to give you access."),
    stats,
    h("div", { class: "grid-2" },
      requestsList(ctx, ids(ctx), { staff: true, onCount: (n) => { counts.reqs = n; draw(); } }),
      docsReviewQueue(ctx, ids(ctx), (n) => { counts.docs = n; draw(); })),
    loadsTable(ctx, ids(ctx), { title: "My loads", showMoney: true, editable: true, onLoads: (r) => { loads = r; draw(); } }));
}

export default [
  { id: "tasks", label: "Tasks", render: tasks },
  { id: "loads", label: "Loads", render: (ctx, root) => root.append(loadForm(ctx), loadsTable(ctx, ids(ctx), { showMoney: true, editable: true })) },
  { id: "requests", label: "Truck requests", render: (ctx, root) => root.append(requestsList(ctx, ids(ctx), { staff: true })) },
  { id: "documents", label: "Documents", render: (ctx, root) => root.append(docsReviewQueue(ctx, ids(ctx))) },
];
