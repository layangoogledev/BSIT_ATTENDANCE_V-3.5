            import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc, query, orderBy, addDoc,
  serverTimestamp, getDoc, writeBatch, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Same Cloudflare Worker used for attendance verification also handles
// admin-only actions that need elevated (service-account) permissions —
// specifically deleting a student's Firebase Auth account, which client
// JS can never do for another user regardless of admin status.
const ATTENDANCE_WORKER_URL = "https://pamsu-attendance.layannoriel9.workers.dev";

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
    startScheduleMonitor();
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
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      if (!rawRows.length) {
        alert("The sheet appears to be empty, or the data doesn't start on the first row.");
        return;
      }

      // Normalize each row's keys: strip a UTF-8 BOM character some
      // spreadsheet apps silently prepend to the first header cell, trim
      // whitespace, lowercase, and strip ALL internal spaces/underscores
      // so "Student Number", "student_number", and "studentNumber" all
      // normalize to the same "studentnumber" key. Real-world exports
      // rarely match a required camelCase header exactly — this handles
      // the common variations instead of requiring hand-renamed columns.
      const normalizeKey = (k) =>
        k.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_-]+/g, "");
      const rows = rawRows.map((row) => {
        const out = {};
        for (const key in row) {
          out[normalizeKey(key)] = typeof row[key] === "string" ? row[key].trim() : row[key];
        }
        return out;
      });

      const valid = rows
        .filter((r) => r.studentnumber && r.fullname)
        .map((r) => ({
          studentNumber: r.studentnumber,
          fullName: r.fullname,
          section: r.section
        }));

      if (!valid.length) {
        const foundHeaders = Object.keys(rows[0] || {}).join(", ") || "(none detected)";
        alert(
          `No valid rows found. Expected columns: studentNumber, fullName, section.\n\n` +
          `Headers actually found in your file: ${foundHeaders}\n\n` +
          `Check for typos, or that data starts on row 1.`
        );
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

// --- Class Schedule ---

const DAY_NAMES = ["", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const scheduleRows = document.getElementById('schedule-rows');

function startScheduleMonitor() {
  if (!scheduleRows) return;
  const q = query(collection(db, "classSchedules"), orderBy("dayOfWeek"));
  onSnapshot(q, (snapshot) => {
    scheduleRows.innerHTML = "";
    snapshot.forEach((docSnap) => {
      const s = docSnap.data();
      const tr = document.createElement('tr');
      appendCell(tr, s.subjectLabel || s.subject);
      appendCell(tr, s.classMode === 'f2f' ? 'Face-to-Face' : 'Online');
      appendCell(tr, DAY_NAMES[s.dayOfWeek] || s.dayOfWeek);
      appendCell(tr, s.time);

      const actionTd = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-small btn-danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Remove ${s.subjectLabel || s.subject} on ${DAY_NAMES[s.dayOfWeek]} ${s.time}?`)) return;
        try {
          await deleteDoc(doc(db, "classSchedules", docSnap.id));
        } catch (err) {
          alert(`Failed to delete: ${err.message}`);
        }
      });
      actionTd.appendChild(delBtn);
      tr.appendChild(actionTd);

      scheduleRows.appendChild(tr);
    });
  }, (err) => {
    scheduleRows.innerHTML = `<tr><td colspan="5">Failed to load schedule: ${err.message}</td></tr>`;
  });
}

const scheduleForm = document.getElementById('schedule-form');
if (scheduleForm) {
  scheduleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const subjectSelect = document.getElementById('schedule-subject');
    const subject = subjectSelect.value;
    const subjectLabel = subjectSelect.options[subjectSelect.selectedIndex].text;
    const classMode = document.getElementById('schedule-mode').value;
    const dayOfWeek = parseInt(document.getElementById('schedule-day').value, 10);
    const time = document.getElementById('schedule-time').value;
    const submitBtn = scheduleForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      // Same section-scoping note as live session generation — this demo
      // targets BSIT-1A only. Extend with a section picker for multi-
      // section faculty.
      await addDoc(collection(db, "classSchedules"), {
        subject,
        subjectLabel,
        section: "BSIT-1A",
        classMode,
        dayOfWeek,
        time,
        createdBy: auth.currentUser.uid,
        createdAt: serverTimestamp()
      });
      scheduleForm.reset();
      document.getElementById('schedule-day').value = "2";
      document.getElementById('schedule-time').value = "09:00";
    } catch (err) {
      alert(`Failed to add schedule entry: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// --- Remove student ---

const removeBtn = document.getElementById('btn-remove-student');
if (removeBtn) {
  removeBtn.addEventListener('click', async () => {
    const stdNumber = document.getElementById('remove-std-id').value.trim();
    if (!stdNumber) return alert("Please enter a Student ID");

    if (!confirm(
      `Permanently remove student ${stdNumber}? This deletes their profile ` +
      `and login access. Their attendance history is kept.`
    )) return;

    removeBtn.disabled = true;
    try {
      const q = query(collection(db, "students"), where("studentNumber", "==", stdNumber));
      const snap = await getDocs(q);
      if (snap.empty) {
        alert(`No student found with ID: ${stdNumber}`);
        return;
      }
      const studentDocId = snap.docs[0].id; // this is the student's Auth uid

      // Step 1: delete the Firestore profile (client can do this directly —
      // firestore.rules already scopes update/delete-adjacent access to
      // admins for this collection).
      await deleteDoc(doc(db, "students", studentDocId));

      // Step 2: delete their Firebase Auth account via the Worker, since
      // client JS can never delete another user's Auth account — only the
      // Worker's service account has the elevated access this requires.
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch(`${ATTENDANCE_WORKER_URL}/admin/delete-student`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ uid: studentDocId }),
      });
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`Worker response was not valid JSON. HTTP ${res.status}. Raw: ${rawText.slice(0, 300)}`);
      }
      if (!res.ok) {
        throw new Error(data.message || "Failed to delete login access.");
      }

      alert(`Student ${stdNumber} removed. Profile deleted and login access revoked.`);
      document.getElementById('remove-std-id').value = "";
    } catch (err) {
      alert(`Error removing student: ${err.message}`);
    } finally {
      removeBtn.disabled = false;
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
        
