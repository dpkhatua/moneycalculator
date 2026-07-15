
const STORAGE_KEY = 'spendingTracker.transactions.v1';
const CATEGORY_KEY = 'spendingTracker.categories.v1';

const DEFAULT_CATEGORIES = {
  expense: ['Food','Transport','Housing','Utilities','Shopping','Entertainment','Health','Education','Other'],
  income: ['Salary','Business','Investment','Gift','Other']
};

let transactions = [];
let categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
let currentType = 'expense';
let editingId = null;

function inr(n){
  n = Math.round(n);
  if(!isFinite(n)) n = 0;
  const neg = n < 0;
  n = Math.abs(n);
  let s = n.toString();
  let last3 = s.slice(-3);
  let rest = s.slice(0,-3);
  if(rest !== '') last3 = ',' + last3;
  let formatted = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + last3;
  return (neg?'-':'') + '₹' + formatted;
}

function loadData(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    transactions = raw ? JSON.parse(raw) : [];
  } catch(e){ transactions = []; }
  try{
    const rawCat = localStorage.getItem(CATEGORY_KEY);
    categories = rawCat ? JSON.parse(rawCat) : JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
  } catch(e){ categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)); }
}
function saveData(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
    localStorage.setItem(CATEGORY_KEY, JSON.stringify(categories));
  } catch(e){
    alert('Could not save — your browser storage may be full or blocked (e.g. private browsing mode).');
  }
}

function uid(){ return 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }

function populateCategorySelect(){
  const sel = document.getElementById('txCategory');
  sel.innerHTML = '';
  categories[currentType].forEach(c=>{
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
  const addOpt = document.createElement('option');
  addOpt.value = '__add_new__'; addOpt.textContent = '+ Add new category…';
  sel.appendChild(addOpt);
}
document.getElementById('txCategory').addEventListener('change', (e)=>{
  if(e.target.value === '__add_new__'){
    const name = prompt('New category name:');
    if(name && name.trim()){
      const trimmed = name.trim();
      if(!categories[currentType].includes(trimmed)) categories[currentType].push(trimmed);
      saveData();
      populateCategorySelect();
      e.target.value = trimmed;
    } else {
      populateCategorySelect();
    }
  }
});

function setType(type){
  currentType = type;
  document.getElementById('typeExpenseBtn').classList.toggle('active', type==='expense');
  document.getElementById('typeIncomeBtn').classList.toggle('active', type==='income');
  populateCategorySelect();
}
document.getElementById('typeExpenseBtn').addEventListener('click', ()=>setType('expense'));
document.getElementById('typeIncomeBtn').addEventListener('click', ()=>setType('income'));

function resetForm(){
  editingId = null;
  document.getElementById('editNote').textContent = '';
  document.getElementById('txSubmit').textContent = 'Add transaction';
  document.getElementById('txDate').value = new Date().toISOString().slice(0,10);
  document.getElementById('txDesc').value = '';
  document.getElementById('txAmount').value = '';
  setType('expense');
}

document.getElementById('txSubmit').addEventListener('click', ()=>{
  const date = document.getElementById('txDate').value;
  const category = document.getElementById('txCategory').value;
  const desc = document.getElementById('txDesc').value.trim();
  const amount = +document.getElementById('txAmount').value;

  if(!date){ alert('Pick a date.'); return; }
  if(!amount || amount<=0){ alert('Enter an amount greater than zero.'); return; }
  if(category==='__add_new__'){ alert('Finish adding the new category first.'); return; }

  if(editingId){
    const tx = transactions.find(t=>t.id===editingId);
    if(tx){ Object.assign(tx, {date, type:currentType, category, description:desc, amount}); }
  } else {
    transactions.push({ id: uid(), date, type: currentType, category, description: desc, amount });
  }
  saveData();
  resetForm();
  renderAll();
});

function startEdit(id){
  const tx = transactions.find(t=>t.id===id);
  if(!tx) return;
  editingId = id;
  setType(tx.type);
  document.getElementById('txDate').value = tx.date;
  document.getElementById('txDesc').value = tx.description;
  document.getElementById('txAmount').value = tx.amount;
  populateCategorySelect();
  document.getElementById('txCategory').value = tx.category;
  document.getElementById('txSubmit').textContent = 'Save changes';
  document.getElementById('editNote').textContent = 'Editing an existing transaction — Save changes will update it in place.';
  window.scrollTo({top: document.querySelector('.tracker-grid').offsetTop - 20, behavior:'smooth'});
}
function deleteTx(id){
  if(!confirm('Delete this transaction? This can\'t be undone.')) return;
  transactions = transactions.filter(t=>t.id!==id);
  saveData();
  renderAll();
}

// ---------- Filters ----------
function monthKey(dateStr){ return dateStr.slice(0,7); } // YYYY-MM
function populateMonthFilter(){
  const sel = document.getElementById('filterMonth');
  const prevValue = sel.value;
  const months = [...new Set(transactions.map(t=>monthKey(t.date)))].sort().reverse();
  sel.innerHTML = '<option value="__all__">All time</option>';
  const thisMonth = new Date().toISOString().slice(0,7);
  if(!months.includes(thisMonth)) months.unshift(thisMonth);
  months.forEach(m=>{
    const opt = document.createElement('option');
    opt.value = m;
    const [y,mo] = m.split('-');
    const label = new Date(y, mo-1, 1).toLocaleString('en-IN', {month:'long', year:'numeric'});
    opt.textContent = label;
    sel.appendChild(opt);
  });
  if(prevValue && [...sel.options].some(o=>o.value===prevValue)) sel.value = prevValue;
  else sel.value = thisMonth;
}
function populateCategoryFilter(){
  const sel = document.getElementById('filterCategory');
  const prevValue = sel.value;
  const cats = [...new Set(transactions.map(t=>t.category))].sort();
  sel.innerHTML = '<option value="">All categories</option>';
  cats.forEach(c=>{
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
  if(prevValue) sel.value = prevValue;
}
document.getElementById('filterMonth').addEventListener('change', renderAll);
document.getElementById('filterCategory').addEventListener('change', renderAll);

function getFilteredTx(){
  const month = document.getElementById('filterMonth').value;
  const cat = document.getElementById('filterCategory').value;
  return transactions.filter(t=>{
    if(month!=='__all__' && monthKey(t.date)!==month) return false;
    if(cat && t.category!==cat) return false;
    return true;
  });
}

// ---------- Rendering ----------
function renderSummary(){
  const thisMonth = new Date().toISOString().slice(0,7);
  const monthTx = transactions.filter(t=>monthKey(t.date)===thisMonth);
  const monthIncome = monthTx.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
  const monthExpense = monthTx.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
  document.getElementById('sumMonthIncome').textContent = inr(monthIncome);
  document.getElementById('sumMonthExpense').textContent = inr(monthExpense);
  const netEl = document.getElementById('sumMonthNet');
  netEl.textContent = inr(monthIncome-monthExpense);
  netEl.classList.toggle('brick', monthIncome-monthExpense<0);

  const allIncome = transactions.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
  const allExpense = transactions.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const balEl = document.getElementById('sumAllBalance');
  balEl.textContent = inr(allIncome-allExpense);
  balEl.classList.toggle('brick', allIncome-allExpense<0);
}

function escapeHtml(str){
  return String(str==null?'':str).replace(/[&<>"']/g, (m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function renderList(){
  const list = document.getElementById('txList');
  const filtered = getFilteredTx().slice().sort((a,b)=> b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  document.getElementById('txCount').textContent = filtered.length + ' transaction' + (filtered.length===1?'':'s');
  if(filtered.length===0){
    list.innerHTML = '<div class="empty-state">Nothing logged for this filter yet. Add a transaction on the left to get started.</div>';
    return;
  }
  list.innerHTML = '';
  filtered.forEach(t=>{
    const row = document.createElement('div');
    row.className = 'tx-row';
    const d = new Date(t.date);
    const dateLabel = d.toLocaleDateString('en-IN', {day:'2-digit', month:'short'});
    row.innerHTML = `
      <div class="tx-date">${escapeHtml(dateLabel)}</div>
      <div class="tx-main">
        <span class="tx-cat">${escapeHtml(t.category)}</span>
        <span class="tx-desc">${escapeHtml(t.description) || '—'}</span>
      </div>
      <div class="tx-amt ${t.type}">${t.type==='expense' ? '−' : '+'}${inr(t.amount)}</div>
      <div class="tx-actions">
        <button title="Edit" data-action="edit">✎</button>
        <button title="Delete" data-action="delete">×</button>
      </div>
    `;
    row.querySelector('[data-action=edit]').addEventListener('click', ()=>startEdit(t.id));
    row.querySelector('[data-action=delete]').addEventListener('click', ()=>deleteTx(t.id));
    list.appendChild(row);
  });
}

let charts = {};
function drawChart(id, labels, datasets, opts, type){
  type = type || 'bar';
  const ctx = document.getElementById(id).getContext('2d');
  if(charts[id]) charts[id].destroy();
  const base = {
    responsive:true, maintainAspectRatio:false,
    plugins:{ legend:{display: datasets.length>1 || type==='doughnut', labels:{font:{family:'ui-monospace, Menlo, Consolas, monospace',size:11}}},
      tooltip:{callbacks:{label:(c)=>(c.dataset.label||'')+': '+inr(c.parsed.y!==undefined?c.parsed.y:c.parsed)}} },
    scales: type==='doughnut' ? undefined : {
      x:{ grid:{display:false}, ticks:{font:{family:'ui-monospace, Menlo, Consolas, monospace',size:10}} },
      y:{ grid:{color:'rgba(27,42,34,0.08)'}, ticks:{font:{family:'ui-monospace, Menlo, Consolas, monospace',size:10}, callback:(v)=>{
        if(Math.abs(v)>=100000) return '₹'+(v/100000).toFixed(1)+'L';
        return '₹'+v;
      }} }
    }
  };
  charts[id] = new Chart(ctx, { type, data:{ labels, datasets }, options: Object.assign(base, opts||{}) });
}

function renderCategoryChart(){
  const filtered = getFilteredTx().filter(t=>t.type==='expense');
  const byCat = {};
  filtered.forEach(t=>{ byCat[t.category] = (byCat[t.category]||0) + t.amount; });
  const labels = Object.keys(byCat);
  const data = Object.values(byCat);
  const palette = ['#1F6F50','#C98A2C','#A2452F','#4B5A50','#7a9e8f','#d9b06b','#c47a68','#8fa89d'];
  if(labels.length===0){
    drawChart('categoryChart', ['No expenses'], [{data:[1], backgroundColor:['#c7cdb9']}], {plugins:{legend:{display:false}}}, 'doughnut');
    return;
  }
  drawChart('categoryChart', labels, [{ data, backgroundColor: labels.map((_,i)=>palette[i%palette.length]) }], {}, 'doughnut');
}

function renderTrendChart(){
  const months = [];
  const now = new Date();
  for(let i=5;i>=0;i--){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    months.push(d.toISOString().slice(0,7));
  }
  const incomeData = months.map(m => transactions.filter(t=>t.type==='income' && monthKey(t.date)===m).reduce((s,t)=>s+t.amount,0));
  const expenseData = months.map(m => transactions.filter(t=>t.type==='expense' && monthKey(t.date)===m).reduce((s,t)=>s+t.amount,0));
  const labels = months.map(m=>{
    const [y,mo] = m.split('-');
    return new Date(y, mo-1, 1).toLocaleString('en-IN', {month:'short'});
  });
  drawChart('trendChart', labels, [
    {label:'Income', data:incomeData, backgroundColor:'#1F6F50'},
    {label:'Expenses', data:expenseData, backgroundColor:'#A2452F'}
  ], {}, 'bar');
}

function renderAll(){
  populateMonthFilter();
  populateCategoryFilter();
  renderSummary();
  renderList();
  renderCategoryChart();
  renderTrendChart();
}

// ---------- Data export / import ----------
function downloadBlob(filename, content, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
document.getElementById('exportJson').addEventListener('click', ()=>{
  const payload = { transactions, categories, exportedAt: new Date().toISOString() };
  downloadBlob('spending-tracker-backup-'+new Date().toISOString().slice(0,10)+'.json', JSON.stringify(payload, null, 2), 'application/json');
  localStorage.setItem('spendingTracker.lastExport', Date.now().toString());
  document.getElementById('backupReminder').style.display = 'none';
});
document.getElementById('exportCsv').addEventListener('click', ()=>{
  const header = 'Date,Type,Category,Description,Amount\n';
  const rows = transactions.slice().sort((a,b)=>a.date.localeCompare(b.date)).map(t=>
    [t.date, t.type, t.category, '"'+(t.description||'').replace(/"/g,'""')+'"', t.amount].join(',')
  ).join('\n');
  downloadBlob('spending-tracker-'+new Date().toISOString().slice(0,10)+'.csv', header+rows, 'text/csv');
});
document.getElementById('importFile').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const data = JSON.parse(reader.result);
      const incoming = Array.isArray(data.transactions) ? data.transactions : [];
      if(!confirm(`Import ${incoming.length} transaction(s)? This will be merged with what's already here (duplicates by ID are skipped).`)) return;
      const existingIds = new Set(transactions.map(t=>t.id));
      incoming.forEach(t=>{ if(t.id && !existingIds.has(t.id)) transactions.push(t); });
      if(data.categories){
        ['income','expense'].forEach(type=>{
          if(Array.isArray(data.categories[type])){
            data.categories[type].forEach(c=>{ if(!categories[type].includes(c)) categories[type].push(c); });
          }
        });
      }
      saveData();
      renderAll();
      alert('Import complete.');
    } catch(err){
      alert('Could not read that file — make sure it\'s a backup exported from this tracker.');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});
document.getElementById('clearAll').addEventListener('click', ()=>{
  if(!confirm('Delete ALL transactions on this device? This cannot be undone. Consider exporting a backup first.')) return;
  if(!confirm('Really sure? This is permanent.')) return;
  transactions = [];
  saveData();
  renderAll();
});

// ---------- Google Drive backup (optional, opt-in only — nothing here loads until you click Connect) ----------
const DRIVE_FILE_NAME = 'spending-tracker-backup.json';
let gsiClient = null;
let driveAccessToken = null;
let driveTokenExpiry = 0;

function loadGoogleClientId(){ return localStorage.getItem('spendingTracker.googleClientId') || ''; }
function saveGoogleClientId(id){ localStorage.setItem('spendingTracker.googleClientId', id); }

document.getElementById('googleClientIdInput').value = loadGoogleClientId();
document.getElementById('saveClientId').addEventListener('click', ()=>{
  const id = document.getElementById('googleClientIdInput').value.trim();
  saveGoogleClientId(id);
  gsiClient = null; // force re-init with new client id
  if(id){
    setDriveStatus('Client ID saved — preparing Google Sign-In…');
    loadGsiScript(()=>{
      initGsi();
      setDriveStatus('Ready. Click Connect Google Drive.');
    });
  } else {
    setDriveStatus('Not connected');
  }
});

function setDriveStatus(text, connected){
  const el = document.getElementById('driveStatus');
  el.textContent = text;
  el.classList.toggle('connected', !!connected);
}

function loadGsiScript(cb){
  if(window.google && google.accounts && google.accounts.oauth2){ cb(); return; }
  const existing = document.getElementById('gsi-script');
  if(existing){ existing.addEventListener('load', cb, {once:true}); return; }
  const s = document.createElement('script');
  s.id = 'gsi-script';
  s.src = 'https://accounts.google.com/gsi/client';
  s.onload = cb;
  s.onerror = () => { setDriveStatus('Could not load Google Sign-In — check your connection.'); };
  document.head.appendChild(s);
}

function initGsi(){
  const clientId = loadGoogleClientId();
  if(!clientId || !window.google) return false;
  gsiClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: 'https://www.googleapis.com/auth/drive.file openid email',
    callback: () => {} // overwritten per-call below
  });
  return true;
}

function requestDriveToken(onGranted){
  const clientId = loadGoogleClientId();
  if(!clientId){ alert('Paste your Google OAuth Client ID above first, then click Save.'); return; }
  // Fast path: script + client already prepared (the common case) — call
  // requestAccessToken() synchronously within this click so the browser
  // still treats the popup as user-initiated and doesn't silently block it.
  if(gsiClient){
    gsiClient.callback = (resp)=>{
      if(resp.error){ setDriveStatus('Connection failed: '+resp.error); return; }
      driveAccessToken = resp.access_token;
      driveTokenExpiry = Date.now() + (resp.expires_in*1000);
      fetchDriveUserInfo();
      if(onGranted) onGranted();
    };
    gsiClient.requestAccessToken();
    return;
  }
  // Slow path: first time, script/client not ready yet. Prepare them now,
  // but the popup may get blocked this one time since it's no longer a
  // same-tick user gesture — tell the person to click Connect once more.
  setDriveStatus('Preparing Google Sign-In — click Connect Google Drive once more…');
  loadGsiScript(()=>{
    if(!initGsi()){ setDriveStatus('Could not start Google Sign-In. Double check your Client ID.'); return; }
    setDriveStatus('Ready — click Connect Google Drive again.');
  });
}

async function fetchDriveUserInfo(){
  try{
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers:{ Authorization:'Bearer '+driveAccessToken } });
    const info = await res.json();
    setDriveStatus('Connected as '+(info.email||'Google account'), true);
  } catch(e){
    setDriveStatus('Connected', true);
  }
}

function ensureToken(cb){
  if(driveAccessToken && Date.now() < driveTokenExpiry-5000){ cb(); return; }
  requestDriveToken(cb);
}

document.getElementById('connectDrive').addEventListener('click', ()=> requestDriveToken());

// If a Client ID was already saved in a previous session, preload the
// sign-in script right away so the very first Connect click this session
// still works on the first try.
if(loadGoogleClientId()){
  loadGsiScript(()=>{ initGsi(); setDriveStatus('Ready. Click Connect Google Drive.'); });
}

async function findDriveFile(){
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime)`, {
    headers:{ Authorization:'Bearer '+driveAccessToken }
  });
  if(!res.ok) throw new Error('Drive list failed');
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

document.getElementById('backupToDrive').addEventListener('click', ()=>{
  ensureToken(async ()=>{
    try{
      const payload = JSON.stringify({ transactions, categories, exportedAt: new Date().toISOString() }, null, 2);
      const existing = await findDriveFile();
      const metadata = { name: DRIVE_FILE_NAME, mimeType: 'application/json' };
      const boundary = 'ledgerboundary' + Date.now();
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
      const url = existing
        ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
      const res = await fetch(url, {
        method: existing ? 'PATCH' : 'POST',
        headers:{ Authorization:'Bearer '+driveAccessToken, 'Content-Type':`multipart/related; boundary=${boundary}` },
        body
      });
      if(res.ok){
        localStorage.setItem('spendingTracker.lastExport', Date.now().toString());
        document.getElementById('backupReminder').style.display = 'none';
        alert('Backed up to Google Drive.');
      } else {
        alert('Backup failed (HTTP '+res.status+'). Try reconnecting.');
      }
    } catch(e){
      alert('Backup failed — check your connection and try again.');
    }
  });
});

document.getElementById('restoreFromDrive').addEventListener('click', ()=>{
  ensureToken(async ()=>{
    try{
      const file = await findDriveFile();
      if(!file){ alert('No backup found in Drive yet — use Backup to Drive first.'); return; }
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
        headers:{ Authorization:'Bearer '+driveAccessToken }
      });
      if(!res.ok){ alert('Restore failed (HTTP '+res.status+').'); return; }
      const data = await res.json();
      const incoming = Array.isArray(data.transactions) ? data.transactions : [];
      if(!confirm(`Restore ${incoming.length} transaction(s) from Drive? This merges with what's already on this device (duplicates by ID are skipped).`)) return;
      const existingIds = new Set(transactions.map(t=>t.id));
      incoming.forEach(t=>{ if(t.id && !existingIds.has(t.id)) transactions.push(t); });
      if(data.categories){
        ['income','expense'].forEach(type=>{
          if(Array.isArray(data.categories[type])) data.categories[type].forEach(c=>{ if(!categories[type].includes(c)) categories[type].push(c); });
        });
      }
      saveData();
      renderAll();
      alert('Restored from Google Drive.');
    } catch(e){
      alert('Restore failed — check your connection and try again.');
    }
  });
});

document.getElementById('disconnectDrive').addEventListener('click', ()=>{
  if(driveAccessToken && window.google && google.accounts){
    google.accounts.oauth2.revoke(driveAccessToken, ()=>{});
  }
  driveAccessToken = null;
  driveTokenExpiry = 0;
  setDriveStatus('Not connected');
});

// (Client ID preload handled above, right after the Connect button wiring.)

// ---------- Init ----------
loadData();
resetForm();
renderAll();
checkBackupReminder();

function checkBackupReminder(){
  if(transactions.length===0) return;
  const dismissedAt = +(sessionStorage.getItem('spendingTracker.reminderDismissed')||0);
  if(dismissedAt) return; // don't nag again this session
  const lastExport = +(localStorage.getItem('spendingTracker.lastExport')||0);
  const daysSince = lastExport ? (Date.now()-lastExport)/(1000*60*60*24) : Infinity;
  if(daysSince > 14){
    document.getElementById('backupReminder').style.display = '';
  }
}
document.getElementById('reminderExportBtn').addEventListener('click', ()=> document.getElementById('exportJson').click());
document.getElementById('reminderDismiss').addEventListener('click', ()=>{
  document.getElementById('backupReminder').style.display = 'none';
  sessionStorage.setItem('spendingTracker.reminderDismissed', Date.now().toString());
});

// ---------- Offline support (service worker) ----------
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{ /* fails silently if unsupported */ });
  });
}
