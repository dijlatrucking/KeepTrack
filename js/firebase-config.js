// Paste your Firebase web app config here (Firebase console → Project settings → Your apps → Web app → Config).
// These values are safe to publish: access is controlled by firestore.rules and storage.rules, not by this key.
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};

export const isConfigured = !firebaseConfig.apiKey.startsWith("PASTE");
