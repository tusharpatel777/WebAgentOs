// Runs as a content script — always available on every page.
// Defines window.__agentGetElements() which content.js calls on demand.

(function () {

  // Priority keywords — these elements bubble to the TOP of context
  const HIGH_PRIORITY = ["add to cart", "buy", "checkout", "purchase", "order", "submit", "search", "login", "sign in", "continue", "proceed", "pay"];

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
    if (el.id)                                  return `#${el.id}`;
    if (el.getAttribute("name"))                return `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
    if (el.getAttribute("data-testid"))         return `[data-testid="${el.getAttribute("data-testid")}"]`;
    if (el.getAttribute("aria-label"))          return `[aria-label="${el.getAttribute("aria-label")}"]`;
    if (el.getAttribute("placeholder"))         return `[placeholder="${el.getAttribute("placeholder")}"]`;
    // Flipkart / Amazon specific attributes
    if (el.getAttribute("data-id"))             return `[data-id="${el.getAttribute("data-id")}"]`;
    if (el.getAttribute("data-tracking-id"))    return `[data-tracking-id="${el.getAttribute("data-tracking-id")}"]`;
    return null;
  }

  window.__agentGetElements = function () {
    // Wider selector net — catches Flipkart/Amazon custom components
    const TAGS = [
      "button",
      "a[href]",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "[role=button]",
      "[role=link]",
      "[role=menuitem]",
      "[role=option]",
      "[class*='cart' i]",
      "[class*='buy' i]",
      "[class*='add-to' i]",
      "[class*='checkout' i]",
    ].join(", ");

    const seen   = new Set();
    const priority = [];
    const normal   = [];

    document.querySelectorAll(TAGS).forEach(el => {
      const rect  = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible =
        rect.width > 0 && rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display    !== "none"   &&
        style.opacity    !== "0";
      if (!visible) return;

      const xpath = getXPath(el);
      if (seen.has(xpath)) return;
      seen.add(xpath);

      const label = (
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.textContent.trim().slice(0, 80) ||
        el.getAttribute("name") ||
        el.getAttribute("value") || ""
      ).trim();

      const entry = {
        tag:   el.tagName.toLowerCase(),
        type:  el.getAttribute("type") || "",
        label,
        css:   getBestCSS(el),
        xpath,
      };

      // High-priority elements go to the front
      if (isPriority(label)) priority.push(entry);
      else normal.push(entry);
    });

    // Priority first, then normal — index after merging
    const merged = [...priority, ...normal].slice(0, 80).map((e, i) => ({ idx: i, ...e }));

    return {
      url:      location.href,
      title:    document.title,
      elements: merged,
      bodyText: document.body.innerText.slice(0, 1200),
    };
  };
})();
