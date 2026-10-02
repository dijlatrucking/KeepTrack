// The owner adds people (with a username + starting password) and resets passwords.
//  - Adding works in the browser: the login is created in a second, throwaway sign-in session so the
//    owner stays signed in, then the owner saves the person's profile.
//  - Resetting needs Google admin rights over the logins, which a website doesn't have. It goes through
//    the owner's Drive script (drive/KeepTrackDrive.gs), which checks the request comes from the owner.
import { db, doc, setDoc, updateDoc, serverTimestamp, spareAuth, createUserWithEmailAndPassword, signOut } from "./fb.js";
import { h, field, input, passwordInput, select, btn, toast, friendlyError } from "./ui.js";
import { loginEmail, cleanUsername, USERNAME_RE, USERNAME_HELP, suggestPassword, loginMessage, personLabel } from "./login.js";
import { driveUrl, driveCall } from "./drive.js";

export const ROLE_CHOICES = [
  { value: "driver", label: "Driver" },
  { value: "carrierAdmin", label: "Carrier admin" },
  { value: "dispatcher", label: "Dispatcher" },
];

export async function addPerson(ctx, p) {
  const username = cleanUsername(p.username);
  if (!USERNAME_RE.test(username)) throw new Error("That username won't work. " + USERNAME_HELP);
  if (String(p.password || "").length < 6) throw new Error("The password needs at least 6 characters.");
  if (["driver", "carrierAdmin"].includes(p.role) && !p.carrierId) throw new Error("Pick their carrier.");
  const spare = spareAuth();
  let cred = null;
  try {
    cred = await createUserWithEmailAndPassword(spare.auth, loginEmail(username), p.password);
    const profile = {
      name: String(p.name || "").trim(), username, phone: String(p.phone || "").trim(), role: p.role,
      tempPassword: !!p.tempPassword, addedBy: ctx.uid, createdAt: serverTimestamp(),
    };
    if (["driver", "carrierAdmin"].includes(p.role)) profile.carrierId = p.carrierId;
    if (p.role === "dispatcher") Object.assign(profile, { allCarriers: !!p.allCarriers, assignedCarriers: p.assignedCarriers || [] });
    await setDoc(doc(db, "users", cred.user.uid), profile);
    return { uid: cred.user.uid, username };
  } catch (e) {
    // the login was made but the profile wasn't: take the login back out so the username is free again
    if (cred) { try { await cred.user.delete(); } catch (_) {} }
    throw e;
  } finally {
    try { await signOut(spare.auth); } catch (_) {}
    spare.done();
  }
}

export async function resetPassword(ctx, u, password, { temp = true } = {}) {
  if (String(password || "").length < 6) throw new Error("The password needs at least 6 characters.");
  if (!(await driveUrl())) throw new Error("Password resets go through your Google Drive script. Connect Google Drive in Settings first.");
  await driveCall({ resetPassword: { uid: u.id, password } });
  await updateDoc(doc(db, "users", u.id), { tempPassword: !!temp });
}

export async function checkResets() {
  if (!(await driveUrl())) throw new Error("Connect Google Drive first (Settings → Google Drive).");
  return driveCall({ checkAdmin: true });
}

// After adding someone or resetting their password: the login details, ready to copy or text.
export function shareCard(person, username, password, { title = "Login ready", temp = true } = {}) {
  const msg = loginMessage(person.name, username, password) + (temp ? "\nYou'll pick your own password the first time you sign in." : "");
  const copy = btn("Copy login details", async () => {
    try { await navigator.clipboard.writeText(msg); toast("Copied", "ok"); }
    catch (e) { toast("Couldn't copy. Press and hold the text to copy it.", "bad"); }
  }, "dark");
  const phone = String(person.phone || "").replace(/[^\d+]/g, "");
  return h("section", { class: "card card-ok share-card" },
    h("div", { class: "card-head" }, h("h2", null, title)),
    h("p", { class: "muted small" }, `For ${personLabel(person)}. This is the only time the password is shown, so send it now.`),
    h("pre", { class: "share-text" }, msg),
    h("div", { class: "row-inline" }, copy,
      phone ? h("a", { class: "btn btn-ghost", href: `sms:${phone}?body=${encodeURIComponent(msg)}` }, "Text it") : null));
}

// "Add a person" form. onDone(result) gets { person, username, password, temp } after it's saved.
export function addPersonForm(ctx, { onDone, onCancel, carrierId = "", role = "driver" } = {}) {
  const roleSel = select("role", ROLE_CHOICES.map((r) => ({ ...r, selected: r.value === role })));
  const carrierSel = select("carrierId", [{ value: "", label: "Pick a carrier" }, ...ctx.carriers.map((c) => ({ value: c.id, label: c.name, selected: c.id === carrierId }))]);
  const carrierField = field("Carrier", carrierSel);
  const allBox = h("input", { type: "checkbox", name: "allCarriers" });
  const boxes = ctx.carriers.map((c) => h("label", { class: "check" }, h("input", { type: "checkbox", value: c.id, class: "disp-carrier" }), c.name));
  const dispBox = h("div", { class: "stack" }, h("span", { class: "field-label" }, "Carriers they work"),
    h("div", { class: "checks" }, h("label", { class: "check" }, allBox, h("strong", null, "All carriers")), boxes));
  // shown by default: the owner is about to send it (Hide is there if someone's looking over their shoulder)
  const passBox = passwordInput("password", { autocomplete: "off", minlength: "6", required: true, value: suggestPassword() }, { shown: true });
  const pass = passBox.input;
  const temp = h("input", { type: "checkbox", name: "temp", checked: true });
  const err = h("p", { class: "form-error", role: "alert" });
  const sync = () => {
    carrierField.hidden = roleSel.value === "dispatcher";
    dispBox.hidden = roleSel.value !== "dispatcher";
  };
  roleSel.addEventListener("change", sync);
  let busy = false;
  const form = h("form", { class: "stack", autocomplete: "off", onSubmit: async (e) => {
    e.preventDefault();
    if (busy) return;
    err.textContent = "";
    const p = {
      role: roleSel.value, carrierId: carrierSel.value, name: form.name.value, phone: form.phone.value,
      username: form.username.value, password: pass.value, tempPassword: temp.checked,
      allCarriers: allBox.checked, assignedCarriers: [...form.querySelectorAll(".disp-carrier:checked")].map((x) => x.value),
    };
    busy = true;
    form.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const r = await addPerson(ctx, p);
      toast(`${p.name || r.username} can sign in now`, "ok");
      onDone && onDone({ person: { ...p, id: r.uid }, username: r.username, password: p.password, temp: p.tempPassword });
    } catch (x) {
      err.textContent = friendlyError(x);
      form.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
    busy = false;
  } },
    h("div", { class: "form-grid" },
      field("Role", roleSel), carrierField,
      field("Full name", input("name", { required: true, autocomplete: "off" })),
      field("Phone", input("phone", { type: "tel", autocomplete: "off" }))),
    dispBox,
    h("div", { class: "form-grid" },
      field("Username", input("username", { type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false", required: true, placeholder: "e.g. drew.smith" }), USERNAME_HELP),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Starting password"), passBox,
        h("span", { class: "field-hint" }, "At least 6 characters. ", h("button", { type: "button", class: "btn-link small", onClick: () => { pass.value = suggestPassword(); passBox.show(true); } }, "Make a new one")))),
    h("label", { class: "check" }, temp, "Have them pick their own password the first time they sign in"),
    err,
    h("div", { class: "row-inline" }, btn("Add person", null, "primary", { type: "submit" }), onCancel ? btn("Cancel", onCancel, "ghost") : null));
  sync();
  return form;
}

// "Reset password" window for one person.
export function resetPasswordDialog(ctx, u, { onDone } = {}) {
  const dlg = h("dialog", { class: "dialog", "aria-label": "Reset password" });
  const close = () => { dlg.close(); dlg.remove(); };
  const passBox = passwordInput("password", { autocomplete: "off", minlength: "6", required: true, value: suggestPassword() }, { shown: true });
  const pass = passBox.input;
  const temp = h("input", { type: "checkbox", name: "temp", checked: true });
  const err = h("p", { class: "form-error", role: "alert" });
  const login = u.username || u.email || "";
  const form = h("form", { class: "stack", onSubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    form.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const save = form.querySelector("button[type=submit]");
    save.textContent = "Resetting…";
    try {
      await resetPassword(ctx, u, pass.value, { temp: temp.checked });
      toast(`New password set for ${personLabel(u)}`, "ok");
      close();
      onDone && onDone({ person: u, username: login, password: pass.value, temp: temp.checked });
    } catch (x) {
      err.textContent = friendlyError(x);
      save.textContent = "Reset password";
      form.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  } },
    h("h2", null, "Reset password"),
    h("p", { class: "muted small" }, `${personLabel(u)}${login ? " · " + login : ""}. Their old password stops working right away.`),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "New password"), passBox,
      h("span", { class: "field-hint" }, "At least 6 characters. ", h("button", { type: "button", class: "btn-link small", onClick: () => { pass.value = suggestPassword(); passBox.show(true); } }, "Make a new one"))),
    h("label", { class: "check" }, temp, "Have them pick their own password next time they sign in"),
    err,
    h("div", { class: "row-inline" }, btn("Reset password", null, "primary", { type: "submit" }), btn("Cancel", close, "ghost")));
  dlg.append(form);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
}
