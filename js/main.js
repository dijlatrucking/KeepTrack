import {
  isConfigured, auth, db, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, doc, getDoc, setDoc, onSnapshot, writeBatch, serverTimestamp, collection
} from "./fb.js";
import { h, field, input, btn, toast, friendlyError } from "./ui.js";
import { loadCarriers } from "./data.js";
import ownerViews from "./views/owner.js";
import dispatcherViews from "./views/dispatcher.js";
import carrierViews from "./views/carrier.js";
import driverViews from "./views/driver.js";

const ROLES = {
  owner: { label: "Owner", views: ownerViews },
  dispatcher: { label: "Dispatcher", views: dispatcherViews },
  carrierAdmin: { label: "Carrier admin", views: carrierViews },
  driver: { label: "Driver", views: driverViews },
};

const root = document.getElementById("app");
let profileUnsub = null;
let viewSubs = [];
let shellCarrierUnsub = null;
let pendingAuthError = "";
let signingUp = false;

const brand = () => h("span", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }, "✓"), h("span", null, "KeepTrack"));

function clearView() {
  viewSubs.forEach((u) => { try { u(); } catch (_) {} });
  viewSubs = [];
}

// ---------- Auth screens ----------

function renderAuth(mode = "signin") {
  clearView();
  const err = h("p", { class: "form-error", role: "alert" }, pendingAuthError);
  pendingAuthError = "";
  const busy = (form, on) => form.querySelectorAll("button").forEach((b) => (b.disabled = on));

  const signin = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    busy(signin, true); err.textContent = "";
    try { await signInWithEmailAndPassword(auth, signin.email.value.trim(), signin.password.value); }
    catch (x) { err.textContent = friendlyError(x); busy(signin, false); }
  } },
    field("Email", input("email", { type: "email", autocomplete: "email", required: true })),
    field("Password", input("password", { type: "password", autocomplete: "current-password", required: true })),
    btn("Sign in", null, "primary", { type: "submit" }),
    btn("Forgot password?", async () => {
      const email = signin.email.value.trim();
      if (!email) return (err.textContent = "Type your email first.");
      try { await sendPasswordResetEmail(auth, email); toast("Reset email sent", "ok"); } catch (x) { err.textContent = friendlyError(x); }
    }, "link"));

  const signup = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    busy(signup, true); err.textContent = "";
    const code = signup.code.value.trim().toUpperCase();
    let cred = null;
    signingUp = true;
    try {
      cred = await createUserWithEmailAndPassword(auth, signup.email.value.trim(), signup.password.value);
      const invRef = doc(db, "invites", code);
      const inv = await getDoc(invRef);
      if (!inv.exists() || inv.data().used) throw new Error("That invite code isn't valid or was already used.");
      const i = inv.data();
      const batch = writeBatch(db);
      batch.set(doc(db, "users", cred.user.uid), {
        name: signup.name.value.trim(), email: signup.email.value.trim(), phone: signup.phone.value.trim(),
        role: i.role, carrierId: i.carrierId ?? null, invite: code, createdAt: serverTimestamp(),
      });
      batch.update(invRef, { used: true, usedBy: cred.user.uid, usedAt: serverTimestamp() });
      await batch.commit();
      signingUp = false;
    } catch (x) {
      pendingAuthError = friendlyError(x);
      if (cred) { try { await cred.user.delete(); } catch (_) {} }
      signingUp = false;
      renderAuth("signup");
    }
  } },
    field("Invite code", input("code", { required: true, autocomplete: "off", placeholder: "From your dispatcher or carrier", style: "text-transform:uppercase" })),
    field("Full name", input("name", { required: true, autocomplete: "name" })),
    field("Phone", input("phone", { type: "tel", autocomplete: "tel" })),
    field("Email", input("email", { type: "email", autocomplete: "email", required: true })),
    field("Password", input("password", { type: "password", autocomplete: "new-password", minlength: "6", required: true })),
    btn("Create account", null, "primary", { type: "submit" }),
    h("p", { class: "muted small" }, "No code? ", btn("Request access instead", () => renderAuth("request"), "link")));

  // No invite code: sign up as "pending" and wait for the owner to approve.
  const roleSel = h("select", { name: "requestedRole", class: "input" },
    h("option", { value: "carrierAdmin" }, "A carrier (I own or run trucks)"),
    h("option", { value: "dispatcher" }, "A dispatcher (joining the team)"));
  const companyBox = h("div", { class: "stack" },
    field("Company name", input("company", { autocomplete: "organization" })),
    h("div", { class: "form-grid" }, field("MC #", input("mc", { inputmode: "numeric" })), field("DOT #", input("dot", { inputmode: "numeric" }))));
  roleSel.addEventListener("change", () => {
    const carrier = roleSel.value === "carrierAdmin";
    companyBox.hidden = !carrier;
    companyBox.querySelector("[name=company]").required = carrier;
  });
  companyBox.querySelector("[name=company]").required = true;

  const request = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    busy(request, true); err.textContent = "";
    const carrier = roleSel.value === "carrierAdmin";
    let cred = null;
    signingUp = true;
    try {
      cred = await createUserWithEmailAndPassword(auth, request.email.value.trim(), request.password.value);
      await setDoc(doc(db, "users", cred.user.uid), {
        name: request.name.value.trim(), email: request.email.value.trim(), phone: request.phone.value.trim(),
        role: "pending", requestedRole: roleSel.value,
        company: carrier ? request.company.value.trim() : "", mc: carrier ? request.mc.value.trim() : "", dot: carrier ? request.dot.value.trim() : "",
        note: request.note.value.trim(), createdAt: serverTimestamp(),
      });
      signingUp = false;
    } catch (x) {
      pendingAuthError = friendlyError(x);
      if (cred) { try { await cred.user.delete(); } catch (_) {} }
      signingUp = false;
      renderAuth("request");
    }
  } },
    field("I'm signing up as", roleSel),
    companyBox,
    field("Full name", input("name", { required: true, autocomplete: "name" })),
    field("Phone", input("phone", { type: "tel", autocomplete: "tel", required: true })),
    field("Email", input("email", { type: "email", autocomplete: "email", required: true })),
    field("Password", input("password", { type: "password", autocomplete: "new-password", minlength: "6", required: true })),
    field("Anything we should know? (optional)", h("textarea", { name: "note", class: "input", rows: "2", placeholder: "Number of trucks, lanes you run, how you heard about us…" })),
    btn("Request access", null, "primary", { type: "submit" }),
    h("p", { class: "muted small" }, "Drivers: ask your carrier for an invite code instead."));

  const tab = (id, label) => h("button", { type: "button", role: "tab", class: "tab" + (mode === id ? " on" : ""), "aria-selected": String(mode === id), onClick: () => renderAuth(id) }, label);
  root.replaceChildren(publicPage(
    h("div", { class: "auth-card" },
      h("h1", null, mode === "signin" ? "Sign in" : mode === "signup" ? "Join with an invite code" : "Request access"),
      h("p", { class: "muted" }, "Loads, paperwork and pay, all in one place."),
      h("div", { class: "tabs tabs-3", role: "tablist" }, tab("signin", "Sign in"), tab("signup", "Invite code"), tab("request", "Request access")),
      mode === "signin" ? signin : mode === "signup" ? signup : request,
      err)));
}

function renderPending(user, profile) {
  clearView();
  root.replaceChildren(publicPage(h("div", { class: "auth-card" },
    h("h1", null, "Request received"),
    h("p", null, `Thanks${profile.name ? ", " + profile.name.split(" ")[0] : ""}. Your ${profile.requestedRole === "dispatcher" ? "dispatcher" : "carrier"} account is waiting for approval.`),
    h("p", { class: "muted" }, "Keep this page open or sign back in later. It opens up automatically the moment you're approved."),
    btn("Sign out", () => signOut(auth)))));
}

// Public pages (sign in, waiting, setup) share a plain site header and footer.
function publicPage(...body) {
  return h("div", { class: "site" },
    h("header", { class: "site-header" }, h("div", { class: "site-header-inner" }, brand())),
    h("main", { class: "site-main auth" }, ...body),
    h("footer", { class: "site-footer" }, h("div", { class: "site-footer-inner" },
      h("span", null, `© ${new Date().getFullYear()} KeepTrack · A Spartan Groups LLC service`))));
}

function renderSetupNeeded() {
  root.replaceChildren(publicPage(h("div", { class: "auth-card" },
    h("h1", null, "Almost there"),
    h("p", null, "Paste your Firebase web config into js/firebase-config.js, then reload. See the README for the full setup steps."))));
}

function renderNoProfile(user) {
  clearView();
  root.replaceChildren(publicPage(h("div", { class: "auth-card" },
    h("h1", null, "Setting up your account…"),
    h("p", { class: "muted" }, `Signed in as ${user.email}. If this screen doesn't change, your account doesn't have access yet. Ask for a new invite code.`),
    btn("Sign out", () => signOut(auth)))));
}

// ---------- App shell ----------

async function renderShell(user, profile) {
  clearView();
  if (profile.role === "pending") return renderPending(user, profile);
  const role = ROLES[profile.role];
  if (!role) return renderNoProfile(user);

  let carriers = [];
  try { carriers = await loadCarriers(profile); } catch (e) { console.error(e); }
  const carrierNames = new Map(carriers.map((c) => [c.id, c.name]));
  // Keep carrier records live (settings, names) without redrawing the whole page.
  const carrierListeners = new Set();
  if (shellCarrierUnsub) shellCarrierUnsub();
  const applyCarrier = (id, data) => {
    const c = carriers.find((x) => x.id === id);
    if (c) Object.assign(c, data); else carriers.push({ id, ...data });
    carrierNames.set(id, data.name);
  };
  const notify = () => carrierListeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  if (profile.role === "owner" || (profile.role === "dispatcher" && profile.allCarriers)) {
    shellCarrierUnsub = onSnapshot(collection(db, "carriers"), (snap) => { snap.docs.forEach((d) => applyCarrier(d.id, d.data())); notify(); }, () => {});
  } else {
    const uns = carriers.map((c) => onSnapshot(doc(db, "carriers", c.id), (d) => { if (d.exists()) { applyCarrier(d.id, d.data()); notify(); } }, () => {}));
    shellCarrierUnsub = () => uns.forEach((u) => u());
  }

  const views = role.views;
  const current = () => views.find((v) => "#" + v.id === location.hash) || views[0];
  const content = h("main", { class: "content", id: "content", tabindex: "-1" });
  const nav = h("nav", { class: "site-nav", id: "site-nav", "aria-label": "Main" });
  const title = h("h1", null);

  const ctx = {
    uid: user.uid, profile, carriers,
    global: profile.role === "owner" || (profile.role === "dispatcher" && !!profile.allCarriers),
    carrierName: (id) => carrierNames.get(id) || (id ? "Carrier" : "—"),
    sub: (u) => viewSubs.push(u),
    reload: () => renderShell(user, profile),
    // Pages that do money math listen here so a carrier's new factoring % or fee shows up right away.
    onCarriers: (fn) => { carrierListeners.add(fn); viewSubs.push(() => carrierListeners.delete(fn)); },
  };

  const show = () => {
    clearView();
    const v = current();
    nav.replaceChildren(...views.map((x) => h("a", { href: "#" + x.id, class: "nav-link" + (x === v ? " on" : ""), "aria-current": x === v ? "page" : null }, x.label)));
    title.textContent = v.label;
    const body = h("div", { class: "view" });
    content.replaceChildren(
      h("header", { class: "page-head" },
        h("div", null,
          h("div", { class: "eyebrow" }, [role.label, profile.role === "carrierAdmin" || profile.role === "driver" ? ctx.carrierName(profile.carrierId) : null].filter(Boolean).join(" · ")),
          title)),
      body);
    try { v.render(ctx, body); } catch (e) { console.error(e); body.append(h("p", { class: "form-error" }, "This page hit an error: " + e.message)); }
  };
  window.onhashchange = show;

  // Traditional website layout: header with logo + menu links, page content, footer.
  const menuBtn = h("button", { type: "button", class: "menu-btn", "aria-expanded": "false", "aria-controls": "site-nav" }, "Menu");
  const header = h("header", { class: "site-header" },
    h("div", { class: "site-header-inner" },
      h("a", { href: "#", class: "brand-link", "aria-label": "KeepTrack home" }, brand()),
      menuBtn,
      nav,
      h("div", { class: "who" },
        h("span", { class: "who-name" }, profile.name || user.email),
        h("span", { class: "who-role" }, role.label),
        btn("Sign out", () => signOut(auth), "link"))));
  menuBtn.addEventListener("click", () => {
    const open = header.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", String(open));
  });
  nav.addEventListener("click", (e) => {
    if (e.target.closest("a")) { header.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); }
  });
  root.replaceChildren(
    h("div", { class: "site" },
      header,
      h("div", { class: "site-main" }, content),
      h("footer", { class: "site-footer" },
        h("div", { class: "site-footer-inner" },
          h("span", null, `© ${new Date().getFullYear()} KeepTrack · A Spartan Groups LLC service`),
          h("span", null, `Signed in as ${user.email}`)))));
  show();
}

// ---------- Boot ----------

if (!isConfigured) {
  renderSetupNeeded();
} else {
  onAuthStateChanged(auth, (user) => {
    if (profileUnsub) { profileUnsub(); profileUnsub = null; }
    if (!user) return signingUp ? null : renderAuth();
    renderNoProfile(user);
    let lastKey = "";
    // Wait for the server-confirmed profile: right after sign-up the local copy exists a moment
    // before the server has it, and queries sent in that gap would be refused.
    profileUnsub = onSnapshot(doc(db, "users", user.uid), { includeMetadataChanges: true }, (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      if (!snap.exists()) return renderNoProfile(user);
      const p = snap.data();
      // Re-render the shell only when access-relevant fields change.
      const key = JSON.stringify([p.role, p.carrierId, p.allCarriers, p.assignedCarriers, p.name]);
      if (key === lastKey) return;
      lastKey = key;
      renderShell(user, p);
    }, (e) => { console.error(e); renderNoProfile(user); });
  });
}
