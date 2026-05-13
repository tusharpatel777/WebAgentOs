// Shared extension config (sync storage).
// Loaded by popup.html (window context) and importScripts() in background.js (service worker).
(function initWAOConfig(globalThisObj) {
  const DEFAULT_BASE = "https://tusharpatel-webagentos-brain.hf.space";

  async function getBrainBaseUrl() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(["brainBaseUrl"], (r) => resolve((r.brainBaseUrl || DEFAULT_BASE).trim()));
    });
  }

  async function setBrainBaseUrl(url) {
    const u = (url || "").trim().replace(/\/+$/, "");
    await new Promise((resolve) => chrome.storage.sync.set({ brainBaseUrl: u || DEFAULT_BASE }, resolve));
  }

  async function getEndpoints() {
    const base = (await getBrainBaseUrl()).replace(/\/+$/, "");
    return {
      base,
      plan: `${base}/plan`,
      verify: `${base}/verify`,
      coords: `${base}/coordinates`,
      memory: `${base}/memory`,
    };
  }

  globalThisObj.WAOConfig = { DEFAULT_BASE, getBrainBaseUrl, setBrainBaseUrl, getEndpoints };
})(typeof window !== "undefined" ? window : self);
