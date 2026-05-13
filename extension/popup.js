// Brain base URL is configurable via WAOConfig (config.js)

// Critical actions that need human approval before executing
const DANGEROUS_LABELS = ["buy", "pay", "checkout", "order", "purchase", "delete", "remove", "submit", "confirm", "place order"];

const memoryBtn      = document.getElementById("memoryBtn");
const settingsBtn    = document.getElementById("settingsBtn");
const memoryPanel    = document.getElementById("memoryPanel");
const settingsPanel  = document.getElementById("settingsPanel");
const memoryList     = document.getElementById("memoryList");
const clearMemoryBtn = document.getElementById("clearMemoryBtn");
const brainUrlInput     = document.getElementById("brainUrlInput");
const saveSettingsBtn   = document.getElementById("saveSettingsBtn");
const resetSettingsBtn  = document.getElementById("resetSettingsBtn");
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
    const ep = await window.WAOConfig.getEndpoints();
    const res = await fetch(`${ep.base}/`, { signal: AbortSignal.timeout(4000) });
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

  async function ensureMicPermission() {
    // Some Chrome builds require explicit mic grant for extension pages.
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch (e) {
      // Surface a helpful error; SpeechRecognition will likely fail with "not-allowed".
      renderEntry({ msg: `Microphone permission error: ${e.message || e.name || e}`, type: "error" });
      throw e;
    }
  }

  voiceBtn.addEventListener("click", () => {
    if (voiceBtn.classList.contains("listening")) {
      recognition.stop();
      return;
    }

    // Prefer running SpeechRecognition in the active TAB context.
    // Many Chrome setups block mic access from extension pages (side panel),
    // but allow it from normal web pages.
    startVoiceInActiveTab().catch(() => {});
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
    const extra = e?.message ? ` (${e.message})` : "";
    renderEntry({ msg: `Voice error: ${e.error}${extra}`, type: "error" });
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      renderEntry({ msg: "Tip: allow microphone access for this extension (Chrome Site settings → Microphone).", type: "info" });
    }
  };

  recognition.onend = () => {
    voiceBtn.classList.remove("listening");
  };

  async function startVoiceInActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      renderEntry({ msg: "No active tab found for voice.", type: "error" });
      return;
    }

    voiceBtn.classList.add("listening");
    speak("Listening");
    renderEntry({ msg: "🎤 Listening in the active tab…", type: "voice" });

    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "VOICE_IN_TAB", tabId: tab.id }, resolve);
    });

    voiceBtn.classList.remove("listening");

    if (!resp?.ok) {
      renderEntry({ msg: `Voice error: ${resp?.error || "unknown"}`, type: "error" });
      if (resp?.error === "not_supported") {
        renderEntry({ msg: "SpeechRecognition not available on this page/browser.", type: "info" });
      }
      if (resp?.error === "not-allowed" || resp?.error === "service-not-allowed") {
        renderEntry({ msg: "Allow microphone for the website (Chrome address bar mic icon / Site settings).", type: "info" });
      }
      return;
    }

    const transcript = (resp.transcript || "").trim();
    if (!transcript) {
      renderEntry({ msg: "Heard nothing. Try again.", type: "warning" });
      return;
    }

    document.getElementById("goalInput").value = transcript;
    renderEntry({ msg: `🎤 Voice: "${transcript}"`, type: "voice" });
    speak(`Got it. Starting: ${transcript}`);
    startAgent();
  }
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

// ── Phase 5: Memory Panel ─────────────────────────────────────────────────────
function getUserId() {
  return new Promise(resolve => {
    chrome.storage.sync.get(["userId"], (r) => {
      if (r.userId) return resolve(r.userId);
      const id = crypto.randomUUID();
      chrome.storage.sync.set({ userId: id });
      resolve(id);
    });
  });
}

async function loadMemory() {
  try {
    const facts = await new Promise((resolve) => {
      chrome.storage.sync.get(["userMemoryFacts"], (r) => resolve(r.userMemoryFacts || []));
    });
    memoryList.innerHTML = "";
    if (facts.length === 0) {
      memoryList.innerHTML = "<li class='mem-hint'>No preferences saved yet.</li>";
    } else {
      facts.forEach(f => {
        const li = document.createElement("li");
        li.textContent = f;
        memoryList.appendChild(li);
      });
    }
  } catch {
    memoryList.innerHTML = "<li class='mem-hint'>Could not load memory.</li>";
  }
}

memoryBtn.addEventListener("click", () => {
  const isHidden = memoryPanel.classList.toggle("hidden");
  if (!memoryPanel.classList.contains("hidden")) settingsPanel.classList.add("hidden");
  if (!isHidden) loadMemory();
});

clearMemoryBtn.addEventListener("click", async () => {
  chrome.storage.sync.set({ userMemoryFacts: [] });
  memoryList.innerHTML = "<li class='mem-hint'>Memory cleared.</li>";
});

async function loadSettings() {
  const base = await window.WAOConfig.getBrainBaseUrl();
  if (brainUrlInput) brainUrlInput.value = base;
}

settingsBtn?.addEventListener("click", async () => {
  const isHidden = settingsPanel.classList.toggle("hidden");
  // Only show one panel at a time
  if (!settingsPanel.classList.contains("hidden")) memoryPanel.classList.add("hidden");
  if (!isHidden) await loadSettings();
});

saveSettingsBtn?.addEventListener("click", async () => {
  await window.WAOConfig.setBrainBaseUrl(brainUrlInput?.value || "");
  renderEntry({ msg: "Settings saved. Reload the extension to apply everywhere.", type: "info" });
  checkBrain();
});

resetSettingsBtn?.addEventListener("click", async () => {
  await window.WAOConfig.setBrainBaseUrl(window.WAOConfig.DEFAULT_BASE);
  await loadSettings();
  renderEntry({ msg: "Brain URL reset to default.", type: "info" });
  checkBrain();
});

// Refresh memory panel when background extracts new facts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "MEMORY_UPDATED" && !memoryPanel.classList.contains("hidden")) {
    loadMemory();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
runBtn.addEventListener("click", startAgent);
stopBtn.addEventListener("click", stopAgent);
setupVoice();
restoreState();
checkBrain();
