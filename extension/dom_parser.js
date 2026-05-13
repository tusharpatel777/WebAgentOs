// Runs as a content script — always available on every page.
// Defines window.__agentGetElements() which content.js calls on demand.

(function () {
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
    if (el.id)                              return `#${el.id}`;
    if (el.getAttribute("name"))            return `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
    if (el.getAttribute("data-testid"))     return `[data-testid="${el.getAttribute("data-testid")}"]`;
    if (el.getAttribute("aria-label"))      return `[aria-label="${el.getAttribute("aria-label")}"]`;
    if (el.getAttribute("placeholder"))     return `[placeholder="${el.getAttribute("placeholder")}"]`;
    return null;
  }

  window.__agentGetElements = function () {
    const TAGS = "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link]";
    const seen = new Set();
    const elements = [];

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
        el.textContent.trim().slice(0, 60) ||
        el.getAttribute("name") ||
        el.getAttribute("value") || ""
      ).trim();

      elements.push({
        idx:   elements.length,
        tag:   el.tagName.toLowerCase(),
        type:  el.getAttribute("type") || "",
        label,
        css:   getBestCSS(el),   // may be null — use xpath then
        xpath,
      });
    });

    return {
      url:      location.href,
      title:    document.title,
      elements: elements.slice(0, 60),
      bodyText: document.body.innerText.slice(0, 800),
    };
  };
})();
