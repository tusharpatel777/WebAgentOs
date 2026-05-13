// Background Service Worker — agent loop runs here, survives popup close.

const BRAIN_URL  = "https://tusharpatel-webagentos-brain.hf.space/plan";
const VERIFY_URL = "https://tusharpatel-webagentos-brain.hf.space/verify";
const COORDS_URL = "https://tusharpatel-webagentos-brain.hf.space/coordinates";
const MAX_STEPS  = 15;

let stopFlag = false;

// ── Dangerous action detection ────────────────────────────────────────────────
const DANGER_WORDS = ["pay now", "place order", "confirm order", "proceed to pay", "delete account", "remove account"];

function isDangerous(plan) {
  const text = `${plan.selector || ""} ${plan.value || ""} ${plan.reason || ""}`.toLowerCase();
  return DANGER_WORDS.some(w => text.includes(w));
}

function requestHumanApproval(plan) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "REQUEST_APPROVAL", plan });
    const handler = (msg) => {
      if (msg.type === "APPROVAL_RESULT") {
        chrome.runtime.onMessage.removeListener(handler);
        resolve(msg.approved);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    setTimeout(() => { chrome.runtime.onMessage.removeListener(handler); resolve(false); }, 30000);
  });
}

// ── Persistent log via chrome.storage ────────────────────────────────────────
function pushLog(msg, type = "info") {
  const entry = { msg, type, ts: Date.now() };
  chrome.storage.local.get(["agentLog"], (r) => {
    const log = (r.agentLog || []).slice(-49);
    log.push(entry);
    chrome.storage.local.set({ agentLog: log });
  });
  chrome.runtime.sendMessage({ type: "LOG", entry }).catch(() => {});
}

// ── Ask content.js for page context ──────────────────────────────────────────
function getContext(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "GET_CONTEXT" }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp?.ok) return reject(new Error(resp?.msg || "dom_parser not ready"));
      resolve(resp.data);
    });
  });
}

// ── Strategy 4: DOM Pruning — top 25 elements + 400-char body excerpt ─────────
function buildContext(data) {
  const MAX_ELEMENTS   = 25;
  const MAX_BODY_CHARS = 400;
  const elements = data.elements.slice(0, MAX_ELEMENTS);
  const lines    = elements.map(e => {
    const sel = e.css || `xpath:${e.xpath}`;
    return `[${e.idx}] ${e.tag}${e.type ? `[${e.type}]` : ""} sel="${sel}" label="${e.label}"`;
  }).join("\n");
  const bodyText = (data.bodyText || "").slice(0, MAX_BODY_CHARS);
  return `URL: ${data.url}\nTitle: ${data.title}\n\nElements (top ${elements.length}):\n${lines}\n\nPage Text:\n${bodyText}`;
}

// ── Execute action via content.js ─────────────────────────────────────────────
function executeAction(tabId, plan) {
  let css = null, xpath = null;
  const sel = plan.selector || "";
  if (sel.startsWith("xpath:")) xpath = sel.slice(6);
  else if (sel) css = sel;

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_ACTION",
      payload: { action: plan.action, css, xpath, value: plan.value || "" },
    }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(resp);
    });
  });
}

// ── Screenshot + Gemini verify ────────────────────────────────────────────────
async function verifyStep(goal, plan) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
    const b64 = dataUrl.split(",")[1];
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screenshot: b64, goal, last_action: plan }),
      signal: AbortSignal.timeout(20000),
    });
    return await res.json();
  } catch {
    return { action_ok: true, goal_done: false, observation: "verify skipped" };
  }
}

// ── Main autonomous loop ──────────────────────────────────────────────────────
async function runAgentLoop(goal, tabId) {
  stopFlag = false;
  chrome.storage.local.set({ agentRunning: true, agentLog: [] });
  pushLog(`Goal: ${goal}`, "info");

  const history = [];
  let lastObservation = null;
  let stepQueue = [];    // Strategy 1: Action Chunking — Brain returns 2-3 steps at once

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (stopFlag) { pushLog("Stopped by user.", "error"); break; }

    // 1. Eyes — always read fresh page state
    pushLog(`Step ${step}: Reading page…`, "info");
    let pageData;
    try {
      pageData = await getContext(tabId);
    } catch (e) {
      pushLog(`Cannot read page: ${e.message}`, "error");
      break;
    }

    // 2. Brain — Strategy 1: skip API call when queue has pending steps
    let plan;
    if (stepQueue.length > 0) {
      plan = stepQueue.shift();
      pushLog(`Queued step (${stepQueue.length} remaining in batch)…`, "info");
    } else {
      pushLog("Asking Brain…", "info");
      try {
        const res = await fetch(BRAIN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            goal,
            context: buildContext(pageData),
            history,
            last_observation: lastObservation,
          }),
          signal: AbortSignal.timeout(30000),
        });
        const brainData = await res.json();

        if (brainData.error) { pushLog(`Brain: ${brainData.error}`, "error"); break; }

        // Support both {steps:[...]} (v3) and {action:...} (v2) response formats
        const steps = brainData.steps || [brainData];

        if (brainData.cache_hit) pushLog(`Cache hit! Reusing ${steps.length} cached step(s).`, "info");
        else                     pushLog(`Brain: ${steps.length} step(s) planned.`, "info");

        plan      = steps[0];
        stepQueue = steps.slice(1);
      } catch (e) {
        pushLog(`Brain error: ${e.message}`, "error");
        break;
      }
    }

    if (plan.error) { pushLog(`Brain: ${plan.error}`, "error"); break; }
    pushLog(`→ ${plan.action.toUpperCase()}: ${plan.selector || plan.value || ""} — ${plan.reason}`, "action");

    if (plan.action === "done") { pushLog("✓ Goal achieved!", "done"); stepQueue = []; break; }
    if (plan.action === "fail") { pushLog(`✗ ${plan.reason}`, "error"); stepQueue = []; break; }

    // 3a. Human-in-the-loop: approval for dangerous actions
    if (isDangerous(plan)) {
      pushLog(`⚠ Waiting for your approval…`, "warning");
      const approved = await requestHumanApproval(plan);
      if (!approved) { pushLog("Action blocked by user.", "error"); stepQueue = []; break; }
      pushLog("Approved. Executing…", "info");
    }

    // 3b. Hands — execute (multi-layer retry in content.js)
    let actionOk = false;

    try {
      const result = await executeAction(tabId, plan);
      if (result?.ok) {
        actionOk = true;
      } else {
        pushLog(`DOM click failed: ${result?.msg} — trying Vision…`, "warning");
      }
    } catch (e) {
      pushLog(`Execute error: ${e.message} — trying Vision…`, "warning");
    }

    // Vision fallback: Gemini finds pixel coordinates
    if (!actionOk && plan.action === "click") {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
        const b64    = dataUrl.split(",")[1];
        const target = plan.reason || plan.selector || "the target button";

        pushLog(`Vision fallback: asking Gemini for "${target}"…`, "info");
        const res = await fetch(COORDS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ screenshot: b64, target }),
          signal: AbortSignal.timeout(20000),
        });
        const coords = await res.json();

        if (coords.x && coords.y) {
          pushLog(`Gemini found (${coords.x}, ${coords.y}) — clicking…`, "action");
          const r2 = await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, { type: "CLICK_AT_XY", payload: { x: coords.x, y: coords.y } }, resp => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              resolve(resp);
            });
          });
          if (r2?.ok) actionOk = true;
          else pushLog(`Coordinate click failed: ${r2?.msg}`, "error");
        } else {
          pushLog(`Gemini could not locate element on screen`, "error");
        }
      } catch (e) {
        pushLog(`Vision fallback error: ${e.message}`, "error");
      }
    }

    if (!actionOk) {
      pushLog("All click strategies failed. Stopping.", "error");
      stepQueue = [];
      break;
    }

    history.push({ step, action: plan.action, selector: plan.selector, value: plan.value });

    await new Promise(r => setTimeout(r, 1800));

    // 4. Vision verify — Gemini checks if action worked
    pushLog("Verifying with Gemini…", "info");
    const verify = await verifyStep(goal, plan);

    if (verify.goal_done) {
      pushLog(`Gemini: ${verify.observation}`, "done");
      pushLog("✓ Gemini confirmed: Goal achieved!", "done");
      stepQueue = [];
      break;
    }

    if (!verify.action_ok) {
      // Self-heal: clear queue so Brain re-plans from fresh page state
      stepQueue       = [];
      lastObservation = `FAILED: ${verify.observation}. Try a completely different approach or selector.`;
      pushLog(`⚠ Self-healing: ${verify.observation}`, "error");
    } else {
      lastObservation = `OK: ${verify.observation}`;
      pushLog(`Gemini: ${verify.observation}`, "info");
    }
  }

  chrome.storage.local.set({ agentRunning: false });
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_AGENT") {
    runAgentLoop(msg.goal, msg.tabId);
    sendResponse({ ok: true });
  }
  if (msg.type === "STOP_AGENT") {
    stopFlag = true;
    chrome.storage.local.set({ agentRunning: false });
    sendResponse({ ok: true });
  }
  if (msg.type === "GET_STATE") {
    chrome.storage.local.get(["agentRunning", "agentLog"], sendResponse);
    return true;
  }
  return true;
});
