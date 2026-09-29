// Local Browser Agent service worker.
// The extension shell is intentionally model-runtime agnostic. See spec/ for contracts.
const sessions = new Map();

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await ensureContentScript(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: "LBA_TOGGLE" });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "_execute_action") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await ensureContentScript(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: "LBA_TOGGLE" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "LBA_OBSERVATION") {
    const tabId = sender.tab?.id;
    if (tabId) sessions.set(tabId, { observation: message.observation, at: Date.now() });
    sendResponse({ ok: true });
  }
});

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "LBA_PING" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }
}
