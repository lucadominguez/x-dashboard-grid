/**
 * GridX service worker.
 *
 * Intentionally minimal: the bulk of the logic lives in the content script.
 * This worker only (a) registers the `commands` shortcuts and (b) relays a
 * command message to whichever tabs are running our content script.
 *
 * Design notes:
 * - We deliberately avoid the `tabs` permission. `chrome.tabs.query({})` without
 *   `tabs` still returns tab objects, but `url` is undefined for tabs we do not
 *   have host access to. We send to every tab and let `chrome.tabs.sendMessage`
 *   reject for tabs that have no GridX content script (caught, ignored).
 *   Host access for x.com / twitter.com / localhost is implied by the
 *   content_scripts `matches` in manifest.json, which is the only surface we
 *   need to message.
 * - The MV3 service worker may be killed at any time; nothing stateful lives here.
 */
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-grid' || command === 'toggle-pause') {
    relay({ type: 'gridx:command', payload: command });
  }
});

async function relay(message) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }
  for (const tab of tabs) {
    if (!tab.id || tab.id === chrome.tabs.TAB_ID_NONE) {
      continue;
    }
    // sendMessage rejects when the tab has no matching content script (or we
    // lack host access). We cannot know without `tabs` permission, so we send
    // and swallow rejections.
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}