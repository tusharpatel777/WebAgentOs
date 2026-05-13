// Background Service Worker — agent loop runs here, survives popup close.

importScripts("config.js");

let _endpointsCache = null;
async function getEndpoints() {
  if (_endpointsCache) return _endpointsCache;
  _endpointsCache = await self.WAOConfig.getEndpoints();
  return _endpointsCache;
}
chrome.storage.sync.onChanged.addListener((changes) => {
  if (changes.brainBaseUrl) _endpointsCache = null;
});

const MAX_STEPS   = 15;

// Phase 5: Persistent user ID — generated once, stored forever in sync storage
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

function getUserMemoryFacts() {
  return new Promise(resolve => {
    chrome.storage.sync.get(["userMemoryFacts"], (r) => resolve(r.userMemoryFacts || []));
  });
}

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

// ── Wait for tab to finish loading before reading page ────────────────────────
function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === "complete") return resolve();

      const timer = setTimeout(resolve, timeout);

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 600); // extra settle for JS/React render
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ── Click, detect if new tab opened, switch to it, wait for load ──────────────
// Flipkart/Amazon links open in new tab (target="_blank") — agent MUST follow them
async function clickAndFollowTab(tabId, plan) {
  let newTabId = null;

  const tabCreatedListener = (tab) => {
    // Accept tab opened by any page (opener may differ due to target=_blank)
    newTabId = tab.id;
  };
  chrome.tabs.onCreated.addListener(tabCreatedListener);

  // Execute the click
  let actionOk = false;
  try {
    const result = await executeAction(tabId, plan);
    actionOk = !!result?.ok;
  } catch (_) {}

  // Wait up to 1.5s to see if a new tab appears
  await new Promise(r => setTimeout(r, 1500));
  chrome.tabs.onCreated.removeListener(tabCreatedListener);

  if (newTabId) {
    // Switch focus to the new tab, then wait for it to fully load
    pushLog(`New tab detected — switching to tab ${newTabId}…`, "info");
    await chrome.tabs.update(newTabId, { active: true });
    await waitForTabLoad(newTabId);
    return { actionOk: true, tabId: newTabId };
  }

  // No new tab — wait for current tab to finish loading
  await waitForTabLoad(tabId);
  return { actionOk, tabId };
}

// ── getContext with retry (page may still be injecting content script) ─────────
async function getContextWithRetry(tabId, retries = 3, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await getContext(tabId);
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw e;
      }
    }
  }
}

// ── Screenshot + Gemini verify ────────────────────────────────────────────────
async function verifyStep(goal, plan) {
  try {
    const ep = await getEndpoints();
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
    const b64 = dataUrl.split(",")[1];
    const res = await fetch(ep.verify, {
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

// ── Phase 5: Memory extraction — fire-and-forget after task done ──────────────
function _extractMemory(userId, goal, history) {
  getEndpoints().then((ep) => fetch(`${ep.memory}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Local-first memory: backend extracts facts, extension stores them in chrome.storage.
    body: JSON.stringify({ goal, history }),
  }))
  .then(r => r.json())
  .then(data => {
    const facts = data.facts || [];
    if (!facts.length) return;

    chrome.storage.sync.get(["userMemoryFacts"], (r) => {
      const existing = Array.isArray(r.userMemoryFacts) ? r.userMemoryFacts : [];
      const merged = [...existing];
      for (const f of facts) {
        if (f && !merged.includes(f)) merged.push(f);
      }
      chrome.storage.sync.set({ userMemoryFacts: merged.slice(-20) }, () => {
        pushLog(`🧠 Remembered ${facts.length} preference(s) locally.`, "info");
        chrome.runtime.sendMessage({ type: "MEMORY_UPDATED" }).catch(() => {});
      });
    });
  })
  .catch(() => {});
}

// ── Main autonomous loop ──────────────────────────────────────────────────────
async function runAgentLoop(goal, tabId) {
  stopFlag = false;
  chrome.storage.local.set({ agentRunning: true, agentLog: [] });
  pushLog(`Goal: ${goal}`, "info");

  const userId  = await getUserId();
  const history = [];
  let lastObservation = null;
  let stepQueue = [];    // Strategy 1: Action Chunking — Brain returns 2-3 steps at once

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (stopFlag) { pushLog("Stopped by user.", "error"); break; }

    // 1. Eyes — always read fresh page state
    pushLog(`Step ${step}: Reading page…`, "info");
    let pageData;
    try {
      pageData = await getContextWithRetry(tabId);
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
        const ep = await getEndpoints();
        const res = await fetch(ep.plan, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            goal,
            context: buildContext(pageData),
            history,
            last_observation: lastObservation,
            user_id: userId,
            user_memory: await getUserMemoryFacts(),
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

    if (plan.action === "done") {
      pushLog("✓ Goal achieved!", "done");
      stepQueue = [];
      _extractMemory(userId, goal, history);
      break;
    }
    if (plan.action === "fail") { pushLog(`✗ ${plan.reason}`, "error"); stepQueue = []; break; }

    // 3a. Human-in-the-loop: approval for dangerous actions
    if (isDangerous(plan)) {
      pushLog(`⚠ Waiting for your approval…`, "warning");
      const approved = await requestHumanApproval(plan);
      if (!approved) { pushLog("Action blocked by user.", "error"); stepQueue = []; break; }
      pushLog("Approved. Executing…", "info");
    }

    // 3b. Hands — click/navigate uses clickAndFollowTab (auto-detects new tabs)
    let actionOk = false;

    if (plan.action === "click" || plan.action === "navigate") {
      pushLog("Executing — watching for new tab…", "info");
      const result = await clickAndFollowTab(tabId, plan);
      actionOk = result.actionOk;
      if (result.tabId !== tabId) {
        tabId = result.tabId; // follow into the new tab
        stepQueue = [];       // clear queue — new page, re-plan needed
      }
    } else {
      // type / scroll — no navigation expected
      try {
        const result = await executeAction(tabId, plan);
        if (result?.ok) {
          actionOk = true;
        } else {
          pushLog(`Action failed: ${result?.msg}`, "warning");
        }
      } catch (e) {
        pushLog(`Execute error: ${e.message}`, "warning");
      }
      await new Promise(r => setTimeout(r, 800));
    }

    // Vision fallback: Gemini finds pixel coordinates (only for click failures)
    if (!actionOk && plan.action === "click") {
      try {
        const ep = await getEndpoints();
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
        const b64    = dataUrl.split(",")[1];
        const target = plan.reason || plan.selector || "the target button";

        pushLog(`Vision fallback: asking Gemini for "${target}"…`, "info");
        const res = await fetch(ep.coords, {
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

    // 4. Vision verify — skip for navigate/scroll (no visual check needed, saves Gemini quota)
    if (plan.action === "navigate" || plan.action === "scroll") {
      lastObservation = null;
      continue;
    }
    pushLog("Verifying with Gemini…", "info");
    const verify = await verifyStep(goal, plan);

    if (verify.goal_done) {
      pushLog(`Gemini: ${verify.observation}`, "done");
      pushLog("✓ Gemini confirmed: Goal achieved!", "done");
      stepQueue = [];
      _extractMemory(userId, goal, history);
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

// ── Side Panel: open on icon click instead of popup ──────────────────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

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
  if (msg.type === "VOICE_IN_TAB") {
    const tabId = msg.tabId || sender?.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: "no_tab" }); return; }

    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        return new Promise((resolve) => {
          if (!SpeechRecognition) return resolve({ ok: false, error: "not_supported" });

          const recognition = new SpeechRecognition();
          recognition.lang = "en-US";
          recognition.continuous = false;
          recognition.interimResults = false;

          const timer = setTimeout(() => {
            try { recognition.stop(); } catch {}
            resolve({ ok: false, error: "timeout" });
          }, 12000);

          recognition.onresult = (e) => {
            clearTimeout(timer);
            const transcript = e?.results?.[0]?.[0]?.transcript || "";
            resolve({ ok: true, transcript });
          };
          recognition.onerror = (e) => {
            clearTimeout(timer);
            resolve({ ok: false, error: e?.error || "error" });
          };
          recognition.onend = () => {
            // If ended without result/error, treat as cancelled.
            // (Some browsers end immediately if permission blocked.)
          };

          try {
            recognition.start();
          } catch (e) {
            clearTimeout(timer);
            resolve({ ok: false, error: e?.message || "start_failed" });
          }
        });
      },
    }, (results) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      const r = results?.[0]?.result;
      sendResponse(r || { ok: false, error: "no_result" });
    });
    return true;
  }
  if (msg.type === "GET_STATE") {
    chrome.storage.local.get(["agentRunning", "agentLog"], sendResponse);
    return true;
  }
  return true;
});
