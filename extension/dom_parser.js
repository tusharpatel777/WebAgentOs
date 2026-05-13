// Runs as a content script — always available on every page.
// Defines window.__agentGetElements() which content.js calls on demand.

(function () {

  const HIGH_PRIORITY = ["add to cart", "buy now", "buy at", "checkout", "place order", "continue", "proceed to pay", "add", "purchase"];
  const ACTION_TEXTS  = ["add to cart", "buy now", "place order", "proceed", "checkout", "add", "buy at"];

  function isPriority(label) {
    const l = label.toLowerCase();
    return HIGH_PRIORITY.some(k => l.includes(k));
  }

  function getXPath(el) {
    if (el.id) return `//*[@id="${el.id}"]`;
    if (el === document.body) return "/html/body";
    const parent = el.parentNode;
    if (!parent) return el.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter(s => s.tagName === el.tagName);
    const idx = siblings.indexOf(el) + 1;
    const pos = siblings.length > 1 ? `[${idx}]` : "";
    return `${getXPath(parent)}/${el.tagName.toLowerCase()}${pos}`;
  }

  function getBestCSS(el) {
    if (el.id)                               return `#${el.id}`;
    if (el.getAttribute("name"))             return `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
    if (el.getAttribute("data-testid"))      return `[data-testid="${el.getAttribute("data-testid")}"]`;
    if (el.getAttribute("aria-label"))       return `[aria-label="${el.getAttribute("aria-label")}"]`;
    if (el.getAttribute("placeholder"))      return `[placeholder="${el.getAttribute("placeholder")}"]`;
    if (el.getAttribute("data-id"))          return `[data-id="${el.getAttribute("data-id")}"]`;
    return null;
  }

  function isVisible(el) {
    const rect  = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display    !== "none"   &&
      style.opacity    !== "0"      &&
      style.pointerEvents !== "none"
    );
  }

  window.__agentGetElements = function () {
    const seen    = new Set();
    const priority = [];
    const normal   = [];

    // ── Pass 1: Standard interactive elements ────────────────────────────────
    const TAGS = [
      "button", "a[href]", "input:not([type=hidden])",
      "select", "textarea",
      "[role=button]", "[role=link]", "[role=menuitem]", "[role=option]",
      "[class*='cart' i]", "[class*='buy' i]", "[class*='add-to' i]", "[class*='checkout' i]",
    ].join(", ");

    document.querySelectorAll(TAGS).forEach(el => {
      if (!isVisible(el)) return;
      const xpath = getXPath(el);
      if (seen.has(xpath)) return;
      seen.add(xpath);

      const label = (
        el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
        el.getAttribute("title")      || el.textContent.trim().slice(0, 80) ||
        el.getAttribute("name")       || el.getAttribute("value") || ""
      ).trim();

      const entry = { tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "", label, css: getBestCSS(el), xpath };
      isPriority(label) ? priority.push(entry) : normal.push(entry);
    });

    // ── Pass 2: Text-based scan — catches Flipkart/Amazon div buttons ────────
    // Finds ANY element whose visible text exactly matches action keywords
    ACTION_TEXTS.forEach(keyword => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        const text = el.childNodes.length === 1 && el.firstChild.nodeType === 3
          ? el.textContent.trim().toLowerCase()   // direct text node only
          : "";
        if (!text.includes(keyword)) continue;
        if (!isVisible(el)) continue;
        const xpath = getXPath(el);
        if (seen.has(xpath)) continue;
        seen.add(xpath);

        const label = el.textContent.trim().slice(0, 80);
        priority.unshift({ tag: el.tagName.toLowerCase(), type: "", label, css: getBestCSS(el), xpath });
      }
    });

    const merged = [...priority, ...normal].slice(0, 80).map((e, i) => ({ idx: i, ...e }));

    return {
      url:      location.href,
      title:    document.title,
      elements: merged,
      bodyText: document.body.innerText.slice(0, 1200),
    };
  };
})();
