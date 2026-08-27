const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// Campus geofence — kept in sync with geo-location.js on the client.
// The client's own isWithinFence check is UX-only; it must be re-verified
// here, or a modified client could skip it and submit fabricated GPS
// coordinates as "within range."
const CAMPUS_LAT = 15.0650;
const CAMPUS_LNG = 120.7200;
const MAX_RADIUS_METERS = 150;
const FACE_MATCH_THRESHOLD = 0.45;
const LATE_WINDOW_MINUTES = 10;

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Server-Side Attendance Verification Function
 */
exports.verifyAndRecordAttendance = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { sessionId, deviceFingerprint, faceVector, gpsCoords, sessionCode } = data;
  const uid = context.auth.uid;

  // 0. Basic input validation — reject malformed payloads with a clean
  // error instead of letting them crash further down with a raw 500.
  if (typeof sessionId !== "string" || !sessionId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing sessionId.");
  }
  if (!Array.isArray(faceVector) || faceVector.length !== 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid face vector.");
  }
  if (
    !gpsCoords ||
    typeof gpsCoords.latitude !== "number" ||
    typeof gpsCoords.longitude !== "number"
  ) {
    throw new functions.https.HttpsError("invalid-argument", "Missing GPS coordinates.");
  }

  // 1. Fetch Student Profile
  const studentDoc = await db.collection("students").doc(uid).get();
  if (!studentDoc.exists) throw new functions.https.HttpsError("not-found", "Student profile missing.");
  const student = studentDoc.data();

  if (!Array.isArray(student.faceEmbeddings) || student.faceEmbeddings.length !== 128) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "No valid biometric reference on file. Please re-enroll your face scan."
    );
  }

  // 2. Device Fingerprint Check
  if (student.deviceId && student.deviceId !== deviceFingerprint) {
    throw new functions.https.HttpsError("permission-denied", "Unauthorized device detected. Unbind required.");
  }

  // 3. Face Matching Euclidean Distance Logic
  const storedVector = student.faceEmbeddings;
  const distance = Math.sqrt(
    storedVector.reduce((sum, val, idx) => sum + Math.pow(val - faceVector[idx], 2), 0)
  );
  if (distance > FACE_MATCH_THRESHOLD) {
    throw new functions.https.HttpsError("invalid-argument", "Biometric face matching failed.");
  }

  // 4. Session Validation
  const sessionDoc = await db.collection("attendanceSessions").doc(sessionId).get();
  if (!sessionDoc.exists) throw new functions.https.HttpsError("not-found", "Session not found.");
  const session = sessionDoc.data();

  if (session.status !== "open") {
    throw new functions.https.HttpsError("failed-precondition", "This session is closed for check-in.");
  }

  if (session.classMode === "f2f") {
    if (session.activeCode !== sessionCode) {
      throw new functions.https.HttpsError("invalid-argument", "Incorrect 4-digit session code.");
    }

    // 5. Server-side geofence re-check. Never trust the client's own
    // isWithinFence flag — recompute it here from the raw coordinates.
    const distanceMeters = haversineDistance(
      gpsCoords.latitude, gpsCoords.longitude, CAMPUS_LAT, CAMPUS_LNG
    );
    if (distanceMeters > MAX_RADIUS_METERS) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Outside campus geofence (${Math.round(distanceMeters)}m from campus, max ${MAX_RADIUS_METERS}m).`
      );
    }
  }

  // 6. Prevent re-submission from silently overwriting an earlier result
  // (e.g. downgrading an existing "On-Time" record by re-running check-in).
  const recordRef = db.collection("attendanceRecords").doc(`${sessionId}_${uid}`);
  const existing = await recordRef.get();
  if (existing.exists) {
    throw new functions.https.HttpsError(
      "already-exists",
      "You've already checked in to this session."
    );
  }

  // Calculate Attendance Status
  const now = admin.firestore.Timestamp.now();
  const startTime = session.startTime;
  const diffMinutes = (now.seconds - startTime.seconds) / 60;

  let status = "On-Time";
  if (diffMinutes > 0 && diffMinutes <= LATE_WINDOW_MINUTES) {
    status = "Late";
  } else if (diffMinutes > LATE_WINDOW_MINUTES) {
    status = "Absent";
  }

  // Write record safely using server timestamp
  await recordRef.set({
    sessionId,
    studentId: uid,
    studentNumber: student.studentNumber,
    fullName: student.fullName,
    section: student.section,
    timestamp: now,
    status,
    faceDistance: distance,
    verifiedByServer: true
  });

  return { success: true, status, faceDistance: distance };
});