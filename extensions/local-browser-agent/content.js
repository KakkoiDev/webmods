(() => {
  if (globalThis.__LOCAL_BROWSER_AGENT__) return;
  globalThis.__LOCAL_BROWSER_AGENT__ = true;

  const INTERACTIVE = [
    "a[href]", "button", "input", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=textbox]", "[contenteditable=true]"
  ].join(",");
  let panel;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LBA_PING") return sendResponse({ ok: true });
    if (message?.type === "LBA_TOGGLE") toggle();
  });

  function observe(limit = 100) {
    const nodes = [...document.querySelectorAll(INTERACTIVE)]
      .filter(visible)
      .slice(0, limit)
      .map((el, index) => ({
        ref: `e${index + 1}`,
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        name: accessibleName(el).slice(0, 200),
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true")
      }));
    return { url: location.href, title: document.title, nodes };
  }

  function toggle() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = document.createElement("aside");
    panel.id = "local-browser-agent";
    panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:min(420px,calc(100vw - 32px));padding:12px;border:1px solid #888;border-radius:12px;background:Canvas;color:CanvasText;font:14px system-ui;box-shadow:0 8px 30px #0004";
    panel.innerHTML = `<strong>Local Browser Agent</strong>
      <p style="margin:8px 0">Extension shell ready. Model runtime is the next milestone.</p>
      <textarea aria-label="Agent goal" rows="3" style="box-sizing:border-box;width:100%" placeholder="What should I do on this page?"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px"><button data-observe>Observe page</button><button data-close>Close</button></div>
      <pre data-output style="max-height:240px;overflow:auto;white-space:pre-wrap"></pre>`;
    panel.querySelector("[data-close]").onclick = toggle;
    panel.querySelector("[data-observe]").onclick = async () => {
      const observation = observe();
      panel.querySelector("[data-output]").textContent = JSON.stringify(observation, null, 2);
      await chrome.runtime.sendMessage({ type: "LBA_OBSERVATION", observation });
    };
    document.documentElement.append(panel);
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }
  function accessibleName(el) {
    return el.getAttribute("aria-label") || el.getAttribute("title") ||
      (el.labels?.[0]?.innerText) || el.innerText || el.value || el.placeholder || "";
  }
})();
