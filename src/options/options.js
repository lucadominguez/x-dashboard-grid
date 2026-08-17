const $ = (id) => document.getElementById(id);
const DEFAULTS = { columnCount:3, density:'compact', fontScale:1.0, showMedia:false, showAvatars:false, showMetrics:false, hideRetweets:false, hidePromoted:true, hideVerified:false, filterKeywords:[], filterHandles:[], extraCss:'', maxCells:300, autoAdvance:true };
let s = {};
async function load() { const { gridxSettings } = await chrome.storage.local.get('gridxSettings'); s = Object.assign({}, DEFAULTS, gridxSettings); render(); }
function render() {
  $('cols').value = s.columnCount; $('cols-v').textContent = s.columnCount;
  $('density').value = s.density;
  $('font').value = Math.round((s.fontScale||1)*100); $('font-v').textContent = (s.fontScale||1)+'x';
  $('maxcells').value = s.maxCells || 300; $('maxcells-v').textContent = s.maxCells || 300;
  $('autoadvance').checked = s.autoAdvance !== false;
  $('media').checked=!!s.showMedia; $('avatars').checked=!!s.showAvatars; $('metrics').checked=!!s.showMetrics;
  $('retweets').checked=!!s.hideRetweets; $('promoted').checked=s.hidePromoted!==false; $('verified').checked=!!s.hideVerified;
  $('keywords').value=(s.filterKeywords||[]).join(', ');
  $('handles').value=(s.filterHandles||[]).join(', ');
  $('extra').value=s.extraCss||'';
}
async function save() {
  s.columnCount=+$('cols').value; s.density=$('density').value; s.fontScale=+$('font').value/100;
  s.maxCells=+$('maxcells').value; s.autoAdvance=$('autoadvance').checked;
  s.showMedia=$('media').checked; s.showAvatars=$('avatars').checked; s.showMetrics=$('metrics').checked;
  s.hideRetweets=$('retweets').checked; s.hidePromoted=$('promoted').checked; s.hideVerified=$('verified').checked;
  s.filterKeywords=$('keywords').value.split(',').map(x=>x.trim()).filter(Boolean);
  s.filterHandles=$('handles').value.split(',').map(x=>x.trim()).filter(Boolean);
  s.extraCss=$('extra').value;
  await chrome.storage.local.set({ gridxSettings: s });
  const [t] = await chrome.tabs.query({active:true,currentWindow:true});
  if (t?.id) chrome.tabs.sendMessage(t.id, { type:'gridx:update', settings: s }).catch(()=>{});
  $('status').textContent='Saved';
  setTimeout(()=>$('status').textContent='',1500);
}
$('cols').addEventListener('input',()=>$('cols-v').textContent=$('cols').value);
$('font').addEventListener('input',()=>$('font-v').textContent=(+$('font').value/100)+'x');
$('maxcells').addEventListener('input',()=>$('maxcells-v').textContent=$('maxcells').value);
$('save').addEventListener('click',save);
$('reset').addEventListener('click',async()=>{ await chrome.storage.local.set({gridxSettings:DEFAULTS}); load(); });
load();
