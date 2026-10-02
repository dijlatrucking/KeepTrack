import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, initializeAuth, inMemoryPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";

export { isConfigured };
export let app = null, auth = null, db = null, storage = null;

if (isConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
}

// A second, throwaway sign-in session. The owner uses it to create someone else's login without
// being signed out of their own (Firebase signs you in as whoever you just created).
export const authHooks = []; // lets the test setup point these sessions at the local emulator
export function spareAuth() {
  const a = initializeApp(firebaseConfig, "spare-" + Math.random().toString(36).slice(2, 10));
  const au = initializeAuth(a, { persistence: inMemoryPersistence });
  authHooks.forEach((fn) => fn(au));
  return { auth: au, done: () => deleteApp(a).catch(() => {}) };
}

export {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, updateProfile, updatePassword, reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

export {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, onSnapshot, serverTimestamp, writeBatch, Timestamp,
  getAggregateFromServer, getCountFromServer, sum, count, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
