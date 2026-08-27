import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// NOTE: The Firebase Web "apiKey" below is a public client identifier,
// not a secret — Firebase's docs confirm it's safe to ship in client code.
// Real access control lives entirely in firestore.rules (server-enforced),
// so DO NOT rely on hiding this key for security. What you must still do
// before going live:
//   1. In the Firebase Console > Authentication > Settings, restrict this
//      key's allowed HTTP referrers to your real domain(s).
//   2. Deploy firestore.rules (paste into Console > Firestore > Rules)
//      so the update-field restriction on /students/{id} is actually live.
const firebaseConfig = {
  apiKey: "AIzaSyBl472hHRVnTCOZH73hwo5oWQHmPEaEFfI",
  authDomain: "attendance-1b040.firebaseapp.com",
  projectId: "attendance-1b040",
  storageBucket: "attendance-1b040.firebasestorage.app",
  messagingSenderId: "327966137487",
  appId: "1:327966137487:web:7e831bfc09bdd910e5a4fa"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
// No `functions` export — attendance verification now runs on a
// Cloudflare Worker (see ATTENDANCE_WORKER_URL in student-app.js)
// instead of a Firebase Cloud Function, since Cloud Functions require
// the paid Blaze plan and this project stays on the free Spark plan.