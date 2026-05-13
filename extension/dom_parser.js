// Runs as a content script — always available on every page.
// Defines window.__agentGetElements() which content.js calls on demand.

(function () {

  const HIGH_PRIORITY = [
    "add to cart", "add to bag", "add to basket",
    "buy now", "buy at",
    "checkout", "go to cart", "view cart",
    "place order", "continue", "proceed to pay",
    "purchase", "add"
  ];
  const ACTION_TEXTS  = [
    "add to cart", "add to bag", "add to basket",
    "buy now", "place order", "proceed", "checkout",
    "go to cart", "view cart", "add", "buy at"
  ];

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
    // Search/text inputs — use type as fallback (better than long XPath)
    if (el.tagName === "INPUT") {
      const type = el.getAttribute("type") || "text";
      if (type === "search") return `input[type="search"]`;
      if (type === "text")   return `input[type="text"]`;
    }
    return null;
  }

  // Walk UP the DOM to find the nearest ancestor that actually handles clicks.
  // Flipkart/Amazon put text in a deep <div>, but the click handler is on a parent.
  function findClickableAncestor(el) {
    let node = el;
    const limit = 8; // max levels to walk up
    for (let i = 0; i < limit && node && node !== document.body; i++) {
      const style = window.getComputedStyle(node);
      if (
        style.cursor === "pointer"          ||
        node.onclick                         ||
        node.hasAttribute("onclick")         ||
        node.getAttribute("role") === "button" ||
        node.tagName === "BUTTON"            ||
        node.tagName === "A"
      ) return node;
      node = node.parentElement;
    }
    return el; // fallback — return original element
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

      // Normalize to the actual click target (many sites attach handlers to ancestors).
      const clickable = findClickableAncestor(el);
      if (!isVisible(clickable)) return;

      const xpath = getXPath(clickable);
      if (seen.has(xpath)) return;
      seen.add(xpath);

      const label = (
        clickable.getAttribute("aria-label") || clickable.getAttribute("placeholder") ||
        clickable.getAttribute("title")      || clickable.innerText?.trim().slice(0, 80) ||
        clickable.textContent?.trim().slice(0, 80) ||
        clickable.getAttribute("name")       || clickable.getAttribute("value") || ""
      ).trim();

      const entry = { tag: clickable.tagName.toLowerCase(), type: clickable.getAttribute("type") || "", label, css: getBestCSS(clickable), xpath };
      isPriority(label) ? priority.push(entry) : normal.push(entry);
    });

    // ── Pass 2: Text-based scan — catches Flipkart/Amazon div buttons ────────
    // Skip elements inside "related/similar/frequently-bought" containers —
    // those are secondary CTAs that confuse the Brain into clicking the wrong thing.
    const EXCLUDED_CONTAINERS = [
      "#slot-list-container",
      "[class*='frequently-bought' i]",
      "[class*='similar-product' i]",
      "[class*='related-product' i]",
      "[class*='also-bought' i]",
      "[data-widget-type='FREQUENTLY_BOUGHT_TOGETHER']",
    ];

    function isInExcludedContainer(el) {
      return EXCLUDED_CONTAINERS.some(sel => {
        try { return !!el.closest(sel); } catch { return false; }
      });
    }

    ACTION_TEXTS.forEach(keyword => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        const text = el.childNodes.length === 1 && el.firstChild.nodeType === 3
          ? el.textContent.trim().toLowerCase()
          : "";
        if (!text.includes(keyword)) continue;
        if (!isVisible(el)) continue;
        if (isInExcludedContainer(el)) continue;  // skip FBT / related sections

        // Walk UP to find the real clickable ancestor
        const clickable = findClickableAncestor(el);
        if (isInExcludedContainer(clickable)) continue;  // double-check ancestor too

        const xpath = getXPath(clickable);
        if (seen.has(xpath)) return;
        seen.add(xpath);

        const label = el.textContent.trim().slice(0, 80);
        priority.unshift({ tag: clickable.tagName.toLowerCase(), type: "", label, css: getBestCSS(clickable), xpath });
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
