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
let restEndsAt = 0;
let angleHistory = [];
let curledAt = 0;
let elbowAnchor = null;
let formWarningShown = false;
let savedThisSession = false;
let selectedPersonIndex = null;
let lastPersonCount = 0;
const personSelect = document.getElementById("personSelect");
const personPickerWrap = document.getElementById("personPickerWrap");
const STORAGE_KEYS = { settings: "repcounter-settings-v2", history: "repcounter-history-v2", lifetime: "repcounter-lifetime-v2" };
const defaultSettings = { restSeconds: 60, sound: true, sensitivity: "standard", weeklySetGoal: 9 };
function loadStored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (!value) return JSON.parse(JSON.stringify(fallback));
    const parsed = JSON.parse(value);
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : JSON.parse(JSON.stringify(fallback));
    if (fallback && typeof fallback === "object") return { ...fallback, ...parsed };
    return parsed;
  } catch { return JSON.parse(JSON.stringify(fallback)); }
}
function saveStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { notify("Could not save to this browser. Check storage settings."); }
}
let settings = loadStored(STORAGE_KEYS.settings, defaultSettings);
let workoutHistory = loadStored(STORAGE_KEYS.history, []);
let lifetime = loadStored(STORAGE_KEYS.lifetime, { reps: 0, sets: 0 });
function playAlert(frequency = 740) {
  if (!settings.sound) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const audio = new AudioContextClass();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.start(); oscillator.stop(audio.currentTime + 0.2);
    oscillator.onended = () => audio.close();
  } catch {}
}

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
  if (sessionStartedAt) {
    const seconds = Math.floor((Date.now() - sessionStartedAt) / 1000);
    $("sessionTime").textContent = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  }
  if (restEndsAt) {
    const remaining = Math.max(0, Math.ceil((restEndsAt - Date.now()) / 1000));
    $("restCountdown").textContent = String(Math.floor(remaining / 60)).padStart(2, "0") + ":" + String(remaining % 60).padStart(2, "0");
    if (remaining <= 0) finishRest();
  }
}
function beginSession() {
  if (hasStartedSession) return;
  hasStartedSession = true;
  savedThisSession = false;
  sessionStartedAt = Date.now();
  $("sessionStatus").textContent = "Session in progress";
  sessionClock = window.setInterval(updateSessionTime, 1000);
}
function updateRepUI() {
  $("repCount").textContent = reps;
  $("totalReps").textContent = totalReps;
  $("setsCompleted").textContent = setsCompleted;
  $("progressText").textContent = reps + " / 12";
  $("progressBar").style.width = Math.min(100, (reps / 12) * 100) + "%";
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
function updateAngle(rawAngle, landmarks = null) {
  if (!Number.isFinite(rawAngle) || restEndsAt) return;
  angleHistory.push(rawAngle);
  if (angleHistory.length > 5) angleHistory.shift();
  const angle = angleHistory.reduce((sum, value) => sum + value, 0) / angleHistory.length;
  $("angleReadout").textContent = "Elbow angle: " + Math.round(angle) + "°";
  beginSession();
  const limits = settings.sensitivity === "strict" ? { extended: 150, curled: 55 } :
    settings.sensitivity === "gentle" ? { extended: 130, curled: 80 } : { extended: 140, curled: 70 };
  let elbowDrift = 0;
  if (landmarks) {
    const right = armSelect.value === "right";
    const shoulder = landmarks[right ? 12 : 11];
    const elbow = landmarks[right ? 14 : 13];
    if (shoulder && elbow) {
      const point = { x: elbow.x - shoulder.x, y: elbow.y - shoulder.y };
      if (elbowAnchor) elbowDrift = Math.hypot(point.x - elbowAnchor.x, point.y - elbowAnchor.y);
    }
  }
  if (angle >= limits.extended) {
    if (phase === "up" && curledAt && Date.now() - curledAt >= 120) {
      const now = Date.now();
      if (now - lastRepAt >= 900 && (!landmarks || elbowDrift < 0.16)) {
        reps += 1;
        totalReps += 1;
        lastRepAt = now;
        if (reps >= 12) {
          setsCompleted += 1;
          reps = 0;
          updateRepUI();
          notify("Set completed — 12 curls counted!");
          setFeedback("Set completed", "12 biceps curls completed. Your rest timer has started.", "✓");
          playAlert(880);
          startRestTimer();
          updateAchievements();
        } else {
          updateRepUI();
          notify("Rep " + reps + " of 12 counted");
          playAlert(660);
        }
      } else if (landmarks && elbowDrift >= 0.16) {
        setFeedback("Keep your elbow steadier", "Avoid swinging your upper arm or torso. This rep was not counted.", "↔");
      }
    }
    setPhase("down");
    curledAt = 0;
    elbowAnchor = null;
    formWarningShown = false;
    if (!restEndsAt) setFeedback("Arm extended", "Curl smoothly, keeping your upper arm close to your side.", "↓");
  } else if (angle <= limits.curled) {
    if (phase === "down") {
      setPhase("up");
      curledAt = Date.now();
      if (landmarks) {
        const right = armSelect.value === "right";
        const shoulder = landmarks[right ? 12 : 11];
        const elbow = landmarks[right ? 14 : 13];
        if (shoulder && elbow) elbowAnchor = { x: elbow.x - shoulder.x, y: elbow.y - shoulder.y };
      }
      setFeedback("Curl detected", "Pause briefly at the top, then lower the weight with control.", "↑");
    }
  } else if (phase === "waiting") {
    setFeedback("Get into position", "Start with your arm comfortably extended, then curl and return through a controlled range.", "↗");
  } else if (phase === "up" && angle > limits.curled + 18 && !formWarningShown) {
    formWarningShown = true;
    setFeedback("Lower with control", "Keep the movement smooth and avoid swinging your torso.", "↘");
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
      runningMode: "VIDEO", numPoses: 5,
      minPoseDetectionConfidence: 0.55, minPosePresenceConfidence: 0.55, minTrackingConfidence: 0.55
    });
  } catch (gpuError) {
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
      runningMode: "VIDEO", numPoses: 5,
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
function processArmLandmarks(landmarks) {
  const isRight = armSelect.value === "right";
  const shoulder = landmarks[isRight ? 12 : 11];
  const elbow = landmarks[isRight ? 14 : 13];
  const wrist = landmarks[isRight ? 16 : 15];
  const visibility = Math.min(shoulder?.visibility ?? 0, elbow?.visibility ?? 0, wrist?.visibility ?? 0);
  if (visibility > 0.4) {
    updateAngle(angleBetween(shoulder, elbow, wrist), landmarks);
    setTrackingStatus("Tracking active", true);
  } else {
    $("angleReadout").textContent = "Arm not clear";
    setFeedback("Move your arm into view", "Try turning sideways and making sure your shoulder, elbow, and wrist are visible.", "◎");
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
      const people = (result.landmarks || []).map((landmarks) => ({
        landmarks,
        x: ((landmarks[23]?.x ?? landmarks[11]?.x ?? 0.5) + (landmarks[24]?.x ?? landmarks[12]?.x ?? 0.5)) / 2
      })).sort((a, b) => a.x - b.x);

      if (people.length > 1) {
        if (people.length !== lastPersonCount) {
          lastPersonCount = people.length;
          selectedPersonIndex = null;
          personSelect.innerHTML = '<option value="">Choose a person…</option>';
          people.forEach((person, index) => {
            const option = document.createElement("option");
            option.value = String(index);
            option.textContent = `Person ${index + 1} — ${index === 0 ? "left" : index === people.length - 1 ? "right" : "middle"}`;
            personSelect.appendChild(option);
          });
          personSelect.value = "";
        }
        personPickerWrap.hidden = false;
        if (selectedPersonIndex === null || selectedPersonIndex >= people.length) {
          drawPose(null);
          $("angleReadout").textContent = `${people.length} people detected`;
          setTrackingStatus("Choose a person");
          setFeedback("Who should I track?", "Select the person doing the biceps curls from the person menu. Rep counting pauses until you choose.", "◎");
        } else {
          processArmLandmarks(people[selectedPersonIndex].landmarks);
          drawPose(people[selectedPersonIndex].landmarks);
        }
      } else if (people.length === 1) {
        lastPersonCount = 1;
        selectedPersonIndex = null;
        personPickerWrap.hidden = true;
        personSelect.innerHTML = '<option value="">Choose a person…</option>';
        drawPose(people[0].landmarks);
        processArmLandmarks(people[0].landmarks);
      } else {
        lastPersonCount = 0;
        selectedPersonIndex = null;
        personPickerWrap.hidden = true;
        drawPose(null);
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
function startRestTimer() {
  restEndsAt = Date.now() + settings.restSeconds * 1000;
  $("restPanel").hidden = false;
  $("restCountdown").textContent = String(Math.floor(settings.restSeconds / 60)).padStart(2, "0") + ":" + String(settings.restSeconds % 60).padStart(2, "0");
  $("restMessage").textContent = "Rest comfortably before your next set.";
  updateSessionTime();
}
function finishRest() {
  restEndsAt = 0;
  $("restPanel").hidden = true;
  $("restCountdown").textContent = "00:00";
  notify("Rest complete — ready when you are.");
  playAlert(820);
}
function skipRest() { if (restEndsAt) finishRest(); }
function renderHistory() {
  const list = $("historyList");
  if (!workoutHistory.length) {
    list.innerHTML = '<p class="helper-text">Your saved workouts will appear here.</p>';
    return;
  }
  list.innerHTML = workoutHistory.slice(0, 5).map(item => {
    const date = new Date(item.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    return '<div class="history-item"><div><strong>' + date + '</strong><small>' + item.duration + ' min · ' + item.sets + ' sets</small></div><span>' + item.reps + ' reps</span></div>';
  }).join("");
}
function saveWorkout() {
  if (totalReps === 0 && setsCompleted === 0) { notify("Complete some curls before saving a workout."); return; }
  if (savedThisSession) { notify("This workout is already saved."); return; }
  const seconds = sessionStartedAt ? Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000)) : 0;
  workoutHistory.unshift({ date: new Date().toISOString(), reps: totalReps, sets: setsCompleted, duration: Math.max(1, Math.round(seconds / 60)) });
  workoutHistory = workoutHistory.slice(0, 50);
  saveStored(STORAGE_KEYS.history, workoutHistory);
  lifetime.reps = (lifetime.reps || 0) + totalReps;
  lifetime.sets = (lifetime.sets || 0) + setsCompleted;
  saveStored(STORAGE_KEYS.lifetime, lifetime);
  savedThisSession = true;
  renderHistory();
  updateAchievements();
  notify("Workout saved on this device.");
  $("sessionStatus").textContent = "Workout saved";
}
function updateAchievements() {
  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const weeklySets = workoutHistory.filter(w => new Date(w.date) >= weekStart).reduce((sum, w) => sum + (w.sets || 0), 0);
  const achievements = [
    { name: "First curl", desc: "Count your first rep", unlocked: (lifetime.reps || 0) >= 1 },
    { name: "First full set", desc: "Complete 12 reps", unlocked: (lifetime.sets || 0) >= 1 },
    { name: "100 reps", desc: "Accumulate 100 reps", unlocked: (lifetime.reps || 0) >= 100 },
    { name: "5 workouts", desc: "Save five workouts", unlocked: workoutHistory.length >= 5 },
    { name: "Weekly goal", desc: weeklySets + " / " + settings.weeklySetGoal + " sets this week", unlocked: weeklySets >= settings.weeklySetGoal }
  ];
  $("achievementList").innerHTML = achievements.map(a => '<div class="achievement ' + (a.unlocked ? "unlocked" : "") + '"><span>' + (a.unlocked ? "✓" : "☆") + '</span><div><strong>' + a.name + '</strong><small>' + a.desc + '</small></div></div>').join("");
  $("weeklyProgress").textContent = weeklySets + " / " + settings.weeklySetGoal + " sets";
}
function applySettings() {
  $("restDuration").value = String(settings.restSeconds);
  $("soundToggle").checked = !!settings.sound;
  $("sensitivitySelect").value = settings.sensitivity;
  $("weeklySetGoal").value = settings.weeklySetGoal;
}
function resetSession() {
  if ((totalReps > 0 || setsCompleted > 0) && !savedThisSession) saveWorkout();
  reps = 0;
  totalReps = 0;
  setsCompleted = 0;
  lastRepAt = 0;
  angleHistory = [];
  curledAt = 0;
  elbowAnchor = null;
  if (restEndsAt) finishRest();
  updateRepUI();
  setPhase("waiting");
  setFeedback("Get into position", "Extend your arm comfortably first. The counter waits for a full curl and return.", "↗");
  $("sessionTime").textContent = "00:00";
  hasStartedSession = false;
  sessionStartedAt = null;
  clearInterval(sessionClock);
  $("sessionStatus").textContent = "Session not started";
  savedThisSession = false;
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
  setFeedback("Arm selection changed", "Extend your selected arm comfortably to begin tracking a full biceps curl.", "↗");
});
personSelect.addEventListener("change", () => {
  selectedPersonIndex = personSelect.value === "" ? null : Number(personSelect.value);
  setPhase("waiting");
  if (selectedPersonIndex === null) {
    setFeedback("Choose a person", "Rep counting stays paused until you choose who to track.", "◎");
  } else {
    setTrackingStatus("Tracking selected person", true);
    setFeedback("Person selected", "Only the selected person's arm will be used for rep counting.", "✓");
  }
});
$("resetButton").addEventListener("click", resetSession);
$("saveWorkout").addEventListener("click", saveWorkout);
$("skipRest").addEventListener("click", skipRest);
$("restDuration").addEventListener("change", () => { settings.restSeconds = Number($("restDuration").value); saveStored(STORAGE_KEYS.settings, settings); });
$("soundToggle").addEventListener("change", () => { settings.sound = $("soundToggle").checked; saveStored(STORAGE_KEYS.settings, settings); });
$("sensitivitySelect").addEventListener("change", () => {
  settings.sensitivity = $("sensitivitySelect").value;
  angleHistory = [];
  setPhase("waiting");
  saveStored(STORAGE_KEYS.settings, settings);
  notify("Curl detection settings updated.");
});
$("weeklySetGoal").addEventListener("change", () => {
  settings.weeklySetGoal = Math.max(1, Math.min(100, Number($("weeklySetGoal").value) || 9));
  $("weeklySetGoal").value = settings.weeklySetGoal;
  saveStored(STORAGE_KEYS.settings, settings);
  updateAchievements();
});
$("undoRep").addEventListener("click", () => {
  if (reps > 0) { reps--; totalReps = Math.max(0, totalReps - 1); updateRepUI(); notify("Last rep removed"); }
  else notify("No reps to undo yet");
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
applySettings();
renderHistory();
updateAchievements();
