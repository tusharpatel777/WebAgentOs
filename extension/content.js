// Content script — The Hands of WebAgentOS.
// Multi-layer click strategy:
//   L1: CSS selector
//   L2: XPath
//   L3: Attribute/text match on interactive elements
//   L4: Full-page text scan + cursor:pointer ancestor walk
//   L5: Coordinate click (Gemini Vision tells x,y → elementFromPoint)

// ── Element finders ───────────────────────────────────────────────────────────
function findElement(css, xpath) {
  // L1: CSS
  if (css) {
    try { const el = document.querySelector(css); if (el) return el; } catch (_) {}
  }
  // L2: XPath
  if (xpath) {
    try {
      const res = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (res.singleNodeValue) return res.singleNodeValue;
    } catch (_) {}
  }
  // L3: Aria/text on standard interactive elements
  const hint = (css || xpath || "").replace(/^xpath:/, "").replace(/#|\.|\[.*?\]/g, " ").trim();
  if (hint) {
    for (const el of document.querySelectorAll("button, a, input, [role=button], [role=link]")) {
      const label = (
        el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
        el.getAttribute("title")      || el.textContent.trim()
      ).toLowerCase();
      if (label.includes(hint.toLowerCase())) return el;
    }
  }
  // L4: Full-page text scan — catches Flipkart/Amazon div-buttons
  const searchText = hint || (xpath || "").split("/").pop().replace(/\[.*\]/, "");
  if (searchText.length > 2) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const text = el.textContent.trim().toLowerCase();
      if (text === searchText.toLowerCase() || text.startsWith(searchText.toLowerCase())) {
        const style = window.getComputedStyle(el);
        if (style.display !== "none" && style.visibility !== "hidden")
          return findClickableAncestor(el);
      }
    }
  }
  return null;
}

// Walk up to nearest cursor:pointer ancestor — real Flipkart click target
function findClickableAncestor(el) {
  let node = el;
  for (let i = 0; i < 8 && node && node !== document.body; i++) {
    const style = window.getComputedStyle(node);
    if (
      style.cursor === "pointer"            ||
      node.onclick                           ||
      node.hasAttribute("onclick")           ||
      node.getAttribute("role") === "button" ||
      node.tagName === "BUTTON"              ||
      node.tagName === "A"
    ) return node;
    node = node.parentElement;
  }
  return el;
}

// Smart text search across ALL elements (button/div/span) — last DOM resort
function smartFindByText(text) {
  const lower = text.toLowerCase();
  let best = null;
  const all = document.querySelectorAll("button, a, div, span, li");
  for (const el of all) {
    const t = el.innerText?.trim().toLowerCase();
    if (!t) continue;
    if (t === lower || t.startsWith(lower)) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Prefer smaller (more specific) element
      if (!best || rect.width * rect.height < best._area) {
        el._area = rect.width * rect.height;
        best = el;
      }
    }
  }
  return best ? findClickableAncestor(best) : null;
}

// Human-like click with MouseEvent
function humanClick(el) {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top  + rect.height / 2;
  ["mouseover","mousedown","mouseup","click"].forEach(type => {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy
    }));
  });
}

async function waitForElement(css, xpath, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const el = findElement(css, xpath);
    if (el) return el;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

// ── Action handler ────────────────────────────────────────────────────────────
async function handleAction(payload) {
  const { action, css, xpath, value } = payload;
  try {
    switch (action) {

      case "click": {
        let el = await waitForElement(css, xpath);
        // Extra fallback: smartFindByText using the label hint
        if (!el) {
          const hint = (css || xpath || "").replace(/^xpath:/, "").split('"')[1] || "";
          if (hint) el = smartFindByText(hint);
        }
        if (!el) return { ok: false, msg: `Element not found — css:${css}` };
        humanClick(el);
        return { ok: true };
      }

      case "type": {
        let el = await waitForElement(css, xpath);
        if (!el) {
          for (const sel of ['input[type="search"]','input[type="text"]','input[name="q"]','input[placeholder]','textarea']) {
            const found = document.querySelector(sel);
            if (found) { el = found; break; }
          }
        }
        if (!el) return { ok: false, msg: `Input not found — css:${css}` };
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus();
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.value = (value || "").replace(/\\n$/, "");
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));

        // Auto-press Enter for search inputs (dismiss dropdown, trigger search)
        const isSearchInput = el.type === "search" ||
          (el.getAttribute("placeholder") || "").toLowerCase().includes("search") ||
          (el.getAttribute("aria-label")  || "").toLowerCase().includes("search") ||
          !!el.closest("form");

        if (isSearchInput || (value || "").endsWith("\n")) {
          await new Promise(r => setTimeout(r, 400)); // let autocomplete settle
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", keyCode: 13, bubbles: true }));
          // Also try submitting the parent form directly
          const form = el.closest("form");
          if (form) form.submit();
        }
        return { ok: true };
      }

      case "scroll": {
        window.scrollBy({ top: value === "up" ? -600 : 600, behavior: "smooth" });
        return { ok: true };
      }

      case "navigate": {
        location.href = value;
        return { ok: true };
      }

      default:
        return { ok: false, msg: `Unknown action: ${action}` };
    }
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// ── L5: Coordinate click (Gemini Vision → x,y → elementFromPoint) ─────────────
function clickAtXY(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { ok: false, msg: `No element at (${x}, ${y})` };
  humanClick(el);
  return { ok: true, tag: el.tagName, text: el.innerText?.slice(0, 40) };
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === "GET_CONTEXT") {
    if (typeof window.__agentGetElements === "function") {
      sendResponse({ ok: true, data: window.__agentGetElements() });
    } else {
      sendResponse({ ok: false, msg: "dom_parser not ready — refresh the tab" });
    }
    return true;
  }

  if (msg.type === "EXECUTE_ACTION") {
    handleAction(msg.payload).then(sendResponse);
    return true;
  }

  // L5: Gemini gave coordinates → click there
  if (msg.type === "CLICK_AT_XY") {
    sendResponse(clickAtXY(msg.payload.x, msg.payload.y));
    return true;
  }
});
