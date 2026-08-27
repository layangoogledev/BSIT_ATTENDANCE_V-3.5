/**
 * Calculates Euclidean Distance between two 128-float face embedding vectors
 */
export function calculateEuclideanDistance(vectorA, vectorB) {
  if (!vectorA || !vectorB || vectorA.length !== vectorB.length) {
    throw new Error("Invalid vector dimensions for comparison.");
  }
  return Math.sqrt(
    vectorA.reduce((sum, val, idx) => sum + Math.pow(val - vectorB[idx], 2), 0)
  );
}

let faceApiLoadPromise = null;

/**
 * Lazily loads face-api.js and its tiny face detector + recognition models
 * from a CDN. Call this once before opening the webcam.
 */
async function loadFaceApi() {
  if (faceApiLoadPromise) return faceApiLoadPromise;

  faceApiLoadPromise = (async () => {
    if (!window.faceapi) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
        script.onload = resolve;
        script.onerror = () => reject(new Error("Failed to load face-api.js from CDN."));
        document.head.appendChild(script);
      });
    }
    const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model";
    await Promise.all([
      window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      window.faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      window.faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);
    return window.faceapi;
  })();

  return faceApiLoadPromise;
}

/**
 * Captures a single frame from the given <video> element (already streaming
 * from the webcam) and returns a 128-float face descriptor.
 * Throws if no face is detected in the frame — caller should show that
 * error to the user and let them retry rather than silently failing.
 */
export async function captureFaceEmbedding(videoEl) {
  const faceapi = await loadFaceApi();
  const detection = await faceapi
    .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    throw new Error("No face detected. Center your face in frame and try again.");
  }
  return Array.from(detection.descriptor);
}

/**
 * Opens the device webcam and attaches the stream to the given <video>
 * element. Returns the MediaStream so the caller can stop it afterwards
 * (important — leaving the camera running after use is a privacy bug).
 */
export async function startWebcam(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
  videoEl.srcObject = stream;
  await new Promise((resolve) => { videoEl.onloadedmetadata = resolve; });
  return stream;
}

export function stopWebcam(stream) {
  if (stream) stream.getTracks().forEach((track) => track.stop());
}

/**
 * Gets or sets browser fingerprint stored locally
 */
export function getDeviceFingerprint() {
  let fp = localStorage.getItem("pamsu_device_fp");
  if (!fp) {
    fp = "DEV-" + crypto.randomUUID();
    localStorage.setItem("pamsu_device_fp", fp);
  }
  return fp;
}