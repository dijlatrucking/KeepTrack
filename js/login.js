// Logins: people sign up with a username and password (no email needed). Firebase still wants an email
// under the hood, so a username becomes "<username>@<USER_DOMAIN>", an address nobody ever writes to.
// Accounts made with a real email before usernames existed keep signing in with that email.
export const USER_DOMAIN = "keeptrack-6426e.firebaseapp.com";
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;
export const USERNAME_HELP = "3 to 24 letters or numbers. Dots, dashes and underscores are fine; no spaces.";

export const cleanUsername = (s) => String(s || "").trim().toLowerCase();
export const isUsernameLogin = (email) => String(email || "").toLowerCase().endsWith("@" + USER_DOMAIN);

// What someone typed in the sign-in box (a username, or an older account's email) → the login email.
export function loginEmail(typed) {
  const v = String(typed || "").trim();
  return v.includes("@") ? v.toLowerCase() : cleanUsername(v) + "@" + USER_DOMAIN;
}

// How to show someone's login: their username, or their email for older accounts.
export function loginName(user, profile) {
  if (profile && profile.username) return profile.username;
  const e = (user && user.email) || (profile && profile.email) || "";
  return isUsernameLogin(e) ? e.split("@")[0] : e;
}
export const personLabel = (u) => (u && (u.name || u.username || u.email)) || "";
