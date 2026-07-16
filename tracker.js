
const STORAGE_KEY = 'spendingTracker.transactions.v1';
const CATEGORY_KEY = 'spendingTracker.categories.v1';
const CURRENCY_KEY = 'spendingTracker.currentCurrency';
const NETWORTH_KEY = 'spendingTracker.netWorth.v1';

const DEFAULT_CATEGORIES = {
  expense: ['Food','Transport','Housing','Utilities','Shopping','Entertainment','Health','Education','Other'],
  income: ['Salary','Business','Investment','Gift','Other']
};

const ASSET_CLASS_LABELS = {
  savings:'Savings', fd:'FD', rd:'RD', epf:'EPF', ppf:'PPF', equity:'Equity', mf:'Mutual Fund',
  liquidmf:'Liquid/Short MF', gold:'Gold/Silver', crypto:'Crypto', usstock:'US Stocks'
};

function emptyNetWorthBucket(){
  return {
    holdings: [],
    flatAssets: { realEstate:0, vehicles:0, otherAsset:0 },
    liabilities: { homeLoan:0, carLoan:0, ccDebt:0, personalLoan:0, otherLiability:0 }
  };
}

let transactions = [];
let categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
let netWorthData = { INR: emptyNetWorthBucket(), USD: emptyNetWorthBucket() };
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
    if(tx){ Object.assign(tx, {date, type:currentType, category, description:desc, amount, currency:currentCurrency}); }
  } else {
    transactions.push({ id: uid(), date, type: currentType, category, description: desc, amount, currency: currentCurrency });
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
document.getElementById('filterMonth').addEventListener('change', renderAll);
document.getElementById('filterCategory').addEventListener('change', renderAll);

function getFilteredTx(){
  const month = document.getElementById('filterMonth').value;
  const cat = document.getElementById('filterCategory').value;
  return transactions.filter(t=>{
    if(t.currency !== currentCurrency) return false;
    if(month!=='__all__' && monthKey(t.date)!==month) return false;
    if(cat && t.category!==cat) return false;
    return true;
  });
}

// ---------- Rendering ----------
function renderSummary(){
  const thisMonth = thisMonthLocal();
  const currencyTx = txInCurrentCurrency();
  const monthTx = currencyTx.filter(t=>monthKey(t.date)===thisMonth);
  const monthIncome = monthTx.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
  const monthExpense = monthTx.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
  document.getElementById('sumMonthIncome').textContent = fmtAmount(monthIncome);
  document.getElementById('sumMonthExpense').textContent = fmtAmount(monthExpense);
  const netEl = document.getElementById('sumMonthNet');
  netEl.textContent = fmtAmount(monthIncome-monthExpense);
  netEl.classList.toggle('brick', monthIncome-monthExpense<0);

  const allIncome = currencyTx.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
  const allExpense = currencyTx.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const balEl = document.getElementById('sumAllBalance');
  balEl.textContent = fmtAmount(allIncome-allExpense);
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
    const d = parseLocalDate(t.date);
    const dateLabel = d.toLocaleDateString('en-IN', {day:'2-digit', month:'short'});
    row.innerHTML = `
      <div class="tx-date">${escapeHtml(dateLabel)}</div>
      <div class="tx-main">
        <span class="tx-cat">${escapeHtml(t.category)}</span>
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

// ---------- Net Worth ----------
function getNW(){ return netWorthData[currentCurrency]; }

function nwUid(){ return 'nw_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }

function daysBetween(dateStr1, dateStr2){
  const d1 = parseLocalDate(dateStr1), d2 = parseLocalDate(dateStr2);
  return Math.round((d2 - d1) / (1000*60*60*24));
}

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

  if(!name){ alert('Give this holding a name.'); return; }
  if(!price || price<=0){ alert('Enter a buy price greater than zero.'); return; }
  if(!quantity || quantity<=0){ alert('Enter a quantity/units greater than zero.'); return; }

  getNW().holdings.push({
    id: nwUid(),
    assetClass,
    name,
    currentPrice,
    lots: [{ id: nwUid(), date, quantity, price }],
    sells: []
  });
  saveData();
  document.getElementById('holdingName').value = '';
  document.getElementById('holdingUnits').value = '1';
  document.getElementById('holdingPrice').value = '';
  document.getElementById('holdingCurrentPrice').value = '';
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
  getNW().holdings = getNW().holdings.filter(x=>x.id!==id);
  saveData();
  renderNetWorth();
}

function toggleHoldingLog(id){
  const el = document.getElementById('log-'+id);
  if(el) el.style.display = el.style.display==='none' ? '' : 'none';
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
  holdings.slice().sort((a,b)=>a.assetClass.localeCompare(b.assetClass)).forEach(h=>{
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
        <span class="h-meta">${daysHeld!==null&&qty>0?'Held '+daysHeld+' day'+(daysHeld===1?'':'s'):''}</span>
      </div>
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
        <button data-action="mark">✎ Update price</button>
        <button data-action="log">☰ Log</button>
        <button data-action="del">× Delete</button>
      </div>
      <div class="h-log" id="log-${h.id}" style="display:none;">
        ${h.lots.map(l=>`Holding: ${l.quantity} unit${l.quantity===1?'':'s'} bought at ${fmtAmount(l.price)} on ${l.date}`).join('<br>')}
        ${(h.sells||[]).map(s=>`Sold ${s.quantity} unit${s.quantity===1?'':'s'} at ${fmtAmount(s.price)} on ${s.date} — held ${s.daysHeld} day${s.daysHeld===1?'':'s'} — ${s.realizedPL>=0?'profit':'loss'} of ${fmtAmount(Math.abs(s.realizedPL))}`).join('<br>')}
      </div>
    `;
    card.querySelector('[data-action=buy]').addEventListener('click', ()=>buyHolding(h.id));
    const sellBtn = card.querySelector('[data-action=sell]');
    if(qty>0) sellBtn.addEventListener('click', ()=>sellHolding(h.id));
    card.querySelector('[data-action=mark]').addEventListener('click', ()=>updateHoldingValue(h.id));
    card.querySelector('[data-action=log]').addEventListener('click', ()=>toggleHoldingLog(h.id));
    card.querySelector('[data-action=del]').addEventListener('click', ()=>deleteHolding(h.id));
    wrap.appendChild(card);
  });
}

function renderNWTotals(){
  const holdings = getNW().holdings;
  const totalInvested = holdings.reduce((s,h)=>s+holdingInvested(h),0);
  const totalCurrent = holdings.reduce((s,h)=>s+holdingCurrentValue(h),0);
  const totalRealized = holdings.reduce((s,h)=>s+holdingRealizedPL(h),0);
  const gain = totalCurrent - totalInvested;
  document.getElementById('nwTotalInvested').textContent = fmtAmount(totalInvested);
  document.getElementById('nwTotalCurrent').textContent = fmtAmount(totalCurrent);
  const gainEl = document.getElementById('nwGainLoss');
  const gainPct = totalInvested>0 ? (gain/totalInvested)*100 : 0;
  gainEl.textContent = (gain>=0?'+':'')+fmtAmount(gain)+' ('+gainPct.toFixed(1)+'%)'+(totalRealized!==0?' · realized '+(totalRealized>=0?'+':'')+fmtAmount(totalRealized):'');
  gainEl.style.color = gain<0 ? 'var(--brick)' : 'var(--green-deep)';
  return totalCurrent;
}

function renderHoldingsChart(){
  const holdings = getNW().holdings;
  const byClass = {};
  holdings.forEach(h=>{ byClass[h.assetClass] = (byClass[h.assetClass]||0) + holdingCurrentValue(h); });
  const labels = Object.keys(byClass).map(k=>ASSET_CLASS_LABELS[k]||k);
  const data = Object.values(byClass);
  const palette = ['#1F6F50','#C98A2C','#A2452F','#4B5A50','#7a9e8f','#d9b06b','#c47a68','#8fa89d','#3d6b8a','#6b5b95','#88a09e'];
  if(labels.length===0 || data.every(v=>v<=0)){
    drawChart('holdingsChart', ['No holdings'], [{data:[1], backgroundColor:['#c7cdb9']}], {plugins:{legend:{display:false}}}, 'doughnut');
    return;
  }
  drawChart('holdingsChart', labels, [{ data, backgroundColor: labels.map((_,i)=>palette[i%palette.length]) }], {}, 'doughnut');
}

function bindFlatNWField(id, group, key){
  const el = document.getElementById(id);
  el.addEventListener('input', ()=>{
    getNW()[group][key] = +el.value || 0;
    saveData();
    renderNWSummary();
  });
}
['nwRealEstate','nwVehicles','nwOtherAsset'].forEach(id=>{
  const key = id==='nwRealEstate'?'realEstate':id==='nwVehicles'?'vehicles':'otherAsset';
  bindFlatNWField(id, 'flatAssets', key);
});
[['nwHomeLoan','homeLoan'],['nwCarLoan','carLoan'],['nwCcDebt','ccDebt'],['nwPersonalLoan','personalLoan'],['nwOtherLiability','otherLiability']].forEach(([id,key])=>{
  bindFlatNWField(id, 'liabilities', key);
});

function renderNWSummary(investmentValue){
  const nw = getNW();
  if(investmentValue===undefined) investmentValue = nw.holdings.reduce((s,h)=>s+holdingCurrentValue(h),0);
  const otherAssets = nw.flatAssets.realEstate + nw.flatAssets.vehicles + nw.flatAssets.otherAsset;
  const liabilities = nw.liabilities.homeLoan + nw.liabilities.carLoan + nw.liabilities.ccDebt + nw.liabilities.personalLoan + nw.liabilities.otherLiability;
  const grandTotal = investmentValue + otherAssets - liabilities;

  document.getElementById('nwInvestValue').textContent = fmtAmount(investmentValue);
  document.getElementById('nwOtherAssetsTotal').textContent = fmtAmount(otherAssets);
  document.getElementById('nwLiabTotal').textContent = fmtAmount(liabilities);
  const grandEl = document.getElementById('nwGrandTotal');
  grandEl.textContent = fmtAmount(grandTotal);
  grandEl.classList.toggle('brick', grandTotal<0);

  // reflect saved flat values into the input fields (e.g. after switching currency or restoring from Drive)
  document.getElementById('nwRealEstate').value = nw.flatAssets.realEstate;
  document.getElementById('nwVehicles').value = nw.flatAssets.vehicles;
  document.getElementById('nwOtherAsset').value = nw.flatAssets.otherAsset;
  document.getElementById('nwHomeLoan').value = nw.liabilities.homeLoan;
  document.getElementById('nwCarLoan').value = nw.liabilities.carLoan;
  document.getElementById('nwCcDebt').value = nw.liabilities.ccDebt;
  document.getElementById('nwPersonalLoan').value = nw.liabilities.personalLoan;
  document.getElementById('nwOtherLiability').value = nw.liabilities.otherLiability;
}

function renderNetWorth(){
  renderHoldingsList();
  const investmentValue = renderNWTotals();
  renderHoldingsChart();
  renderNWSummary(investmentValue);
}

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
  renderSummary();
  renderList();
  renderCategoryChart();
  renderTrendChart();
  renderNetWorth();
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
        if(h.id && !existingIds.has(h.id)){ localBucket.holdings.push(h); addedHoldings++; }
      });
    }
    if(incomingBucket.flatAssets) Object.assign(localBucket.flatAssets, incomingBucket.flatAssets);
    if(incomingBucket.liabilities) Object.assign(localBucket.liabilities, incomingBucket.liabilities);
  });
  return addedHoldings;
}

document.getElementById('exportJson').addEventListener('click', ()=>{
  const payload = { transactions, categories, netWorthData, exportedAt: new Date().toISOString() };
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
      const existingIds = new Set(transactions.map(t=>t.id));
      incoming.forEach(t=>{ if(t.id && !existingIds.has(t.id)){ if(!t.currency) t.currency='INR'; transactions.push(t); } });
      if(data.categories){
        ['income','expense'].forEach(type=>{
          if(Array.isArray(data.categories[type])){
            data.categories[type].forEach(c=>{ if(!categories[type].includes(c)) categories[type].push(c); });
          }
        });
      }
      mergeNetWorthFromBackup(data.netWorthData);
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
    const payload = JSON.stringify({ transactions, categories, netWorthData, exportedAt: new Date().toISOString() }, null, 2);
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
    const incoming = Array.isArray(data.transactions) ? data.transactions : [];
    const existingIds = new Set(transactions.map(t=>t.id));
    let added = 0;
    incoming.forEach(t=>{ if(t.id && !existingIds.has(t.id)){ if(!t.currency) t.currency='INR'; transactions.push(t); added++; } });
    if(data.categories){
      ['income','expense'].forEach(type=>{
        if(Array.isArray(data.categories[type])) data.categories[type].forEach(c=>{ if(!categories[type].includes(c)) categories[type].push(c); });
      });
    }
    const addedHoldings = mergeNetWorthFromBackup(data.netWorthData);
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
