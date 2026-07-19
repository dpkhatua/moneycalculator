
const STORAGE_KEY = 'spendingTracker.transactions.v1';
const CATEGORY_KEY = 'spendingTracker.categories.v1';
const CURRENCY_KEY = 'spendingTracker.currentCurrency';
const NETWORTH_KEY = 'spendingTracker.netWorth.v1';
const BUDGET_KEY = 'spendingTracker.budgets.v1';
const DELETED_KEY = 'spendingTracker.deletedIds.v1';

const DEFAULT_CATEGORIES = {
  expense: ['Food','Transport','Housing','Utilities','Shopping','Entertainment','Health','Education','Other'],
  income: ['Salary','Business','Investment','Gift','Other']
};

const ASSET_CLASS_LABELS = {
  savings:'Savings', fd:'FD', rd:'RD', epf:'EPF', ppf:'PPF', equity:'Equity', mf:'Mutual Fund',
  liquidmf:'Liquid/Short MF', gold:'Gold/Silver', crypto:'Crypto', usstock:'US Stocks',
  realestate:'Real Estate', vehicle:'Vehicle', other:'Other Asset'
};

function emptyNetWorthBucket(){
  return {
    holdings: [],
    liabilities: { homeLoan:0, carLoan:0, ccDebt:0, personalLoan:0, otherLiability:0 },
    lending: [], // money lent to people — intentionally never included in net worth totals
    sips: [],    // ongoing SIPs — installments auto-log on their due date
    insurance: [], // ongoing insurance policies
    recurringExpenses: [] // "definite spending" — fixed bills that auto-log as real expenses on schedule
  };
}

let transactions = [];
let categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
let netWorthData = { INR: emptyNetWorthBucket(), USD: emptyNetWorthBucket() };
let budgets = { INR: {}, USD: {} }; // { category: monthlyBudgetAmount }, per currency
// Tombstones — IDs of anything you've explicitly deleted (transactions,
// holdings, lending records, SIPs, insurance, recurring expenses). Checked
// during every merge (import / Drive restore) so a deletion can never be
// silently undone by an older backup that still has the item in it.
let deletedIds = new Set();
function markDeleted(id){ if(id) deletedIds.add(id); }
function isDeleted(id){ return deletedIds.has(id); }
let currentType = 'expense';
let editingId = null;
// currentCurrency is the single "which country am I looking at" lens: it decides
// what currency new transactions are logged in AND what the summary/list/charts
// show. Switching it never mixes USD and INR totals together.
let currentCurrency = localStorage.getItem(CURRENCY_KEY) || 'INR';

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
function usd(n){
  n = Math.round(n*100)/100;
  if(!isFinite(n)) n = 0;
  const neg = n < 0;
  n = Math.abs(n);
  return (neg?'-':'') + '$' + n.toLocaleString('en-US', {minimumFractionDigits: n%1===0?0:2, maximumFractionDigits:2});
}
function fmtAmount(n, currency){
  return (currency||currentCurrency)==='USD' ? usd(n) : inr(n);
}

// ---- Timezone-safe date helpers ----
// Date-only strings like "2026-07-15" get parsed by `new Date(...)` as UTC
// midnight. Anyone west of UTC (all of the US) then sees it roll back to the
// previous day once displayed in local time. These helpers work entirely in
// local time so "today" and displayed dates always match the calendar date
// you actually meant, regardless of timezone.
function todayLocalISO(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function thisMonthLocal(){ return todayLocalISO().slice(0,7); }
function parseLocalDate(dateStr){
  const [y,m,d] = dateStr.split('-').map(Number);
  return new Date(y, m-1, d); // local time, no UTC shift
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
  try{
    const rawNW = localStorage.getItem(NETWORTH_KEY);
    const parsed = rawNW ? JSON.parse(rawNW) : null;
    netWorthData = {
      INR: Object.assign(emptyNetWorthBucket(), parsed && parsed.INR),
      USD: Object.assign(emptyNetWorthBucket(), parsed && parsed.USD)
    };
  } catch(e){ netWorthData = { INR: emptyNetWorthBucket(), USD: emptyNetWorthBucket() }; }
  // Migration: holdings created before quantity/price tracking get converted
  // into a single lot so no data is lost.
  ['INR','USD'].forEach(cur=>{
    netWorthData[cur].holdings = netWorthData[cur].holdings.map(migrateHolding);
  });
  // Migration: Real Estate/Vehicles/Other used to be flat number fields —
  // convert any non-zero values into regular holdings so nothing is lost,
  // then drop the old fields.
  ['INR','USD'].forEach(cur=>{
    const bucket = netWorthData[cur];
    const flat = bucket.flatAssets;
    if(flat){
      const today = todayLocalISO();
      if(flat.realEstate>0) bucket.holdings.push({ id: nwUid(), assetClass:'realestate', name:'Real estate', currentPrice: flat.realEstate, lots:[{id:nwUid(), date:today, quantity:1, price:flat.realEstate}], sells:[] });
      if(flat.vehicles>0) bucket.holdings.push({ id: nwUid(), assetClass:'vehicle', name:'Vehicles', currentPrice: flat.vehicles, lots:[{id:nwUid(), date:today, quantity:1, price:flat.vehicles}], sells:[] });
      if(flat.otherAsset>0) bucket.holdings.push({ id: nwUid(), assetClass:'other', name:'Other assets', currentPrice: flat.otherAsset, lots:[{id:nwUid(), date:today, quantity:1, price:flat.otherAsset}], sells:[] });
      delete bucket.flatAssets;
    }
  });
  try{
    const rawBudget = localStorage.getItem(BUDGET_KEY);
    const parsedBudget = rawBudget ? JSON.parse(rawBudget) : null;
    budgets = { INR: (parsedBudget && parsedBudget.INR) || {}, USD: (parsedBudget && parsedBudget.USD) || {} };
  } catch(e){ budgets = { INR: {}, USD: {} }; }
  try{
    const rawDeleted = localStorage.getItem(DELETED_KEY);
    deletedIds = new Set(rawDeleted ? JSON.parse(rawDeleted) : []);
  } catch(e){ deletedIds = new Set(); }
  // Migration: transactions logged before multi-currency support have no
  // currency field — treat them as INR, since that was the only option then.
  let migrated = false;
  transactions.forEach(t=>{ if(!t.currency){ t.currency = 'INR'; migrated = true; } });
  if(migrated) saveData();
}
function persistLocal(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
    localStorage.setItem(CATEGORY_KEY, JSON.stringify(categories));
    localStorage.setItem(NETWORTH_KEY, JSON.stringify(netWorthData));
    localStorage.setItem(BUDGET_KEY, JSON.stringify(budgets));
    localStorage.setItem(DELETED_KEY, JSON.stringify([...deletedIds]));
  } catch(e){
    alert('Could not save — your browser storage may be full or blocked (e.g. private browsing mode).');
  }
}
// Use this when data just came FROM Drive, so we don't immediately push the
// same thing straight back and cause a pointless round trip.
function saveDataLocalOnly(){ persistLocal(); }
// Use this for anything the person does locally (add/edit/delete) — it saves
// to this device immediately, and also pushes to Drive in the background if
// currently connected, so multi-device use feels like real syncing.
function saveData(){
  persistLocal();
  if(typeof driveAccessToken !== 'undefined' && driveAccessToken && Date.now() < driveTokenExpiry-5000 && !driveSyncing){
    pushToDrive(true);
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
  document.getElementById('txDate').value = todayLocalISO();
  document.getElementById('txDesc').value = '';
  document.getElementById('txTag').value = '';
  document.getElementById('txAmount').value = '';
  setType('expense');
}

document.getElementById('txSubmit').addEventListener('click', ()=>{
  const date = document.getElementById('txDate').value;
  const category = document.getElementById('txCategory').value;
  const desc = document.getElementById('txDesc').value.trim();
  const tag = document.getElementById('txTag').value.trim();
  const amount = +document.getElementById('txAmount').value;

  if(!date){ alert('Pick a date.'); return; }
  if(!amount || amount<=0){ alert('Enter an amount greater than zero.'); return; }
  if(category==='__add_new__'){ alert('Finish adding the new category first.'); return; }

  if(editingId){
    const tx = transactions.find(t=>t.id===editingId);
    if(tx){ Object.assign(tx, {date, type:currentType, category, description:desc, tag:tag||null, amount, currency:currentCurrency}); }
  } else {
    transactions.push({ id: uid(), date, type: currentType, category, description: desc, tag: tag||null, amount, currency: currentCurrency });
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
  document.getElementById('txTag').value = tx.tag || '';
  document.getElementById('txAmount').value = tx.amount;
  populateCategorySelect();
  document.getElementById('txCategory').value = tx.category;
  document.getElementById('txSubmit').textContent = 'Save changes';
  document.getElementById('editNote').textContent = 'Editing an existing transaction — Save changes will update it in place.';
  window.scrollTo({top: document.querySelector('.tracker-grid').offsetTop - 20, behavior:'smooth'});
}
function deleteTx(id){
  if(!confirm('Delete this transaction? This can\'t be undone.')) return;
  markDeleted(id);
  transactions = transactions.filter(t=>t.id!==id);
  saveData();
  renderAll();
}

// ---------- Filters ----------
function monthKey(dateStr){ return dateStr.slice(0,7); } // YYYY-MM
function txInCurrentCurrency(){ return transactions.filter(t=>t.currency===currentCurrency); }
function populateMonthFilter(){
  const sel = document.getElementById('filterMonth');
  const prevValue = sel.value;
  const months = [...new Set(txInCurrentCurrency().map(t=>monthKey(t.date)))].sort().reverse();
  sel.innerHTML = '<option value="__all__">All time</option>';
  const thisMonth = thisMonthLocal();
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
  const cats = [...new Set(txInCurrentCurrency().map(t=>t.category))].sort();
  sel.innerHTML = '<option value="">All categories</option>';
  cats.forEach(c=>{
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
  if(prevValue) sel.value = prevValue;
}
function populateTagFilter(){
  const sel = document.getElementById('filterTag');
  const prevValue = sel.value;
  const tags = [...new Set(txInCurrentCurrency().map(t=>t.tag).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All tags</option>';
  tags.forEach(tag=>{
    const opt = document.createElement('option');
    opt.value = tag; opt.textContent = tag;
    sel.appendChild(opt);
  });
  if(prevValue) sel.value = prevValue;
  // Also keep the "add transaction" tag field's autocomplete suggestions fresh.
  const datalist = document.getElementById('txTagOptions');
  datalist.innerHTML = tags.map(tag=>`<option value="${escapeHtml(tag)}">`).join('');
}
document.getElementById('filterMonth').addEventListener('change', renderAll);
document.getElementById('filterType').addEventListener('change', renderAll);
document.getElementById('filterCategory').addEventListener('change', renderAll);
document.getElementById('filterTag').addEventListener('change', renderAll);

function getFilteredTx(){
  const month = document.getElementById('filterMonth').value;
  const type = document.getElementById('filterType').value;
  const cat = document.getElementById('filterCategory').value;
  const tag = document.getElementById('filterTag').value;
  return transactions.filter(t=>{
    if(t.currency !== currentCurrency) return false;
    if(month!=='__all__' && monthKey(t.date)!==month) return false;
    if(type && t.type!==type) return false;
    if(cat && t.category!==cat) return false;
    if(tag && t.tag!==tag) return false;
    return true;
  });
}

// ---------- Rendering ----------
function renderSummary(){
  const thisMonth = thisMonthLocal();
  const thisYear = todayLocalISO().slice(0,4);
  const currencyTx = txInCurrentCurrency();
  const monthTx = currencyTx.filter(t=>monthKey(t.date)===thisMonth);
  const monthIncome = monthTx.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
  const monthExpense = monthTx.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
  document.getElementById('sumMonthIncome').textContent = fmtAmount(monthIncome);
  document.getElementById('sumMonthExpense').textContent = fmtAmount(monthExpense);
  const netEl = document.getElementById('sumMonthNet');
  netEl.textContent = fmtAmount(monthIncome-monthExpense);
  netEl.classList.toggle('brick', monthIncome-monthExpense<0);

  const yearTx = currencyTx.filter(t=>t.date.slice(0,4)===thisYear);
  const yearIncome = yearTx.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
  const yearExpense = yearTx.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
  document.getElementById('sumYearIncome').textContent = fmtAmount(yearIncome);
  document.getElementById('sumYearExpense').textContent = fmtAmount(yearExpense);
  const yearNetEl = document.getElementById('sumYearNet');
  yearNetEl.textContent = fmtAmount(yearIncome-yearExpense);
  yearNetEl.classList.toggle('brick', yearIncome-yearExpense<0);

  const allIncome = currencyTx.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
  const allExpense = currencyTx.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
  document.getElementById('sumAllIncome').textContent = fmtAmount(allIncome);
  document.getElementById('sumAllExpense').textContent = fmtAmount(allExpense);
  const balEl = document.getElementById('sumAllBalance');
  balEl.textContent = fmtAmount(allIncome-allExpense);
  balEl.classList.toggle('brick', allIncome-allExpense<0);
}

function escapeHtml(str){
  return String(str==null?'':str).replace(/[&<>"']/g, (m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
// Flags transactions that share the same date, type, category, description,
// and amount as another one — a strong signal of an accidental duplicate
// (e.g. importing the same backup twice), without ever auto-deleting anything.
function findDuplicateTxIds(){
  const groups = {};
  txInCurrentCurrency().forEach(t=>{
    const key = [t.date, t.type, t.category, (t.description||'').trim().toLowerCase(), t.amount].join('|');
    (groups[key] = groups[key] || []).push(t.id);
  });
  const dupIds = new Set();
  Object.values(groups).forEach(ids=>{ if(ids.length>1) ids.forEach(id=>dupIds.add(id)); });
  return dupIds;
}

function renderList(){
  const list = document.getElementById('txList');
  const filtered = getFilteredTx().slice().sort((a,b)=> b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  document.getElementById('txCount').textContent = filtered.length + ' transaction' + (filtered.length===1?'':'s');
  if(filtered.length===0){
    list.innerHTML = '<div class="empty-state">Nothing logged for this filter yet. Add a transaction on the left to get started.</div>';
    return;
  }
  const dupIds = findDuplicateTxIds();
  list.innerHTML = '';
  filtered.forEach(t=>{
    const row = document.createElement('div');
    row.className = 'tx-row';
    const d = parseLocalDate(t.date);
    const dateLabel = d.toLocaleDateString('en-IN', {day:'2-digit', month:'short'});
    const isDup = dupIds.has(t.id);
    row.innerHTML = `
      <div class="tx-date">${escapeHtml(dateLabel)}</div>
      <div class="tx-main">
        <span class="tx-cat">${escapeHtml(t.category)}${t.tag?' · '+escapeHtml(t.tag):''}${isDup?' <span class="dup-badge" title="Same date, amount, category, and description as another transaction — check it is not a duplicate">⚠ possible duplicate</span>':''}</span>
        <span class="tx-desc">${escapeHtml(t.description) || '—'}</span>
      </div>
      <div class="tx-amt ${t.type}">${t.type==='expense' ? '−' : '+'}${fmtAmount(t.amount, t.currency)}</div>
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
      tooltip:{callbacks:{label:(c)=>(c.dataset.label||'')+': '+fmtAmount(c.parsed.y!==undefined?c.parsed.y:c.parsed)}} },
    scales: type==='doughnut' ? undefined : {
      x:{ grid:{display:false}, ticks:{font:{family:'ui-monospace, Menlo, Consolas, monospace',size:10}} },
      y:{ grid:{color:'rgba(27,42,34,0.08)'}, ticks:{font:{family:'ui-monospace, Menlo, Consolas, monospace',size:10}, callback:(v)=>{
        if(currentCurrency==='USD') return '$'+v;
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
  const currencyTx = txInCurrentCurrency();
  const incomeData = months.map(m => currencyTx.filter(t=>t.type==='income' && monthKey(t.date)===m).reduce((s,t)=>s+t.amount,0));
  const expenseData = months.map(m => currencyTx.filter(t=>t.type==='expense' && monthKey(t.date)===m).reduce((s,t)=>s+t.amount,0));
  const labels = months.map(m=>{
    const [y,mo] = m.split('-');
    return new Date(y, mo-1, 1).toLocaleString('en-IN', {month:'short'});
  });
  drawChart('trendChart', labels, [
    {label:'Income', data:incomeData, backgroundColor:'#1F6F50'},
    {label:'Expenses', data:expenseData, backgroundColor:'#A2452F'}
  ], {}, 'bar');
}

function renderYearlyStats(){
  const wrap = document.getElementById('yearlyStatsTable');
  const currencyTx = txInCurrentCurrency();
  if(currencyTx.length===0){
    wrap.innerHTML = '<div class="empty-state">Nothing logged yet.</div>';
    return;
  }
  const years = [...new Set(currencyTx.map(t=>t.date.slice(0,4)))].sort().reverse();
  let html = `
    <table class="cat-table">
      <thead><tr><th>Year</th><th style="text-align:right;">Income</th><th style="text-align:right;">Expenses</th><th style="text-align:right;">Net</th></tr></thead>
      <tbody>
  `;
  years.forEach(year=>{
    const yearTx = currencyTx.filter(t=>t.date.slice(0,4)===year);
    const income = yearTx.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
    const expense = yearTx.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
    const net = income-expense;
    html += `
      <tr>
        <td>${year}</td>
        <td class="num">${fmtAmount(income)}</td>
        <td class="num">${fmtAmount(expense)}</td>
        <td class="num ${net<0?'loss':'gain'}">${net>=0?'+':''}${fmtAmount(net)}</td>
      </tr>
    `;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderMonthlyCategoryTable(){
  const wrap = document.getElementById('monthlyCategoryTable');
  const expenseTx = txInCurrentCurrency().filter(t=>t.type==='expense');
  if(expenseTx.length===0){
    wrap.innerHTML = '<div class="empty-state">No expenses logged yet.</div>';
    return;
  }
  // Months present, most recent first; categories actually used, alphabetical.
  const months = [...new Set(expenseTx.map(t=>monthKey(t.date)))].sort().reverse();
  const cats = [...new Set(expenseTx.map(t=>t.category))].sort();

  let html = `
    <table class="cat-table">
      <thead><tr><th>Month</th>${cats.map(c=>`<th style="text-align:right;">${escapeHtml(c)}</th>`).join('')}<th style="text-align:right;">Total</th></tr></thead>
      <tbody>
  `;
  months.forEach(m=>{
    const monthTx = expenseTx.filter(t=>monthKey(t.date)===m);
    const [y,mo] = m.split('-');
    const label = new Date(y, mo-1, 1).toLocaleString('en-IN', {month:'short', year:'numeric'});
    let monthTotal = 0;
    const cells = cats.map(cat=>{
      const sum = monthTx.filter(t=>t.category===cat).reduce((s,t)=>s+t.amount,0);
      monthTotal += sum;
      return `<td class="num">${sum>0?fmtAmount(sum):'—'}</td>`;
    }).join('');
    html += `<tr><td>${label}</td>${cells}<td class="num" style="font-weight:600;">${fmtAmount(monthTotal)}</td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderTagBreakdown(){
  const wrap = document.getElementById('tagBreakdownTable');
  const expenseTx = txInCurrentCurrency().filter(t=>t.type==='expense' && t.tag);
  if(expenseTx.length===0){
    wrap.innerHTML = '<div class="empty-state">No tagged transactions yet — add a tag when logging a transaction (e.g. a person or household name).</div>';
    return;
  }
  const byTag = {};
  expenseTx.forEach(t=>{ byTag[t.tag] = (byTag[t.tag]||0) + t.amount; });
  const tags = Object.keys(byTag).sort((a,b)=>byTag[b]-byTag[a]);
  const total = tags.reduce((s,t)=>s+byTag[t],0);

  let html = `
    <table class="cat-table">
      <thead><tr><th>Tag</th><th style="text-align:right;">Total spent</th><th style="text-align:right;">% of tagged spending</th></tr></thead>
      <tbody>
  `;
  tags.forEach(tag=>{
    const amt = byTag[tag];
    const pct = total>0 ? (amt/total)*100 : 0;
    html += `
      <tr>
        <td>${escapeHtml(tag)}</td>
        <td class="num">${fmtAmount(amt)}</td>
        <td class="num">${pct.toFixed(1)}%</td>
      </tr>
    `;
  });
  html += `
      <tr class="total-row">
        <td>Total</td>
        <td class="num">${fmtAmount(total)}</td>
        <td class="num">100%</td>
      </tr>
    </tbody></table>
  `;
  wrap.innerHTML = html;
}

// ---------- Budget Plan ----------
function getBudgets(){ return budgets[currentCurrency]; }

function populateBudgetCategorySelect(){
  const sel = document.getElementById('budgetCategory');
  const prevValue = sel.value;
  sel.innerHTML = '';
  categories.expense.forEach(c=>{
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
  if(prevValue && [...sel.options].some(o=>o.value===prevValue)) sel.value = prevValue;
}

document.getElementById('saveBudget').addEventListener('click', ()=>{
  const category = document.getElementById('budgetCategory').value;
  const amount = +document.getElementById('budgetAmount').value;
  if(!category){ alert('Pick a category.'); return; }
  if(!amount || amount<=0){ alert('Enter a budget amount greater than zero.'); return; }
  getBudgets()[category] = amount;
  saveData();
  document.getElementById('budgetAmount').value = '';
  renderBudget();
});

function removeBudget(category){
  if(!confirm(`Remove the budget for "${category}"?`)) return;
  delete getBudgets()[category];
  saveData();
  renderBudget();
}
function editBudget(category){
  const current = getBudgets()[category];
  const raw = prompt(`Monthly budget for "${category}":`, current);
  if(raw===null) return;
  const amt = +raw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  getBudgets()[category] = amt;
  saveData();
  renderBudget();
}

function renderBudgetList(){
  const wrap = document.getElementById('budgetList');
  const budgetMap = getBudgets();
  const cats = Object.keys(budgetMap);
  if(cats.length===0){
    wrap.innerHTML = '<div class="empty-state">No category budgets set yet — add one above.</div>';
    return;
  }
  const thisMonth = thisMonthLocal();
  const monthExpenseTx = txInCurrentCurrency().filter(t=>t.type==='expense' && monthKey(t.date)===thisMonth);

  wrap.innerHTML = '';
  cats.sort().forEach(cat=>{
    const budgeted = budgetMap[cat];
    const spent = monthExpenseTx.filter(t=>t.category===cat).reduce((s,t)=>s+t.amount,0);
    const remaining = budgeted - spent;
    const pct = budgeted>0 ? Math.min(100, (spent/budgeted)*100) : 0;
    const over = spent>budgeted;

    const row = document.createElement('div');
    row.className = 'budget-row';
    row.innerHTML = `
      <div class="b-top">
        <span class="b-cat">${escapeHtml(cat)}</span>
        <span class="b-figures"><b>${fmtAmount(spent)}</b> of ${fmtAmount(budgeted)} — ${over?'over by '+fmtAmount(Math.abs(remaining)):fmtAmount(remaining)+' left'}</span>
      </div>
      <div class="budget-bar-track"><div class="budget-bar-fill${over?' over':''}" style="width:${pct}%;"></div></div>
      <div class="b-actions">
        <button data-action="edit">✎ Edit</button>
        <button data-action="del">× Remove</button>
      </div>
    `;
    row.querySelector('[data-action=edit]').addEventListener('click', ()=>editBudget(cat));
    row.querySelector('[data-action=del]').addEventListener('click', ()=>removeBudget(cat));
    wrap.appendChild(row);
  });
}

function renderBudgetSummary(){
  const budgetMap = getBudgets();
  const cats = Object.keys(budgetMap);
  const thisMonth = thisMonthLocal();
  const monthExpenseTx = txInCurrentCurrency().filter(t=>t.type==='expense' && monthKey(t.date)===thisMonth);
  const totalPlanned = cats.reduce((s,c)=>s+budgetMap[c],0);
  const totalSpent = cats.reduce((s,c)=>s+monthExpenseTx.filter(t=>t.category===c).reduce((s2,t)=>s2+t.amount,0),0);
  document.getElementById('budgetTotalPlanned').textContent = fmtAmount(totalPlanned);
  document.getElementById('budgetTotalSpent').textContent = fmtAmount(totalSpent);
  const remEl = document.getElementById('budgetTotalRemaining');
  remEl.textContent = fmtAmount(totalPlanned-totalSpent);
  remEl.classList.toggle('brick', totalPlanned-totalSpent<0);
}

function renderBudget(){
  populateBudgetCategorySelect();
  renderBudgetList();
  renderBudgetSummary();
}


// ---------- Net Worth ----------
function getNW(){ return netWorthData[currentCurrency]; }

function nwUid(){ return 'nw_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }

function daysBetween(dateStr1, dateStr2){
  const d1 = parseLocalDate(dateStr1), d2 = parseLocalDate(dateStr2);
  return Math.round((d2 - d1) / (1000*60*60*24));
}

// Adds n months to a YYYY-MM-DD date, clamping to the last day of the target
// month if the original day doesn't exist there (e.g. Jan 31 + 1 month -> Feb 28).
function addMonthsClamped(dateStr, n){
  const [y,m,d] = dateStr.split('-').map(Number);
  const totalMonthIndex = (m-1) + n;
  const targetYear = y + Math.floor(totalMonthIndex/12);
  const targetMonth = ((totalMonthIndex%12)+12)%12; // 0-based
  const lastDay = new Date(targetYear, targetMonth+1, 0).getDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(targetMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function addDays(dateStr, n){
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// Generic "advance by one period" for any frequency (weekly = days, monthly/quarterly = months).
function advanceDate(dateStr, unit, value){
  return unit==='days' ? addDays(dateStr, value) : addMonthsClamped(dateStr, value);
}
const SIP_FREQ_LABEL = { 'days:7':'Weekly', 'months:1':'Monthly', 'months:3':'Quarterly' };
function sipFrequencyLabel(sip){ return SIP_FREQ_LABEL[`${sip.frequencyUnit}:${sip.frequencyValue}`] || `Every ${sip.frequencyValue} ${sip.frequencyUnit}`; }
// Normalizes any frequency into a comparable monthly-equivalent figure, so
// mixed weekly/monthly/quarterly SIPs can still be summed into one commitment total.
function sipMonthlyEquivalent(sip){
  if(sip.frequencyUnit==='days') return sip.amount * (30.44/sip.frequencyValue);
  return sip.amount / sip.frequencyValue;
}
function periodsPerYear(unit, value){ return unit==='days' ? 365/value : 12/value; }
function sipPaidThisYear(sip){
  const year = todayLocalISO().slice(0,4);
  return sip.installments.filter(i=>i.date.slice(0,4)===year).reduce((s,i)=>s+i.amount,0);
}
function sipYearlyRequirement(sip){ return sip.amount * periodsPerYear(sip.frequencyUnit, sip.frequencyValue); }
function sipNeededThisYear(sip){ return Math.max(0, sipYearlyRequirement(sip) - sipPaidThisYear(sip)); }

// ---- Derived figures from a holding's lot history (all computed, nothing stored redundantly) ----
function holdingQuantity(h){ return h.lots.reduce((s,l)=>s+l.quantity, 0); }
function holdingInvested(h){ return h.lots.reduce((s,l)=>s+l.quantity*l.price, 0); }
function holdingAvgPrice(h){ const q = holdingQuantity(h); return q>0 ? holdingInvested(h)/q : 0; }
function holdingCurrentValue(h){ return holdingQuantity(h) * (h.currentPrice||0); }
function holdingOldestLotDate(h){
  if(h.lots.length===0) return null;
  return h.lots.reduce((min,l)=> l.date < min ? l.date : min, h.lots[0].date);
}
function holdingRealizedPL(h){ return (h.sells||[]).reduce((s,x)=>s+x.realizedPL, 0); }

// Old holdings (before quantity/price tracking) get converted into a single
// lot of quantity 1 at the old invested amount, so nothing is lost — you can
// keep using them as-is, or edit the quantity/price going forward.
function migrateHolding(h){
  if(h.lots) return h;
  return {
    id: h.id, assetClass: h.assetClass, name: h.name,
    currentPrice: h.current!=null ? h.current : (h.invested||0),
    lots: [{ id: nwUid(), date: (h.log && h.log[0] && h.log[0].date) || todayLocalISO(), quantity: 1, price: h.invested||0 }],
    sells: []
  };
}

document.getElementById('addHolding').addEventListener('click', ()=>{
  const assetClass = document.getElementById('holdingClass').value;
  const name = document.getElementById('holdingName').value.trim();
  const qtyRaw = document.getElementById('holdingUnits').value;
  const quantity = qtyRaw==='' ? 1 : +qtyRaw;
  const price = +document.getElementById('holdingPrice').value;
  const date = document.getElementById('holdingDate').value || todayLocalISO();
  const currentPriceRaw = document.getElementById('holdingCurrentPrice').value;
  const currentPrice = currentPriceRaw==='' ? price : +currentPriceRaw;
  const ticker = document.getElementById('holdingTicker').value.trim();
  const note = document.getElementById('holdingNote').value.trim();

  if(!name){ alert('Give this holding a name.'); return; }
  if(!price || price<=0){ alert('Enter a buy price greater than zero.'); return; }
  if(!quantity || quantity<=0){ alert('Enter a quantity/units greater than zero.'); return; }

  getNW().holdings.push({
    id: nwUid(),
    assetClass,
    name,
    ticker: ticker || null,
    note: note || null,
    currentPrice,
    lots: [{ id: nwUid(), date, quantity, price }],
    sells: []
  });
  saveData();
  document.getElementById('holdingName').value = '';
  document.getElementById('holdingUnits').value = '1';
  document.getElementById('holdingPrice').value = '';
  document.getElementById('holdingCurrentPrice').value = '';
  document.getElementById('holdingTicker').value = '';
  document.getElementById('holdingNote').value = '';
  document.getElementById('holdingDate').value = todayLocalISO();
  renderNetWorth();
});

function buyHolding(id){
  const h = getNW().holdings.find(x=>x.id===id);
  if(!h) return;
  const qtyRaw = prompt(`Buy more of "${h.name}" — quantity/units:`, '');
  if(!qtyRaw) return;
  const quantity = +qtyRaw;
  if(!quantity || quantity<=0){ alert('Enter a valid quantity.'); return; }
  const priceRaw = prompt('Buy price per unit:', h.currentPrice || '');
  if(!priceRaw) return;
  const price = +priceRaw;
  if(!price || price<=0){ alert('Enter a valid price.'); return; }
  const dateRaw = prompt('Buy date (YYYY-MM-DD):', todayLocalISO());
  const date = dateRaw || todayLocalISO();

  h.lots.push({ id: nwUid(), date, quantity, price });
  h.currentPrice = price;
  saveData();
  renderNetWorth();
}

function sellHolding(id){
  const h = getNW().holdings.find(x=>x.id===id);
  if(!h) return;
  const totalQty = holdingQuantity(h);
  if(totalQty<=0){ alert('Nothing left to sell.'); return; }
  const qtyRaw = prompt(`Sell from "${h.name}" — quantity/units (you hold ${totalQty}):`, '');
  if(!qtyRaw) return;
  const sellQty = +qtyRaw;
  if(!sellQty || sellQty<=0){ alert('Enter a valid quantity.'); return; }
  if(sellQty > totalQty){ alert(`You only hold ${totalQty} units.`); return; }
  const priceRaw = prompt('Sell price per unit:', h.currentPrice || '');
  if(!priceRaw) return;
  const sellPrice = +priceRaw;
  if(!sellPrice || sellPrice<=0){ alert('Enter a valid price.'); return; }
  const dateRaw = prompt('Sell date (YYYY-MM-DD):', todayLocalISO());
  const sellDate = dateRaw || todayLocalISO();

  // FIFO: consume the oldest lots first, splitting a lot if the sale only
  // takes part of it. This is also what most tax authorities assume by
  // default for holding-period purposes (oldest units sold first).
  h.lots.sort((a,b)=>a.date.localeCompare(b.date));
  let remaining = sellQty;
  let costBasisTotal = 0;
  let weightedDaysSum = 0;
  const newLots = [];
  for(const lot of h.lots){
    if(remaining<=0){ newLots.push(lot); continue; }
    if(lot.quantity<=remaining){
      costBasisTotal += lot.quantity*lot.price;
      weightedDaysSum += lot.quantity * daysBetween(lot.date, sellDate);
      remaining -= lot.quantity;
      // fully consumed — dropped from newLots
    } else {
      costBasisTotal += remaining*lot.price;
      weightedDaysSum += remaining * daysBetween(lot.date, sellDate);
      newLots.push({ id: lot.id, date: lot.date, quantity: lot.quantity-remaining, price: lot.price });
      remaining = 0;
    }
  }
  h.lots = newLots;
  const realizedPL = sellQty*sellPrice - costBasisTotal;
  const daysHeld = Math.round(weightedDaysSum/sellQty);
  h.sells = h.sells || [];
  h.sells.push({ id: nwUid(), date: sellDate, quantity: sellQty, price: sellPrice, costBasis: costBasisTotal, realizedPL, daysHeld });
  h.currentPrice = sellPrice;
  saveData();
  renderNetWorth();
}

function updateHoldingValue(id){
  const h = getNW().holdings.find(x=>x.id===id);
  if(!h) return;
  const raw = prompt(`Update current market price per unit of "${h.name}" (was ${fmtAmount(h.currentPrice)}):`, h.currentPrice);
  if(raw===null || raw==='') return;
  const val = +raw;
  if(isNaN(val) || val<0){ alert('Enter a valid price.'); return; }
  h.currentPrice = val;
  saveData();
  renderNetWorth();
}
function deleteHolding(id){
  const h = getNW().holdings.find(x=>x.id===id);
  if(!h) return;
  if(!confirm(`Delete "${h.name}" entirely, including its buy/sell history? This can't be undone.`)) return;
  markDeleted(id);
  getNW().holdings = getNW().holdings.filter(x=>x.id!==id);
  saveData();
  renderNetWorth();
}

function toggleHoldingLog(id){
  const el = document.getElementById('log-'+id);
  if(el) el.style.display = el.style.display==='none' ? '' : 'none';
}

function setHoldingTicker(id){
  const h = getNW().holdings.find(x=>x.id===id);
  if(!h) return;
  const raw = prompt(`Ticker / Coin ID for "${h.name}" (e.g. AAPL, bitcoin, RELIANCE.BSE):`, h.ticker||'');
  if(raw===null) return;
  h.ticker = raw.trim() || null;
  saveData();
  renderNetWorth();
}

function setHoldingNote(id){
  const h = getNW().holdings.find(x=>x.id===id);
  if(!h) return;
  const raw = prompt(`A few words about "${h.name}":`, h.note||'');
  if(raw===null) return;
  h.note = raw.trim() || null;
  saveData();
  renderNetWorth();
}

function editHoldingInfo(id){
  const h = getNW().holdings.find(x=>x.id===id);
  if(!h) return;
  const newName = prompt('Name:', h.name);
  if(newName===null) return;
  if(!newName.trim()){ alert('Name can\'t be empty.'); return; }

  const validClasses = Object.keys(ASSET_CLASS_LABELS);
  const classList = validClasses.map(c=>`${c} (${ASSET_CLASS_LABELS[c]})`).join(', ');
  const newClass = prompt(`Asset type — enter one of:\n${classList}`, h.assetClass);
  if(newClass===null) return;
  const trimmedClass = newClass.trim();
  if(trimmedClass && !validClasses.includes(trimmedClass)){
    alert('Not a recognized asset type — nothing changed. Use one of the exact codes shown (e.g. "equity", "crypto").');
    return;
  }

  h.name = newName.trim();
  if(trimmedClass) h.assetClass = trimmedClass;
  saveData();
  renderNetWorth();
}

function editLot(holdingId, lotId){
  const h = getNW().holdings.find(x=>x.id===holdingId);
  if(!h) return;
  const lot = h.lots.find(l=>l.id===lotId);
  if(!lot) return;

  const qtyRaw = prompt('Quantity/units for this buy:', lot.quantity);
  if(qtyRaw===null) return;
  const qty = +qtyRaw;
  if(!qty || qty<=0){ alert('Enter a valid quantity.'); return; }

  const priceRaw = prompt('Price per unit for this buy:', lot.price);
  if(priceRaw===null) return;
  const price = +priceRaw;
  if(!price || price<=0){ alert('Enter a valid price.'); return; }

  const dateRaw = prompt('Date (YYYY-MM-DD):', lot.date);
  if(dateRaw===null) return;

  const noteRaw = prompt('Note (optional):', lot.note||'');
  if(noteRaw===null) return;

  lot.quantity = qty;
  lot.price = price;
  lot.date = dateRaw || lot.date;
  lot.note = noteRaw.trim() || null;
  saveData();
  renderNetWorth();
}

function deleteLot(holdingId, lotId){
  const h = getNW().holdings.find(x=>x.id===holdingId);
  if(!h) return;
  if(h.lots.length===1 && (!h.sells || h.sells.length===0)){
    if(!confirm('This is the only buy on this holding — deleting it will remove the whole holding. Continue?')) return;
    getNW().holdings = getNW().holdings.filter(x=>x.id!==holdingId);
    saveData();
    renderNetWorth();
    return;
  }
  if(!confirm('Delete this buy entry?')) return;
  h.lots = h.lots.filter(l=>l.id!==lotId);
  saveData();
  renderNetWorth();
}

function deleteSell(holdingId, sellId){
  const h = getNW().holdings.find(x=>x.id===holdingId);
  if(!h) return;
  if(!confirm('Delete this sell record?\n\nNote: this removes it from your history and realized P&L, but doesn\'t automatically restore the sold units back into the holding — if you need those units back, use "+ Buy" to re-add them at the correct price.')) return;
  h.sells = (h.sells||[]).filter(s=>s.id!==sellId);
  saveData();
  renderNetWorth();
}

// ---- Auto price fetch: a scheduled GitHub Action fetches prices (US stocks,
// Indian NSE/BSE stocks, and crypto, all via one source) and publishes them
// to prices.json in this repo. The browser just reads that file — nothing
// calls an external API directly, so there's no key to manage here and no
// CORS uncertainty. See tickers.json and .github/workflows/update-prices.yml.
async function fetchPricesJson(){
  try{
    const res = await fetch('./prices.json', { cache: 'no-store' });
    if(!res.ok) return null;
    return await res.json();
  } catch(e){ return null; }
}

function resolvePrice(entry, pricesData){
  if(!entry) return { error: 'Ticker not found in prices.json — check tickers.json and that the Action has run' };
  const wantCurrency = currentCurrency;
  if(entry.currency === wantCurrency) return { price: entry.price };
  const rate = pricesData && pricesData.usdToInr;
  if(!rate) return { error: `Priced in ${entry.currency}, but you're viewing ${wantCurrency}, and no USD/INR rate was published to convert it` };
  if(entry.currency==='USD' && wantCurrency==='INR') return { price: entry.price * rate };
  if(entry.currency==='INR' && wantCurrency==='USD') return { price: entry.price / rate };
  return { error: `Can't convert ${entry.currency} to ${wantCurrency}` };
}

async function refreshHoldingPrice(id){
  const h = getNW().holdings.find(x=>x.id===id);
  if(!h) return;
  if(!h.ticker){ alert('Add a ticker/coin ID to this holding first (\uD83D\uDD17 button).'); return; }
  const status = document.getElementById('priceRefreshStatus');
  status.textContent = `Fetching ${h.name}\u2026`;
  const pricesData = await fetchPricesJson();
  if(!pricesData){ status.textContent = 'Could not load prices.json \u2014 has the GitHub Action run yet?'; return; }
  const result = resolvePrice(pricesData[h.ticker], pricesData);
  if(result.price!=null){
    h.currentPrice = result.price;
    saveData();
    renderNetWorth();
    status.textContent = `Updated ${h.name} to ${fmtAmount(result.price)}.`;
  } else {
    status.textContent = `Couldn't update ${h.name}: ${result.error} \u2014 update it manually instead.`;
  }
}

document.getElementById('refreshAllPrices').addEventListener('click', async ()=>{
  const status = document.getElementById('priceRefreshStatus');
  const holdings = getNW().holdings.filter(h=>h.ticker);
  if(holdings.length===0){ status.textContent = 'No holdings have a ticker/coin ID set yet.'; return; }
  status.textContent = `Refreshing ${holdings.length} holding(s)\u2026`;
  const pricesData = await fetchPricesJson();
  if(!pricesData){ status.textContent = 'Could not load prices.json \u2014 has the GitHub Action run yet? Check the Actions tab in your repo.'; return; }
  let updated = 0, failed = 0;
  holdings.forEach(h=>{
    const result = resolvePrice(pricesData[h.ticker], pricesData);
    if(result.price!=null){ h.currentPrice = result.price; updated++; }
    else failed++;
  });
  saveData();
  renderNetWorth();
  const updatedAt = pricesData.updatedAt ? new Date(pricesData.updatedAt).toLocaleString() : 'unknown time';
  status.textContent = `Updated ${updated} holding(s)${failed>0?`, ${failed} not found/convertible \u2014 update those manually`:''}. Prices last published: ${updatedAt}.`;
});


const CATEGORY_GROUPS = [
  { name: 'Bank & Deposits', classes: ['savings','fd','rd'] },
  { name: 'Retirement', classes: ['epf','ppf'] },
  { name: 'Equity', classes: ['equity'] },
  { name: 'Mutual Fund', classes: ['mf'] },
  { name: 'Liquid Fund', classes: ['liquidmf'] },
  { name: 'Gold', classes: ['gold'] },
  { name: 'International', classes: ['usstock'] },
  { name: 'Other', classes: ['crypto','realestate','vehicle','other'] }
];
// Which category groups are currently expanded — resets on page reload,
// same as any collapsible section. Collapsed by default so you only open
// up the category you actually want to check.
let categoryExpandState = {};

function toggleCategoryGroup(name){
  categoryExpandState[name] = !categoryExpandState[name];
  renderHoldingsList();
}

function buildHoldingCard(h, today){
  const qty = holdingQuantity(h);
  const invested = holdingInvested(h);
  const avgPrice = holdingAvgPrice(h);
  const currentValue = holdingCurrentValue(h);
  const unrealized = currentValue - invested;
  const unrealizedPct = invested>0 ? (unrealized/invested)*100 : 0;
  const oldestDate = holdingOldestLotDate(h);
  const daysHeld = oldestDate ? daysBetween(oldestDate, today) : null;
  const realizedPL = holdingRealizedPL(h);
  const sellCount = (h.sells||[]).length;

  const card = document.createElement('div');
  card.className = 'holding-card';
  card.innerHTML = `
    <div class="hc-top">
      <span class="h-class">${escapeHtml(ASSET_CLASS_LABELS[h.assetClass]||h.assetClass)}</span>
      <span class="h-name">${escapeHtml(h.name)}${qty<=0?' (fully sold)':''}</span>
      <span class="h-meta">${h.ticker?escapeHtml(h.ticker)+' · ':''}${daysHeld!==null&&qty>0?'Held '+daysHeld+' day'+(daysHeld===1?'':'s'):''}</span>
    </div>
    ${h.note?`<div class="h-note">${escapeHtml(h.note)}</div>`:''}
    <div class="hc-stats">
      <div class="h-figure"><span class="lbl">Units</span>${qty}</div>
      <div class="h-figure"><span class="lbl">Avg buy</span>${qty>0?fmtAmount(avgPrice):'—'}</div>
      <div class="h-figure"><span class="lbl">Current px</span>${fmtAmount(h.currentPrice)}</div>
      <div class="h-figure"><span class="lbl">Invested</span>${fmtAmount(invested)}</div>
      <div class="h-figure"><span class="lbl">Value</span>${fmtAmount(currentValue)}</div>
      <div class="h-figure h-gain${unrealized<0?' loss':''}"><span class="lbl">Unrealized</span>${qty>0?(unrealized>=0?'+':'')+fmtAmount(unrealized)+' ('+unrealizedPct.toFixed(1)+'%)':'—'}</div>
    </div>
    ${realizedPL!==0?`<div class="h-realized ${realizedPL<0?'loss':''}" style="color:${realizedPL<0?'var(--brick)':'var(--green-deep)'};">Realized P&amp;L: ${realizedPL>=0?'+':''}${fmtAmount(realizedPL)} across ${sellCount} sale${sellCount===1?'':'s'}</div>`:''}
    <div class="h-actions">
      <button class="buy" data-action="buy">+ Buy</button>
      <button class="sell" data-action="sell" ${qty<=0?'disabled':''}>− Sell</button>
      <button data-action="edit">✎ Edit name/type</button>
      <button data-action="mark">Update value</button>
      <button data-action="ticker">🔗 ${h.ticker?'Edit':'Set'} ticker</button>
      ${h.ticker?'<button data-action="refresh">🔄 Refresh</button>':''}
      <button data-action="note">📝 ${h.note?'Edit':'Add'} note</button>
      <button data-action="log">☰ Edit buys/sells</button>
      <button data-action="del">× Delete</button>
    </div>
    <div class="h-log" id="log-${h.id}" style="display:none;"></div>
  `;
  card.querySelector('[data-action=buy]').addEventListener('click', ()=>buyHolding(h.id));
  const sellBtn = card.querySelector('[data-action=sell]');
  if(qty>0) sellBtn.addEventListener('click', ()=>sellHolding(h.id));
  card.querySelector('[data-action=edit]').addEventListener('click', ()=>editHoldingInfo(h.id));
  card.querySelector('[data-action=mark]').addEventListener('click', ()=>updateHoldingValue(h.id));
  card.querySelector('[data-action=ticker]').addEventListener('click', ()=>setHoldingTicker(h.id));
  const refreshBtn = card.querySelector('[data-action=refresh]');
  if(refreshBtn) refreshBtn.addEventListener('click', ()=>refreshHoldingPrice(h.id));
  card.querySelector('[data-action=note]').addEventListener('click', ()=>setHoldingNote(h.id));
  card.querySelector('[data-action=log]').addEventListener('click', ()=>toggleHoldingLog(h.id));
  card.querySelector('[data-action=del]').addEventListener('click', ()=>deleteHolding(h.id));

  // Build the buy/sell log with per-entry edit/delete controls (done as real
  // DOM nodes, not string-joined text, so each entry can carry its own buttons).
  const logEl = card.querySelector('.h-log');
  const lotDupCounts = {};
  h.lots.forEach(l=>{
    const key = [l.date, l.quantity, l.price].join('|');
    lotDupCounts[key] = (lotDupCounts[key]||0)+1;
  });
  h.lots.forEach(l=>{
    const key = [l.date, l.quantity, l.price].join('|');
    const isDup = lotDupCounts[key] > 1;
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `<span>Bought ${l.quantity} unit${l.quantity===1?'':'s'} at ${fmtAmount(l.price)} on ${l.date}${l.note?' — '+escapeHtml(l.note):''}${isDup?' <span class="dup-badge" title="Another buy on this holding has the same date, quantity, and price">⚠ possible duplicate</span>':''}</span>`;
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎';
    editBtn.title = 'Edit this entry';
    editBtn.addEventListener('click', ()=>editLot(h.id, l.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = '×';
    delBtn.title = 'Delete this entry';
    delBtn.addEventListener('click', ()=>deleteLot(h.id, l.id));
    row.appendChild(editBtn);
    row.appendChild(delBtn);
    logEl.appendChild(row);
  });
  (h.sells||[]).forEach(s=>{
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `<span>Sold ${s.quantity} unit${s.quantity===1?'':'s'} at ${fmtAmount(s.price)} on ${s.date} — held ${s.daysHeld} day${s.daysHeld===1?'':'s'} — ${s.realizedPL>=0?'profit':'loss'} of ${fmtAmount(Math.abs(s.realizedPL))}</span>`;
    const delBtn = document.createElement('button');
    delBtn.textContent = '×';
    delBtn.title = 'Delete this entry';
    delBtn.addEventListener('click', ()=>deleteSell(h.id, s.id));
    row.appendChild(delBtn);
    logEl.appendChild(row);
  });
  if(h.lots.length===0 && (!h.sells || h.sells.length===0)){
    logEl.innerHTML = '<span style="color:var(--ink-soft);">No entries.</span>';
  }

  return card;
}

function renderHoldingsList(){
  const wrap = document.getElementById('holdingList');
  const holdings = getNW().holdings;
  if(holdings.length===0){
    wrap.innerHTML = '<div class="empty-state">No holdings logged yet — add one above.</div>';
    return;
  }
  wrap.innerHTML = '';
  const today = todayLocalISO();

  CATEGORY_GROUPS.forEach(group=>{
    const groupHoldings = holdings.filter(h=>group.classes.includes(h.assetClass));
    if(groupHoldings.length===0) return; // hide empty categories entirely

    const subtotal = groupHoldings.reduce((s,h)=>s+holdingCurrentValue(h),0);
    const expanded = !!categoryExpandState[group.name];

    const section = document.createElement('div');
    section.className = 'cat-group';
    const header = document.createElement('div');
    header.className = 'cat-group-header';
    header.innerHTML = `
      <span class="cat-arrow">${expanded?'▾':'▸'}</span>
      <span class="cat-group-name">${escapeHtml(group.name)}</span>
      <span class="cat-group-meta">${groupHoldings.length} holding${groupHoldings.length===1?'':'s'} · ${fmtAmount(subtotal)}</span>
    `;
    header.addEventListener('click', ()=>toggleCategoryGroup(group.name));
    section.appendChild(header);

    if(expanded){
      const body = document.createElement('div');
      body.className = 'cat-group-body';
      groupHoldings
        .sort((a,b)=>a.assetClass.localeCompare(b.assetClass))
        .forEach(h=>body.appendChild(buildHoldingCard(h, today)));
      section.appendChild(body);
    }
    wrap.appendChild(section);
  });
}


function renderNWTotals(){
  const holdings = getNW().holdings;
  const totalInvested = holdings.reduce((s,h)=>s+holdingInvested(h),0);
  const totalCurrent = holdings.reduce((s,h)=>s+holdingCurrentValue(h),0);
  const totalRealized = holdings.reduce((s,h)=>s+holdingRealizedPL(h),0);
  const gain = totalCurrent - totalInvested; // unrealized only
  const totalProfit = gain + totalRealized;

  document.getElementById('nwTotalInvested').textContent = fmtAmount(totalInvested);
  document.getElementById('nwTotalCurrent').textContent = fmtAmount(totalCurrent);
  const gainEl = document.getElementById('nwGainLoss');
  const gainPct = totalInvested>0 ? (gain/totalInvested)*100 : 0;
  gainEl.textContent = (gain>=0?'+':'')+fmtAmount(gain)+' ('+gainPct.toFixed(1)+'%)';
  gainEl.style.color = gain<0 ? 'var(--brick)' : 'var(--green-deep)';

  const thisMonth = thisMonthLocal();
  const thisYear = todayLocalISO().slice(0,4);
  const monthInvested = holdings.reduce((s,h)=> s + h.lots.filter(l=>monthKey(l.date)===thisMonth).reduce((s2,l)=>s2+l.quantity*l.price,0), 0);
  const yearInvested = holdings.reduce((s,h)=> s + h.lots.filter(l=>l.date.slice(0,4)===thisYear).reduce((s2,l)=>s2+l.quantity*l.price,0), 0);
  document.getElementById('nwInvestedThisMonth').textContent = fmtAmount(monthInvested);
  document.getElementById('nwInvestedThisYear').textContent = fmtAmount(yearInvested);

  const realizedEl = document.getElementById('nwRealizedTotal');
  realizedEl.textContent = (totalRealized>=0?'+':'')+fmtAmount(totalRealized);
  realizedEl.style.color = totalRealized<0 ? 'var(--brick)' : 'var(--green-deep)';

  const profitEl = document.getElementById('nwTotalProfit');
  profitEl.textContent = (totalProfit>=0?'+':'')+fmtAmount(totalProfit);
  profitEl.style.color = totalProfit<0 ? 'var(--brick)' : 'var(--green-deep)';

  return totalCurrent;
}

function renderInvestYearlyTable(){
  const wrap = document.getElementById('investYearlyTable');
  const holdings = getNW().holdings;
  const allLots = holdings.flatMap(h=>h.lots.map(l=>({year: l.date.slice(0,4), amount: l.quantity*l.price})));
  const allSells = holdings.flatMap(h=>(h.sells||[]).map(s=>({year: s.date.slice(0,4), pl: s.realizedPL})));
  const years = [...new Set([...allLots.map(l=>l.year), ...allSells.map(s=>s.year)])].sort().reverse();
  if(years.length===0){
    wrap.innerHTML = '<div class="empty-state">No investment activity logged yet.</div>';
    return;
  }
  let html = `
    <table class="cat-table">
      <thead><tr><th>Year</th><th style="text-align:right;">Invested</th><th style="text-align:right;">Realized P&amp;L</th></tr></thead>
      <tbody>
  `;
  years.forEach(year=>{
    const invested = allLots.filter(l=>l.year===year).reduce((s,l)=>s+l.amount,0);
    const realized = allSells.filter(s=>s.year===year).reduce((s,x)=>s+x.pl,0);
    html += `
      <tr>
        <td>${year}</td>
        <td class="num">${fmtAmount(invested)}</td>
        <td class="num ${realized<0?'loss':'gain'}">${realized>=0?'+':''}${fmtAmount(realized)}</td>
      </tr>
    `;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

const ASSET_CLASS_PALETTE = ['#1F6F50','#C98A2C','#A2452F','#4B5A50','#7a9e8f','#d9b06b','#c47a68','#8fa89d','#3d6b8a','#6b5b95','#88a09e'];

function computeCategoryBreakdown(){
  const holdings = getNW().holdings;
  const byClass = {};
  holdings.forEach(h=>{
    if(!byClass[h.assetClass]) byClass[h.assetClass] = { invested:0, current:0 };
    byClass[h.assetClass].invested += holdingInvested(h);
    byClass[h.assetClass].current += holdingCurrentValue(h);
  });
  return Object.keys(byClass)
    .map(assetClass=>({ assetClass, label: ASSET_CLASS_LABELS[assetClass]||assetClass, ...byClass[assetClass] }))
    .sort((a,b)=>b.current-a.current);
}

function renderHoldingsChart(){
  const rows = computeCategoryBreakdown();
  if(rows.length===0 || rows.every(r=>r.current<=0)){
    drawChart('holdingsChart', ['No holdings'], [{data:[1], backgroundColor:['#c7cdb9']}], {plugins:{legend:{display:false}}}, 'doughnut');
    return;
  }
  const labels = rows.map(r=>r.label);
  const data = rows.map(r=>r.current);
  drawChart('holdingsChart', labels, [{ data, backgroundColor: labels.map((_,i)=>ASSET_CLASS_PALETTE[i%ASSET_CLASS_PALETTE.length]) }], {}, 'doughnut');
}

function renderCategoryBreakdownTable(){
  const wrap = document.getElementById('categoryBreakdownTable');
  const rows = computeCategoryBreakdown();
  if(rows.length===0){
    wrap.innerHTML = '';
    return;
  }
  const totalInvested = rows.reduce((s,r)=>s+r.invested,0);
  const totalCurrent = rows.reduce((s,r)=>s+r.current,0);
  const totalGain = totalCurrent - totalInvested;

  let html = `
    <table class="cat-table">
      <thead><tr><th>Category</th><th style="text-align:right;">Invested</th><th style="text-align:right;">Current value</th><th style="text-align:right;">Gain/Loss</th></tr></thead>
      <tbody>
  `;
  rows.forEach((r,i)=>{
    const gain = r.current - r.invested;
    const gainPct = r.invested>0 ? (gain/r.invested)*100 : 0;
    html += `
      <tr>
        <td><span class="swatch" style="background:${ASSET_CLASS_PALETTE[i%ASSET_CLASS_PALETTE.length]};"></span>${escapeHtml(r.label)}</td>
        <td class="num">${fmtAmount(r.invested)}</td>
        <td class="num">${fmtAmount(r.current)}</td>
        <td class="num ${gain<0?'loss':'gain'}">${gain>=0?'+':''}${fmtAmount(gain)} (${gainPct.toFixed(1)}%)</td>
      </tr>
    `;
  });
  const totalGainPct = totalInvested>0 ? (totalGain/totalInvested)*100 : 0;
  html += `
      <tr class="total-row">
        <td>Total</td>
        <td class="num">${fmtAmount(totalInvested)}</td>
        <td class="num">${fmtAmount(totalCurrent)}</td>
        <td class="num ${totalGain<0?'loss':'gain'}">${totalGain>=0?'+':''}${fmtAmount(totalGain)} (${totalGainPct.toFixed(1)}%)</td>
      </tr>
    </tbody></table>
  `;
  wrap.innerHTML = html;
}

function bindFlatNWField(id, group, key){
  const el = document.getElementById(id);
  el.addEventListener('input', ()=>{
    getNW()[group][key] = +el.value || 0;
    saveData();
    renderNWSummary();
  });
}
[['nwHomeLoan','homeLoan'],['nwCarLoan','carLoan'],['nwCcDebt','ccDebt'],['nwPersonalLoan','personalLoan'],['nwOtherLiability','otherLiability']].forEach(([id,key])=>{
  bindFlatNWField(id, 'liabilities', key);
});

function renderNWSummary(investmentValue){
  const nw = getNW();
  if(investmentValue===undefined) investmentValue = nw.holdings.reduce((s,h)=>s+holdingCurrentValue(h),0);
  const liabilities = nw.liabilities.homeLoan + nw.liabilities.carLoan + nw.liabilities.ccDebt + nw.liabilities.personalLoan + nw.liabilities.otherLiability;
  const grandTotal = investmentValue - liabilities;

  document.getElementById('nwInvestValue').textContent = fmtAmount(investmentValue);
  document.getElementById('nwLiabTotal').textContent = fmtAmount(liabilities);
  const grandEl = document.getElementById('nwGrandTotal');
  grandEl.textContent = fmtAmount(grandTotal);
  grandEl.classList.toggle('brick', grandTotal<0);

  // reflect saved liability values into the input fields (e.g. after switching currency or restoring from Drive)
  document.getElementById('nwHomeLoan').value = nw.liabilities.homeLoan;
  document.getElementById('nwCarLoan').value = nw.liabilities.carLoan;
  document.getElementById('nwCcDebt').value = nw.liabilities.ccDebt;
  document.getElementById('nwPersonalLoan').value = nw.liabilities.personalLoan;
  document.getElementById('nwOtherLiability').value = nw.liabilities.otherLiability;
}

function renderNetWorth(){
  renderHoldingsList();
  const investmentValue = renderNWTotals();
  renderInvestYearlyTable();
  renderHoldingsChart();
  renderCategoryBreakdownTable();
  renderNWSummary(investmentValue);
}

// ---------- Lending (money lent to people — never counted in net worth) ----------
// One record per PERSON, not per loan — so lending to the same person again
// adds to their existing record instead of creating a separate card.
function getLending(){ return getNW().lending; }

// Backward compatibility: records created before this multi-loan redesign
// had a single {amount, dateLent, note} instead of a lends[] array.
function migrateLending(l){
  if(l.lends) return l;
  return {
    id: l.id,
    name: l.name,
    lends: [{ id: nwUid(), date: l.dateLent, amount: l.amount, note: l.note||null }],
    repayments: (l.repayments||[]).map(r=>({ id:r.id, date:r.date, amount:r.amount, note:r.note||null }))
  };
}

function lendingTotalLent(l){ return l.lends.reduce((s,x)=>s+x.amount,0); }
function lendingTotalRepaid(l){ return (l.repayments||[]).reduce((s,r)=>s+r.amount,0); }
function lendingOutstanding(l){ return Math.max(0, lendingTotalLent(l) - lendingTotalRepaid(l)); }
function lendingStatus(l){
  const outstanding = lendingOutstanding(l);
  if(outstanding<=0) return 'repaid';
  if(lendingTotalRepaid(l)>0) return 'partial';
  return 'outstanding';
}
function lendingFirstDate(l){ return l.lends.reduce((min,x)=> x.date<min?x.date:min, l.lends[0].date); }
const LENDING_STATUS_LABEL = { repaid:'Fully repaid', partial:'Partially repaid', outstanding:'Outstanding' };

document.getElementById('addLending').addEventListener('click', ()=>{
  const name = document.getElementById('lendName').value.trim();
  const amount = +document.getElementById('lendAmount').value;
  const date = document.getElementById('lendDate').value || todayLocalISO();
  const note = document.getElementById('lendNote').value.trim();

  if(!name){ alert('Enter who this was lent to.'); return; }
  if(!amount || amount<=0){ alert('Enter an amount greater than zero.'); return; }

  // If a record already exists for this person (case-insensitive match),
  // add this as another loan to them instead of creating a duplicate card.
  const existing = getLending().find(l=>l.name.trim().toLowerCase()===name.toLowerCase());
  if(existing){
    existing.lends.push({ id: nwUid(), date, amount, note: note||null });
  } else {
    getLending().push({
      id: nwUid(),
      name,
      lends: [{ id: nwUid(), date, amount, note: note||null }],
      repayments: []
    });
  }
  saveData();
  document.getElementById('lendName').value = '';
  document.getElementById('lendAmount').value = '';
  document.getElementById('lendNote').value = '';
  document.getElementById('lendDate').value = todayLocalISO();
  renderLending();
});

function addLoanToPerson(id){
  const l = getLending().find(x=>x.id===id);
  if(!l) return;
  const raw = prompt(`Another loan to "${l.name}" — amount:`, '');
  if(!raw) return;
  const amount = +raw;
  if(!amount || amount<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date (YYYY-MM-DD):', todayLocalISO());
  const date = dateRaw || todayLocalISO();
  const note = prompt('Note (optional):', '') || '';
  l.lends.push({ id: nwUid(), date, amount, note: note.trim()||null });
  saveData();
  renderLending();
}

function addRepayment(id){
  const l = getLending().find(x=>x.id===id);
  if(!l) return;
  const outstanding = lendingOutstanding(l);
  const raw = prompt(`Repayment from "${l.name}" (outstanding: ${fmtAmount(outstanding)}) — enter the full amount for a one-time payoff, or a partial amount for an EMI-style installment:`, outstanding);
  if(!raw) return;
  const amount = +raw;
  if(!amount || amount<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date received (YYYY-MM-DD):', todayLocalISO());
  const date = dateRaw || todayLocalISO();
  const note = prompt('Note (optional):', '') || '';
  l.repayments = l.repayments || [];
  l.repayments.push({ id: nwUid(), date, amount, note: note.trim()||null });
  saveData();
  renderLending();
}

function editLoan(personId, loanId){
  const l = getLending().find(x=>x.id===personId);
  if(!l) return;
  const loan = l.lends.find(x=>x.id===loanId);
  if(!loan) return;
  const amtRaw = prompt('Amount lent:', loan.amount);
  if(amtRaw===null) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date (YYYY-MM-DD):', loan.date);
  if(dateRaw===null) return;
  const noteRaw = prompt('Note (optional):', loan.note||'');
  if(noteRaw===null) return;
  loan.amount = amt;
  loan.date = dateRaw || loan.date;
  loan.note = noteRaw.trim() || null;
  saveData();
  renderLending();
}
function deleteLoan(personId, loanId){
  const l = getLending().find(x=>x.id===personId);
  if(!l) return;
  if(l.lends.length===1){
    if(!confirm(`This is the only loan on record for "${l.name}" — deleting it removes their whole record. Continue?`)) return;
    getNW().lending = getLending().filter(x=>x.id!==personId);
    saveData();
    renderLending();
    return;
  }
  if(!confirm('Delete this loan entry?')) return;
  l.lends = l.lends.filter(x=>x.id!==loanId);
  saveData();
  renderLending();
}

function editRepayment(personId, repId){
  const l = getLending().find(x=>x.id===personId);
  if(!l) return;
  const rep = (l.repayments||[]).find(r=>r.id===repId);
  if(!rep) return;
  const amtRaw = prompt('Repayment amount:', rep.amount);
  if(amtRaw===null) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date (YYYY-MM-DD):', rep.date);
  if(dateRaw===null) return;
  const noteRaw = prompt('Note (optional):', rep.note||'');
  if(noteRaw===null) return;
  rep.amount = amt;
  rep.date = dateRaw || rep.date;
  rep.note = noteRaw.trim() || null;
  saveData();
  renderLending();
}
function deleteRepayment(personId, repId){
  const l = getLending().find(x=>x.id===personId);
  if(!l) return;
  if(!confirm('Delete this repayment entry?')) return;
  l.repayments = (l.repayments||[]).filter(r=>r.id!==repId);
  saveData();
  renderLending();
}

function renameLendingPerson(id){
  const l = getLending().find(x=>x.id===id);
  if(!l) return;
  const newName = prompt('Name:', l.name);
  if(newName===null) return;
  if(!newName.trim()){ alert('Name can\'t be empty.'); return; }
  l.name = newName.trim();
  saveData();
  renderLending();
}
function deleteLendingPerson(id){
  const l = getLending().find(x=>x.id===id);
  if(!l) return;
  if(!confirm(`Delete the entire record for "${l.name}", including all loans and repayments? This can't be undone.`)) return;
  markDeleted(id);
  getNW().lending = getLending().filter(x=>x.id!==id);
  saveData();
  renderLending();
}

function buildLendingCard(l, today){
  const totalLent = lendingTotalLent(l);
  const repaid = lendingTotalRepaid(l);
  const outstanding = lendingOutstanding(l);
  const status = lendingStatus(l);
  const daysSinceFirst = daysBetween(lendingFirstDate(l), today);

  // Merge every loan and repayment into one chronological history, most recent first.
  const history = [
    ...l.lends.map(x=>({ ...x, kind:'lend' })),
    ...(l.repayments||[]).map(x=>({ ...x, kind:'repay' }))
  ].sort((a,b)=> b.date.localeCompare(a.date));

  const card = document.createElement('div');
  card.className = 'holding-card';
  card.innerHTML = `
    <div class="hc-top">
      <span class="status-badge ${status}">${LENDING_STATUS_LABEL[status]}</span>
      <span class="h-name">${escapeHtml(l.name)}</span>
      <span class="h-meta">First loan ${daysSinceFirst} day${daysSinceFirst===1?'':'s'} ago · ${l.lends.length} loan${l.lends.length===1?'':'s'}</span>
    </div>
    <div class="hc-stats">
      <div class="h-figure"><span class="lbl">Total lent</span>${fmtAmount(totalLent)}</div>
      <div class="h-figure"><span class="lbl">Total repaid</span>${fmtAmount(repaid)}</div>
      <div class="h-figure h-gain${outstanding>0?' loss':''}"><span class="lbl">Outstanding</span>${fmtAmount(outstanding)}</div>
    </div>
    <div class="h-actions">
      <button class="buy" data-action="newloan">+ New loan</button>
      <button data-action="repay" ${outstanding<=0?'disabled':''}>+ Add repayment</button>
      <button data-action="rename">✎ Rename</button>
      <button data-action="del">× Delete</button>
    </div>
    <div class="h-log" id="lendlog-${l.id}"></div>
  `;
  card.querySelector('[data-action=newloan]').addEventListener('click', ()=>addLoanToPerson(l.id));
  const repayBtn = card.querySelector('[data-action=repay]');
  if(outstanding>0) repayBtn.addEventListener('click', ()=>addRepayment(l.id));
  card.querySelector('[data-action=rename]').addEventListener('click', ()=>renameLendingPerson(l.id));
  card.querySelector('[data-action=del]').addEventListener('click', ()=>deleteLendingPerson(l.id));

  const logEl = card.querySelector('.h-log');
  if(history.length===0){
    logEl.innerHTML = '<span style="color:var(--ink-soft);">No loans yet.</span>';
  }
  history.forEach(entry=>{
    const row = document.createElement('div');
    row.className = 'log-row';
    const label = entry.kind==='lend'
      ? `Lent ${fmtAmount(entry.amount)} on ${entry.date}${entry.note?' — '+escapeHtml(entry.note):''}`
      : `Repaid ${fmtAmount(entry.amount)} on ${entry.date}${entry.note?' — '+escapeHtml(entry.note):''}`;
    row.innerHTML = `<span style="${entry.kind==='repay'?'color:var(--green-deep);':''}">${label}</span>`;
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎'; editBtn.title = 'Edit this entry';
    editBtn.addEventListener('click', ()=> entry.kind==='lend' ? editLoan(l.id, entry.id) : editRepayment(l.id, entry.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = '×'; delBtn.title = 'Delete this entry';
    delBtn.addEventListener('click', ()=> entry.kind==='lend' ? deleteLoan(l.id, entry.id) : deleteRepayment(l.id, entry.id));
    row.appendChild(editBtn); row.appendChild(delBtn);
    logEl.appendChild(row);
  });

  return card;
}

function renderLendingList(){
  const wrap = document.getElementById('lendingList');
  const lending = getLending();
  if(lending.length===0){
    wrap.innerHTML = '<div class="empty-state">No loans given logged yet — add one above.</div>';
    return;
  }
  wrap.innerHTML = '';
  const today = todayLocalISO();
  lending.slice()
    .sort((a,b)=> lendingStatus(a)==='repaid' && lendingStatus(b)!=='repaid' ? 1 : (lendingStatus(b)==='repaid' && lendingStatus(a)!=='repaid' ? -1 : lendingFirstDate(b).localeCompare(lendingFirstDate(a))))
    .forEach(l=>wrap.appendChild(buildLendingCard(l, today)));
}

function renderLendingSummary(){
  const lending = getLending();
  const totalLent = lending.reduce((s,l)=>s+lendingTotalLent(l),0);
  const totalRepaid = lending.reduce((s,l)=>s+lendingTotalRepaid(l),0);
  const totalOutstanding = lending.reduce((s,l)=>s+lendingOutstanding(l),0);
  document.getElementById('lendTotalLent').textContent = fmtAmount(totalLent);
  document.getElementById('lendTotalRepaid').textContent = fmtAmount(totalRepaid);
  document.getElementById('lendTotalOutstanding').textContent = fmtAmount(totalOutstanding);
}

function renderLending(){
  getNW().lending = getLending().map(migrateLending);
  renderLendingList();
  renderLendingSummary();
}

// ---------- SIPs (installments auto-log on their due date, monthly, until stopped) ----------
function getSips(){ return getNW().sips; }

function sipTotalInvested(sip){ return sip.installments.reduce((s,x)=>s+x.amount,0); }

// Catches up any installments whose due date has passed since we last
// checked — this is what makes it feel automatic: just opening the tracker
// logs anything that came due, for every SIP still marked active.
function populateSipLinkedHoldingSelect(){
  const sel = document.getElementById('sipLinkedHolding');
  const prevValue = sel.value;
  sel.innerHTML = '<option value="">— none —</option>';
  getNW().holdings.forEach(h=>{
    const opt = document.createElement('option');
    opt.value = h.id;
    opt.textContent = `${h.name} (${ASSET_CLASS_LABELS[h.assetClass]||h.assetClass})`;
    sel.appendChild(opt);
  });
  if(prevValue && [...sel.options].some(o=>o.value===prevValue)) sel.value = prevValue;
}

function syncSipInstallments(){
  const today = todayLocalISO();
  let changed = false;
  getSips().forEach(sip=>{
    // Migration: SIPs created before frequency support default to monthly.
    if(!sip.frequencyUnit){ sip.frequencyUnit = 'months'; sip.frequencyValue = 1; }
    if(sip.status!=='active') return;
    let guard = 0;
    while(sip.nextDueDate<=today && guard<600){
      const installmentDate = sip.nextDueDate;
      sip.installments.push({ id: nwUid(), date: installmentDate, amount: sip.amount });
      // If this SIP is linked to a real holding, also log the same amount as
      // a buy there — that's what makes an automatic note show up at the
      // bottom of the holding's own buy/sell log, right where you'd look for it.
      if(sip.linkedHoldingId){
        const holding = getNW().holdings.find(h=>h.id===sip.linkedHoldingId);
        if(holding){
          holding.lots.push({ id: nwUid(), date: installmentDate, quantity: 1, price: sip.amount, note: `SIP: ${sip.name}` });
          holding.currentPrice = holding.currentPrice || sip.amount;
        }
      }
      sip.nextDueDate = advanceDate(sip.nextDueDate, sip.frequencyUnit, sip.frequencyValue);
      changed = true;
      guard++;
    }
  });
  if(changed) saveData();
}

document.getElementById('addSip').addEventListener('click', ()=>{
  const name = document.getElementById('sipName').value.trim();
  const amount = +document.getElementById('sipAmount').value;
  const startDate = document.getElementById('sipStartDate').value || todayLocalISO();
  const linkedHoldingId = document.getElementById('sipLinkedHolding').value || null;
  const [frequencyUnit, freqValueRaw] = document.getElementById('sipFrequency').value.split(':');
  const frequencyValue = +freqValueRaw;

  if(!name){ alert('Give this SIP a name.'); return; }
  if(!amount || amount<=0){ alert('Enter an amount greater than zero.'); return; }

  getSips().push({
    id: nwUid(),
    name,
    amount,
    startDate,
    linkedHoldingId,
    frequencyUnit,
    frequencyValue,
    status: 'active',
    stoppedDate: null,
    nextDueDate: startDate,
    installments: []
  });
  saveData();
  document.getElementById('sipName').value = '';
  document.getElementById('sipAmount').value = '';
  document.getElementById('sipLinkedHolding').value = '';
  document.getElementById('sipStartDate').value = todayLocalISO();
  renderSips();
});

function stopSip(id){
  const sip = getSips().find(x=>x.id===id);
  if(!sip) return;
  if(!confirm(`Stop "${sip.name}"? No more installments will be logged automatically after today.`)) return;
  sip.status = 'stopped';
  sip.stoppedDate = todayLocalISO();
  saveData();
  renderSips();
}
function resumeSip(id){
  const sip = getSips().find(x=>x.id===id);
  if(!sip) return;
  sip.status = 'active';
  sip.stoppedDate = null;
  // Don't burst-generate installments for the whole paused period —
  // resume fresh from today if the due date fell behind while stopped.
  if(sip.nextDueDate < todayLocalISO()) sip.nextDueDate = todayLocalISO();
  saveData();
  renderSips();
}
function editSipInfo(id){
  const sip = getSips().find(x=>x.id===id);
  if(!sip) return;
  const newName = prompt('SIP name:', sip.name);
  if(newName===null) return;
  if(!newName.trim()){ alert('Name can\'t be empty.'); return; }
  const newAmt = prompt(`Amount per ${sipFrequencyLabel(sip).toLowerCase()} installment (applies to future installments only):`, sip.amount);
  if(newAmt===null) return;
  const amt = +newAmt;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const newLinked = prompt('Linked to (optional):', sip.linkedHolding||'');
  if(newLinked===null) return;
  sip.name = newName.trim();
  sip.amount = amt;
  sip.linkedHolding = newLinked.trim() || null;
  saveData();
  renderSips();
}
function editInstallment(sipId, instId){
  const sip = getSips().find(x=>x.id===sipId);
  if(!sip) return;
  const inst = sip.installments.find(i=>i.id===instId);
  if(!inst) return;
  const amtRaw = prompt('Amount:', inst.amount);
  if(amtRaw===null) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date (YYYY-MM-DD):', inst.date);
  if(dateRaw===null) return;
  inst.amount = amt;
  inst.date = dateRaw || inst.date;
  saveData();
  renderSips();
}
function deleteInstallment(sipId, instId){
  const sip = getSips().find(x=>x.id===sipId);
  if(!sip) return;
  if(!confirm('Delete this installment entry?')) return;
  sip.installments = sip.installments.filter(i=>i.id!==instId);
  saveData();
  renderSips();
}
function deleteSip(id){
  const sip = getSips().find(x=>x.id===id);
  if(!sip) return;
  if(!confirm(`Delete "${sip.name}" entirely, including its installment history? This can't be undone.`)) return;
  markDeleted(id);
  getNW().sips = getSips().filter(x=>x.id!==id);
  saveData();
  renderSips();
}

function buildSipCard(sip){
  const invested = sipTotalInvested(sip);
  const isStopped = sip.status==='stopped';
  const paidThisYear = sipPaidThisYear(sip);
  const yearlyReq = sipYearlyRequirement(sip);
  const neededThisYear = sipNeededThisYear(sip);
  const linkedHolding = sip.linkedHoldingId ? getNW().holdings.find(h=>h.id===sip.linkedHoldingId) : null;
  const linkedName = linkedHolding ? linkedHolding.name : (sip.linkedHolding || null); // old text-based links still display

  const card = document.createElement('div');
  card.className = 'holding-card';
  card.innerHTML = `
    <div class="hc-top">
      <span class="status-badge ${isStopped?'stopped':'repaid'}">${isStopped?'Stopped':'Active'}</span>
      <span class="h-name">${escapeHtml(sip.name)}</span>
      <span class="h-meta">${linkedName?'→ '+escapeHtml(linkedName):''}</span>
    </div>
    <div class="hc-stats">
      <div class="h-figure"><span class="lbl">Amount / ${sipFrequencyLabel(sip)}</span>${fmtAmount(sip.amount)}</div>
      <div class="h-figure"><span class="lbl">Started</span>${sip.startDate}</div>
      <div class="h-figure"><span class="lbl">Total paid upto</span>${fmtAmount(invested)}</div>
      <div class="h-figure"><span class="lbl">Installments</span>${sip.installments.length}</div>
      <div class="h-figure"><span class="lbl">Paid this year</span>${fmtAmount(paidThisYear)}</div>
      <div class="h-figure"><span class="lbl">Yearly requirement</span>${fmtAmount(yearlyReq)}</div>
      <div class="h-figure"><span class="lbl">Monthly requirement</span>${fmtAmount(sipMonthlyEquivalent(sip))}</div>
      <div class="h-figure h-gain${neededThisYear>0?' loss':''}"><span class="lbl">Needed this year</span>${fmtAmount(neededThisYear)}</div>
      ${!isStopped?`<div class="h-figure"><span class="lbl">Next due</span>${sip.nextDueDate}</div>`:''}
    </div>
    <div class="h-actions">
      ${isStopped?'<button class="buy" data-action="resume">▶ Resume</button>':'<button data-action="stop">⏸ Stop SIP</button>'}
      <button data-action="edit">✎ Edit</button>
      <button data-action="log">☰ Installments</button>
      <button data-action="del">× Delete</button>
    </div>
    <div class="h-log" id="siplog-${sip.id}" style="display:none;"></div>
  `;
  const stopBtn = card.querySelector('[data-action=stop]');
  if(stopBtn) stopBtn.addEventListener('click', ()=>stopSip(sip.id));
  const resumeBtn = card.querySelector('[data-action=resume]');
  if(resumeBtn) resumeBtn.addEventListener('click', ()=>resumeSip(sip.id));
  card.querySelector('[data-action=edit]').addEventListener('click', ()=>editSipInfo(sip.id));
  card.querySelector('[data-action=log]').addEventListener('click', ()=>{
    const el = document.getElementById('siplog-'+sip.id);
    el.style.display = el.style.display==='none' ? '' : 'none';
  });
  card.querySelector('[data-action=del]').addEventListener('click', ()=>deleteSip(sip.id));

  const logEl = card.querySelector('.h-log');
  if(sip.installments.length===0){
    logEl.innerHTML = '<span style="color:var(--ink-soft);">No installments logged yet.</span>';
  }
  sip.installments.slice().sort((a,b)=>b.date.localeCompare(a.date)).forEach(inst=>{
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `<span>Added ${fmtAmount(inst.amount)} on ${inst.date}${linkedName?' → '+escapeHtml(linkedName):''}</span>`;
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎'; editBtn.title = 'Edit this entry';
    editBtn.addEventListener('click', ()=>editInstallment(sip.id, inst.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = '×'; delBtn.title = 'Delete this entry';
    delBtn.addEventListener('click', ()=>deleteInstallment(sip.id, inst.id));
    row.appendChild(editBtn); row.appendChild(delBtn);
    logEl.appendChild(row);
  });
  return card;
}

function renderSipsList(){
  const wrap = document.getElementById('sipList');
  const sips = getSips();
  if(sips.length===0){
    wrap.innerHTML = '<div class="empty-state">No SIPs logged yet — add one above.</div>';
    return;
  }
  wrap.innerHTML = '';
  sips.slice()
    .sort((a,b)=> (a.status==='active'?0:1) - (b.status==='active'?0:1))
    .forEach(sip=>wrap.appendChild(buildSipCard(sip)));
}
function renderSipsSummary(){
  const sips = getSips();
  const active = sips.filter(s=>s.status==='active');
  document.getElementById('sipActiveCount').textContent = active.length;
  document.getElementById('sipMonthlyTotal').textContent = fmtAmount(active.reduce((s,x)=>s+sipMonthlyEquivalent(x),0));
  document.getElementById('sipTotalInvested').textContent = fmtAmount(sips.reduce((s,x)=>s+sipTotalInvested(x),0));
  document.getElementById('sipPaidThisYear').textContent = fmtAmount(sips.reduce((s,x)=>s+sipPaidThisYear(x),0));
  document.getElementById('sipYearlyReq').textContent = fmtAmount(active.reduce((s,x)=>s+sipYearlyRequirement(x),0));
  document.getElementById('sipNeededThisYear').textContent = fmtAmount(active.reduce((s,x)=>s+sipNeededThisYear(x),0));
}
function renderSips(){
  syncSipInstallments();
  populateSipLinkedHoldingSelect();
  renderSipsList();
  renderSipsSummary();
  renderNetWorth(); // a SIP sync may have just added a buy to a linked holding — keep that in sync too
}

// ---------- Insurance ----------
function getInsurance(){ return getNW().insurance; }
const INS_FREQ_LABEL = { 1:'Monthly', 3:'Quarterly', 6:'Half-yearly', 12:'Yearly' };

function insuranceTotalPaid(ins){ return ins.payments.reduce((s,p)=>s+p.amount,0); }
function insurancePaidThisYear(ins){
  const year = todayLocalISO().slice(0,4);
  return ins.payments.filter(p=>p.date.slice(0,4)===year).reduce((s,p)=>s+p.amount,0);
}
function insuranceYearlyRequirement(ins){ return ins.premiumAmount * (12/ins.frequencyMonths); }
function insuranceMonthlyRequirement(ins){ return ins.premiumAmount / ins.frequencyMonths; }
function insuranceNeededThisYear(ins){ return Math.max(0, insuranceYearlyRequirement(ins) - insurancePaidThisYear(ins)); }
function insuranceStatusBadge(ins, today){
  if(ins.status==='lapsed') return 'stopped';
  const days = daysBetween(today, ins.nextDueDate);
  if(days<0) return 'overdue';
  if(days<=14) return 'due-soon';
  return 'repaid'; // reuses the green "good standing" color
}
const INS_STATUS_TEXT = { overdue:'Overdue', 'due-soon':'Due soon', repaid:'Active', stopped:'Lapsed' };

document.getElementById('addInsurance').addEventListener('click', ()=>{
  const name = document.getElementById('insName').value.trim();
  const provider = document.getElementById('insProvider').value.trim();
  const boughtDate = document.getElementById('insBoughtDate').value || todayLocalISO();
  const premium = +document.getElementById('insPremium').value;
  const freq = +document.getElementById('insFrequency').value;

  if(!name){ alert('Give this policy a name.'); return; }
  if(!premium || premium<=0){ alert('Enter a premium amount greater than zero.'); return; }

  getInsurance().push({
    id: nwUid(),
    name,
    provider: provider || null,
    boughtDate,
    premiumAmount: premium,
    frequencyMonths: freq,
    nextDueDate: addMonthsClamped(boughtDate, freq),
    status: 'active',
    payments: [{ id: nwUid(), date: boughtDate, amount: premium }] // first premium, paid at purchase
  });
  saveData();
  document.getElementById('insName').value = '';
  document.getElementById('insProvider').value = '';
  document.getElementById('insPremium').value = '';
  document.getElementById('insBoughtDate').value = todayLocalISO();
  renderInsurance();
});

function payPremium(id){
  const ins = getInsurance().find(x=>x.id===id);
  if(!ins) return;
  const amtRaw = prompt(`Premium payment for "${ins.name}":`, ins.premiumAmount);
  if(!amtRaw) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date paid (YYYY-MM-DD):', todayLocalISO());
  const date = dateRaw || todayLocalISO();
  ins.payments.push({ id: nwUid(), date, amount: amt });
  ins.nextDueDate = addMonthsClamped(ins.nextDueDate, ins.frequencyMonths);
  saveData();
  renderInsurance();
}
function editInsuranceInfo(id){
  const ins = getInsurance().find(x=>x.id===id);
  if(!ins) return;
  const newName = prompt('Policy name:', ins.name);
  if(newName===null) return;
  if(!newName.trim()){ alert('Name can\'t be empty.'); return; }
  const newProvider = prompt('Bought from:', ins.provider||'');
  if(newProvider===null) return;
  const newPremium = prompt('Premium amount:', ins.premiumAmount);
  if(newPremium===null) return;
  const premium = +newPremium;
  if(!premium || premium<=0){ alert('Enter a valid amount.'); return; }
  ins.name = newName.trim();
  ins.provider = newProvider.trim() || null;
  ins.premiumAmount = premium;
  saveData();
  renderInsurance();
}
function setNextDueDate(id){
  const ins = getInsurance().find(x=>x.id===id);
  if(!ins) return;
  const raw = prompt('Next due date (YYYY-MM-DD):', ins.nextDueDate);
  if(raw===null) return;
  if(raw) ins.nextDueDate = raw;
  saveData();
  renderInsurance();
}
function toggleInsuranceLapsed(id){
  const ins = getInsurance().find(x=>x.id===id);
  if(!ins) return;
  ins.status = ins.status==='lapsed' ? 'active' : 'lapsed';
  saveData();
  renderInsurance();
}
function editPayment(insId, payId){
  const ins = getInsurance().find(x=>x.id===insId);
  if(!ins) return;
  const pay = ins.payments.find(p=>p.id===payId);
  if(!pay) return;
  const amtRaw = prompt('Amount:', pay.amount);
  if(amtRaw===null) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date (YYYY-MM-DD):', pay.date);
  if(dateRaw===null) return;
  pay.amount = amt;
  pay.date = dateRaw || pay.date;
  saveData();
  renderInsurance();
}
function deletePayment(insId, payId){
  const ins = getInsurance().find(x=>x.id===insId);
  if(!ins) return;
  if(!confirm('Delete this payment entry?')) return;
  ins.payments = ins.payments.filter(p=>p.id!==payId);
  saveData();
  renderInsurance();
}
function deleteInsurance(id){
  const ins = getInsurance().find(x=>x.id===id);
  if(!ins) return;
  if(!confirm(`Delete "${ins.name}" entirely, including its payment history? This can't be undone.`)) return;
  markDeleted(id);
  getNW().insurance = getInsurance().filter(x=>x.id!==id);
  saveData();
  renderInsurance();
}

function buildInsuranceCard(ins, today){
  const totalPaid = insuranceTotalPaid(ins);
  const badge = insuranceStatusBadge(ins, today);
  const paidThisYear = insurancePaidThisYear(ins);
  const yearlyReq = insuranceYearlyRequirement(ins);
  const neededThisYear = insuranceNeededThisYear(ins);

  const card = document.createElement('div');
  card.className = 'holding-card';
  card.innerHTML = `
    <div class="hc-top">
      <span class="status-badge ${badge}">${INS_STATUS_TEXT[badge]}</span>
      <span class="h-name">${escapeHtml(ins.name)}</span>
      <span class="h-meta">${ins.provider?escapeHtml(ins.provider):''}</span>
    </div>
    <div class="hc-stats">
      <div class="h-figure"><span class="lbl">Premium</span>${fmtAmount(ins.premiumAmount)} / ${INS_FREQ_LABEL[ins.frequencyMonths]||''}</div>
      <div class="h-figure"><span class="lbl">Bought</span>${ins.boughtDate}</div>
      <div class="h-figure"><span class="lbl">Next due</span>${ins.nextDueDate}</div>
      <div class="h-figure"><span class="lbl">Total paid upto</span>${fmtAmount(totalPaid)}</div>
      <div class="h-figure"><span class="lbl">Paid this year</span>${fmtAmount(paidThisYear)}</div>
      <div class="h-figure"><span class="lbl">Yearly requirement</span>${fmtAmount(yearlyReq)}</div>
      <div class="h-figure"><span class="lbl">Monthly requirement</span>${fmtAmount(insuranceMonthlyRequirement(ins))}</div>
      <div class="h-figure h-gain${neededThisYear>0?' loss':''}"><span class="lbl">Needed this year</span>${fmtAmount(neededThisYear)}</div>
    </div>
    <div class="h-actions">
      <button class="buy" data-action="pay">+ Pay premium</button>
      <button data-action="duedate">📅 Set next due</button>
      <button data-action="edit">✎ Edit</button>
      <button data-action="lapsed">${ins.status==='lapsed'?'Mark active':'Mark lapsed'}</button>
      <button data-action="log">☰ Payments</button>
      <button data-action="del">× Delete</button>
    </div>
    <div class="h-log" id="inslog-${ins.id}" style="display:none;"></div>
  `;
  card.querySelector('[data-action=pay]').addEventListener('click', ()=>payPremium(ins.id));
  card.querySelector('[data-action=duedate]').addEventListener('click', ()=>setNextDueDate(ins.id));
  card.querySelector('[data-action=edit]').addEventListener('click', ()=>editInsuranceInfo(ins.id));
  card.querySelector('[data-action=lapsed]').addEventListener('click', ()=>toggleInsuranceLapsed(ins.id));
  card.querySelector('[data-action=log]').addEventListener('click', ()=>{
    const el = document.getElementById('inslog-'+ins.id);
    el.style.display = el.style.display==='none' ? '' : 'none';
  });
  card.querySelector('[data-action=del]').addEventListener('click', ()=>deleteInsurance(ins.id));

  const logEl = card.querySelector('.h-log');
  if(ins.payments.length===0){
    logEl.innerHTML = '<span style="color:var(--ink-soft);">No payments logged yet.</span>';
  }
  ins.payments.slice().sort((a,b)=>b.date.localeCompare(a.date)).forEach(p=>{
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `<span>Paid ${fmtAmount(p.amount)} on ${p.date}</span>`;
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎'; editBtn.title = 'Edit this entry';
    editBtn.addEventListener('click', ()=>editPayment(ins.id, p.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = '×'; delBtn.title = 'Delete this entry';
    delBtn.addEventListener('click', ()=>deletePayment(ins.id, p.id));
    row.appendChild(editBtn); row.appendChild(delBtn);
    logEl.appendChild(row);
  });
  return card;
}

function renderInsuranceList(){
  const wrap = document.getElementById('insuranceList');
  const insurance = getInsurance();
  if(insurance.length===0){
    wrap.innerHTML = '<div class="empty-state">No policies logged yet — add one above.</div>';
    return;
  }
  wrap.innerHTML = '';
  const today = todayLocalISO();
  insurance.slice()
    .sort((a,b)=>a.nextDueDate.localeCompare(b.nextDueDate))
    .forEach(ins=>wrap.appendChild(buildInsuranceCard(ins, today)));
}
function renderInsuranceSummary(){
  const insurance = getInsurance();
  const active = insurance.filter(i=>i.status!=='lapsed');
  document.getElementById('insActiveCount').textContent = active.length;
  document.getElementById('insTotalPaid').textContent = fmtAmount(insurance.reduce((s,i)=>s+insuranceTotalPaid(i),0));
  document.getElementById('insPaidThisYear').textContent = fmtAmount(insurance.reduce((s,i)=>s+insurancePaidThisYear(i),0));
  document.getElementById('insYearlyReq').textContent = fmtAmount(active.reduce((s,i)=>s+insuranceYearlyRequirement(i),0));
  document.getElementById('insMonthlyReq').textContent = fmtAmount(active.reduce((s,i)=>s+insuranceMonthlyRequirement(i),0));
  document.getElementById('insNeededThisYear').textContent = fmtAmount(active.reduce((s,i)=>s+insuranceNeededThisYear(i),0));
}
function renderInsurance(){
  renderInsuranceList();
  renderInsuranceSummary();
}

// ---------- Upcoming due-date notifications ----------
// SIPs and recurring expenses: warn 5 days out. Insurance: warn a full month
// out, since premiums are usually bigger and less convenient to scramble for.
function renderNotifications(){
  const wrap = document.getElementById('upcomingNotifications');
  const today = todayLocalISO();
  const items = [];

  getSips().forEach(sip=>{
    if(sip.status!=='active') return;
    const days = daysBetween(today, sip.nextDueDate);
    if(days>=0 && days<=5){
      items.push({ days, kind:'sip', text:`SIP "${sip.name}" — ${fmtAmount(sip.amount)} due ${days===0?'today':'in '+days+' day'+(days===1?'':'s')} (${sip.nextDueDate})` });
    }
  });
  getRecurring().forEach(r=>{
    if(r.status!=='active') return;
    const days = daysBetween(today, r.nextDueDate);
    if(days>=0 && days<=5){
      items.push({ days, kind:'recurring', text:`Recurring "${r.name}" — ${fmtAmount(r.amount)} due ${days===0?'today':'in '+days+' day'+(days===1?'':'s')} (${r.nextDueDate})` });
    }
  });
  getInsurance().forEach(ins=>{
    if(ins.status==='lapsed') return;
    const days = daysBetween(today, ins.nextDueDate);
    if(days>=0 && days<=30){
      items.push({ days, kind:'insurance', text:`Insurance "${ins.name}" premium — ${fmtAmount(ins.premiumAmount)} due ${days===0?'today':'in '+days+' day'+(days===1?'':'s')} (${ins.nextDueDate})` });
    }
  });

  if(items.length===0){ wrap.style.display='none'; wrap.innerHTML=''; return; }
  items.sort((a,b)=>a.days-b.days);
  let html = `<div class="notify-banner"><div class="notify-title">🔔 Coming up (${currentCurrency})</div>`;
  items.forEach(item=>{
    const soon = item.days>5; // only insurance items can be in the 6-30 day range
    const whenLabel = item.days===0 ? 'TODAY' : item.days+'d';
    html += `<div class="notify-row"><span class="notify-when${soon?' soon':''}">${whenLabel}</span><span>${escapeHtml(item.text)}</span></div>`;
  });
  html += '</div>';
  wrap.style.display = '';
  wrap.innerHTML = html;
}

// ---------- Recurring Expenses ("Definite Spending") ----------
// Same idea as SIPs, but for expenses: fires automatically on schedule and
// logs a real transaction each time, so it shows up in your normal spending
// stats/budget/charts — not a separate parallel ledger.
function getRecurring(){ return getNW().recurringExpenses; }

function recurringFrequencyLabel(r){
  return r.frequencyUnit==='months' ? 'Monthly' : `Every ${r.frequencyValue} day${r.frequencyValue===1?'':'s'}`;
}
function recurringMonthlyEquivalent(r){
  return r.frequencyUnit==='days' ? r.amount*(30.44/r.frequencyValue) : r.amount;
}
function recurringTotalLogged(r){ return r.loggedTx.reduce((s,x)=>s+x.amount,0); }

function populateRecurringCategorySelect(){
  const sel = document.getElementById('recurCategory');
  const prevValue = sel.value;
  sel.innerHTML = '';
  categories.expense.forEach(c=>{
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
  if(prevValue && [...sel.options].some(o=>o.value===prevValue)) sel.value = prevValue;
}

// Catches up any due dates that have passed, logging a real expense
// transaction for each one — this is what makes it "automatic."
function syncRecurringExpenses(){
  const today = todayLocalISO();
  let changed = false;
  getRecurring().forEach(r=>{
    if(r.status!=='active') return;
    let guard = 0;
    while(r.nextDueDate<=today && guard<600){
      const tx = { id: uid(), date: r.nextDueDate, type:'expense', category:r.category, description:`Recurring: ${r.name}`, amount:r.amount, currency:currentCurrency };
      transactions.push(tx);
      r.loggedTx.push({ id: tx.id, date: r.nextDueDate, amount: r.amount });
      r.nextDueDate = advanceDate(r.nextDueDate, r.frequencyUnit, r.frequencyValue);
      changed = true;
      guard++;
    }
  });
  if(changed) saveData();
}

document.getElementById('addRecurring').addEventListener('click', ()=>{
  const name = document.getElementById('recurName').value.trim();
  const amount = +document.getElementById('recurAmount').value;
  const category = document.getElementById('recurCategory').value;
  const frequencyUnit = document.getElementById('recurFrequencyType').value;
  const daysN = +document.getElementById('recurDaysN').value;
  const startDate = document.getElementById('recurStartDate').value || todayLocalISO();

  if(!name){ alert('Give this a name.'); return; }
  if(!amount || amount<=0){ alert('Enter an amount greater than zero.'); return; }
  if(frequencyUnit==='days' && (!daysN || daysN<=0)){ alert('Enter how many days between each one.'); return; }

  getRecurring().push({
    id: nwUid(),
    name,
    amount,
    category,
    frequencyUnit,
    frequencyValue: frequencyUnit==='days' ? daysN : 1,
    startDate,
    status: 'active',
    stoppedDate: null,
    nextDueDate: startDate,
    loggedTx: []
  });
  saveData();
  document.getElementById('recurName').value = '';
  document.getElementById('recurAmount').value = '';
  document.getElementById('recurDaysN').value = '';
  document.getElementById('recurStartDate').value = todayLocalISO();
  renderRecurring();
});

function stopRecurring(id){
  const r = getRecurring().find(x=>x.id===id);
  if(!r) return;
  if(!confirm(`Stop "${r.name}"? No more transactions will be logged automatically after today.`)) return;
  r.status = 'stopped';
  r.stoppedDate = todayLocalISO();
  saveData();
  renderRecurring();
}
function resumeRecurring(id){
  const r = getRecurring().find(x=>x.id===id);
  if(!r) return;
  r.status = 'active';
  r.stoppedDate = null;
  if(r.nextDueDate < todayLocalISO()) r.nextDueDate = todayLocalISO();
  saveData();
  renderRecurring();
}
function editRecurringInfo(id){
  const r = getRecurring().find(x=>x.id===id);
  if(!r) return;
  const newName = prompt('Name:', r.name);
  if(newName===null) return;
  if(!newName.trim()){ alert('Name can\'t be empty.'); return; }
  const newAmt = prompt('Amount (applies to future occurrences only):', r.amount);
  if(newAmt===null) return;
  const amt = +newAmt;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  r.name = newName.trim();
  r.amount = amt;
  saveData();
  renderRecurring();
}
function deleteRecurring(id){
  const r = getRecurring().find(x=>x.id===id);
  if(!r) return;
  const removeTx = confirm(`Delete "${r.name}"? Click OK to also remove the ${r.loggedTx.length} transaction(s) it already logged, or Cancel to keep those transactions and just stop future ones.`);
  if(removeTx){
    const loggedIds = new Set(r.loggedTx.map(l=>l.id));
    loggedIds.forEach(markDeleted);
    transactions = transactions.filter(t=>!loggedIds.has(t.id));
  }
  markDeleted(id);
  getNW().recurringExpenses = getRecurring().filter(x=>x.id!==id);
  saveData();
  renderAll();
}

function buildRecurringCard(r, today){
  const totalLogged = recurringTotalLogged(r);
  const isStopped = r.status==='stopped';
  const daysUntilDue = daysBetween(today, r.nextDueDate);
  let badge = 'repaid', badgeText = 'Active';
  if(isStopped){ badge='stopped'; badgeText='Stopped'; }
  else if(daysUntilDue<0){ badge='overdue'; badgeText='Overdue'; }
  else if(daysUntilDue<=3){ badge='due-soon'; badgeText='Due soon'; }

  const card = document.createElement('div');
  card.className = 'holding-card';
  card.innerHTML = `
    <div class="hc-top">
      <span class="status-badge ${badge}">${badgeText}</span>
      <span class="h-name">${escapeHtml(r.name)}</span>
      <span class="h-meta">${escapeHtml(r.category)}</span>
    </div>
    <div class="hc-stats">
      <div class="h-figure"><span class="lbl">Amount</span>${fmtAmount(r.amount)}</div>
      <div class="h-figure"><span class="lbl">Frequency</span>${recurringFrequencyLabel(r)}</div>
      <div class="h-figure"><span class="lbl">Total logged</span>${fmtAmount(totalLogged)}</div>
      <div class="h-figure"><span class="lbl">Occurrences</span>${r.loggedTx.length}</div>
      ${!isStopped?`<div class="h-figure"><span class="lbl">Next due</span>${r.nextDueDate}</div>`:''}
    </div>
    <div class="h-actions">
      ${isStopped?'<button class="buy" data-action="resume">▶ Resume</button>':'<button data-action="stop">⏸ Stop</button>'}
      <button data-action="edit">✎ Edit</button>
      <button data-action="log">☰ Log</button>
      <button data-action="del">× Delete</button>
    </div>
    <div class="h-log" id="recurlog-${r.id}" style="display:none;"></div>
  `;
  const stopBtn = card.querySelector('[data-action=stop]');
  if(stopBtn) stopBtn.addEventListener('click', ()=>stopRecurring(r.id));
  const resumeBtn = card.querySelector('[data-action=resume]');
  if(resumeBtn) resumeBtn.addEventListener('click', ()=>resumeRecurring(r.id));
  card.querySelector('[data-action=edit]').addEventListener('click', ()=>editRecurringInfo(r.id));
  card.querySelector('[data-action=log]').addEventListener('click', ()=>{
    const el = document.getElementById('recurlog-'+r.id);
    el.style.display = el.style.display==='none' ? '' : 'none';
  });
  card.querySelector('[data-action=del]').addEventListener('click', ()=>deleteRecurring(r.id));

  const logEl = card.querySelector('.h-log');
  if(r.loggedTx.length===0){
    logEl.innerHTML = '<span style="color:var(--ink-soft);">Nothing logged yet.</span>';
  }
  r.loggedTx.slice().sort((a,b)=>b.date.localeCompare(a.date)).forEach(entry=>{
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `<span>Logged ${fmtAmount(entry.amount)} on ${entry.date}</span>`;
    logEl.appendChild(row);
  });
  return card;
}

function renderRecurringList(){
  const wrap = document.getElementById('recurringList');
  const recurring = getRecurring();
  if(recurring.length===0){
    wrap.innerHTML = '<div class="empty-state">No recurring expenses logged yet — add one above.</div>';
    return;
  }
  wrap.innerHTML = '';
  const today = todayLocalISO();
  recurring.slice()
    .sort((a,b)=> (a.status==='active'?0:1) - (b.status==='active'?0:1))
    .forEach(r=>wrap.appendChild(buildRecurringCard(r, today)));
}
function renderRecurringSummary(){
  const recurring = getRecurring();
  const active = recurring.filter(r=>r.status==='active');
  document.getElementById('recurActiveCount').textContent = active.length;
  document.getElementById('recurMonthlyTotal').textContent = fmtAmount(active.reduce((s,r)=>s+recurringMonthlyEquivalent(r),0));
  document.getElementById('recurTotalLogged').textContent = fmtAmount(recurring.reduce((s,r)=>s+recurringTotalLogged(r),0));
}
function renderRecurring(){
  syncRecurringExpenses();
  populateRecurringCategorySelect();
  renderRecurringList();
  renderRecurringSummary();
  renderSummary(); // a newly-logged recurring expense affects income/expense totals too
  renderList();
}

// ---------- Collapsible sections (Lending / SIPs / Insurance) ----------
// Remembered for the browser session (sessionStorage) so collapsing a
// section you don't use stays collapsed as you keep using the tracker,
// without permanently hiding it forever across visits.
function setupCollapsibleSection(headId, arrowId, bodyId, storageKey){
  const head = document.getElementById(headId);
  const arrow = document.getElementById(arrowId);
  const body = document.getElementById(bodyId);
  const collapsed = sessionStorage.getItem(storageKey) === '1';
  body.style.display = collapsed ? 'none' : '';
  arrow.textContent = collapsed ? '▸' : '▾';
  head.addEventListener('click', ()=>{
    const nowCollapsed = body.style.display !== 'none';
    body.style.display = nowCollapsed ? 'none' : '';
    arrow.textContent = nowCollapsed ? '▸' : '▾';
    sessionStorage.setItem(storageKey, nowCollapsed ? '1' : '0');
  });
}
setupCollapsibleSection('lendingSectionHead','lendingArrow','lendingSectionBody','spendingTracker.collapsed.lending');
setupCollapsibleSection('sipsSectionHead','sipsArrow','sipsSectionBody','spendingTracker.collapsed.sips');
setupCollapsibleSection('insuranceSectionHead','insuranceArrow','insuranceSectionBody','spendingTracker.collapsed.insurance');
setupCollapsibleSection('recurringSectionHead','recurringArrow','recurringSectionBody','spendingTracker.collapsed.recurring');
setupCollapsibleSection('budgetSectionHead','budgetArrow','budgetSectionBody','spendingTracker.collapsed.budget');

function setCurrency(currency){
  currentCurrency = currency;
  localStorage.setItem(CURRENCY_KEY, currency);
  document.getElementById('currencyUSA').classList.toggle('active', currency==='USD');
  document.getElementById('currencyIndia').classList.toggle('active', currency==='INR');
  document.getElementById('txAmountCurrency').textContent = currency==='USD' ? '$' : '₹';
  renderAll();
}
document.getElementById('currencyUSA').addEventListener('click', ()=>setCurrency('USD'));
document.getElementById('currencyIndia').addEventListener('click', ()=>setCurrency('INR'));

function renderAll(){
  populateMonthFilter();
  populateCategoryFilter();
  populateTagFilter();
  syncRecurringExpenses(); // before the transaction-dependent renders below, so a fresh auto-logged expense shows up right away
  renderSummary();
  renderList();
  renderBudget();
  renderCategoryChart();
  renderTrendChart();
  renderYearlyStats();
  renderMonthlyCategoryTable();
  renderTagBreakdown();
  syncSipInstallments(); // before renderNetWorth, so a SIP-driven buy shows up in the holdings list right away
  renderNetWorth();
  renderLending();
  renderSips();
  renderInsurance();
  renderRecurring();
  renderNotifications();
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
// When another device deletes something and its tombstone reaches us via
// import/restore, this both remembers that deletion locally (so we never
// re-add it ourselves later) and removes it here right now if it's still
// sitting in our own local data — makes deletions travel both directions.
function applyIncomingTombstones(incomingDeletedIds){
  if(!Array.isArray(incomingDeletedIds) || incomingDeletedIds.length===0) return;
  incomingDeletedIds.forEach(id=>deletedIds.add(id));
  transactions = transactions.filter(t=>!isDeleted(t.id));
  ['INR','USD'].forEach(cur=>{
    const bucket = netWorthData[cur];
    bucket.holdings = bucket.holdings.filter(h=>!isDeleted(h.id));
    bucket.lending = bucket.lending.filter(l=>!isDeleted(l.id));
    bucket.sips = bucket.sips.filter(s=>!isDeleted(s.id));
    bucket.insurance = bucket.insurance.filter(i=>!isDeleted(i.id));
    bucket.recurringExpenses = bucket.recurringExpenses.filter(r=>!isDeleted(r.id));
  });
}

function mergeNetWorthFromBackup(incomingNW){
  if(!incomingNW) return 0;
  let addedHoldings = 0;
  ['INR','USD'].forEach(cur=>{
    const incomingBucket = incomingNW[cur];
    if(!incomingBucket) return;
    const localBucket = netWorthData[cur];
    if(Array.isArray(incomingBucket.holdings)){
      const existingIds = new Set(localBucket.holdings.map(h=>h.id));
      incomingBucket.holdings.forEach(raw=>{
        const h = migrateHolding(raw);
        if(h.id && !existingIds.has(h.id) && !isDeleted(h.id)){ localBucket.holdings.push(h); addedHoldings++; }
      });
    }
    // Old-format backups may still have flatAssets (Real Estate/Vehicles/Other
    // as flat numbers) — convert any into holdings so nothing is lost.
    if(incomingBucket.flatAssets){
      const flat = incomingBucket.flatAssets;
      const today = todayLocalISO();
      const map = { realEstate:['realestate','Real estate'], vehicles:['vehicle','Vehicles'], otherAsset:['other','Other assets'] };
      Object.keys(map).forEach(key=>{
        if(flat[key]>0){
          const [assetClass, name] = map[key];
          localBucket.holdings.push({ id: nwUid(), assetClass, name, currentPrice: flat[key], lots:[{id:nwUid(), date:today, quantity:1, price:flat[key]}], sells:[] });
          addedHoldings++;
        }
      });
    }
    if(incomingBucket.liabilities) Object.assign(localBucket.liabilities, incomingBucket.liabilities);
    if(Array.isArray(incomingBucket.lending)){
      if(!localBucket.lending) localBucket.lending = [];
      const existingLendIds = new Set(localBucket.lending.map(l=>l.id));
      incomingBucket.lending.forEach(raw=>{
        const l = migrateLending(raw);
        if(l.id && !existingLendIds.has(l.id) && !isDeleted(l.id)) localBucket.lending.push(l);
      });
    }
    if(Array.isArray(incomingBucket.sips)){
      if(!localBucket.sips) localBucket.sips = [];
      const existingSipIds = new Set(localBucket.sips.map(s=>s.id));
      incomingBucket.sips.forEach(s=>{ if(s.id && !existingSipIds.has(s.id) && !isDeleted(s.id)) localBucket.sips.push(s); });
    }
    if(Array.isArray(incomingBucket.insurance)){
      if(!localBucket.insurance) localBucket.insurance = [];
      const existingInsIds = new Set(localBucket.insurance.map(i=>i.id));
      incomingBucket.insurance.forEach(i=>{ if(i.id && !existingInsIds.has(i.id) && !isDeleted(i.id)) localBucket.insurance.push(i); });
    }
    if(Array.isArray(incomingBucket.recurringExpenses)){
      if(!localBucket.recurringExpenses) localBucket.recurringExpenses = [];
      const existingRecurIds = new Set(localBucket.recurringExpenses.map(r=>r.id));
      incomingBucket.recurringExpenses.forEach(r=>{ if(r.id && !existingRecurIds.has(r.id) && !isDeleted(r.id)) localBucket.recurringExpenses.push(r); });
    }
  });
  return addedHoldings;
}

document.getElementById('exportJson').addEventListener('click', ()=>{
  const payload = { transactions, categories, netWorthData, budgets, deletedIds: [...deletedIds], exportedAt: new Date().toISOString() };
  downloadBlob('spending-tracker-backup-'+new Date().toISOString().slice(0,10)+'.json', JSON.stringify(payload, null, 2), 'application/json');
  localStorage.setItem('spendingTracker.lastExport', Date.now().toString());
  document.getElementById('backupReminder').style.display = 'none';
});
document.getElementById('exportCsv').addEventListener('click', ()=>{
  const header = 'Date,Type,Category,Description,Amount,Currency\n';
  const rows = transactions.slice().sort((a,b)=>a.date.localeCompare(b.date)).map(t=>
    [t.date, t.type, t.category, '"'+(t.description||'').replace(/"/g,'""')+'"', t.amount, t.currency||'INR'].join(',')
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
      const nwCount = data.netWorthData ? Object.values(data.netWorthData).reduce((s,b)=>s+(Array.isArray(b.holdings)?b.holdings.length:0),0) : 0;
      if(!confirm(`Import ${incoming.length} transaction(s)${nwCount?` and up to ${nwCount} holding(s)`:''}? This will be merged with what's already here (duplicates by ID are skipped; asset/liability totals will be overwritten by the imported file).`)) return;
      applyIncomingTombstones(data.deletedIds);
      const existingIds = new Set(transactions.map(t=>t.id));
      incoming.forEach(t=>{ if(t.id && !existingIds.has(t.id) && !isDeleted(t.id)){ if(!t.currency) t.currency='INR'; transactions.push(t); } });
      if(data.categories){
        ['income','expense'].forEach(type=>{
          if(Array.isArray(data.categories[type])){
            data.categories[type].forEach(c=>{ if(!categories[type].includes(c)) categories[type].push(c); });
          }
        });
      }
      mergeNetWorthFromBackup(data.netWorthData);
      if(data.budgets){
        Object.assign(budgets.INR, data.budgets.INR||{});
        Object.assign(budgets.USD, data.budgets.USD||{});
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

// If this page was opened via a "setup link" (tracker.html?clientId=...),
// auto-fill and save it — this is how a second device gets set up with one
// tap instead of copy-pasting the Client ID by hand. The Client ID itself
// isn't a secret (unlike a password or the OAuth Client Secret), so putting
// it in a URL you share with yourself (e.g. via your own Notes app or a
// message to yourself) is safe.
(function autoFillClientIdFromUrl(){
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('clientId');
  if(fromUrl && fromUrl.trim()){
    saveGoogleClientId(fromUrl.trim());
    // Remove it from the visible URL/history once saved, so it doesn't
    // linger in browser history or get accidentally shared again.
    params.delete('clientId');
    const cleanUrl = window.location.pathname + (params.toString() ? '?'+params.toString() : '');
    window.history.replaceState({}, '', cleanUrl);
  }
})();

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
document.getElementById('copySetupLink').addEventListener('click', async ()=>{
  const id = loadGoogleClientId();
  if(!id){ alert('Save a Client ID first, then copy the setup link.'); return; }
  const url = window.location.origin + window.location.pathname + '?clientId=' + encodeURIComponent(id);
  try{
    await navigator.clipboard.writeText(url);
    alert('Setup link copied! Send it to yourself (e.g. your own Notes app or a message to yourself) and open it on your other device — it\u2019ll auto-fill the Client ID there.');
  } catch(e){
    prompt('Copy this link and open it on your other device:', url);
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
      pullFromDrive(true); // auto-pull whatever's already in Drive from other devices
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
  if(!res.ok){
    let detail = 'HTTP '+res.status;
    try{ const errJson = await res.json(); if(errJson.error && errJson.error.message) detail = errJson.error.message; } catch(e){}
    throw new Error(detail);
  }
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

let driveSyncing = false;
async function pushToDrive(silent){
  try{
    driveSyncing = true;
    if(silent) setDriveStatus('Syncing to Drive…', true);
    const payload = JSON.stringify({ transactions, categories, netWorthData, budgets, deletedIds: [...deletedIds], exportedAt: new Date().toISOString() }, null, 2);
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
    driveSyncing = false;
    if(res.ok){
      localStorage.setItem('spendingTracker.lastExport', Date.now().toString());
      document.getElementById('backupReminder').style.display = 'none';
      if(silent) fetchDriveUserInfo(); else alert('Backed up to Google Drive.');
      return true;
    } else {
      let detail = 'HTTP '+res.status;
      try{ const errJson = await res.json(); if(errJson.error && errJson.error.message) detail = errJson.error.message; } catch(e){}
      if(!silent) alert('Backup failed: '+detail);
      else setDriveStatus('Backup failed: '+detail);
      return false;
    }
  } catch(e){
    driveSyncing = false;
    const msg = 'Backup failed: '+(e && e.message ? e.message : 'unknown error');
    if(!silent) alert(msg); else setDriveStatus(msg);
    return false;
  }
}

async function pullFromDrive(silent){
  try{
    const file = await findDriveFile();
    if(!file){ if(!silent) alert('No backup found in Drive yet — use Backup to Drive first.'); return; }
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
      headers:{ Authorization:'Bearer '+driveAccessToken }
    });
    if(!res.ok){
      let detail = 'HTTP '+res.status;
      try{ const errJson = await res.json(); if(errJson.error && errJson.error.message) detail = errJson.error.message; } catch(e){}
      if(!silent) alert('Restore failed: '+detail); else setDriveStatus('Restore failed: '+detail);
      return;
    }
    const data = await res.json();
    applyIncomingTombstones(data.deletedIds);
    const incoming = Array.isArray(data.transactions) ? data.transactions : [];
    const existingIds = new Set(transactions.map(t=>t.id));
    let added = 0;
    incoming.forEach(t=>{ if(t.id && !existingIds.has(t.id) && !isDeleted(t.id)){ if(!t.currency) t.currency='INR'; transactions.push(t); added++; } });
    if(data.categories){
      ['income','expense'].forEach(type=>{
        if(Array.isArray(data.categories[type])) data.categories[type].forEach(c=>{ if(!categories[type].includes(c)) categories[type].push(c); });
      });
    }
    const addedHoldings = mergeNetWorthFromBackup(data.netWorthData);
    if(data.budgets){
      Object.assign(budgets.INR, data.budgets.INR||{});
      Object.assign(budgets.USD, data.budgets.USD||{});
    }
    if(added>0 || addedHoldings>0){
      saveDataLocalOnly(); // don't re-trigger a push for data we just pulled
      renderAll();
    }
    if(!silent) alert((added>0||addedHoldings>0) ? `Restored ${added} new transaction(s) and ${addedHoldings} holding(s) from Drive.` : 'Already up to date with Drive.');
    else fetchDriveUserInfo();
  } catch(e){
    const msg = 'Restore failed: '+(e && e.message ? e.message : 'unknown error');
    if(!silent) alert(msg); else setDriveStatus(msg);
  }
}

document.getElementById('backupToDrive').addEventListener('click', ()=>{ ensureToken(()=>pushToDrive(false)); });
document.getElementById('restoreFromDrive').addEventListener('click', ()=>{ ensureToken(()=>pullFromDrive(false)); });

document.getElementById('disconnectDrive').addEventListener('click', ()=>{
  if(driveAccessToken && window.google && google.accounts){
    google.accounts.oauth2.revoke(driveAccessToken, ()=>{});
  }
  driveAccessToken = null;
  driveTokenExpiry = 0;
  setDriveStatus('Not connected');
});

// While connected this session, check Drive for changes made on another
// device whenever you come back to this tab (e.g. switching from your phone
// back to your laptop). This isn't constant background polling — only when
// the tab regains focus — to keep it light and battery-friendly.
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible' && driveAccessToken && Date.now() < driveTokenExpiry-5000){
    pullFromDrive(true);
  }
});

// (Client ID preload handled above, right after the Connect button wiring.)

// ---------- Init ----------
loadData();
document.getElementById('currencyUSA').classList.toggle('active', currentCurrency==='USD');
document.getElementById('currencyIndia').classList.toggle('active', currentCurrency==='INR');
document.getElementById('txAmountCurrency').textContent = currentCurrency==='USD' ? '$' : '₹';
resetForm();
document.getElementById('holdingDate').value = todayLocalISO();
document.getElementById('lendDate').value = todayLocalISO();
document.getElementById('sipStartDate').value = todayLocalISO();
document.getElementById('insBoughtDate').value = todayLocalISO();
document.getElementById('recurStartDate').value = todayLocalISO();
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
