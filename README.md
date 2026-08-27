# PamSU BSIT Attendance Portal — Fixes Applied

## What was broken (see full breakdown in chat)
- Admin login had no handler; admin dashboard buttons (session gen, CSV
  export, roster import, logout) were all unwired.
- Student dashboard (logout, class list, check-in modal, face capture,
  excuse form) was entirely unwired despite the markup existing.
- The check-in flow never called the geolocation, face-distance, or
  Cloud Function code that already existed in the project.
- Cloud Function had no package.json/firebase.json/.firebaserc — undeployable.
- Firestore rule let students overwrite their own `deviceId` and
  `faceEmbeddings`, defeating the anti-proxy design.
- Server never re-verified the geofence — a modified client could fake GPS.
- Admin dashboard used `innerHTML` with student-supplied data (stored XSS).
- `generateMockEmbedding()` returned random noise — biometric match could
  never work. Replaced with real face-api.js webcam capture.
- Device unbind looked students up by the wrong document ID.
- No duplicate check-in guard, no session `status === "open"` check.

## Before deploying, you still need to do this manually

**Active setup (no Blaze plan needed):** attendance verification runs on
a **Cloudflare Worker** (`cf-worker/worker.js`), not the Firebase Cloud
Function in `functions/`. The `functions/` folder is kept only as a
fallback if you later upgrade to Firebase's Blaze plan — it is not
currently deployed or called by anything.

1. **Deploy Firestore rules**: Firebase Console → Firestore → Rules tab
   → paste the contents of `firestore.rules` → Publish. (No CLI needed.)
2. **Deploy the Cloudflare Worker** — see the step-by-step Cloudflare
   setup walkthrough (dashboard → Workers & Pages → Create → paste
   `cf-worker/worker.js` → set secrets `FIREBASE_SERVICE_ACCOUNT_JSON`,
   `FIREBASE_PROJECT_ID`, `ALLOWED_ORIGIN` → Deploy).
3. **Update `ATTENDANCE_WORKER_URL`** in `student-app.js` to your actual
   deployed Worker URL (looks like
   `https://pamsu-attendance.YOUR-SUBDOMAIN.workers.dev`).
4. **Create the first admin account manually** — there is no self-serve
   admin signup by design. In the Firebase Console, create a user under
   Authentication, then add a document at `admins/{that user's UID}`
   in Firestore (any fields, e.g. `{ "role": "faculty" }`) so the
   `isAdmin()` rule check passes.
5. **Composite index**: the student dashboard's active-session query
   (`where section == ... AND where status == "open"`) needs a composite
   index. The first time it runs, open the browser console — Firestore
   will print a direct link to create it. Click it once; no manual config.
6. **Restrict the Firebase Web API key** to your real domain(s) in
   Firebase Console → Authentication → Settings → Authorized domains
   (the key itself is meant to be public; access control is enforced by
   firestore.rules, which is why step 1 matters).
7. **Roster import** only stages rows into a `studentsRoster` collection
   for admin reference — it does not create Firebase Auth accounts
   (that requires a service account, which the Worker doesn't do for
   bulk user creation). Students still self-enroll via the signup form.
8. **Excuse letter file attachment** is currently not uploaded anywhere.
   If you need that, add a Firebase Storage upload in the excuse-form
   handler in `student-app.js` and store the resulting download URL.

### If you upgrade to Blaze later and want the Cloud Function instead
The original Cloud Function is preserved in `functions/index.js`. Switch
back by: deploying it (`firebase deploy --only functions` from Cloud
Shell or a local machine with the CLI), restoring the `functions` export
in `firebase-config.js`, and swapping the `fetch(ATTENDANCE_WORKER_URL)`
call in `student-app.js` back to `httpsCallable`.

## Face recognition note
Face capture now uses face-api.js (loaded from CDN) with a tiny face
detector + 128-d recognition model. First load will be slow (~1-2MB of
model weights) — consider self-hosting the model files under your own
domain for production instead of relying on the CDN.
