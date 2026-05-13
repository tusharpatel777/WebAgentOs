// Content script — The Hands of WebAgentOS.
// Handles two message types from popup.js:
//   GET_CONTEXT    → returns parsed DOM elements via dom_parser.js
//   EXECUTE_ACTION → performs click / type / scroll / navigate on the page

// Self-healing: CSS → XPath → aria/text match → full-page text scan
function findElement(css, xpath) {
  // 1. CSS selector
  if (css) {
    try { const el = document.querySelector(css); if (el) return el; } catch (_) {}
  }

  // 2. XPath
  if (xpath) {
    try {
      const res = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (res.singleNodeValue) return res.singleNodeValue;
    } catch (_) {}
  }

  // 3. Attribute / text match on standard interactive elements
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

  // 4. Full-page text scan — catches Flipkart/Amazon div-based buttons
  const searchText = hint || (xpath || "").split("/").pop().replace(/\[.*\]/, "");
  if (searchText.length > 2) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const text = el.textContent.trim().toLowerCase();
      if (text === searchText.toLowerCase() || text.startsWith(searchText.toLowerCase())) {
        const style = window.getComputedStyle(el);
        if (style.display !== "none" && style.visibility !== "hidden") {
          // Walk up to find actual clickable ancestor (cursor:pointer parent)
          return findClickableAncestorInContent(el);
        }
      }
    }
  }

  return null;
}

// Walk up DOM to find element with cursor:pointer — the real clickable target
function findClickableAncestorInContent(el) {
  let node = el;
  for (let i = 0; i < 8 && node && node !== document.body; i++) {
    const style = window.getComputedStyle(node);
    if (
      style.cursor === "pointer"             ||
      node.onclick                            ||
      node.hasAttribute("onclick")            ||
      node.getAttribute("role") === "button"  ||
      node.tagName === "BUTTON"               ||
      node.tagName === "A"
    ) return node;
    node = node.parentElement;
  }
  return el;
}

// Waits up to `timeout` ms for element to appear in DOM (handles dynamic pages)
async function waitForElement(css, xpath, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const el = findElement(css, xpath);
    if (el) return el;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function handleAction(payload) {
  const { action, css, xpath, value } = payload;
  try {
    switch (action) {
      case "click": {
        const el = await waitForElement(css, xpath);
        if (!el) return { ok: false, msg: `Element not found after 5s — css:${css}` };
        el.focus(); el.click();
        return { ok: true };
      }
      case "type": {
        const el = await waitForElement(css, xpath);
        if (!el) return { ok: false, msg: `Element not found after 5s — css:${css}` };
        el.focus();
        el.value = value || "";
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if ((value || "").endsWith("\n"))
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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
    return true; // keep message channel open for async response
  }
});
