// Firebase web app config for the KeepTrack project.
// These values are safe to publish: access is controlled by firestore.rules and storage.rules, not by this key.
export const firebaseConfig = {
  apiKey: "AIzaSyAD09pk9OyApPn6f8OCiCFr-PpYT17sEHU",
  authDomain: "keeptrack-6426e.firebaseapp.com",
  projectId: "keeptrack-6426e",
  storageBucket: "keeptrack-6426e.firebasestorage.app",
  messagingSenderId: "1062091068119",
  appId: "1:1062091068119:web:9be37e250c94d189561692"
};

export const isConfigured = !firebaseConfig.apiKey.startsWith("PASTE");
