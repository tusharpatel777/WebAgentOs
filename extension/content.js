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
  const all = queryAllDeep("button, a, div, span, li");
  for (const el of all) {
    const t = (el.innerText || el.textContent || "").trim().toLowerCase();
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

// Query selector across document + open shadow roots + same-origin iframes (best-effort)
function queryAllDeep(selector) {
  const out = [];
  const roots = getAllRoots();
  for (const root of roots) {
    try {
      out.push(...root.querySelectorAll(selector));
    } catch (_) {}
  }
  return out;
}

function getAllRoots() {
  const roots = [];
  const seen = new Set();

  function addRoot(root) {
    if (!root) return;
    if (seen.has(root)) return;
    seen.add(root);
    roots.push(root);
  }

  function walkDoc(doc) {
    if (!doc?.documentElement) return;
    addRoot(doc);

    for (const iframe of doc.querySelectorAll("iframe")) {
      try {
        const child = iframe.contentDocument;
        if (child) walkDoc(child);
      } catch (_) {}
    }

    const hosts = doc.querySelectorAll("*");
    for (const host of hosts) {
      const sr = host.shadowRoot;
      if (sr) walkShadow(sr);
    }
  }

  function walkShadow(sr) {
    addRoot(sr);
    const hosts = sr.querySelectorAll("*");
    for (const host of hosts) {
      const nested = host.shadowRoot;
      if (nested) walkShadow(nested);
    }
  }

  walkDoc(document);
  return roots.slice(0, 30);
}

// L6: Scroll → find by text → click (handles sticky/hidden/shadow/iframe)
async function forceClickByText(text) {
  const lower = text.toLowerCase().trim();

  function clickIfMatch(selector, exact = true) {
    let best = null;
    for (const el of queryAllDeep(selector)) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (!t) continue;
      const match = exact ? (t === lower) : (t.startsWith(lower) && t.length < lower.length + 25);
      if (!match) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") continue;

      if (exact) {
        humanClick(el);
        el.click();
        return { ok: true, matched: t };
      }

      if (!best || t.length < best.t.length) best = { el, t };
    }
    if (best) {
      humanClick(best.el);
      best.el.click();
      return { ok: true, matched: best.t };
    }
    return null;
  }

  // Pass A: try at current scroll position
  let r =
    clickIfMatch("button, [role='button']", true) ||
    clickIfMatch("button, a, [role='button'], div, span", true) ||
    clickIfMatch("button, a, [role='button'], div, span", false);
  if (r) return r;

  // Only do aggressive scroll sweeps for CTA-like targets; otherwise avoid up/down oscillation.
  const isCtaTarget =
    lower.includes("add to") ||
    lower.includes("cart") ||
    lower.includes("buy") ||
    lower.includes("checkout") ||
    lower.includes("place order");

  if (!isCtaTarget) return null;

  // Pass B: scroll top then retry (sticky CTAs often become visible)
  window.scrollTo({ top: 0, behavior: "smooth" });
  await new Promise(r2 => setTimeout(r2, 500));
  r =
    clickIfMatch("button, [role='button']", true) ||
    clickIfMatch("button, a, [role='button'], div, span", true) ||
    clickIfMatch("button, a, [role='button'], div, span", false);
  if (r) return r;

  return null;
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

        // Safety: if Brain gave a selector inside Frequently Bought Together,
        // discard it — it's a secondary CTA, not the main product button
        if (el && el.closest("#slot-list-container, [class*='frequently-bought' i]")) {
          el = null;
        }

        // L3/L4: smartFindByText using selector hint
        if (!el) {
          const hint = (css || xpath || "").replace(/^xpath:/, "").split('"')[1] || "";
          if (hint) el = smartFindByText(hint);
          // Discard if still in FBT section
          if (el && el.closest("#slot-list-container, [class*='frequently-bought' i]")) el = null;
        }

        // L5: humanClick on found element (scrolls into view, fires mouse events)
        if (el) {
          humanClick(el);
          el.click(); // also fire native click for React/Vue event listeners
          return { ok: true };
        }

        // L6: Scroll-to-top + force-click by text — works on sticky/fixed/hidden bars
        const labelHints = [
          (css || "").replace(/[#\.\[\]='"]/g, " ").trim(),
          (xpath || "").split("/").pop().replace(/\[.*\]/, "").trim(),
          "add to cart", "add to bag", "add to basket", "buy now", "view cart", "go to cart",
        ].filter(h => h.length > 2);

        for (const hint of labelHints) {
          const result = await forceClickByText(hint);
          if (result) return { ok: true, layer: "L6-force", matched: result.matched };
        }

        return { ok: false, msg: `Element not found — css:${css}` };
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
