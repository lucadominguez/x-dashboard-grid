// GridX service worker - minimal. Only instantiates commands and relays messages.
// The bulk of logic lives in the content script (DOM-hoisting grid renderer).
const DEFAULTS = {
  columnCount: 3,
  density: 'compact',
  fontScale: 1.0,
  showMedia: false,
  showAvatars: false,
  showMetrics: false,
  hideRetweets: false,
  hidePromoted: true,
  hideVerified: false,
  filterKeywords: [],
  filterHandles: [],
  extraCss: '',
  scanMode: false,
  paused: false,
  maxCells: 300,
  autoAdvance: true,
};

chrome.runtime.onInstalled.addListener(async () => {
  const { gridxSettings } = await chrome.storage.local.get('gridxSettings');
  if (!gridxSettings) {
    await chrome.storage.local.set({ gridxSettings: DEFAULTS });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const { gridxSettings } = await chrome.storage.local.get('gridxSettings');
  let next = { ...gridxSettings };
  if (command === 'toggle-grid') {
    next.scanMode = !next.scanMode;
    // toggle: if scan was off, enter scan; else restore defaults
  } else if (command === 'toggle-pause') {
    next.paused = !next.paused;
  }
  await chrome.storage.local.set({ gridxSettings: next });
  // broadcast to all x/twitter tabs
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.url && /x\.com|twitter\.com/.test(t.url)) {
      chrome.tabs.sendMessage(t.id, { type: 'gridx:update', settings: next }).catch(() => {});
    }
  }
});
