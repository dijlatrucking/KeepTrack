import {
  isConfigured, auth, db, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, doc, getDoc, onSnapshot, writeBatch, serverTimestamp
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
let pendingAuthError = "";
let signingUp = false;

const brand = () => h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }, "✓"), h("span", null, "KeepTrack"));

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
    btn("Create account", null, "primary", { type: "submit" }));

  const tab = (id, label) => h("button", { type: "button", role: "tab", class: "tab" + (mode === id ? " on" : ""), "aria-selected": String(mode === id), onClick: () => renderAuth(id) }, label);
  root.replaceChildren(h("main", { class: "auth" },
    h("div", { class: "auth-card" },
      brand(),
      h("p", { class: "muted" }, "Loads, paperwork and pay, all in one place."),
      h("div", { class: "tabs", role: "tablist" }, tab("signin", "Sign in"), tab("signup", "Create account")),
      mode === "signin" ? signin : signup,
      err),
    h("p", { class: "muted small center" }, "A Spartan Groups LLC service")));
}

function renderSetupNeeded() {
  root.replaceChildren(h("main", { class: "auth" }, h("div", { class: "auth-card" }, brand(),
    h("h1", null, "Almost there"),
    h("p", null, "Paste your Firebase web config into js/firebase-config.js, then reload. See the README for the full setup steps."))));
}

function renderNoProfile(user) {
  clearView();
  root.replaceChildren(h("main", { class: "auth" }, h("div", { class: "auth-card" }, brand(),
    h("h1", null, "Setting up your account…"),
    h("p", { class: "muted" }, `Signed in as ${user.email}. If this screen doesn't change, your account doesn't have access yet. Ask for a new invite code.`),
    btn("Sign out", () => signOut(auth)))));
}

// ---------- App shell ----------

async function renderShell(user, profile) {
  clearView();
  const role = ROLES[profile.role];
  if (!role) return renderNoProfile(user);

  let carriers = [];
  try { carriers = await loadCarriers(profile); } catch (e) { console.error(e); }
  const carrierNames = new Map(carriers.map((c) => [c.id, c.name]));

  const views = role.views;
  const current = () => views.find((v) => "#" + v.id === location.hash) || views[0];
  const content = h("main", { class: "content", id: "content", tabindex: "-1" });
  const nav = h("nav", { class: "side", "aria-label": "Main" });
  const title = h("h1", null);

  const ctx = {
    uid: user.uid, profile, carriers,
    carrierName: (id) => carrierNames.get(id) || (id ? "Carrier" : "—"),
    sub: (u) => viewSubs.push(u),
    reload: () => renderShell(user, profile),
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

  root.replaceChildren(
    h("div", { class: "shell" },
      h("header", { class: "topbar" },
        brand(),
        h("div", { class: "who" }, h("span", { class: "who-name" }, profile.name || user.email), h("span", { class: "who-role" }, role.label)),
        btn("Sign out", () => signOut(auth), "ghost-dark")),
      nav,
      content));
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
    profileUnsub = onSnapshot(doc(db, "users", user.uid), (snap) => {
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
