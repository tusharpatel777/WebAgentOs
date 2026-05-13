const BRAIN_URL = "https://tusharpatel-webagentos-brain.hf.space/plan";

// Critical actions that need human approval before executing
const DANGEROUS_LABELS = ["buy", "pay", "checkout", "order", "purchase", "delete", "remove", "submit", "confirm", "place order"];

const runBtn      = document.getElementById("runBtn");
const stopBtn     = document.getElementById("stopBtn");
const voiceBtn    = document.getElementById("voiceBtn");
const logEl       = document.getElementById("log");
const statusDot   = document.getElementById("status-dot");
const approvalBox = document.getElementById("approvalBox");
const approvalMsg = document.getElementById("approvalMsg");
const approveBtn  = document.getElementById("approveBtn");
const denyBtn     = document.getElementById("denyBtn");

// ── TTS: AI speaks its status ─────────────────────────────────────────────────
function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang  = "en-US";
  u.rate  = 1.1;
  window.speechSynthesis.speak(u);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function clearLog() { logEl.innerHTML = ""; }

function renderEntry(entry) {
  const el = document.createElement("div");
  el.className = `log-entry ${entry.type}`;
  el.textContent = entry.msg;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function setRunning(running) {
  runBtn.disabled  = running;
  stopBtn.disabled = !running;
}

// ── Brain health check ────────────────────────────────────────────────────────
async function checkBrain() {
  statusDot.className = "dot checking";
  try {
    const res = await fetch(BRAIN_URL.replace("/plan", "/"), { signal: AbortSignal.timeout(4000) });
    statusDot.className = res.ok ? "dot online" : "dot offline";
  } catch {
    statusDot.className = "dot offline";
  }
}

// ── Human-in-the-loop: pause for approval on critical actions ─────────────────
function needsApproval(plan) {
  const text = `${plan.selector || ""} ${plan.value || ""} ${plan.reason || ""}`.toLowerCase();
  return DANGEROUS_LABELS.some(w => text.includes(w));
}

function requestApproval(plan) {
  return new Promise((resolve) => {
    approvalMsg.textContent = `⚠ AI wants to: ${plan.action.toUpperCase()} — "${plan.selector || plan.value}"\nReason: ${plan.reason}`;
    approvalBox.classList.remove("hidden");
    speak(`Caution. Agent wants to ${plan.action} on ${plan.reason}. Please approve or block.`);

    approveBtn.onclick = () => { approvalBox.classList.add("hidden"); resolve(true); };
    denyBtn.onclick    = () => { approvalBox.classList.add("hidden"); resolve(false); };
  });
}

// ── Voice input (Web Speech API — no API key needed) ─────────────────────────
function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    voiceBtn.title = "Voice not supported in this browser";
    voiceBtn.style.opacity = "0.3";
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = false;
  recognition.interimResults = false;

  voiceBtn.addEventListener("click", () => {
    if (voiceBtn.classList.contains("listening")) {
      recognition.stop();
      return;
    }
    recognition.start();
    voiceBtn.classList.add("listening");
    speak("Listening");
  });

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    document.getElementById("goalInput").value = transcript;
    voiceBtn.classList.remove("listening");

    renderEntry({ msg: `🎤 Voice: "${transcript}"`, type: "voice" });
    speak(`Got it. Starting: ${transcript}`);

    // Auto-start agent after voice input
    startAgent();
  };

  recognition.onerror = (e) => {
    voiceBtn.classList.remove("listening");
    renderEntry({ msg: `Voice error: ${e.error}`, type: "error" });
  };

  recognition.onend = () => {
    voiceBtn.classList.remove("listening");
  };
}

// ── Restore log when popup reopens ────────────────────────────────────────────
function restoreState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (!state) return;
    if (state.agentRunning) setRunning(true);
    (state.agentLog || []).forEach(renderEntry);
  });
}

// ── Live log from background ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "LOG") {
    renderEntry(msg.entry);
    // Speak key events aloud
    if (msg.entry.type === "done")   speak(msg.entry.msg);
    if (msg.entry.type === "error")  speak("Error: " + msg.entry.msg);
    if (msg.entry.type === "action") speak(msg.entry.msg.replace("→ ", ""));
  }
  if (msg.type === "AGENT_DONE") setRunning(false);

  // Human-in-the-loop: background asks popup to confirm
  if (msg.type === "REQUEST_APPROVAL") {
    requestApproval(msg.plan).then(approved => {
      chrome.runtime.sendMessage({ type: "APPROVAL_RESULT", approved });
    });
  }
});

// ── Start agent ───────────────────────────────────────────────────────────────
async function startAgent() {
  const goal = document.getElementById("goalInput").value.trim();
  if (!goal) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("about:")) {
    clearLog();
    renderEntry({ msg: "Open a real website first, then try again.", type: "error" });
    return;
  }

  clearLog();
  setRunning(true);
  speak(`Starting agent. Goal: ${goal}`);
  chrome.runtime.sendMessage({ type: "START_AGENT", goal, tabId: tab.id });
}

// ── Stop agent ────────────────────────────────────────────────────────────────
function stopAgent() {
  chrome.runtime.sendMessage({ type: "STOP_AGENT" });
  setRunning(false);
  speak("Agent stopped.");
}

// ── Boot ──────────────────────────────────────────────────────────────────────
runBtn.addEventListener("click", startAgent);
stopBtn.addEventListener("click", stopAgent);
setupVoice();
restoreState();
checkBrain();
