const $ = (id) => document.getElementById(id);
let settings = {};
let enabled = false;

async function tab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}
async function load() {
  const { gridxSettings } = await chrome.storage.local.get('gridxSettings');
  settings = gridxSettings || {};
  $('cols').value = settings.columnCount || 3;
  $('density').value = settings.density || 'compact';
  $('scan').checked = !!settings.scanMode;
  $('media').checked = !!settings.showMedia;
  $('metrics').checked = !!settings.showMetrics;
  $('promoted').checked = settings.hidePromoted !== false;
  $('filter').value = (settings.filterKeywords || []).join(', ');
}
async function saveAndSend() {
  settings.columnCount = +$('cols').value;
  settings.density = $('density').value;
  settings.scanMode = $('scan').checked;
  settings.showMedia = $('media').checked;
  settings.showMetrics = $('metrics').checked;
  settings.hidePromoted = $('promoted').checked;
  settings.filterKeywords = $('filter').value.split(',').map(s=>s.trim()).filter(Boolean);
  await chrome.storage.local.set({ gridxSettings: settings });
  const t = await tab();
  if (t?.id) chrome.tabs.sendMessage(t.id, { type: 'gridx:update', settings }).catch(()=>{});
}

['cols','density','scan','media','metrics','promoted','filter'].forEach(id => {
  const el = $(id);
  if (el && el.addEventListener) el.addEventListener('input', saveAndSend);
  if (el && el.addEventListener) el.addEventListener('change', saveAndSend);
});

$('toggle-btn').addEventListener('click', async () => {
  // toggle is handled in-content via keybind; here we send full settings to enable
  const t = await tab();
  enabled = !enabled;
  $('toggle-btn').textContent = enabled ? 'Disable Grid' : 'Enable Grid';
  if (t?.id) chrome.tabs.sendMessage(t.id, { type: 'gridx:update', settings, enable: enabled }).catch(()=>{});
  $('stats').textContent = enabled ? 'Grid: enabled' : 'Grid: idle';
});
$('options').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

$('cols').addEventListener('input', () => { $('stats').textContent = `Columns: ${$('cols').value}`; });
load();
