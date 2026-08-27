import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  doc, setDoc, getDoc, collection, query, where, addDoc, serverTimestamp, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getVerifiedLocation } from "./geo-location.js";
import {
  getDeviceFingerprint, captureFaceEmbedding, startWebcam, stopWebcam
} from "./face-verify.js";

// The verify-and-record step now runs on a Cloudflare Worker instead of
// a Firebase Cloud Function (Cloud Functions require the paid Blaze
// plan; this app stays on Firebase's free Spark plan by moving just
// this one server-side check elsewhere).
// Replace with your actual Worker URL after deploying it — see the
// Cloudflare Worker setup steps.
const ATTENDANCE_WORKER_URL = "https://pamsu-attendance.YOUR-SUBDOMAIN.workers.dev";

// ---------------------------------------------------------------------
// LOGIN PAGE (index.html): sign in / enroll
// (tab-switching lives in ui-common.js, loaded separately)
// ---------------------------------------------------------------------

let capturedFaceEmbedding = null;
let enrollWebcamStream = null;

const scanBtn = document.getElementById('btn-scan-face');
if (scanBtn) {
  scanBtn.addEventListener('click', async () => {
    const statusEl = document.getElementById('face-status');
    scanBtn.disabled = true;
    statusEl.textContent = "Starting camera...";
    statusEl.className = "status-pill warn";

    // Build a temporary video element to drive capture, since the login
    // page markup has no <video> element for this step.
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = "width:220px;border-radius:8px;margin-top:8px;";
    scanBtn.insertAdjacentElement('afterend', video);

    try {
      enrollWebcamStream = await startWebcam(video);
      statusEl.textContent = "Loading model & detecting face...";
      // Small delay so the user can see their frame before we snapshot it.
      await new Promise((r) => setTimeout(r, 1200));
      capturedFaceEmbedding = await captureFaceEmbedding(video);
      statusEl.textContent = "Captured";
      statusEl.className = "status-pill success";
    } catch (err) {
      statusEl.textContent = "Capture failed — retry";
      statusEl.className = "status-pill danger";
      alert(`Face capture error: ${err.message}`);
    } finally {
      stopWebcam(enrollWebcamStream);
      video.remove();
      scanBtn.disabled = false;
    }
  });
}

const studentForm = document.getElementById('student-form');
if (studentForm) {
  studentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const studentNum = document.getElementById('std-number').value.trim();
    const password = document.getElementById('std-password').value;
    const isSignup = !document.getElementById('signup-fields').classList.contains('hidden');
    const email = `${studentNum}@student.pamsu.edu.ph`;
    const submitBtn = document.getElementById('btn-student-submit');

    if (isSignup && !capturedFaceEmbedding) {
      alert("Please capture your face reference scan before enrolling.");
      return;
    }

    submitBtn.disabled = true;
    try {
      if (isSignup) {
        const name = document.getElementById('std-name').value.trim();
        const section = document.getElementById('std-section').value;
        if (!name) {
          alert("Full name is required.");
          return;
        }
        const deviceId = getDeviceFingerprint();

        const userCred = await createUserWithEmailAndPassword(auth, email, password);
        await setDoc(doc(db, "students", userCred.user.uid), {
          studentNumber: studentNum,
          fullName: name,
          section: section,
          deviceId: deviceId,
          faceEmbeddings: capturedFaceEmbedding,
          createdAt: new Date().toISOString()
        });
        alert("Enrollment successful! Logging in...");
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      window.location.href = "student-dashboard.html";
    } catch (err) {
      alert(`Authentication Error: ${friendlyAuthError(err)}`);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function friendlyAuthError(err) {
  const map = {
    "auth/email-already-in-use": "That student number is already enrolled. Try signing in instead.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/invalid-credential": "Incorrect student number or password.",
    "auth/user-not-found": "No account found for that student number.",
    "auth/wrong-password": "Incorrect password.",
    "auth/too-many-requests": "Too many attempts. Please wait and try again."
  };
  return map[err.code] || err.message;
}

// ---------------------------------------------------------------------
// STUDENT DASHBOARD (student-dashboard.html)
// ---------------------------------------------------------------------

const dashboardRoot = document.getElementById('active-classes-list');
if (dashboardRoot) {
  initDashboard();
}

let currentUser = null;
let currentStudentDoc = null;
let selectedSession = null;

async function initDashboard() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }
    currentUser = user;
    const snap = await getDoc(doc(db, "students", user.uid));
    if (!snap.exists()) {
      alert("Student profile not found. Please contact your admin.");
      await signOut(auth);
      window.location.href = "index.html";
      return;
    }
    currentStudentDoc = snap.data();
    document.getElementById('user-display-name').textContent =
      `${currentStudentDoc.fullName} (${currentStudentDoc.studentNumber})`;

    await loadActiveSessions(currentStudentDoc.section);
    populateExcuseSubjects();
  });
}

async function loadActiveSessions(section) {
  const listEl = document.getElementById('active-classes-list');
  listEl.innerHTML = "<p class='text-muted'>Loading sessions...</p>";

  const q = query(
    collection(db, "attendanceSessions"),
    where("section", "==", section),
    where("status", "==", "open")
  );
  const snap = await getDocs(q);

  if (snap.empty) {
    listEl.innerHTML = "<p class='text-muted'>No active class sessions right now.</p>";
    return;
  }

  listEl.innerHTML = "";
  snap.forEach((docSnap) => {
    const session = docSnap.data();
    const row = document.createElement('div');
    row.className = "class-list-item";
    row.innerHTML = `
      <div>
        <strong>${session.subject || 'Class'}</strong>
        <span class="text-muted"> — ${session.classMode === 'f2f' ? 'Face-to-Face' : 'Online'}</span>
      </div>
      <button class="btn-primary btn-small glow-cyan" data-session-id="${docSnap.id}">Check In</button>
    `;
    row.querySelector('button').addEventListener('click', () => openCheckinModal(docSnap.id, session));
    listEl.appendChild(row);
  });
}

function populateExcuseSubjects() {
  const select = document.getElementById('excuse-subject');
  if (!select) return;
  // Static subject list matches the admin session-generation options;
  // kept in sync manually since there's no separate "subjects" collection.
  ["IT101", "IT201", "IT301"].forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    select.appendChild(opt);
  });
}

// --- Check-in modal ---

const modal = document.getElementById('checkin-modal');
let checkinStream = null;

function openCheckinModal(sessionId, session) {
  selectedSession = { id: sessionId, ...session };
  modal.classList.remove('hidden');
  document.getElementById('code-input-group').classList.toggle('hidden', session.classMode !== 'f2f');
  resetStep('step-device');
  resetStep('step-face');
  resetStep('step-geo');

  const video = document.getElementById('webcam-feed');
  startWebcam(video)
    .then((stream) => { checkinStream = stream; })
    .catch((err) => alert(`Camera error: ${err.message}`));
}

function closeCheckinModal() {
  modal.classList.add('hidden');
  stopWebcam(checkinStream);
  checkinStream = null;
  selectedSession = null;
}

function resetStep(id) {
  document.getElementById(id).classList.remove('active', 'complete');
}
function markStep(id, state) {
  const el = document.getElementById(id);
  el.classList.remove('active', 'complete');
  el.classList.add(state);
}

const closeBtn = document.getElementById('btn-close-modal');
if (closeBtn) closeBtn.addEventListener('click', closeCheckinModal);

const verifyBtn = document.getElementById('btn-verify-now');
if (verifyBtn) {
  verifyBtn.addEventListener('click', async () => {
    if (!selectedSession) return;
    verifyBtn.disabled = true;

    try {
      // Step 1: device fingerprint (computed client-side; server re-checks it)
      markStep('step-device', 'active');
      const deviceFingerprint = getDeviceFingerprint();
      markStep('step-device', 'complete');

      // Step 2: face match
      markStep('step-face', 'active');
      const video = document.getElementById('webcam-feed');
      const faceVector = await captureFaceEmbedding(video);
      markStep('step-face', 'complete');

      // Step 3: geofence
      markStep('step-geo', 'active');
      const location = await getVerifiedLocation();
      markStep('step-geo', location.isWithinFence ? 'complete' : 'active');
      if (selectedSession.classMode === 'f2f' && !location.isWithinFence) {
        throw new Error(`You're ${Math.round(location.distanceMeters)}m from campus — outside the 150m check-in radius.`);
      }

      const sessionCode = document.getElementById('session-code').value.trim();
      if (selectedSession.classMode === 'f2f' && sessionCode.length !== 4) {
        throw new Error("Enter the 4-digit session code from your instructor.");
      }

      const verifyAndRecordAttendance = async (payload) => {
        const idToken = await currentUser.getIdToken();
        const res = await fetch(ATTENDANCE_WORKER_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || "Verification request failed.");
        }
        return data;
      };

      const result = await verifyAndRecordAttendance({
        sessionId: selectedSession.id,
        deviceFingerprint,
        faceVector,
        gpsCoords: { latitude: location.latitude, longitude: location.longitude },
        sessionCode
      });

      alert(`Check-in recorded: ${result.status}`);
      closeCheckinModal();
      await loadActiveSessions(currentStudentDoc.section);
    } catch (err) {
      alert(`Verification failed: ${err.message}`);
    } finally {
      verifyBtn.disabled = false;
    }
  });
}

// --- Excuse letter ---

const excuseForm = document.getElementById('excuse-form');
if (excuseForm) {
  excuseForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return;
    const submitBtn = excuseForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await addDoc(collection(db, "excuseLetters"), {
        studentId: currentUser.uid,
        studentNumber: currentStudentDoc.studentNumber,
        fullName: currentStudentDoc.fullName,
        subject: document.getElementById('excuse-subject').value,
        date: document.getElementById('excuse-date').value,
        reason: document.getElementById('excuse-reason').value,
        status: "pending",
        submittedAt: serverTimestamp()
        // Note: the file attachment (excuse-file input) is not uploaded
        // here — this build has no Firebase Storage upload wired up. Add
        // Storage upload + store the resulting download URL if attachments
        // are required.
      });
      alert("Excuse letter submitted.");
      excuseForm.reset();
    } catch (err) {
      alert(`Submission error: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// --- Logout ---

const logoutBtn = document.getElementById('btn-logout');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = "index.html";
  });
}
