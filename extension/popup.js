const BRAIN_URL = "https://tusharpatel-webagentos-brain.hf.space/plan";

const runBtn    = document.getElementById("runBtn");
const stopBtn   = document.getElementById("stopBtn");
const logEl     = document.getElementById("log");
const statusDot = document.getElementById("status-dot");

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

// ── Restore log when popup reopens (agent may still be running) ───────────────
async function restoreState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (!state) return;
    if (state.agentRunning) setRunning(true);
    (state.agentLog || []).forEach(renderEntry);
  });
}

// ── Live log from background ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "LOG") renderEntry(msg.entry);
  if (msg.type === "AGENT_DONE") setRunning(false);
});

// ── Start agent ───────────────────────────────────────────────────────────────
async function startAgent() {
  const goal = document.getElementById("goalInput").value.trim();
  if (!goal) { return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("about:")) {
    clearLog();
    const e = document.createElement("div");
    e.className = "log-entry error";
    e.textContent = "Open a real website first (e.g. google.com), then try again.";
    logEl.appendChild(e);
    return;
  }

  clearLog();
  setRunning(true);

  // Hand off loop to background service worker
  chrome.runtime.sendMessage({ type: "START_AGENT", goal, tabId: tab.id });
}

// ── Stop agent ────────────────────────────────────────────────────────────────
function stopAgent() {
  chrome.runtime.sendMessage({ type: "STOP_AGENT" });
  setRunning(false);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
runBtn.addEventListener("click", startAgent);
stopBtn.addEventListener("click", stopAgent);
restoreState();
checkBrain();
