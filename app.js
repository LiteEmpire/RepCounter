import { FilesetResolver, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

const $ = (id) => document.getElementById(id);
const video = $("cameraVideo");
const canvas = $("overlay");
const ctx = canvas.getContext("2d");
const stage = $("cameraStage");
const placeholder = $("cameraPlaceholder");
const startButton = $("startCamera");
const stopButton = $("stopCamera");
const demoButton = $("demoButton");
const armSelect = $("armSelect");
let poseLandmarker = null;
let cameraStream = null;
let animationFrame = 0;
let demoTimer = 0;
let sessionStartedAt = null;
let sessionClock = 0;
let reps = 0;
let totalReps = 0;
let setsCompleted = 0;
let phase = "waiting";
let hasStartedSession = false;
let lastVideoTime = -1;
let lastRepAt = 0;
let toastTimer = 0;

const modelUrl = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

function notify(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}
function setTrackingStatus(text, active = false) {
  $("trackingStatus").textContent = text;
  $("trackingStatus").classList.toggle("active", active);
}
function updateSessionTime() {
  if (!sessionStartedAt) return;
  const seconds = Math.floor((Date.now() - sessionStartedAt) / 1000);
  $("sessionTime").textContent = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
}
function beginSession() {
  if (hasStartedSession) return;
  hasStartedSession = true;
  sessionStartedAt = Date.now();
  $("sessionStatus").textContent = "Session in progress";
  sessionClock = window.setInterval(updateSessionTime, 1000);
}
function updateRepUI() {
  $("repCount").textContent = reps;
  $("totalReps").textContent = totalReps;
  $("setsCompleted").textContent = setsCompleted;
  $("progressText").textContent = reps + " / 10";
  $("progressBar").style.width = Math.min(100, reps * 10) + "%";
}
function setPhase(next) {
  phase = next;
  $("currentPhase").textContent = next === "down" ? "Lowered" : next === "up" ? "Curled" : "Waiting";
  $("phaseDown").classList.toggle("active", next === "down");
  $("phaseUp").classList.toggle("active", next === "up");
}
function setFeedback(title, text, symbol = "↗") {
  $("feedbackTitle").textContent = title;
  $("feedbackText").textContent = text;
  $("feedbackSymbol").textContent = symbol;
}
function updateAngle(angle) {
  if (!Number.isFinite(angle)) return;
  $("angleReadout").textContent = "Elbow angle: " + Math.round(angle) + "°";
  beginSession();
  if (angle > 145) {
    if (phase === "up") {
      const now = Date.now();
      if (now - lastRepAt > 650) {
        reps += 1;
        totalReps += 1;
        lastRepAt = now;
        updateRepUI();
        if (reps === 10) notify("10 reps — finish your set whenever you're ready.");
        else notify("Rep " + reps + " counted");
      }
    }
    setPhase("down");
    setFeedback("Arm extended", "Good. Curl the weight up smoothly, keeping your elbow near your side.", "↓");
  } else if (angle < 65) {
    if (phase === "down") {
      setPhase("up");
      setFeedback("Curl detected", "Now lower the dumbbell with control to complete the repetition.", "↑");
    } else if (phase === "waiting") {
      setFeedback("Find your starting position", "Extend your arm comfortably first. The counter starts after it detects the full movement.", "◎");
    }
  } else if (phase === "waiting") {
    setFeedback("Get into position", "Extend your arm comfortably so the counter can recognize the start of a full curl.", "↗");
  }
}
function angleBetween(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const dot = ba.x * bc.x + ba.y * bc.y;
  const mag = Math.hypot(ba.x, ba.y) * Math.hypot(bc.x, bc.y);
  if (!mag) return NaN;
  const cosine = Math.max(-1, Math.min(1, dot / mag));
  return Math.acos(cosine) * (180 / Math.PI);
}
function drawPose(landmarks) {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  if (!landmarks) return;
  const pairs = [[11,13],[13,15],[12,14],[14,16],[11,12]];
  ctx.lineWidth = Math.max(3, width * 0.006);
  ctx.lineCap = "round";
  for (const [a, b] of pairs) {
    if (landmarks[a].visibility < 0.35 || landmarks[b].visibility < 0.35) continue;
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x * width, landmarks[a].y * height);
    ctx.lineTo(landmarks[b].x * width, landmarks[b].y * height);
    ctx.strokeStyle = "#b7f36b";
    ctx.stroke();
  }
  for (const index of [11,12,13,14,15,16]) {
    const p = landmarks[index];
    if (p.visibility < 0.35) continue;
    ctx.beginPath();
    ctx.arc(p.x * width, p.y * height, Math.max(4, width * 0.008), 0, Math.PI * 2);
    ctx.fillStyle = (index === 13 || index === 14) ? "#ffffff" : "#b7f36b";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#10131b";
    ctx.stroke();
  }
}
function setCanvasSize() {
  if (!video.videoWidth || !video.videoHeight) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}
async function createPoseTracker() {
  if (poseLandmarker) return poseLandmarker;
  setTrackingStatus("Loading pose model");
  const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" },
      runningMode: "VIDEO", numPoses: 1,
      minPoseDetectionConfidence: 0.55, minPosePresenceConfidence: 0.55, minTrackingConfidence: 0.55
    });
  } catch (gpuError) {
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
      runningMode: "VIDEO", numPoses: 1,
      minPoseDetectionConfidence: 0.55, minPosePresenceConfidence: 0.55, minTrackingConfidence: 0.55
    });
  }
  return poseLandmarker;
}
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    notify("Camera access needs a secure site (HTTPS) and a supported browser.");
    return;
  }
  startButton.disabled = true;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = cameraStream;
    await video.play();
    stage.classList.add("has-camera");
    stopButton.disabled = false;
    demoButton.disabled = true;
    $("cameraHelp").textContent = "Keep your shoulder, elbow, and wrist visible. Turn slightly sideways and avoid swinging the weight.";
    await createPoseTracker();
    setTrackingStatus("Tracking active", true);
    setFeedback("Looking for your arm", "Keep your selected arm in view. The counter will wait until it recognizes a full curl.", "◎");
    animationFrame = requestAnimationFrame(trackFrame);
  } catch (error) {
    console.error(error);
    stopCamera(false);
    let message = "Couldn't start the camera. Check browser permissions and try again.";
    if (error?.name === "NotAllowedError") message = "Camera permission was blocked. Allow camera access in your browser settings, then try again.";
    else if (error?.name === "NotFoundError") message = "No camera was found on this device.";
    else if (error?.name === "NotReadableError") message = "The camera may already be in use by another app. Close it and try again.";
    notify(message);
    setFeedback("Camera unavailable", message, "!");
  } finally {
    startButton.disabled = false;
  }
}
function trackFrame() {
  if (!cameraStream || video.readyState < 2 || !poseLandmarker) {
    animationFrame = requestAnimationFrame(trackFrame);
    return;
  }
  setCanvasSize();
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      const result = poseLandmarker.detectForVideo(video, performance.now());
      const landmarks = result.landmarks?.[0];
      drawPose(landmarks);
      if (landmarks) {
        const isRight = armSelect.value === "right";
        const shoulder = landmarks[isRight ? 12 : 11];
        const elbow = landmarks[isRight ? 14 : 13];
        const wrist = landmarks[isRight ? 16 : 15];
        const visibility = Math.min(shoulder.visibility ?? 0, elbow.visibility ?? 0, wrist.visibility ?? 0);
        if (visibility > 0.4) {
          updateAngle(angleBetween(shoulder, elbow, wrist));
        } else {
          $("angleReadout").textContent = "Arm not clear";
          setFeedback("Move your arm into view", "Try turning sideways and making sure your shoulder, elbow, and wrist are visible.", "◎");
        }
      } else {
        $("angleReadout").textContent = "Looking for pose…";
        setFeedback("Looking for your arm", "Step back slightly and keep your upper body in the camera frame.", "◎");
      }
    } catch (error) {
      console.warn("Pose tracking frame skipped", error);
    }
  }
  animationFrame = requestAnimationFrame(trackFrame);
}
function stopCamera(showNotice = true) {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
  cameraStream = null;
  video.srcObject = null;
  stage.classList.remove("has-camera");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  stopButton.disabled = true;
  demoButton.disabled = false;
  setTrackingStatus("Camera off");
  $("angleReadout").textContent = "Elbow angle: --°";
  startButton.disabled = false;
  if (showNotice) notify("Camera stopped.");
}
function startDemo() {
  stopCamera(false);
  clearInterval(demoTimer);
  stage.classList.add("has-camera");
  video.style.display = "none";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Use a simple drawn arm so the demo can be explored without camera access.
  canvas.width = 800;
  canvas.height = 500;
  canvas.style.transform = "none";
  setTrackingStatus("Demo mode", true);
  stopButton.disabled = false;
  demoButton.disabled = true;
  startButton.disabled = true;
  $("cameraHelp").textContent = "Demo mode uses a simulated arm angle. It does not use the camera or represent real movement.";
  setFeedback("Demo mode active", "Watch the angle change and the counter complete a simulated curl.", "✦");
  beginSession();
  let tick = 0;
  demoTimer = window.setInterval(() => {
    tick += 1;
    const t = tick % 80;
    const angle = t < 35 ? 160 - (t / 35) * 115 : t < 45 ? 45 : 45 + ((t - 45) / 35) * 115;
    drawDemoArm(angle);
    updateAngle(angle);
    $("fpsReadout").textContent = "SIMULATED MOTION";
  }, 100);
  notify("Demo mode started");
}
function drawDemoArm(angle) {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  // Simple side-view arm illustration, intentionally labeled as simulated.
  const shoulder = { x: 300, y: 155 };
  const elbow = { x: 390, y: 280 };
  const radians = (angle * Math.PI) / 180;
  const length = 125;
  const wrist = { x: elbow.x + Math.sin(radians) * length, y: elbow.y + Math.cos(radians) * length };
  ctx.lineCap = "round";
  ctx.lineWidth = 26;
  ctx.strokeStyle = "#718096";
  ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(elbow.x, elbow.y); ctx.stroke();
  ctx.strokeStyle = "#b7f36b";
  ctx.beginPath(); ctx.moveTo(elbow.x, elbow.y); ctx.lineTo(wrist.x, wrist.y); ctx.stroke();
  for (const p of [shoulder, elbow, wrist]) {
    ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI*2); ctx.fillStyle = "#f5f7fb"; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = "#b7f36b"; ctx.stroke();
  }
  ctx.fillStyle = "#ffffff"; ctx.font = "600 20px DM Sans"; ctx.fillText("DEMO ARM", 35, 48);
  ctx.fillStyle = "#b7f36b"; ctx.font = "600 18px DM Sans"; ctx.fillText(Math.round(angle) + "°", 35, 78);
  $("angleReadout").textContent = "Elbow angle: " + Math.round(angle) + "°";
}
function stopDemo() {
  clearInterval(demoTimer);
  demoTimer = 0;
  stage.classList.remove("has-camera");
  video.style.display = "";
  canvas.style.transform = "";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setTrackingStatus("Camera off");
  stopButton.disabled = true;
  demoButton.disabled = false;
  startButton.disabled = false;
  $("angleReadout").textContent = "Elbow angle: --°";
}
function resetSession() {
  reps = 0;
  totalReps = 0;
  setsCompleted = 0;
  lastRepAt = 0;
  updateRepUI();
  setPhase("waiting");
  setFeedback("Get into position", "Extend your arm comfortably first. The counter waits for a full curl and return.", "↗");
  $("sessionTime").textContent = "00:00";
  hasStartedSession = false;
  sessionStartedAt = null;
  clearInterval(sessionClock);
  $("sessionStatus").textContent = "Session not started";
  notify("Session reset");
}
startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", () => {
  if (demoTimer) stopDemo();
  else stopCamera();
});
demoButton.addEventListener("click", startDemo);
armSelect.addEventListener("change", () => {
  setPhase("waiting");
  setFeedback("Arm selection changed", "Extend your selected arm comfortably to begin tracking a full curl.", "↗");
});
$("resetButton").addEventListener("click", resetSession);
$("undoRep").addEventListener("click", () => {
  if (reps > 0) { reps--; totalReps = Math.max(0, totalReps - 1); updateRepUI(); notify("Last rep removed"); }
  else notify("No reps to undo yet");
});
$("finishSet").addEventListener("click", () => {
  if (reps === 0) { notify("Complete a rep before finishing the set."); return; }
  setsCompleted += 1;
  reps = 0;
  updateRepUI();
  setPhase("waiting");
  notify("Set saved. Take a comfortable rest before the next one.");
  setFeedback("Set completed", "Nice work. Rest as needed, then start again from a comfortable arm-extended position.", "✓");
});
$("themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("light");
  $("themeToggle").textContent = document.body.classList.contains("light") ? "☾" : "☼";
});
window.addEventListener("beforeunload", () => {
  stopCamera(false);
  stopDemo();
  clearInterval(sessionClock);
});
updateRepUI();
setPhase("waiting");
