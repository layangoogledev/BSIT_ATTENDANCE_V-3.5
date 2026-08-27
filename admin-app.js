import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  collection, onSnapshot, doc, updateDoc, query, orderBy, addDoc,
  serverTimestamp, getDoc, writeBatch, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ---------------------------------------------------------------------
// ADMIN LOGIN (index.html)
// ---------------------------------------------------------------------

const adminForm = document.getElementById('admin-form');
if (adminForm) {
  adminForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('admin-email').value.trim();
    const password = document.getElementById('admin-password').value;
    const submitBtn = adminForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      // Verify this account is actually an admin before granting access to
      // the dashboard — signing in only proves the credentials are valid,
      // not that this user has admin rights.
      const adminSnap = await getDoc(doc(db, "admins", cred.user.uid));
      if (!adminSnap.exists()) {
        await signOut(auth);
        throw new Error("This account is not authorized for admin access.");
      }
      window.location.href = "admin-dashboard.html";
    } catch (err) {
      alert(`Authentication Error: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// ADMIN DASHBOARD (admin-dashboard.html)
// ---------------------------------------------------------------------

const rowsContainer = document.getElementById('attendance-live-rows');
if (rowsContainer) {
  initAdminDashboard();
}

let latestRecords = [];

function initAdminDashboard() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }
    const adminSnap = await getDoc(doc(db, "admins", user.uid));
    if (!adminSnap.exists()) {
      alert("This account is not authorized for admin access.");
      await signOut(auth);
      window.location.href = "index.html";
      return;
    }
    startLiveMonitor();
  });
}

function startLiveMonitor() {
  const q = query(collection(db, "attendanceRecords"), orderBy("timestamp", "desc"));

  onSnapshot(q, (snapshot) => {
    latestRecords = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    rowsContainer.innerHTML = "";
    latestRecords.forEach((data) => {
      const tr = document.createElement('tr');
      // Build cells with textContent instead of innerHTML so student-
      // supplied fields (name, section, etc.) can't inject markup/script
      // into the admin dashboard (stored XSS).
      appendCell(tr, data.studentNumber);
      appendCell(tr, data.fullName || 'N/A');
      appendCell(tr, data.section || 'N/A');
      appendCell(tr, data.timestamp ? new Date(data.timestamp.toDate()).toLocaleTimeString() : 'N/A');

      const statusTd = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = `status-pill ${getStatusClass(data.status)}`;
      pill.textContent = data.status;
      statusTd.appendChild(pill);
      tr.appendChild(statusTd);

      appendCell(tr, typeof data.faceDistance === 'number' ? data.faceDistance.toFixed(3) : 'N/A');
      rowsContainer.appendChild(tr);
    });
  }, (err) => {
    rowsContainer.innerHTML = `<tr><td colspan="6">Failed to load records: ${err.message}</td></tr>`;
  });
}

function appendCell(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
}

function getStatusClass(status) {
  if (status === 'On-Time') return 'success';
  if (status === 'Late') return 'warn';
  return 'danger';
}

// --- Session generation ---

const sessionForm = document.getElementById('session-gen-form');
if (sessionForm) {
  sessionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const subjectSelect = document.getElementById('session-subject');
    const subject = subjectSelect.value;
    const subjectLabel = subjectSelect.options[subjectSelect.selectedIndex].text;
    const classMode = document.getElementById('session-mode').value;
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const submitBtn = sessionForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      // NOTE: this demo derives "section" from the admin's own current
      // section context. Adjust this to a real section picker if faculty
      // teach more than one section — right now every generated session
      // targets BSIT-1A only, matching this site's stated scope.
      await addDoc(collection(db, "attendanceSessions"), {
        subject,
        subjectLabel,
        section: "BSIT-1A",
        classMode,
        activeCode: code,
        status: "open",
        startTime: serverTimestamp(),
        createdBy: auth.currentUser.uid
      });
      document.getElementById('active-code').textContent = code;
    } catch (err) {
      alert(`Failed to generate session: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// --- CSV export ---

const exportBtn = document.getElementById('btn-export-excel');
if (exportBtn) {
  exportBtn.addEventListener('click', () => {
    if (!latestRecords.length) {
      alert("No attendance records to export yet.");
      return;
    }
    const header = ["Student ID", "Name", "Section", "Check-In Time", "Status", "Face Distance"];
    const rows = latestRecords.map((r) => [
      r.studentNumber,
      r.fullName || '',
      r.section || '',
      r.timestamp ? new Date(r.timestamp.toDate()).toLocaleString() : '',
      r.status,
      typeof r.faceDistance === 'number' ? r.faceDistance.toFixed(3) : ''
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map(csvEscape).join(","))
      .join("\r\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-summary-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// --- Roster importer (uses the SheetJS <script> tag loaded on the page) ---

const uploadBtn = document.getElementById('btn-upload-excel');
if (uploadBtn) {
  uploadBtn.addEventListener('click', async () => {
    const fileInput = document.getElementById('excel-file-input');
    const file = fileInput.files[0];
    if (!file) {
      alert("Choose a .xlsx or .csv file first.");
      return;
    }
    if (typeof XLSX === 'undefined') {
      alert("Roster parser failed to load. Check your internet connection and reload the page.");
      return;
    }

    uploadBtn.disabled = true;
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);
      // Expected columns: studentNumber, fullName, section
      const valid = rows.filter((r) => r.studentNumber && r.fullName);
      if (!valid.length) {
        alert("No valid rows found. Expected columns: studentNumber, fullName, section.");
        return;
      }

      // This only stages roster records for reference (studentsRoster
      // collection) — it does NOT create Auth accounts, since that
      // requires the Admin SDK and cannot be done from client code.
      // Students still self-enroll via the signup form; admins can cross-
      // check enrollment against this staged roster.
      const batch = writeBatch(db);
      valid.forEach((r) => {
        const ref = doc(collection(db, "studentsRoster"), String(r.studentNumber));
        batch.set(ref, {
          studentNumber: String(r.studentNumber),
          fullName: r.fullName,
          section: r.section || "BSIT-1A",
          importedAt: new Date().toISOString()
        });
      });
      await batch.commit();
      alert(`Imported ${valid.length} roster row(s).`);
      fileInput.value = "";
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    } finally {
      uploadBtn.disabled = false;
    }
  });
}

// --- Unbind device ---

const unbindBtn = document.getElementById('btn-unbind-device');
if (unbindBtn) {
  unbindBtn.addEventListener('click', async () => {
    const stdNumber = document.getElementById('unbind-std-id').value.trim();
    if (!stdNumber) return alert("Please enter a Student ID");

    unbindBtn.disabled = true;
    try {
      // Student docs are keyed by Firebase Auth uid, not by the 10-digit
      // student number the admin types in here — so we have to look the
      // doc up by its studentNumber field first. (Previously this called
      // updateDoc(doc(db, "students", stdNumber), ...), which silently
      // targeted a document that could never exist under that ID and
      // would just throw "not-found" for every real student.)
      const q = query(collection(db, "students"), where("studentNumber", "==", stdNumber));
      const snap = await getDocs(q);
      if (snap.empty) {
        alert(`No student found with ID: ${stdNumber}`);
        return;
      }
      await updateDoc(doc(db, "students", snap.docs[0].id), { deviceId: null });
      alert(`Device unbound for Student: ${stdNumber}`);
      document.getElementById('unbind-std-id').value = "";
    } catch (err) {
      alert(`Error unbinding device: ${err.message}`);
    } finally {
      unbindBtn.disabled = false;
    }
  });
}

// --- Logout ---

const logoutBtn = document.getElementById('btn-admin-logout');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = "index.html";
  });
}
