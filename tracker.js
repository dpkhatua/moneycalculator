const STORAGE_KEY = 'spendingTracker.transactions.v1';
const CATEGORY_KEY = 'spendingTracker.categories.v1';
const CURRENCY_KEY = 'spendingTracker.currentCurrency';
const NETWORTH_KEY = 'spendingTracker.netWorth.v1';
const BUDGET_KEY = 'spendingTracker.budgets.v1';
const DELETED_KEY = 'spendingTracker.deletedIds.v1';
const REMIT_KEY = 'spendingTracker.remittances.v1';
// Tracks the exportedAt timestamp of the last backup this device has fully
// incorporated (pushed or pulled). Used to tell whether an incoming backup
// is newer than what this device already knows, which determines whether
// overlapping records should be treated as edits (overwrite) or left alone.
const SYNC_TS_KEY = 'spendingTracker.lastSyncTimestamp';
function getLastSyncTimestamp(){ return localStorage.getItem(SYNC_TS_KEY) || ''; }
function setLastSyncTimestamp(ts){ if(ts) localStorage.setItem(SYNC_TS_KEY, ts); }

const DEFAULT_CATEGORIES = {
  expense: ['Food','Transport','Housing','Utilities','Shopping','Entertainment','Health','Education','Other'],
  income: ['Salary','Business','Investment','Gift','Other']
};

const ASSET_CLASS_LABELS = {
  savings:'Savings', fd:'FD', rd:'RD', epf:'EPF', ppf:'PPF', equity:'Equity', mf:'Mutual Fund',
  liquidmf:'Liquid/Short MF', gold:'Gold/Silver', crypto:'Crypto', usstock:'US Stocks',
  realestate:'Real Estate', vehicle:'Vehicle', other:'Other Asset'
};

// These asset types are tracked by amount, not units/shares — no quantity or
// per-unit price math for them, just "how much is invested" and "what's it
// worth now." (Equity, US Stocks, and Crypto keep real unit tracking, since
// share/coin counts genuinely matter there.)
const SIMPLE_VALUE_CLASSES = ['savings','fd','rd','epf','ppf','mf','liquidmf','gold','realestate','vehicle','other'];
function isSimpleValueClass(assetClass){ return SIMPLE_VALUE_CLASSES.includes(assetClass); }
// Savings accounts are pure cash balances — no "invested vs current value"
// concept at all (unlike FD/MF/Gold, which genuinely have a cost basis and a
// market value that can diverge). Just one number: what's in the account.
function isCashAccountClass(assetClass){ return assetClass==='savings'; }

function getSavingsAccounts(){ return getNW().holdings.filter(h=>isCashAccountClass(h.assetClass)); }
function getSavingsAccountsForCurrency(cur){ return netWorthData[cur].holdings.filter(h=>isCashAccountClass(h.assetClass)); }

// Adjusts a cash account's balance directly and keeps invested/current in
// lockstep (so it never shows a gain/loss — it's cash, not an investment).
// Allowed to go negative, since silently capping at zero would hide genuine
// overspending from an account you're trying to track honestly.
function adjustCashAccount(holdingId, amount){
  const h = getNW().holdings.find(x=>x.id===holdingId && isCashAccountClass(x.assetClass));
  if(!h) return false;
  h.currentPrice = (h.currentPrice||0) + amount;
  if(h.lots.length===0) h.lots.push({ id: nwUid(), date: todayLocalISO(), quantity:1, price:0 });
  h.lots[0].price = h.currentPrice;
  return true;
}
function creditSavingsAccount(holdingId, amount){ return adjustCashAccount(holdingId, amount); }
function debitSavingsAccount(holdingId, amount){ return adjustCashAccount(holdingId, -amount); }

// Same as adjustCashAccount, but for a specific currency's holdings bucket
// regardless of which currency toggle is currently active — needed for
// remittances, which touch a USD account and an INR account at once.
function adjustCashAccountInCurrency(cur, holdingId, amount){
  const h = netWorthData[cur].holdings.find(x=>x.id===holdingId && isCashAccountClass(x.assetClass));
  if(!h) return false;
  h.currentPrice = (h.currentPrice||0) + amount;
  if(h.lots.length===0) h.lots.push({ id: nwUid(), date: todayLocalISO(), quantity:1, price:0 });
  h.lots[0].price = h.currentPrice;
  return true;
}

function getCreditCards(){ return getNW().creditCards; }
// A charge increases what you owe (opposite of a bank debit, which decreases
// what you have) — this is the whole difference between an account and a card.
function chargeCreditCard(cardId, amount){
  const c = getCreditCards().find(x=>x.id===cardId);
  if(!c) return false;
  c.currentDue = (c.currentDue||0) + amount;
  return true;
}
function unchargeCreditCard(cardId, amount){ return chargeCreditCard(cardId, -amount); }

// The transaction form's "Paid via" dropdown offers both accounts (debit) and
// credit cards (charge) in one list, prefixed so we know which is which.
function populateTxPaymentSelect(){
  const sel = document.getElementById('txAccount');
  const prevValue = sel.value;
  const accounts = getSavingsAccounts();
  const cards = getCreditCards();
  let html = `<option value="">— none / untracked —</option>`;
  if(accounts.length>0){
    html += `<optgroup label="Accounts">${accounts.map(a=>`<option value="acct:${a.id}">${escapeHtml(a.name)}</option>`).join('')}</optgroup>`;
  }
  if(cards.length>0){
    html += `<optgroup label="Credit Cards">${cards.map(c=>`<option value="card:${c.id}">${escapeHtml(c.name)}</option>`).join('')}</optgroup>`;
  }
  html += `<option value="__add_new_account__">+ Add new account…</option><option value="__add_new_card__">+ Add new credit card…</option>`;
  sel.innerHTML = html;
  if(prevValue && [...sel.options].some(o=>o.value===prevValue)) sel.value = prevValue;
}

// Applies (direction=+1) or reverses (direction=-1) a transaction's effect on
// whichever payment method it's tagged with — debits a bank account, or
// charges/uncharges a credit card. Handles both the old accountId-only shape
// and the new prefixed paymentMethod shape for backward compatibility.
function applyTxToPaymentMethod(tx, direction){
  if(!tx) return;
  if(tx.creditCardId){
    const delta = tx.amount * direction; // expenses on a card always increase what's owed
    chargeCreditCard(tx.creditCardId, tx.type==='expense' ? delta : -delta);
    return;
  }
  applyTxToAccount(tx, direction);
}


// Same as before, but works for any select element — used by SIP/Loan/
// Remittance/Recurring "debit from" dropdowns (never shows "+ Add new…").
function populateAccountSelect(selectId, includeNoneLabel, currencyOverride){
  const sel = document.getElementById(selectId);
  if(!sel) return;
  const prevValue = sel.value;
  const accounts = currencyOverride ? getSavingsAccountsForCurrency(currencyOverride) : getSavingsAccounts();
  sel.innerHTML = `<option value="">${includeNoneLabel||'— none / untracked —'}</option>` +
    accounts.map(a=>`<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  if(prevValue && [...sel.options].some(o=>o.value===prevValue)) sel.value = prevValue;
}

// Creates a bare-bones account (a Savings-class holding) directly — no need
// to go through the full Add Holding form just to name a bank account.
function createQuickAccount(name, openingBalance){
  const h = {
    id: nwUid(), assetClass:'savings', name, ticker:null, note:null,
    currentPrice: openingBalance,
    lots: [{ id: nwUid(), date: todayLocalISO(), quantity:1, price: openingBalance }],
    sells: [],
    investmentLog: [{ id: nwUid(), date: todayLocalISO(), amount: openingBalance, note: null }]
  };
  getNW().holdings.push(h);
  return h;
}

function createQuickCreditCard(name, dueDate){
  const c = {
    id: nwUid(), name, issuer:null, currentDue:0,
    nextDueDate: dueDate || addMonthsClamped(todayLocalISO(), 1),
    status:'active', payments:[], pendingOccurrences:[]
  };
  getCreditCards().push(c);
  return c;
}

// The transaction form's Account dropdown gets its own populate function so
// it can offer "+ Add new account…" inline — no pre-made accounts exist
// until you create one this way (or via Net Worth).
document.getElementById('txAccount').addEventListener('change', (e)=>{
  if(e.target.value === '__add_new_account__'){
    const name = prompt('New account name (e.g. "Checking", "HDFC Savings"):');
    if(name && name.trim()){
      const balRaw = prompt(`Starting balance for "${name.trim()}":`, '0');
      const balance = balRaw===null ? 0 : (+balRaw || 0);
      const h = createQuickAccount(name.trim(), balance);
      saveData();
      populateTxPaymentSelect();
      e.target.value = 'acct:'+h.id;
      renderNetWorth();
    } else {
      populateTxPaymentSelect();
    }
  } else if(e.target.value === '__add_new_card__'){
    const name = prompt('New credit card name (e.g. "HDFC Regalia"):');
    if(name && name.trim()){
      const c = createQuickCreditCard(name.trim());
      saveData();
      populateTxPaymentSelect();
      e.target.value = 'card:'+c.id;
      renderCreditCards();
    } else {
      populateTxPaymentSelect();
    }
  }
});


function emptyNetWorthBucket(){
  return {
    holdings: [],
    liabilities: { homeLoan:0, carLoan:0, ccDebt:0, personalLoan:0, otherLiability:0 },
    lending: [], // money lent to people — intentionally never included in net worth totals
    sips: [],    // ongoing SIPs — installments auto-log on their due date
    insurance: [], // ongoing insurance policies
    recurringExpenses: [], // "definite spending" — fixed bills that auto-log as real expenses on schedule
    swps: [], // Systematic Withdrawal (and optional transfer-into-SIP): auto-withdraws from one holding, optionally auto-invests into another
    wealthSnapshots: [], // { month:'YYYY-MM', netWorth, investedValue, currentValue } — one entry per month, refreshed each time you open the tracker that month. Can't be reconstructed for months before this feature existed, since past market values were never recorded.
    loansTaken: [], // any loan you've borrowed (home/car/personal/etc.) — EMI auto-logs on schedule; outstanding balance counts as a liability in net worth
    creditCards: [] // charges tagged to a card increase its due; outstanding due counts as a liability in net worth
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
// USA → India money transfers — spans both currencies at once (USD sent,
// INR received), so unlike everything else this isn't split into per-currency
// buckets. Not counted in net worth (it's a transfer, not new wealth).
let remittances = [];
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
  // Migration: amount-based holdings (Savings/FD/RD/EPF/PPF/MF/Liquid MF/
  // Gold/Real Estate/Vehicle/Other) must always have exactly one lot — if
  // "Buy" was used more than once before this fix, multiple lots would have
  // made quantity grow past 1, which silently multiplied the current value
  // (quantity × currentPrice) incorrectly. Consolidate into a single lot,
  // preserving the correct total invested amount and moving the original
  // per-buy history into investmentLog so nothing is lost.
  ['INR','USD'].forEach(cur=>{
    netWorthData[cur].holdings.forEach(h=>{
      if(isSimpleValueClass(h.assetClass) && h.lots.length>1){
        const totalCost = h.lots.reduce((s,l)=>s+l.quantity*l.price,0);
        const latestDate = h.lots.reduce((max,l)=> l.date>max?l.date:max, h.lots[0].date);
        const earliestDate = h.lots.reduce((min,l)=> l.date<min?l.date:min, h.lots[0].date);
        if(!h.investmentLog){
          h.investmentLog = h.lots.map(l=>({ id: l.id, date: l.date, amount: l.quantity*l.price, note: l.note||null }));
        }
        h.lots = [{ id: nwUid(), date: earliestDate, quantity: 1, price: totalCost }];
        h.lots[0].date = earliestDate;
        void latestDate; // kept for clarity; earliestDate is what "held since" should use
      }
    });
  });
  // Migration: every simple-value holding needs an investmentLog (a running,
  // editable history of each contribution) — seed one from the single lot if
  // it doesn't have one yet, so older holdings get history too.
  ['INR','USD'].forEach(cur=>{
    netWorthData[cur].holdings.forEach(h=>{
      if(isSimpleValueClass(h.assetClass) && !h.investmentLog){
        h.investmentLog = h.lots.length>0
          ? [{ id: nwUid(), date: h.lots[0].date, amount: h.lots[0].price, note: h.lots[0].note||null }]
          : [];
      }
    });
  });
  // Migration: SIP installments logged before "postedToHolding" tracking
  // existed don't have that flag at all. Rather than assuming they were (or
  // weren't) posted, check the linked holding's own history for a matching
  // date+amount entry — if it's genuinely there, mark it posted so Backfill
  // won't double-count it; if it's missing, leave it eligible for backfill.
  ['INR','USD'].forEach(cur=>{
    const bucket = netWorthData[cur];
    bucket.sips.forEach(sip=>{
      const holding = sip.linkedHoldingId ? bucket.holdings.find(h=>h.id===sip.linkedHoldingId) : null;
      sip.installments.forEach(inst=>{
        if(inst.postedToHolding !== undefined) return;
        if(!holding){ inst.postedToHolding = false; return; }
        const alreadyThere = isSimpleValueClass(holding.assetClass)
          ? (holding.investmentLog||[]).some(e=>e.date===inst.date && Math.abs(e.amount-inst.amount)<0.01)
          : (holding.lots||[]).some(l=>l.date===inst.date && Math.abs(l.price-inst.amount)<0.01);
        inst.postedToHolding = alreadyThere;
      });
    });
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
  try{
    const rawRemit = localStorage.getItem(REMIT_KEY);
    remittances = rawRemit ? JSON.parse(rawRemit) : [];
  } catch(e){ remittances = []; }
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
    localStorage.setItem(REMIT_KEY, JSON.stringify(remittances));
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

// Category removal only affects new transactions/budgets — anything already
// logged keeps its category label untouched, so past data is never silently
// changed or orphaned.
function removeCategory(type, name){
  const usageCount = transactions.filter(t=>t.type===type && t.category===name).length;
  const hasBudget = type==='expense' && (budgets.INR[name]!==undefined || budgets.USD[name]!==undefined);
  let msg = `Remove "${name}" from your ${type} categories?`;
  if(usageCount>0) msg += `\n\n${usageCount} existing transaction(s) use this category — they'll keep it as-is; you just won't be able to pick it for new ones.`;
  if(hasBudget) msg += `\n\nIts budget (if set, in either currency) will be removed too.`;
  if(!confirm(msg)) return;

  categories[type] = categories[type].filter(c=>c!==name);
  if(hasBudget){
    delete budgets.INR[name];
    delete budgets.USD[name];
  }
  saveData();
  renderCategoryManagement();
  populateCategorySelect();
  renderBudget();
}

function renderCategoryManagement(){
  ['expense','income'].forEach(type=>{
    const wrap = document.getElementById(type==='expense' ? 'manageExpenseCategories' : 'manageIncomeCategories');
    if(categories[type].length===0){ wrap.innerHTML = '<div class="empty-state">None yet.</div>'; return; }
    wrap.innerHTML = '';
    categories[type].slice().sort().forEach(name=>{
      const count = transactions.filter(t=>t.type===type && t.category===name).length;
      const row = document.createElement('div');
      row.className = 'cat-chip-row';
      row.innerHTML = `<span class="cat-chip-name">${escapeHtml(name)}</span><span class="cat-chip-count">${count>0?count+' used':''}</span>`;
      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.title = 'Remove this category';
      delBtn.addEventListener('click', ()=>removeCategory(type, name));
      row.appendChild(delBtn);
      wrap.appendChild(row);
    });
  });
}

document.getElementById('addQuickAccount').addEventListener('click', ()=>{
  const name = document.getElementById('quickAccountName').value.trim();
  const balRaw = document.getElementById('quickAccountBalance').value;
  if(!name){ alert('Enter an account name.'); return; }
  const balance = balRaw==='' ? 0 : (+balRaw || 0);
  createQuickAccount(name, balance);
  saveData();
  document.getElementById('quickAccountName').value = '';
  document.getElementById('quickAccountBalance').value = '';
  renderAll();
});

function renderAccountManagement(){
  const wrap = document.getElementById('manageAccountsList');
  const accounts = getSavingsAccounts();
  if(accounts.length===0){ wrap.innerHTML = '<div class="empty-state">No accounts yet — add one above.</div>'; return; }
  wrap.innerHTML = '';
  accounts.slice().sort((a,b)=>a.name.localeCompare(b.name)).forEach(a=>{
    const usedByTx = transactions.filter(t=>t.accountId===a.id).length;
    const row = document.createElement('div');
    row.className = 'cat-chip-row';
    row.innerHTML = `<span class="cat-chip-name">${escapeHtml(a.name)} — ${fmtAmount(holdingCurrentValue(a))}</span><span class="cat-chip-count">${usedByTx>0?usedByTx+' transaction(s)':''}</span>`;
    const delBtn = document.createElement('button');
    delBtn.textContent = '×';
    delBtn.title = 'Delete this account';
    delBtn.addEventListener('click', ()=>deleteHolding(a.id));
    row.appendChild(delBtn);
    wrap.appendChild(row);
  });
}

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
  document.getElementById('txAccount').value = '';
  document.getElementById('txAmount').value = '';
  setType('expense');
}

// Applies (direction=+1) or reverses (direction=-1) a transaction's effect on
// its linked account — expenses debit, income credits. Used whenever a
// transaction is added, edited (reverse-old-then-apply-new), or deleted.
function applyTxToAccount(tx, direction){
  if(!tx || !tx.accountId) return;
  const delta = (tx.type==='expense' ? -tx.amount : tx.amount) * direction;
  adjustCashAccount(tx.accountId, delta);
}

// Parses the "Paid via" dropdown's prefixed value ("acct:xxx" or "card:xxx")
// into the pair of fields a transaction actually stores.
function parsePaymentSelectValue(raw){
  if(!raw) return { accountId:null, creditCardId:null };
  if(raw.startsWith('acct:')) return { accountId: raw.slice(5), creditCardId:null };
  if(raw.startsWith('card:')) return { accountId:null, creditCardId: raw.slice(5) };
  return { accountId:null, creditCardId:null }; // ignores stray __add_new_*__ values, shouldn't reach here
}
function paymentSelectValueFor(tx){
  if(tx.creditCardId) return 'card:'+tx.creditCardId;
  if(tx.accountId) return 'acct:'+tx.accountId;
  return '';
}

document.getElementById('txSubmit').addEventListener('click', ()=>{
  const date = document.getElementById('txDate').value;
  const category = document.getElementById('txCategory').value;
  const desc = document.getElementById('txDesc').value.trim();
  const tag = document.getElementById('txTag').value.trim();
  const { accountId, creditCardId } = parsePaymentSelectValue(document.getElementById('txAccount').value);
  const amount = +document.getElementById('txAmount').value;

  if(!date){ alert('Pick a date.'); return; }
  if(!amount || amount<=0){ alert('Enter an amount greater than zero.'); return; }
  if(category==='__add_new__'){ alert('Finish adding the new category first.'); return; }

  if(editingId){
    const tx = transactions.find(t=>t.id===editingId);
    if(tx){
      applyTxToPaymentMethod(tx, -1); // undo whatever the old version did
      Object.assign(tx, {date, type:currentType, category, description:desc, tag:tag||null, accountId, creditCardId, amount, currency:currentCurrency});
      applyTxToPaymentMethod(tx, 1); // apply the new version's effect
    }
  } else {
    const tx = { id: uid(), date, type: currentType, category, description: desc, tag: tag||null, accountId, creditCardId, amount, currency: currentCurrency };
    transactions.push(tx);
    applyTxToPaymentMethod(tx, 1);
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
  populateTxPaymentSelect();
  document.getElementById('txAccount').value = paymentSelectValueFor(tx);
  document.getElementById('txAmount').value = tx.amount;
  populateCategorySelect();
  document.getElementById('txCategory').value = tx.category;
  document.getElementById('txSubmit').textContent = 'Save changes';
  document.getElementById('editNote').textContent = 'Editing an existing transaction — Save changes will update it in place.';
  window.scrollTo({top: document.querySelector('.tracker-grid').offsetTop - 20, behavior:'smooth'});
}
function deleteTx(id){
  if(!confirm('Delete this transaction? This can\'t be undone.')) return;
  const tx = transactions.find(t=>t.id===id);
  if(tx) applyTxToPaymentMethod(tx, -1); // undo its effect on the linked account/card, if any
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
  const accountsById = new Map(getSavingsAccounts().map(a=>[a.id, a.name]));
  list.innerHTML = '';
  filtered.forEach(t=>{
    const row = document.createElement('div');
    row.className = 'tx-row';
    const d = parseLocalDate(t.date);
    const dateLabel = d.toLocaleDateString('en-IN', {day:'2-digit', month:'short'});
    const isDup = dupIds.has(t.id);
    const accountName = t.accountId ? accountsById.get(t.accountId) : null;
    row.innerHTML = `
      <div class="tx-date">${escapeHtml(dateLabel)}</div>
      <div class="tx-main">
        <span class="tx-cat">${escapeHtml(t.category)}${t.tag?' · '+escapeHtml(t.tag):''}${accountName?' · 🏦 '+escapeHtml(accountName):''}${isDup?' <span class="dup-badge" title="Same date, amount, category, and description as another transaction — check it is not a duplicate">⚠ possible duplicate</span>':''}</span>
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

function populateMonthlyCategoryYearFilter(){
  const sel = document.getElementById('monthlyCategoryYear');
  const prevValue = sel.value;
  const expenseTx = txInCurrentCurrency().filter(t=>t.type==='expense');
  const years = [...new Set(expenseTx.map(t=>t.date.slice(0,4)))].sort().reverse();
  sel.innerHTML = '<option value="__all__">All years</option>' + years.map(y=>`<option value="${y}">${y}</option>`).join('');
  if(prevValue && [...sel.options].some(o=>o.value===prevValue)) sel.value = prevValue;
  else if(years.length>0) sel.value = years[0]; // default to most recent year
}
document.getElementById('monthlyCategoryYear').addEventListener('change', renderMonthlyCategoryTable);

function renderMonthlyCategoryTable(){
  const wrap = document.getElementById('monthlyCategoryTable');
  const selectedYear = document.getElementById('monthlyCategoryYear').value;
  let expenseTx = txInCurrentCurrency().filter(t=>t.type==='expense');
  if(selectedYear && selectedYear!=='__all__') expenseTx = expenseTx.filter(t=>t.date.slice(0,4)===selectedYear);
  if(expenseTx.length===0){
    wrap.innerHTML = '<div class="empty-state">No expenses logged yet for this selection.</div>';
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

function renderIncomeCategoryTotalTable(){
  const wrap = document.getElementById('incomeCatTotalTable');
  const incomeTx = txInCurrentCurrency().filter(t=>t.type==='income');
  if(incomeTx.length===0){
    wrap.innerHTML = '<div class="empty-state">No income logged yet.</div>';
    return;
  }
  const byCat = {};
  incomeTx.forEach(t=>{ byCat[t.category] = (byCat[t.category]||0) + t.amount; });
  const cats = Object.keys(byCat).sort((a,b)=>byCat[b]-byCat[a]);
  const total = cats.reduce((s,c)=>s+byCat[c],0);

  let html = `
    <table class="cat-table">
      <thead><tr><th>Category</th><th style="text-align:right;">Total</th><th style="text-align:right;">% of income</th></tr></thead>
      <tbody>
  `;
  cats.forEach(cat=>{
    const amt = byCat[cat];
    const pct = total>0 ? (amt/total)*100 : 0;
    html += `
      <tr>
        <td>${escapeHtml(cat)}</td>
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

function renderIncomeCategoryYearTable(){
  const wrap = document.getElementById('incomeCatYearTable');
  const incomeTx = txInCurrentCurrency().filter(t=>t.type==='income');
  if(incomeTx.length===0){ wrap.innerHTML = ''; return; }
  const cats = [...new Set(incomeTx.map(t=>t.category))].sort();
  const years = [...new Set(incomeTx.map(t=>t.date.slice(0,4)))].sort().reverse();

  let html = `
    <table class="cat-table">
      <thead><tr><th>Year</th>${cats.map(c=>`<th style="text-align:right;">${escapeHtml(c)}</th>`).join('')}<th style="text-align:right;">Total</th></tr></thead>
      <tbody>
  `;
  years.forEach(y=>{
    const yearTx = incomeTx.filter(t=>t.date.slice(0,4)===y);
    let yearTotal = 0;
    const cells = cats.map(cat=>{
      const sum = yearTx.filter(t=>t.category===cat).reduce((s,t)=>s+t.amount,0);
      yearTotal += sum;
      return `<td class="num">${sum>0?fmtAmount(sum):'—'}</td>`;
    }).join('');
    html += `<tr><td>${y}</td>${cells}<td class="num" style="font-weight:600;">${fmtAmount(yearTotal)}</td></tr>`;
  });
  html += '</tbody></table>';
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
// For simple-value holdings, investmentLog is the editable source of truth
// (every contribution, manual or SIP-driven, as its own entry). The single
// lot is just a derived total kept in sync with it, so the value math
// (quantity × currentPrice) stays correct without ever needing a second lot.
function recomputeSimpleLot(h){
  const total = (h.investmentLog||[]).reduce((s,e)=>s+e.amount,0);
  const oldestDate = (h.investmentLog||[]).reduce((min,e)=> (!min||e.date<min) ? e.date : min, null) || todayLocalISO();
  if(h.lots.length===0) h.lots.push({ id: nwUid(), date: oldestDate, quantity:1, price:0 });
  h.lots[0].quantity = 1;
  h.lots[0].price = total;
  h.lots[0].date = oldestDate;
}

// Shared "deposit into a holding automatically" used by both SIP installments
// and SWP transfers — same logic as a manual "+ Buy"/"+ Add", just without prompts.
function postContributionToHolding(holding, date, amount, note){
  if(isSimpleValueClass(holding.assetClass)){
    holding.investmentLog = holding.investmentLog || [];
    holding.investmentLog.push({ id: nwUid(), date, amount, note });
    recomputeSimpleLot(holding);
  } else {
    holding.lots.push({ id: nwUid(), date, quantity: 1, price: amount, note });
  }
}

// Shared "withdraw from a holding automatically" used by SWP — same math as
// the manual "− Sell"/"− Withdraw" flow, just without prompts, and capped at
// whatever the holding is actually worth (so it can never go negative).
function withdrawFromHoldingAuto(holding, date, amount){
  const currentValue = holdingCurrentValue(holding);
  if(currentValue<=0) return { withdrawn:0, realizedPL:0, shortfall:true };
  const actual = Math.min(amount, currentValue);
  let realizedPL = 0;

  if(isSimpleValueClass(holding.assetClass)){
    const proportion = actual / currentValue;
    const costBasisRemoved = holding.lots[0].price * proportion;
    const daysHeld = daysBetween(holding.lots[0].date, date);
    (holding.investmentLog||[]).forEach(e=>{ e.amount = e.amount * (1-proportion); });
    recomputeSimpleLot(holding);
    holding.currentPrice -= actual;
    realizedPL = actual - costBasisRemoved;
    holding.sells = holding.sells || [];
    holding.sells.push({ id: nwUid(), date, amount: actual, costBasis: costBasisRemoved, realizedPL, daysHeld });
  } else {
    const sellQty = holding.currentPrice>0 ? actual / holding.currentPrice : 0;
    holding.lots.sort((a,b)=>a.date.localeCompare(b.date));
    let remaining = sellQty, costBasisTotal=0, weightedDaysSum=0;
    const newLots=[];
    for(const lot of holding.lots){
      if(remaining<=0){ newLots.push(lot); continue; }
      if(lot.quantity<=remaining){
        costBasisTotal += lot.quantity*lot.price;
        weightedDaysSum += lot.quantity*daysBetween(lot.date, date);
        remaining -= lot.quantity;
      } else {
        costBasisTotal += remaining*lot.price;
        weightedDaysSum += remaining*daysBetween(lot.date, date);
        newLots.push({ id: lot.id, date: lot.date, quantity: lot.quantity-remaining, price: lot.price });
        remaining = 0;
      }
    }
    holding.lots = newLots;
    realizedPL = actual - costBasisTotal;
    const daysHeld = sellQty>0 ? Math.round(weightedDaysSum/sellQty) : 0;
    holding.sells = holding.sells || [];
    holding.sells.push({ id: nwUid(), date, quantity: sellQty, price: holding.currentPrice, costBasis: costBasisTotal, realizedPL, daysHeld });
  }
  return { withdrawn: actual, realizedPL, shortfall: actual<amount-0.01 };
}

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
  const quantity = isSimpleValueClass(assetClass) ? 1 : (qtyRaw==='' ? 1 : +qtyRaw);
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
    sells: [],
    investmentLog: isSimpleValueClass(assetClass) ? [{ id: nwUid(), date, amount: price, note: null }] : undefined
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

  if(isCashAccountClass(h.assetClass)){
    const raw = prompt(`Deposit into "${h.name}" — amount:`, '');
    if(!raw) return;
    const amount = +raw;
    if(!amount || amount<=0){ alert('Enter a valid amount.'); return; }
    creditSavingsAccount(h.id, amount);
    saveData();
    renderNetWorth();
    return;
  }

  if(isSimpleValueClass(h.assetClass)){
    const raw = prompt(`Add to "${h.name}" — amount invested now:`, '');
    if(!raw) return;
    const amount = +raw;
    if(!amount || amount<=0){ alert('Enter a valid amount.'); return; }
    const dateRaw = prompt('Date (YYYY-MM-DD):', todayLocalISO());
    const date = dateRaw || todayLocalISO();
    const noteRaw = prompt('Note (optional):', '') || '';
    h.investmentLog = h.investmentLog || [];
    h.investmentLog.push({ id: nwUid(), date, amount, note: noteRaw.trim() || null });
    recomputeSimpleLot(h);
    h.currentPrice = (h.currentPrice||0) + amount;
    saveData();
    renderNetWorth();
    return;
  }

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

  if(isCashAccountClass(h.assetClass)){
    const raw = prompt(`Withdraw from "${h.name}" — amount (current balance: ${fmtAmount(holdingCurrentValue(h))}):`, '');
    if(!raw) return;
    const amount = +raw;
    if(!amount || amount<=0){ alert('Enter a valid amount.'); return; }
    debitSavingsAccount(h.id, amount);
    saveData();
    renderNetWorth();
    return;
  }

  if(isSimpleValueClass(h.assetClass)){
    const currentValue = holdingCurrentValue(h);
    if(currentValue<=0){ alert('Nothing left to withdraw.'); return; }
    const raw = prompt(`Withdraw from "${h.name}" — amount (current value: ${fmtAmount(currentValue)}):`, '');
    if(!raw) return;
    const amount = +raw;
    if(!amount || amount<=0){ alert('Enter a valid amount.'); return; }
    if(amount > currentValue){ alert('That is more than the current value.'); return; }
    const dateRaw = prompt('Date (YYYY-MM-DD):', todayLocalISO());
    const sellDate = dateRaw || todayLocalISO();

    const proportion = amount / currentValue;
    const costBasisRemoved = h.lots[0].price * proportion;
    const daysHeld = daysBetween(h.lots[0].date, sellDate);
    // Scale every historical contribution down by the same proportion, so
    // investmentLog (the source of truth for invested amount) reflects the
    // withdrawal, rather than editing the derived lot directly.
    (h.investmentLog||[]).forEach(e=>{ e.amount = e.amount * (1-proportion); });
    recomputeSimpleLot(h);
    h.currentPrice -= amount;
    const realizedPL = amount - costBasisRemoved;
    h.sells = h.sells || [];
    h.sells.push({ id: nwUid(), date: sellDate, amount, costBasis: costBasisRemoved, realizedPL, daysHeld });
    saveData();
    renderNetWorth();
    return;
  }

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
  renderAccountManagement(); // in case this was a savings account, keep the accounts list/dropdown in sync
  populateTxPaymentSelect();
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

function setLowBalanceAlert(id){
  const h = getNW().holdings.find(x=>x.id===id);
  if(!h) return;
  const raw = prompt(`Alert me when "${h.name}" drops below this amount (leave blank or 0 to turn off):`, h.lowBalanceThreshold||'');
  if(raw===null) return;
  const threshold = +raw;
  h.lowBalanceThreshold = (threshold && threshold>0) ? threshold : null;
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

// For simple-value holdings, each contribution (manual or SIP) is its own
// editable/deletable entry in investmentLog — the single lot is just kept in
// sync with it via recomputeSimpleLot, never edited directly.
function editInvestmentLogEntry(holdingId, entryId){
  const h = getNW().holdings.find(x=>x.id===holdingId);
  if(!h) return;
  const entry = (h.investmentLog||[]).find(e=>e.id===entryId);
  if(!entry) return;
  const amtRaw = prompt('Amount:', entry.amount);
  if(amtRaw===null) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date (YYYY-MM-DD):', entry.date);
  if(dateRaw===null) return;
  const noteRaw = prompt('Note (optional):', entry.note||'');
  if(noteRaw===null) return;
  entry.amount = amt;
  entry.date = dateRaw || entry.date;
  entry.note = noteRaw.trim() || null;
  recomputeSimpleLot(h);
  saveData();
  renderNetWorth();
}
function deleteInvestmentLogEntry(holdingId, entryId){
  const h = getNW().holdings.find(x=>x.id===holdingId);
  if(!h) return;
  if(h.investmentLog.length===1 && (!h.sells || h.sells.length===0)){
    if(!confirm('This is the only contribution on this holding — deleting it will remove the whole holding. Continue?')) return;
    getNW().holdings = getNW().holdings.filter(x=>x.id!==holdingId);
    saveData();
    renderNetWorth();
    return;
  }
  if(!confirm('Delete this entry?')) return;
  h.investmentLog = h.investmentLog.filter(e=>e.id!==entryId);
  recomputeSimpleLot(h);
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
  const simple = isSimpleValueClass(h.assetClass);
  const cash = isCashAccountClass(h.assetClass);

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
      ${cash ? `
      <div class="h-figure"><span class="lbl">Current balance</span>${fmtAmount(currentValue)}</div>
      ` : simple ? `
      <div class="h-figure"><span class="lbl">Invested</span>${fmtAmount(invested)}</div>
      <div class="h-figure"><span class="lbl">Value</span>${fmtAmount(currentValue)}</div>
      <div class="h-figure h-gain${unrealized<0?' loss':''}"><span class="lbl">Unrealized</span>${qty>0?(unrealized>=0?'+':'')+fmtAmount(unrealized)+' ('+unrealizedPct.toFixed(1)+'%)':'—'}</div>
      ` : `
      <div class="h-figure"><span class="lbl">Units</span>${qty}</div>
      <div class="h-figure"><span class="lbl">Avg buy</span>${qty>0?fmtAmount(avgPrice):'—'}</div>
      <div class="h-figure"><span class="lbl">Current px</span>${fmtAmount(h.currentPrice)}</div>
      <div class="h-figure"><span class="lbl">Invested</span>${fmtAmount(invested)}</div>
      <div class="h-figure"><span class="lbl">Value</span>${fmtAmount(currentValue)}</div>
      <div class="h-figure h-gain${unrealized<0?' loss':''}"><span class="lbl">Unrealized</span>${qty>0?(unrealized>=0?'+':'')+fmtAmount(unrealized)+' ('+unrealizedPct.toFixed(1)+'%)':'—'}</div>
      `}
    </div>
    ${realizedPL!==0?`<div class="h-realized ${realizedPL<0?'loss':''}" style="color:${realizedPL<0?'var(--brick)':'var(--green-deep)'};">Realized P&amp;L: ${realizedPL>=0?'+':''}${fmtAmount(realizedPL)} across ${sellCount} sale${sellCount===1?'':'s'}</div>`:''}
    <div class="h-actions">
      <button class="buy" data-action="buy">+ ${cash?'Deposit':simple?'Add':'Buy'}</button>
      <button class="sell" data-action="sell" ${(cash?false:simple?currentValue<=0:qty<=0)?'disabled':''}>− ${cash?'Withdraw':simple?'Withdraw':'Sell'}</button>
      <button data-action="edit">✎ Edit name/type</button>
      ${cash?'':'<button data-action="mark">Update value</button>'}
      <button data-action="ticker">🔗 ${h.ticker?'Edit':'Set'} ticker</button>
      ${h.ticker?'<button data-action="refresh">🔄 Refresh</button>':''}
      <button data-action="note">📝 ${h.note?'Edit':'Add'} note</button>
      ${cash?`<button data-action="lowbal">⚠ ${h.lowBalanceThreshold?'Edit':'Set'} low-balance alert${h.lowBalanceThreshold?' ('+fmtAmount(h.lowBalanceThreshold)+')':''}</button>`:''}
      <button data-action="log">☰ Edit buys/sells</button>
      <button data-action="del">× Delete</button>
    </div>
    <div class="h-log" id="log-${h.id}" style="display:none;"></div>
  `;
  card.querySelector('[data-action=buy]').addEventListener('click', ()=>buyHolding(h.id));
  const sellBtn = card.querySelector('[data-action=sell]');
  if(cash ? true : simple ? currentValue>0 : qty>0) sellBtn.addEventListener('click', ()=>sellHolding(h.id));
  card.querySelector('[data-action=edit]').addEventListener('click', ()=>editHoldingInfo(h.id));
  const markBtn = card.querySelector('[data-action=mark]');
  if(markBtn) markBtn.addEventListener('click', ()=>updateHoldingValue(h.id));
  card.querySelector('[data-action=ticker]').addEventListener('click', ()=>setHoldingTicker(h.id));
  const refreshBtn = card.querySelector('[data-action=refresh]');
  if(refreshBtn) refreshBtn.addEventListener('click', ()=>refreshHoldingPrice(h.id));
  card.querySelector('[data-action=note]').addEventListener('click', ()=>setHoldingNote(h.id));
  const lowBalBtn = card.querySelector('[data-action=lowbal]');
  if(lowBalBtn) lowBalBtn.addEventListener('click', ()=>setLowBalanceAlert(h.id));
  card.querySelector('[data-action=log]').addEventListener('click', ()=>toggleHoldingLog(h.id));
  card.querySelector('[data-action=del]').addEventListener('click', ()=>deleteHolding(h.id));

  // Build the buy/sell log with per-entry edit/delete controls (done as real
  // DOM nodes, not string-joined text, so each entry can carry its own buttons).
  const logEl = card.querySelector('.h-log');
  if(simple){
    (h.investmentLog||[]).slice().sort((a,b)=>b.date.localeCompare(a.date)).forEach(e=>{
      const row = document.createElement('div');
      row.className = 'log-row';
      row.innerHTML = `<span>Invested ${fmtAmount(e.amount)} on ${e.date}${e.note?' — '+escapeHtml(e.note):''}</span>`;
      const editBtn = document.createElement('button');
      editBtn.textContent = '✎';
      editBtn.title = 'Edit this entry';
      editBtn.addEventListener('click', ()=>editInvestmentLogEntry(h.id, e.id));
      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.title = 'Delete this entry';
      delBtn.addEventListener('click', ()=>deleteInvestmentLogEntry(h.id, e.id));
      row.appendChild(editBtn);
      row.appendChild(delBtn);
      logEl.appendChild(row);
    });
  } else {
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
      const lotText = `Bought ${l.quantity} unit${l.quantity===1?'':'s'} at ${fmtAmount(l.price)} on ${l.date}${l.note?' — '+escapeHtml(l.note):''}`;
      row.innerHTML = `<span>${lotText}${isDup?' <span class="dup-badge" title="Another buy on this holding has the same date, quantity, and price">⚠ possible duplicate</span>':''}</span>`;
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
  }
  (h.sells||[]).forEach(s=>{
    const row = document.createElement('div');
    row.className = 'log-row';
    const sellText = simple
      ? `Withdrew ${fmtAmount(s.amount)} on ${s.date} — held ${s.daysHeld} day${s.daysHeld===1?'':'s'} — ${s.realizedPL>=0?'profit':'loss'} of ${fmtAmount(Math.abs(s.realizedPL))}`
      : `Sold ${s.quantity} unit${s.quantity===1?'':'s'} at ${fmtAmount(s.price)} on ${s.date} — held ${s.daysHeld} day${s.daysHeld===1?'':'s'} — ${s.realizedPL>=0?'profit':'loss'} of ${fmtAmount(Math.abs(s.realizedPL))}`;
    row.innerHTML = `<span>${sellText}</span>`;
    const delBtn = document.createElement('button');
    delBtn.textContent = '×';
    delBtn.title = 'Delete this entry';
    delBtn.addEventListener('click', ()=>deleteSell(h.id, s.id));
    row.appendChild(delBtn);
    logEl.appendChild(row);
  });
  const logEntryCount = simple ? (h.investmentLog||[]).length : h.lots.length;
  if(logEntryCount===0 && (!h.sells || h.sells.length===0)){
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

// Captures/refreshes this month's net worth snapshot every time the tracker
// loads. Past months are never touched again once the calendar moves on, so
// history quietly accumulates from here forward — there's no way to know
// what things were worth on past dates that were never recorded.
function updateWealthSnapshot(){
  const nw = getNW();
  const investmentValue = nw.holdings.reduce((s,h)=>s+holdingCurrentValue(h),0);
  const liabilities = nw.liabilities.homeLoan + nw.liabilities.carLoan + nw.liabilities.ccDebt + nw.liabilities.personalLoan + nw.liabilities.otherLiability;
  const netWorth = investmentValue - liabilities;
  const investedValue = nw.holdings.reduce((s,h)=>s+holdingInvested(h),0);
  const thisMonth = todayLocalISO().slice(0,7);

  if(!nw.wealthSnapshots) nw.wealthSnapshots = [];
  const existing = nw.wealthSnapshots.find(s=>s.month===thisMonth);
  let changed = false;
  if(existing){
    if(existing.netWorth!==netWorth || existing.investedValue!==investedValue || existing.currentValue!==investmentValue){
      existing.netWorth = netWorth;
      existing.investedValue = investedValue;
      existing.currentValue = investmentValue;
      changed = true;
    }
  } else {
    nw.wealthSnapshots.push({ month: thisMonth, netWorth, investedValue, currentValue: investmentValue });
    changed = true;
  }
  // Persist locally right away so this survives a reload even if you close
  // the tab without doing anything else — but skip a full saveData() (and
  // the Drive push it triggers) on every single render; the next real
  // change you make will carry this along to Drive naturally.
  if(changed) persistLocal();
}

function renderWealthTrendChart(){
  const snapshots = (getNW().wealthSnapshots||[]).slice().sort((a,b)=>a.month.localeCompare(b.month));
  if(snapshots.length===0) return;

  const labels = snapshots.map(s=>{
    const [y,m] = s.month.split('-');
    return new Date(y, m-1, 1).toLocaleString('en-IN', {month:'short', year:'numeric'});
  });
  const totals = snapshots.map(s=>s.netWorth);
  const pctChange = snapshots.map((s,i)=>{
    if(i===0) return null;
    const prev = snapshots[i-1].netWorth;
    return prev!==0 ? ((s.netWorth-prev)/Math.abs(prev))*100 : null;
  });

  const ctx = document.getElementById('wealthTrendChart').getContext('2d');
  if(charts['wealthTrendChart']) charts['wealthTrendChart'].destroy();
  charts['wealthTrendChart'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Net worth', data: totals, yAxisID: 'y',
          borderColor: '#4a7fd6', backgroundColor: '#4a7fd6',
          pointStyle: 'rect', pointRadius: 5, borderWidth: 2, tension: 0.15
        },
        {
          label: 'Change (%)', data: pctChange, yAxisID: 'y1',
          borderColor: 'var(--green-deep, #1F6F50)', backgroundColor: '#4d6b3f',
          pointStyle: 'triangle', pointRadius: 6, borderWidth: 2, tension: 0.15
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position:'top', labels:{ usePointStyle:true, font:{family:'ui-monospace, Menlo, Consolas, monospace', size:11} } },
        tooltip: { callbacks: { label: (c)=> c.dataset.label + ': ' + (c.dataset.yAxisID==='y1' ? (c.parsed.y===null?'—':c.parsed.y.toFixed(2)+'%') : fmtAmount(c.parsed.y)) } }
      },
      scales: {
        x: { grid:{display:false}, ticks:{font:{family:'ui-monospace, Menlo, Consolas, monospace', size:10}} },
        y: {
          position: 'left', grid:{color:'rgba(27,42,34,0.08)'},
          ticks: { font:{family:'ui-monospace, Menlo, Consolas, monospace', size:10}, callback:(v)=>fmtAmount(v) },
          title: { display:true, text:'Net worth', font:{size:11} }
        },
        y1: {
          position: 'right', grid:{display:false},
          ticks: { font:{family:'ui-monospace, Menlo, Consolas, monospace', size:10}, callback:(v)=>v.toFixed(1)+'%' },
          title: { display:true, text:'Change (%)', font:{size:11} }
        }
      }
    }
  });
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
  const flatLiabilities = nw.liabilities.homeLoan + nw.liabilities.carLoan + nw.liabilities.ccDebt + nw.liabilities.personalLoan + nw.liabilities.otherLiability;
  const loanLiabilities = (nw.loansTaken||[]).filter(l=>l.status==='active').reduce((s,l)=>s+loanOutstanding(l),0);
  const ccLiabilities = (nw.creditCards||[]).filter(c=>c.status==='active').reduce((s,c)=>s+c.currentDue,0);
  const liabilities = flatLiabilities + loanLiabilities + ccLiabilities;
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
  updateWealthSnapshot();
  renderWealthTrendChart();
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

// ---------- Remittances (USA -> India, spans both currencies at once) ----------
function remitRate(r){ return r.usdAmount>0 ? r.inrAmount/r.usdAmount : 0; }

function populateRemitFilters(){
  const recipients = [...new Set(remittances.map(r=>r.recipient))].sort();
  const recSel = document.getElementById('remitRecipientFilter');
  const prevRec = recSel.value;
  recSel.innerHTML = '<option value="">All accounts/recipients</option>' + recipients.map(r=>`<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
  if(prevRec) recSel.value = prevRec;

  const years = [...new Set(remittances.map(r=>r.date.slice(0,4)))].sort().reverse();
  const yearSel = document.getElementById('remitYearFilter');
  const prevYear = yearSel.value;
  yearSel.innerHTML = '<option value="__all__">All years</option>' + years.map(y=>`<option value="${y}">${y}</option>`).join('');
  if(prevYear && [...yearSel.options].some(o=>o.value===prevYear)) yearSel.value = prevYear;

  const datalist = document.getElementById('remitRecipientOptions');
  datalist.innerHTML = recipients.map(r=>`<option value="${escapeHtml(r)}">`).join('');
}
document.getElementById('remitRecipientFilter').addEventListener('change', renderRemitViews);
document.getElementById('remitYearFilter').addEventListener('change', renderRemitViews);

function getFilteredRemittances(){
  const recipient = document.getElementById('remitRecipientFilter').value;
  const year = document.getElementById('remitYearFilter').value;
  return remittances.filter(r=>{
    if(recipient && r.recipient!==recipient) return false;
    if(year!=='__all__' && r.date.slice(0,4)!==year) return false;
    return true;
  });
}

// Applies (direction=+1) or reverses (direction=-1) a remittance's effect on
// its linked accounts — debits the USD source, credits the INR destination.
function applyRemitToAccounts(r, direction){
  if(!r) return;
  if(r.sourceAccountId) adjustCashAccountInCurrency('USD', r.sourceAccountId, -r.usdAmount * direction);
  if(r.destAccountId) adjustCashAccountInCurrency('INR', r.destAccountId, r.inrAmount * direction);
}

document.getElementById('addRemit').addEventListener('click', ()=>{
  const date = document.getElementById('remitDate').value || todayLocalISO();
  const recipient = document.getElementById('remitRecipient').value.trim();
  const usdAmount = +document.getElementById('remitUsd').value;
  const inrAmount = +document.getElementById('remitInr').value;
  const sourceAccountId = document.getElementById('remitSourceAccount').value || null;
  const destAccountId = document.getElementById('remitDestAccount').value || null;
  const note = document.getElementById('remitNote').value.trim();

  if(!recipient){ alert('Enter which account/recipient this went to.'); return; }
  if(!usdAmount || usdAmount<=0){ alert('Enter the USD amount sent.'); return; }
  if(!inrAmount || inrAmount<=0){ alert('Enter the INR amount received.'); return; }

  const r = { id: nwUid(), date, recipient, usdAmount, inrAmount, sourceAccountId, destAccountId, note: note||null };
  remittances.push(r);
  applyRemitToAccounts(r, 1);
  saveData();
  document.getElementById('remitRecipient').value = '';
  document.getElementById('remitUsd').value = '';
  document.getElementById('remitInr').value = '';
  document.getElementById('remitNote').value = '';
  document.getElementById('remitDate').value = todayLocalISO();
  renderRemit();
});

function editRemit(id){
  const r = remittances.find(x=>x.id===id);
  if(!r) return;
  const recipientRaw = prompt('Account/Recipient:', r.recipient);
  if(recipientRaw===null) return;
  if(!recipientRaw.trim()){ alert('Can\'t be empty.'); return; }
  const usdRaw = prompt('USD sent:', r.usdAmount);
  if(usdRaw===null) return;
  const usd = +usdRaw;
  if(!usd || usd<=0){ alert('Enter a valid USD amount.'); return; }
  const inrRaw = prompt('INR received:', r.inrAmount);
  if(inrRaw===null) return;
  const inr = +inrRaw;
  if(!inr || inr<=0){ alert('Enter a valid INR amount.'); return; }
  const dateRaw = prompt('Date (YYYY-MM-DD):', r.date);
  if(dateRaw===null) return;
  const noteRaw = prompt('Note (optional):', r.note||'');
  if(noteRaw===null) return;

  applyRemitToAccounts(r, -1); // undo whatever the old amounts did to the linked accounts
  r.recipient = recipientRaw.trim();
  r.usdAmount = usd;
  r.inrAmount = inr;
  r.date = dateRaw || r.date;
  r.note = noteRaw.trim() || null;
  applyRemitToAccounts(r, 1); // apply the new amounts (same linked accounts, since those aren't editable here)
  saveData();
  renderRemit();
}
function deleteRemit(id){
  if(!confirm('Delete this transfer? This can\'t be undone.')) return;
  const r = remittances.find(x=>x.id===id);
  if(r) applyRemitToAccounts(r, -1); // undo its effect on any linked accounts
  markDeleted(id);
  remittances = remittances.filter(x=>x.id!==id);
  saveData();
  renderRemit();
}

let remitListExpanded = false;
document.getElementById('remitListToggle').addEventListener('click', ()=>{
  remitListExpanded = !remitListExpanded;
  renderRemitList();
});

function renderRemitList(){
  const wrap = document.getElementById('remitList');
  const arrow = document.getElementById('remitListArrow');
  const meta = document.getElementById('remitListMeta');
  const filtered = getFilteredRemittances().slice().sort((a,b)=>b.date.localeCompare(a.date));

  arrow.textContent = remitListExpanded ? '▾' : '▸';
  meta.textContent = `${filtered.length} transfer${filtered.length===1?'':'s'}`;
  wrap.style.display = remitListExpanded ? '' : 'none';
  if(!remitListExpanded) return;

  if(filtered.length===0){
    wrap.innerHTML = '<div class="empty-state">No transfers logged yet for this selection.</div>';
    return;
  }
  wrap.innerHTML = '';
  const usdAccountsById = new Map(getSavingsAccountsForCurrency('USD').map(a=>[a.id, a.name]));
  const inrAccountsById = new Map(getSavingsAccountsForCurrency('INR').map(a=>[a.id, a.name]));
  filtered.forEach(r=>{
    const row = document.createElement('div');
    row.className = 'log-row';
    const srcName = r.sourceAccountId ? usdAccountsById.get(r.sourceAccountId) : null;
    const destName = r.destAccountId ? inrAccountsById.get(r.destAccountId) : null;
    const accountNote = (srcName||destName) ? ` (${srcName?'🏦 '+escapeHtml(srcName):'—'} → ${destName?'🏦 '+escapeHtml(destName):'—'})` : '';
    row.innerHTML = `<span><b>${escapeHtml(r.recipient)}</b> — $${r.usdAmount.toLocaleString('en-US')} → ₹${r.inrAmount.toLocaleString('en-IN')} (rate ${remitRate(r).toFixed(2)}) on ${r.date}${accountNote}${r.note?' — '+escapeHtml(r.note):''}</span>`;
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎'; editBtn.title = 'Edit this entry';
    editBtn.addEventListener('click', ()=>editRemit(r.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = '×'; delBtn.title = 'Delete this entry';
    delBtn.addEventListener('click', ()=>deleteRemit(r.id));
    row.appendChild(editBtn); row.appendChild(delBtn);
    wrap.appendChild(row);
  });
}

function renderRemitRecipientTable(){
  const wrap = document.getElementById('remitRecipientTable');
  const filtered = getFilteredRemittances();
  if(filtered.length===0){ wrap.innerHTML = ''; return; }
  const byRecipient = {};
  filtered.forEach(r=>{
    if(!byRecipient[r.recipient]) byRecipient[r.recipient] = { usd:0, inr:0, count:0 };
    byRecipient[r.recipient].usd += r.usdAmount;
    byRecipient[r.recipient].inr += r.inrAmount;
    byRecipient[r.recipient].count++;
  });
  const recipients = Object.keys(byRecipient).sort((a,b)=>byRecipient[b].inr-byRecipient[a].inr);
  let html = `<table class="cat-table"><thead><tr><th>Account/Recipient</th><th style="text-align:right;">USD sent</th><th style="text-align:right;">INR received</th><th style="text-align:right;">Avg rate</th><th style="text-align:right;">Transfers</th></tr></thead><tbody>`;
  recipients.forEach(name=>{
    const d = byRecipient[name];
    html += `<tr><td>${escapeHtml(name)}</td><td class="num">$${d.usd.toLocaleString('en-US')}</td><td class="num">₹${d.inr.toLocaleString('en-IN')}</td><td class="num">${(d.inr/d.usd).toFixed(2)}</td><td class="num">${d.count}</td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderRemitYearTable(){
  const wrap = document.getElementById('remitYearTable');
  const filtered = getFilteredRemittances();
  if(filtered.length===0){ wrap.innerHTML = ''; return; }
  const byYear = {};
  filtered.forEach(r=>{
    const y = r.date.slice(0,4);
    if(!byYear[y]) byYear[y] = { usd:0, inr:0, count:0 };
    byYear[y].usd += r.usdAmount;
    byYear[y].inr += r.inrAmount;
    byYear[y].count++;
  });
  const years = Object.keys(byYear).sort().reverse();
  let html = `<table class="cat-table"><thead><tr><th>Year</th><th style="text-align:right;">USD sent</th><th style="text-align:right;">INR received</th><th style="text-align:right;">Avg rate</th><th style="text-align:right;">Transfers</th></tr></thead><tbody>`;
  years.forEach(y=>{
    const d = byYear[y];
    html += `<tr><td>${y}</td><td class="num">$${d.usd.toLocaleString('en-US')}</td><td class="num">₹${d.inr.toLocaleString('en-IN')}</td><td class="num">${(d.inr/d.usd).toFixed(2)}</td><td class="num">${d.count}</td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderRemitAccountYearTable(){
  const wrap = document.getElementById('remitAccountYearTable');
  const filtered = getFilteredRemittances();
  if(filtered.length===0){ wrap.innerHTML = ''; return; }
  const recipients = [...new Set(filtered.map(r=>r.recipient))].sort();
  const years = [...new Set(filtered.map(r=>r.date.slice(0,4)))].sort().reverse();

  let html = `<table class="cat-table"><thead><tr><th>Year</th>${recipients.map(r=>`<th style="text-align:right;">${escapeHtml(r)}</th>`).join('')}<th style="text-align:right;">Total</th></tr></thead><tbody>`;
  years.forEach(y=>{
    const yearTx = filtered.filter(r=>r.date.slice(0,4)===y);
    let yearUsdTotal = 0, yearInrTotal = 0;
    const cells = recipients.map(name=>{
      const matches = yearTx.filter(r=>r.recipient===name);
      if(matches.length===0) return '<td class="num">—</td>';
      const usd = matches.reduce((s,r)=>s+r.usdAmount,0);
      const inr = matches.reduce((s,r)=>s+r.inrAmount,0);
      yearUsdTotal += usd; yearInrTotal += inr;
      return `<td class="num">$${usd.toLocaleString('en-US')}<br>₹${inr.toLocaleString('en-IN')}</td>`;
    }).join('');
    html += `<tr><td>${y}</td>${cells}<td class="num" style="font-weight:600;">$${yearUsdTotal.toLocaleString('en-US')}<br>₹${yearInrTotal.toLocaleString('en-IN')}</td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderRemitSummary(){
  const filtered = getFilteredRemittances();
  const totalUsd = filtered.reduce((s,r)=>s+r.usdAmount,0);
  const totalInr = filtered.reduce((s,r)=>s+r.inrAmount,0);
  document.getElementById('remitTotalUsd').textContent = '$'+totalUsd.toLocaleString('en-US');
  document.getElementById('remitTotalInr').textContent = '₹'+totalInr.toLocaleString('en-IN');
  document.getElementById('remitAvgRate').textContent = totalUsd>0 ? (totalInr/totalUsd).toFixed(2) : '—';
  document.getElementById('remitCount').textContent = filtered.length;
}

function renderRemitViews(){
  renderRemitList();
  renderRemitRecipientTable();
  renderRemitYearTable();
  renderRemitAccountYearTable();
  renderRemitSummary();
}
function renderRemit(){
  populateRemitFilters();
  populateAccountSelect('remitSourceAccount', '— none / untracked —', 'USD');
  populateAccountSelect('remitDestAccount', '— none / untracked —', 'INR');
  renderRemitViews();
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
      const installment = { id: nwUid(), date: installmentDate, amount: sip.amount, postedToHolding: false };
      sip.installments.push(installment);
      // If this SIP is linked to a real holding, also log the same amount as
      // a buy there — that's what makes an automatic note show up at the
      // bottom of the holding's own buy/sell log, right where you'd look for it.
      if(sip.linkedHoldingId){
        const holding = getNW().holdings.find(h=>h.id===sip.linkedHoldingId);
        if(holding){
          if(isSimpleValueClass(holding.assetClass)){
            // MF/Liquid Fund/Gold/etc. must always stay as exactly one lot for
            // the value math — but investmentLog keeps a full, separate
            // history of every contribution (so each SIP installment shows
            // up as its own dated entry, not one note getting overwritten).
            // Current value is intentionally left alone; you update that yourself.
            holding.investmentLog = holding.investmentLog || [];
            holding.investmentLog.push({ id: nwUid(), date: installmentDate, amount: sip.amount, note: `SIP amount added to this fund on ${installmentDate}` });
            recomputeSimpleLot(holding);
          } else {
            // Share-based holdings (Equity/US Stocks/Crypto) keep real per-buy lots.
            holding.lots.push({ id: nwUid(), date: installmentDate, quantity: 1, price: sip.amount, note: `SIP: ${sip.name}` });
          }
          installment.postedToHolding = true;
        }
      }
      // If a debit account is set, subtract the installment from its balance —
      // same as money actually leaving your bank account for a real SIP.
      if(sip.debitAccountId) debitSavingsAccount(sip.debitAccountId, sip.amount);
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
  const debitAccountId = document.getElementById('sipDebitAccount').value || null;
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
    debitAccountId,
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

  // Let them (re)link to a real holding — this is what actually makes future
  // installments post as buys into that holding's invested amount. Typing a
  // holding's number here fixes SIPs created before this linking existed, or
  // ones where "— none —" was picked originally.
  const holdings = getNW().holdings;
  const currentIndex = sip.linkedHoldingId ? holdings.findIndex(h=>h.id===sip.linkedHoldingId) : -1;
  const list = holdings.map((h,i)=>`${i+1}. ${h.name} (${ASSET_CLASS_LABELS[h.assetClass]||h.assetClass})`).join('\n');
  const linkRaw = holdings.length===0
    ? null
    : prompt(`Link to a holding, so future installments auto-invest into it.\nEnter a number, or 0 for none:\n\n0. — none —\n${list}`, currentIndex>=0 ? String(currentIndex+2) : '0');

  sip.name = newName.trim();
  sip.amount = amt;
  if(linkRaw!==null){
    const linkNum = parseInt(linkRaw, 10);
    const newLinkedHoldingId = (!isNaN(linkNum) && linkNum>=1 && linkNum<=holdings.length) ? holdings[linkNum-1].id : null;
    const linkChanged = newLinkedHoldingId !== (sip.linkedHoldingId||null);
    sip.linkedHoldingId = newLinkedHoldingId;
    sip.linkedHolding = null; // clear the old legacy text label now that it's properly linked (or explicitly unlinked)
    saveData();
    if(linkChanged && newLinkedHoldingId){
      backfillSipInstallments(sip.id); // offers to post any already-fired installments that predate this link
      return; // backfillSipInstallments re-renders itself
    }
  }
  saveData();
  renderSips();
}

// Posts any of this SIP's installments that fired before it was linked (or
// before a re-link) into the holding's invested amount — without this,
// installments that happened before you set/changed the link would just sit
// in the SIP's own history and never reach the fund.
function backfillSipInstallments(sipId){
  const sip = getSips().find(x=>x.id===sipId);
  if(!sip || !sip.linkedHoldingId) return;
  const holding = getNW().holdings.find(h=>h.id===sip.linkedHoldingId);
  if(!holding) return;
  const unposted = sip.installments.filter(i=>!i.postedToHolding);
  if(unposted.length===0){ renderSips(); return; }
  const total = unposted.reduce((s,i)=>s+i.amount,0);
  if(!confirm(`"${sip.name}" has ${unposted.length} installment(s) totaling ${fmtAmount(total)} that fired before this link and never reached "${holding.name}". Add them to its invested amount now?`)){
    renderSips();
    return;
  }
  unposted.forEach(inst=>{
    if(isSimpleValueClass(holding.assetClass)){
      holding.investmentLog = holding.investmentLog || [];
      holding.investmentLog.push({ id: nwUid(), date: inst.date, amount: inst.amount, note: `SIP amount added to this fund on ${inst.date} (backfilled)` });
    } else {
      holding.lots.push({ id: nwUid(), date: inst.date, quantity: 1, price: inst.amount, note: `SIP: ${sip.name} (backfilled)` });
    }
    inst.postedToHolding = true;
  });
  if(isSimpleValueClass(holding.assetClass)) recomputeSimpleLot(holding);
  saveData();
  renderAll();
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
  const unpostedCount = sip.linkedHoldingId ? sip.installments.filter(i=>!i.postedToHolding).length : 0;

  const card = document.createElement('div');
  card.className = 'holding-card';
  card.innerHTML = `
    <div class="hc-top">
      <span class="status-badge ${isStopped?'stopped':'repaid'}">${isStopped?'Stopped':'Active'}</span>
      <span class="h-name">${escapeHtml(sip.name)}</span>
      <span class="h-meta">${linkedName?'→ '+escapeHtml(linkedName):''}</span>
    </div>
    ${unpostedCount>0?`<div class="h-note" style="color:var(--brick);">⚠ ${unpostedCount} installment(s) haven't reached "${escapeHtml(linkedName||'the linked fund')}" yet — see Backfill below.</div>`:''}
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
      ${unpostedCount>0?'<button class="buy" data-action="backfill">⏪ Backfill '+unpostedCount+' installment(s)</button>':''}
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
  const backfillBtn = card.querySelector('[data-action=backfill]');
  if(backfillBtn) backfillBtn.addEventListener('click', ()=>backfillSipInstallments(sip.id));
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
  populateAccountSelect('sipDebitAccount');
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
  const debitAccountId = document.getElementById('insDebitAccount').value || null;

  if(!name){ alert('Give this policy a name.'); return; }
  if(!premium || premium<=0){ alert('Enter a premium amount greater than zero.'); return; }

  const firstTx = { id: uid(), date: boughtDate, type:'expense', category:'Insurance', description:`Insurance premium: ${name}`, accountId: debitAccountId, amount: premium, currency: currentCurrency };
  transactions.push(firstTx);
  applyTxToAccount(firstTx, 1);

  getInsurance().push({
    id: nwUid(),
    name,
    provider: provider || null,
    boughtDate,
    premiumAmount: premium,
    frequencyMonths: freq,
    debitAccountId,
    nextDueDate: addMonthsClamped(boughtDate, freq),
    status: 'active',
    payments: [{ id: firstTx.id, date: boughtDate, amount: premium }], // first premium, paid at purchase
    pendingOccurrences: []
  });
  saveData();
  document.getElementById('insName').value = '';
  document.getElementById('insProvider').value = '';
  document.getElementById('insPremium').value = '';
  document.getElementById('insBoughtDate').value = todayLocalISO();
  renderInsurance();
});

// Generates a pending occurrence (awaiting your checkbox confirmation) for
// each premium that's come due, instead of doing anything automatically.
// Nothing is added to your expenses or debited from any account until you
// tick the checkbox in the notification banner.
function syncInsurancePending(){
  const today = todayLocalISO();
  let changed = false;
  getInsurance().forEach(ins=>{
    if(!ins.pendingOccurrences) ins.pendingOccurrences = [];
    if(ins.status==='lapsed') return;
    let guard = 0;
    while(ins.nextDueDate<=today && guard<600){
      ins.pendingOccurrences.push({ id: nwUid(), date: ins.nextDueDate, amount: ins.premiumAmount });
      ins.nextDueDate = addMonthsClamped(ins.nextDueDate, ins.frequencyMonths);
      changed = true;
      guard++;
    }
  });
  if(changed) saveData();
}

// Called when you tick the checkbox for a pending insurance premium.
function confirmInsurancePending(insId, occId){
  const ins = getInsurance().find(x=>x.id===insId);
  if(!ins) return;
  const occ = (ins.pendingOccurrences||[]).find(o=>o.id===occId);
  if(!occ) return;
  const tx = { id: uid(), date: occ.date, type:'expense', category:'Insurance', description:`Insurance premium: ${ins.name}`, accountId: ins.debitAccountId||null, amount: occ.amount, currency: currentCurrency };
  transactions.push(tx);
  applyTxToAccount(tx, 1);
  ins.payments.push({ id: tx.id, date: occ.date, amount: occ.amount });
  ins.pendingOccurrences = ins.pendingOccurrences.filter(o=>o.id!==occId);
  saveData();
  renderAll();
}

function payPremium(id){
  const ins = getInsurance().find(x=>x.id===id);
  if(!ins) return;
  const amtRaw = prompt(`Premium payment for "${ins.name}":`, ins.premiumAmount);
  if(!amtRaw) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date paid (YYYY-MM-DD):', todayLocalISO());
  const date = dateRaw || todayLocalISO();
  const tx = { id: uid(), date, type:'expense', category:'Insurance', description:`Insurance premium: ${ins.name}`, accountId: ins.debitAccountId||null, amount: amt, currency: currentCurrency };
  transactions.push(tx);
  applyTxToAccount(tx, 1);
  ins.payments.push({ id: tx.id, date, amount: amt });
  ins.nextDueDate = addMonthsClamped(ins.nextDueDate, ins.frequencyMonths);
  saveData();
  renderAll();
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
  const pending = ins.pendingOccurrences||[];

  const card = document.createElement('div');
  card.className = 'holding-card';
  card.innerHTML = `
    <div class="hc-top">
      <span class="status-badge ${pending.length>0?'due-soon':badge}">${pending.length>0?'Awaiting confirmation':INS_STATUS_TEXT[badge]}</span>
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
    ${pending.length>0?`<div class="pending-box" id="inspending-${ins.id}"></div>`:''}
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

  const pendingBox = card.querySelector('.pending-box');
  if(pendingBox){
    pending.slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach(occ=>{
      const row = document.createElement('label');
      row.className = 'pending-row';
      row.innerHTML = `<input type="checkbox"><span>Confirm ${fmtAmount(occ.amount)} on ${occ.date} — adds to expenses${ins.debitAccountId?' and debits the linked account':''}</span>`;
      row.querySelector('input').addEventListener('change', (e)=>{
        if(e.target.checked) confirmInsurancePending(ins.id, occ.id);
      });
      pendingBox.appendChild(row);
    });
  }

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
  syncInsurancePending();
  populateAccountSelect('insDebitAccount');
  renderInsuranceList();
  renderInsuranceSummary();
}

// ---------- Loans Taken (EMI auto-fires on schedule; outstanding balance counts as a liability) ----------
function getLoans(){ return getNW().loansTaken; }

function loanFrequencyLabel(loan){ return SIP_FREQ_LABEL[`${loan.frequencyUnit}:${loan.frequencyValue}`] || `Every ${loan.frequencyValue} ${loan.frequencyUnit}`; }
function loanMonthlyEquivalent(loan){
  return loan.frequencyUnit==='days' ? loan.emiAmount*(30.44/loan.frequencyValue) : loan.emiAmount/loan.frequencyValue;
}
function loanTotalPaid(loan){ return loan.payments.reduce((s,p)=>s+p.amount,0); }
function loanOutstanding(loan){ return Math.max(0, loan.principalAmount - loanTotalPaid(loan)); }

function syncLoanEmis(){
  const today = todayLocalISO();
  let changed = false;
  getLoans().forEach(loan=>{
    if(loan.status!=='active') return;
    let guard = 0;
    while(loan.nextDueDate<=today && loanOutstanding(loan)>0 && guard<600){
      const emiAmount = Math.min(loan.emiAmount, loanOutstanding(loan));
      loan.payments.push({ id: nwUid(), date: loan.nextDueDate, amount: emiAmount });
      // If a debit account is set, subtract the EMI from its balance — same
      // as money actually leaving your bank account for a real EMI auto-debit.
      if(loan.debitAccountId) debitSavingsAccount(loan.debitAccountId, emiAmount);
      loan.nextDueDate = advanceDate(loan.nextDueDate, loan.frequencyUnit, loan.frequencyValue);
      changed = true;
      guard++;
    }
    if(loanOutstanding(loan)<=0) loan.status = 'closed';
  });
  if(changed) saveData();
}

document.getElementById('addLoan').addEventListener('click', ()=>{
  const name = document.getElementById('loanName').value.trim();
  const lender = document.getElementById('loanLender').value.trim();
  const loanType = document.getElementById('loanType').value;
  const principalAmount = +document.getElementById('loanPrincipal').value;
  const emiAmount = +document.getElementById('loanEmi').value;
  const [frequencyUnit, freqValueRaw] = document.getElementById('loanFrequency').value.split(':');
  const frequencyValue = +freqValueRaw;
  const startDate = document.getElementById('loanStartDate').value || todayLocalISO();
  const tenureRaw = document.getElementById('loanTenure').value;
  const tenureMonths = tenureRaw ? +tenureRaw : null;
  const debitAccountId = document.getElementById('loanDebitAccount').value || null;

  if(!name){ alert('Give this loan a name.'); return; }
  if(!principalAmount || principalAmount<=0){ alert('Enter the principal amount.'); return; }
  if(!emiAmount || emiAmount<=0){ alert('Enter the EMI amount.'); return; }

  getLoans().push({
    id: nwUid(),
    name, lender: lender||null, loanType, principalAmount, emiAmount,
    frequencyUnit, frequencyValue, startDate, tenureMonths, debitAccountId,
    status: 'active', stoppedDate: null,
    nextDueDate: startDate,
    payments: []
  });
  saveData();
  document.getElementById('loanName').value = '';
  document.getElementById('loanLender').value = '';
  document.getElementById('loanPrincipal').value = '';
  document.getElementById('loanEmi').value = '';
  document.getElementById('loanTenure').value = '';
  document.getElementById('loanStartDate').value = todayLocalISO();
  renderLoans();
});

function toggleLoanClosed(id){
  const loan = getLoans().find(x=>x.id===id);
  if(!loan) return;
  loan.status = loan.status==='closed' ? 'active' : 'closed';
  if(loan.status==='active' && loan.nextDueDate<todayLocalISO()) loan.nextDueDate = todayLocalISO();
  saveData();
  renderLoans();
}
function editLoanInfo(id){
  const loan = getLoans().find(x=>x.id===id);
  if(!loan) return;
  const newName = prompt('Name:', loan.name);
  if(newName===null) return;
  if(!newName.trim()){ alert('Name can\'t be empty.'); return; }
  const newLender = prompt('Lender:', loan.lender||'');
  if(newLender===null) return;
  const newEmi = prompt('EMI amount (applies to future payments only):', loan.emiAmount);
  if(newEmi===null) return;
  const emi = +newEmi;
  if(!emi || emi<=0){ alert('Enter a valid EMI amount.'); return; }
  loan.name = newName.trim();
  loan.lender = newLender.trim() || null;
  loan.emiAmount = emi;
  saveData();
  renderLoans();
}
function editLoanPayment(loanId, paymentId){
  const loan = getLoans().find(x=>x.id===loanId);
  if(!loan) return;
  const p = loan.payments.find(x=>x.id===paymentId);
  if(!p) return;
  const amtRaw = prompt('Amount:', p.amount);
  if(amtRaw===null) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date (YYYY-MM-DD):', p.date);
  if(dateRaw===null) return;
  p.amount = amt;
  p.date = dateRaw || p.date;
  saveData();
  renderLoans();
}
function deleteLoanPayment(loanId, paymentId){
  const loan = getLoans().find(x=>x.id===loanId);
  if(!loan) return;
  if(!confirm('Delete this payment entry?')) return;
  loan.payments = loan.payments.filter(x=>x.id!==paymentId);
  if(loanOutstanding(loan)>0) loan.status = 'active';
  saveData();
  renderLoans();
}
function deleteLoan(id){
  const loan = getLoans().find(x=>x.id===id);
  if(!loan) return;
  markDeleted(id);
  if(!confirm(`Delete "${loan.name}" entirely, including its payment history? This can't be undone.`)) return;
  getNW().loansTaken = getLoans().filter(x=>x.id!==id);
  saveData();
  renderLoans();
}

function buildLoanCard(loan){
  const totalPaid = loanTotalPaid(loan);
  const outstanding = loanOutstanding(loan);
  const isClosed = loan.status==='closed';
  const remainingEmis = loan.tenureMonths ? Math.max(0, loan.tenureMonths - loan.payments.length) : null;

  const card = document.createElement('div');
  card.className = 'holding-card';
  card.innerHTML = `
    <div class="hc-top">
      <span class="status-badge ${isClosed?'repaid':'outstanding'}">${isClosed?'Closed':'Active'}</span>
      <span class="h-name">${escapeHtml(loan.name)}</span>
      <span class="h-meta">${loan.lender?escapeHtml(loan.lender)+' · ':''}${escapeHtml(loan.loanType)}</span>
    </div>
    <div class="hc-stats">
      <div class="h-figure"><span class="lbl">Principal</span>${fmtAmount(loan.principalAmount)}</div>
      <div class="h-figure"><span class="lbl">EMI / ${loanFrequencyLabel(loan)}</span>${fmtAmount(loan.emiAmount)}</div>
      <div class="h-figure"><span class="lbl">Total paid</span>${fmtAmount(totalPaid)}</div>
      <div class="h-figure h-gain loss"><span class="lbl">Outstanding</span>${fmtAmount(outstanding)}</div>
      ${remainingEmis!==null?`<div class="h-figure"><span class="lbl">EMIs left</span>${remainingEmis}</div>`:''}
      ${!isClosed?`<div class="h-figure"><span class="lbl">Next due</span>${loan.nextDueDate}</div>`:''}
    </div>
    <div class="h-actions">
      <button data-action="toggle">${isClosed?'▶ Reopen':'✓ Mark closed'}</button>
      <button data-action="edit">✎ Edit</button>
      <button data-action="log">☰ Payments</button>
      <button data-action="del">× Delete</button>
    </div>
    <div class="h-log" id="loanlog-${loan.id}" style="display:none;"></div>
  `;
  card.querySelector('[data-action=toggle]').addEventListener('click', ()=>toggleLoanClosed(loan.id));
  card.querySelector('[data-action=edit]').addEventListener('click', ()=>editLoanInfo(loan.id));
  card.querySelector('[data-action=log]').addEventListener('click', ()=>{
    const el = document.getElementById('loanlog-'+loan.id);
    el.style.display = el.style.display==='none' ? '' : 'none';
  });
  card.querySelector('[data-action=del]').addEventListener('click', ()=>deleteLoan(loan.id));

  const logEl = card.querySelector('.h-log');
  if(loan.payments.length===0){
    logEl.innerHTML = '<span style="color:var(--ink-soft);">No EMI payments logged yet.</span>';
  }
  loan.payments.slice().sort((a,b)=>b.date.localeCompare(a.date)).forEach(p=>{
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `<span>Paid ${fmtAmount(p.amount)} on ${p.date}</span>`;
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎'; editBtn.title = 'Edit this entry';
    editBtn.addEventListener('click', ()=>editLoanPayment(loan.id, p.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = '×'; delBtn.title = 'Delete this entry';
    delBtn.addEventListener('click', ()=>deleteLoanPayment(loan.id, p.id));
    row.appendChild(editBtn); row.appendChild(delBtn);
    logEl.appendChild(row);
  });
  return card;
}

function renderLoansList(){
  const wrap = document.getElementById('loansList');
  const loans = getLoans();
  if(loans.length===0){
    wrap.innerHTML = '<div class="empty-state">No loans logged yet — add one above.</div>';
    return;
  }
  wrap.innerHTML = '';
  loans.slice()
    .sort((a,b)=> (a.status==='active'?0:1) - (b.status==='active'?0:1))
    .forEach(loan=>wrap.appendChild(buildLoanCard(loan)));
}
function renderLoansSummary(){
  const loans = getLoans();
  const active = loans.filter(l=>l.status==='active');
  document.getElementById('loanActiveCount').textContent = active.length;
  document.getElementById('loanMonthlyTotal').textContent = fmtAmount(active.reduce((s,l)=>s+loanMonthlyEquivalent(l),0));
  document.getElementById('loanTotalPaid').textContent = fmtAmount(loans.reduce((s,l)=>s+loanTotalPaid(l),0));
  document.getElementById('loanTotalOutstanding').textContent = fmtAmount(active.reduce((s,l)=>s+loanOutstanding(l),0));
}
function renderLoans(){
  syncLoanEmis();
  populateAccountSelect('loanDebitAccount');
  renderLoansList();
  renderLoansSummary();
  renderNWSummary(); // outstanding loan balance affects net worth's liabilities total
}

// ---------- Credit Card Bills ----------
// Charges tagged to a card in the transaction form increase currentDue
// automatically (see applyTxToPaymentMethod). On the due date, a pending
// confirmation appears — same pattern as Recurring/Insurance — and nothing
// is marked paid until you tick the checkbox.
function ccTotalPaidAllTime(c){ return c.payments.reduce((s,p)=>s+p.amount,0); }

document.getElementById('addCreditCard').addEventListener('click', ()=>{
  const name = document.getElementById('ccName').value.trim();
  const issuer = document.getElementById('ccIssuer').value.trim();
  const nextDueDate = document.getElementById('ccNextDueDate').value || addMonthsClamped(todayLocalISO(), 1);
  if(!name){ alert('Give this card a name.'); return; }

  getCreditCards().push({
    id: nwUid(), name, issuer: issuer||null, currentDue: 0,
    nextDueDate, status:'active', payments:[], pendingOccurrences:[]
  });
  saveData();
  document.getElementById('ccName').value = '';
  document.getElementById('ccIssuer').value = '';
  document.getElementById('ccNextDueDate').value = '';
  renderCreditCards();
});

// Generates a pending occurrence on the due date, snapshotting whatever is
// currently owed at that moment — new charges after that keep accumulating
// separately in currentDue and will show up as the next month's due.
function syncCreditCardDue(){
  const today = todayLocalISO();
  let changed = false;
  getCreditCards().forEach(c=>{
    if(!c.pendingOccurrences) c.pendingOccurrences = [];
    if(c.status!=='active') return;
    let guard = 0;
    while(c.nextDueDate<=today && guard<12){
      if(c.currentDue>0.01){
        c.pendingOccurrences.push({ id: nwUid(), date: c.nextDueDate, amount: c.currentDue });
      }
      c.nextDueDate = addMonthsClamped(c.nextDueDate, 1);
      changed = true;
      guard++;
    }
  });
  if(changed) saveData();
}

// Called when you tick the checkbox for a pending credit card due.
function confirmCreditCardPending(cardId, occId){
  const c = getCreditCards().find(x=>x.id===cardId);
  if(!c) return;
  const occ = (c.pendingOccurrences||[]).find(o=>o.id===occId);
  if(!occ) return;
  c.payments.push({ id: nwUid(), date: occ.date, amount: occ.amount });
  c.currentDue = Math.max(0, c.currentDue - occ.amount);
  c.pendingOccurrences = c.pendingOccurrences.filter(o=>o.id!==occId);
  saveData();
  renderAll();
}

function payCreditCardNow(id){
  const c = getCreditCards().find(x=>x.id===id);
  if(!c) return;
  const amtRaw = prompt(`Payment for "${c.name}" (currently due: ${fmtAmount(c.currentDue)}):`, c.currentDue);
  if(!amtRaw) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date paid (YYYY-MM-DD):', todayLocalISO());
  const date = dateRaw || todayLocalISO();
  c.payments.push({ id: nwUid(), date, amount: amt });
  c.currentDue = Math.max(0, c.currentDue - amt);
  saveData();
  renderAll();
}

// For adding a payment record directly — e.g. restoring one you accidentally
// deleted. Unlike "+ Pay now", this asks first whether it should also reduce
// what's currently due, since a restored record's balance effect may have
// already happened (and reducing it again would double-count).
function logCreditCardPayment(id){
  const c = getCreditCards().find(x=>x.id===id);
  if(!c) return;
  const amtRaw = prompt(`Amount for this payment record on "${c.name}":`);
  if(!amtRaw) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date paid (YYYY-MM-DD):', todayLocalISO());
  const date = dateRaw || todayLocalISO();
  const alsoReduce = confirm('Should this also reduce the current due?\n\nClick OK if this is a genuinely new payment.\nClick Cancel if you\'re just restoring a record for a payment that already reduced the due before (e.g. one you accidentally deleted) — this avoids counting it twice.');
  c.payments.push({ id: nwUid(), date, amount: amt });
  if(alsoReduce) c.currentDue = Math.max(0, c.currentDue - amt);
  saveData();
  renderAll();
}

function editCreditCardPayment(cardId, payId){
  const c = getCreditCards().find(x=>x.id===cardId);
  if(!c) return;
  const p = c.payments.find(x=>x.id===payId);
  if(!p) return;
  const amtRaw = prompt('Amount:', p.amount);
  if(amtRaw===null) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date (YYYY-MM-DD):', p.date);
  if(dateRaw===null) return;
  p.amount = amt;
  p.date = dateRaw || p.date;
  saveData();
  renderCreditCards();
}

function editCreditCardInfo(id){
  const c = getCreditCards().find(x=>x.id===id);
  if(!c) return;
  const newName = prompt('Name:', c.name);
  if(newName===null) return;
  if(!newName.trim()){ alert('Name can\'t be empty.'); return; }
  const newIssuer = prompt('Issuer:', c.issuer||'');
  if(newIssuer===null) return;
  c.name = newName.trim();
  c.issuer = newIssuer.trim() || null;
  saveData();
  renderCreditCards();
}
function setCreditCardDueDate(id){
  const c = getCreditCards().find(x=>x.id===id);
  if(!c) return;
  const raw = prompt('Next due date (YYYY-MM-DD):', c.nextDueDate);
  if(raw===null) return;
  if(raw) c.nextDueDate = raw;
  saveData();
  renderCreditCards();
}
function toggleCreditCardClosed(id){
  const c = getCreditCards().find(x=>x.id===id);
  if(!c) return;
  c.status = c.status==='closed' ? 'active' : 'closed';
  if(c.status==='active' && c.nextDueDate<todayLocalISO()) c.nextDueDate = todayLocalISO();
  saveData();
  renderCreditCards();
}
function deleteCreditCardPayment(cardId, payId){
  const c = getCreditCards().find(x=>x.id===cardId);
  if(!c) return;
  if(!confirm('Delete this payment entry? This does not restore the due amount it cleared. (If you need it back later, use "📝 Log a payment" and say no when it asks whether to reduce the due again.)')) return;
  c.payments = c.payments.filter(x=>x.id!==payId);
  saveData();
  renderCreditCards();
}
function deleteCreditCard(id){
  const c = getCreditCards().find(x=>x.id===id);
  if(!c) return;
  if(!confirm(`Delete "${c.name}" entirely, including its payment history? This can't be undone.`)) return;
  markDeleted(id);
  getNW().creditCards = getCreditCards().filter(x=>x.id!==id);
  saveData();
  renderCreditCards();
}

function buildCreditCardCard(c){
  const totalPaid = ccTotalPaidAllTime(c);
  const isClosed = c.status==='closed';
  const pending = c.pendingOccurrences||[];
  let badge = 'repaid', badgeText = 'Active';
  if(isClosed){ badge='stopped'; badgeText='Closed'; }
  else if(pending.length>0){ badge='due-soon'; badgeText='Awaiting confirmation'; }
  else if(c.currentDue>0.01){ badge='outstanding'; badgeText='Due building up'; }

  const card = document.createElement('div');
  card.className = 'holding-card';
  card.innerHTML = `
    <div class="hc-top">
      <span class="status-badge ${badge}">${badgeText}</span>
      <span class="h-name">${escapeHtml(c.name)}</span>
      <span class="h-meta">${c.issuer?escapeHtml(c.issuer):''}</span>
    </div>
    <div class="hc-stats">
      <div class="h-figure h-gain loss"><span class="lbl">Current due</span>${fmtAmount(c.currentDue)}</div>
      <div class="h-figure"><span class="lbl">Total paid</span>${fmtAmount(totalPaid)}</div>
      ${!isClosed?`<div class="h-figure"><span class="lbl">Next due date</span>${c.nextDueDate}</div>`:''}
    </div>
    ${pending.length>0?`<div class="pending-box" id="ccpending-${c.id}"></div>`:''}
    <div class="h-actions">
      <button class="buy" data-action="pay" ${c.currentDue<=0?'disabled':''}>+ Pay now</button>
      <button data-action="logpay">📝 Log a payment</button>
      <button data-action="duedate">📅 Set next due</button>
      <button data-action="edit">✎ Edit</button>
      <button data-action="toggle">${isClosed?'▶ Reopen':'✓ Mark closed'}</button>
      <button data-action="log">☰ Payments</button>
      <button data-action="del">× Delete</button>
    </div>
    <div class="h-log" id="cclog-${c.id}" style="display:none;"></div>
  `;
  const payBtn = card.querySelector('[data-action=pay]');
  if(c.currentDue>0) payBtn.addEventListener('click', ()=>payCreditCardNow(c.id));
  card.querySelector('[data-action=logpay]').addEventListener('click', ()=>logCreditCardPayment(c.id));
  card.querySelector('[data-action=duedate]').addEventListener('click', ()=>setCreditCardDueDate(c.id));
  card.querySelector('[data-action=edit]').addEventListener('click', ()=>editCreditCardInfo(c.id));
  card.querySelector('[data-action=toggle]').addEventListener('click', ()=>toggleCreditCardClosed(c.id));
  card.querySelector('[data-action=log]').addEventListener('click', ()=>{
    const el = document.getElementById('cclog-'+c.id);
    el.style.display = el.style.display==='none' ? '' : 'none';
  });
  card.querySelector('[data-action=del]').addEventListener('click', ()=>deleteCreditCard(c.id));

  const logEl = card.querySelector('.h-log');
  if(c.payments.length===0){
    logEl.innerHTML = '<span style="color:var(--ink-soft);">No payments logged yet.</span>';
  }
  c.payments.slice().sort((a,b)=>b.date.localeCompare(a.date)).forEach(p=>{
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `<span>Paid ${fmtAmount(p.amount)} on ${p.date}</span>`;
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎'; editBtn.title = 'Edit this entry';
    editBtn.addEventListener('click', ()=>editCreditCardPayment(c.id, p.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = '×'; delBtn.title = 'Delete this entry';
    delBtn.addEventListener('click', ()=>deleteCreditCardPayment(c.id, p.id));
    row.appendChild(editBtn);
    row.appendChild(delBtn);
    logEl.appendChild(row);
  });

  const pendingBox = card.querySelector('.pending-box');
  if(pendingBox){
    pending.slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach(occ=>{
      const row = document.createElement('label');
      row.className = 'pending-row';
      row.innerHTML = `<input type="checkbox"><span>Confirm payment of ${fmtAmount(occ.amount)} for the bill due ${occ.date} — clears this from what's owed</span>`;
      row.querySelector('input').addEventListener('change', (e)=>{
        if(e.target.checked) confirmCreditCardPending(c.id, occ.id);
      });
      pendingBox.appendChild(row);
    });
  }

  return card;
}

function renderCreditCardsList(){
  const wrap = document.getElementById('ccList');
  const cards = getCreditCards();
  if(cards.length===0){
    wrap.innerHTML = '<div class="empty-state">No credit cards logged yet — add one above.</div>';
    return;
  }
  wrap.innerHTML = '';
  cards.slice()
    .sort((a,b)=> (a.status==='active'?0:1) - (b.status==='active'?0:1))
    .forEach(c=>wrap.appendChild(buildCreditCardCard(c)));
}
function renderCreditCardsSummary(){
  const cards = getCreditCards();
  const active = cards.filter(c=>c.status==='active');
  document.getElementById('ccActiveCount').textContent = active.length;
  document.getElementById('ccTotalDue').textContent = fmtAmount(active.reduce((s,c)=>s+c.currentDue,0));
  document.getElementById('ccTotalPaid').textContent = fmtAmount(cards.reduce((s,c)=>s+ccTotalPaidAllTime(c),0));
}
function renderCreditCards(){
  syncCreditCardDue();
  renderCreditCardsList();
  renderCreditCardsSummary();
  renderNWSummary(); // outstanding card dues affect net worth's liabilities total
}

// ---------- Upcoming due-date notifications ----------
// SIPs and recurring expenses: warn 5 days out. Insurance: warn a full month
// out, since premiums are usually bigger and less convenient to scramble for.
function renderNotifications(){
  const wrap = document.getElementById('upcomingNotifications');
  const today = todayLocalISO();
  const items = []; // plain informational reminders (no checkbox)
  const pending = []; // awaiting your confirmation (checkbox)

  // SIPs and SWP stay fully automatic — no confirmation step, just a heads-up.
  getSips().forEach(sip=>{
    if(sip.status!=='active') return;
    const days = daysBetween(today, sip.nextDueDate);
    if(days>=0 && days<=5){
      items.push({ days, text:`SIP "${sip.name}" — ${fmtAmount(sip.amount)} due ${days===0?'today':'in '+days+' day'+(days===1?'':'s')} (${sip.nextDueDate})` });
    }
  });
  getSwps().forEach(swp=>{
    if(swp.status!=='active') return;
    const days = daysBetween(today, swp.nextDueDate);
    if(days>=0 && days<=5){
      items.push({ days, text:`SWP "${swp.name}" — ${fmtAmount(swp.amount)} withdrawal due ${days===0?'today':'in '+days+' day'+(days===1?'':'s')} (${swp.nextDueDate})` });
    }
  });
  getLoans().forEach(loan=>{
    if(loan.status!=='active') return;
    const days = daysBetween(today, loan.nextDueDate);
    if(days>=0 && days<=5){
      items.push({ days, text:`Loan "${loan.name}" — EMI ${fmtAmount(loan.emiAmount)} due ${days===0?'today':'in '+days+' day'+(days===1?'':'s')} (${loan.nextDueDate})` });
    }
  });
  getSavingsAccounts().forEach(acc=>{
    if(!acc.lowBalanceThreshold) return;
    const balance = holdingCurrentValue(acc);
    if(balance < acc.lowBalanceThreshold){
      items.push({ days:-1, whenLabel:'LOW', urgent:true, text:`"${acc.name}" balance is ${fmtAmount(balance)} — below your alert threshold of ${fmtAmount(acc.lowBalanceThreshold)}` });
    }
  });

  // Recurring expenses and insurance: upcoming ones are just a heads-up (no
  // checkbox yet); once actually due, they wait as a pending confirmation —
  // nothing gets added to your expenses or debited until you tick the box.
  getRecurring().forEach(r=>{
    if(r.status!=='active') return;
    const days = daysBetween(today, r.nextDueDate);
    if(days>=0 && days<=5){
      items.push({ days, text:`Recurring "${r.name}" — ${fmtAmount(r.amount)} next due ${days===0?'today':'in '+days+' day'+(days===1?'':'s')} (${r.nextDueDate})` });
    }
    (r.pendingOccurrences||[]).forEach(occ=>{
      pending.push({ date: occ.date, text:`Recurring "${r.name}" — ${fmtAmount(occ.amount)} on ${occ.date}`, confirm: ()=>confirmRecurringOccurrence(r.id, occ.id) });
    });
  });
  getInsurance().forEach(ins=>{
    if(ins.status==='lapsed') return;
    const days = daysBetween(today, ins.nextDueDate);
    if(days>=0 && days<=30){
      items.push({ days, text:`Insurance "${ins.name}" premium — ${fmtAmount(ins.premiumAmount)} next due ${days===0?'today':'in '+days+' day'+(days===1?'':'s')} (${ins.nextDueDate})` });
    }
    (ins.pendingOccurrences||[]).forEach(occ=>{
      pending.push({ date: occ.date, text:`Insurance "${ins.name}" premium — ${fmtAmount(occ.amount)} on ${occ.date}`, confirm: ()=>confirmInsurancePending(ins.id, occ.id) });
    });
  });
  getCreditCards().forEach(c=>{
    if(c.status!=='active') return;
    const days = daysBetween(today, c.nextDueDate);
    if(days>=0 && days<=5 && c.currentDue>0.01){
      items.push({ days, text:`Credit card "${c.name}" — ${fmtAmount(c.currentDue)} bill next due ${days===0?'today':'in '+days+' day'+(days===1?'':'s')} (${c.nextDueDate})` });
    }
    (c.pendingOccurrences||[]).forEach(occ=>{
      pending.push({ date: occ.date, text:`Credit card "${c.name}" — ${fmtAmount(occ.amount)} bill due ${occ.date}`, confirm: ()=>confirmCreditCardPending(c.id, occ.id) });
    });
  });

  if(items.length===0 && pending.length===0){ wrap.style.display='none'; wrap.innerHTML=''; return; }
  items.sort((a,b)=>a.days-b.days);
  pending.sort((a,b)=>a.date.localeCompare(b.date));

  wrap.innerHTML = '';
  const banner = document.createElement('div');
  banner.className = 'notify-banner';
  banner.innerHTML = `<div class="notify-title">🔔 Coming up (${currentCurrency})</div>`;

  pending.forEach(p=>{
    const row = document.createElement('div');
    row.className = 'notify-row';
    row.innerHTML = `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;width:100%;"><input type="checkbox" style="width:16px;height:16px;"><span class="notify-when">CONFIRM</span><span>${escapeHtml(p.text)} — tick to add to expenses and debit the linked account</span></label>`;
    row.querySelector('input').addEventListener('change', (e)=>{
      if(e.target.checked) p.confirm();
    });
    banner.appendChild(row);
  });
  items.forEach(item=>{
    const row = document.createElement('div');
    row.className = 'notify-row';
    const soon = item.urgent || item.days>5;
    const whenLabel = item.whenLabel || (item.days===0 ? 'TODAY' : item.days+'d');
    row.innerHTML = `<span class="notify-when${soon?' soon':''}">${whenLabel}</span><span>${escapeHtml(item.text)}</span>`;
    banner.appendChild(row);
  });

  wrap.appendChild(banner);
  wrap.style.display = '';
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
// Generates a pending occurrence (awaiting your checkbox confirmation) for
// each due date that's passed, instead of logging a transaction immediately.
// Nothing is added to your expenses or debited from any account until you
// tick the checkbox in the notification banner.
function syncRecurringExpenses(){
  const today = todayLocalISO();
  let changed = false;
  getRecurring().forEach(r=>{
    if(!r.pendingOccurrences) r.pendingOccurrences = [];
    if(r.status!=='active') return;
    let guard = 0;
    while(r.nextDueDate<=today && guard<600){
      r.pendingOccurrences.push({ id: nwUid(), date: r.nextDueDate, amount: r.amount });
      r.nextDueDate = advanceDate(r.nextDueDate, r.frequencyUnit, r.frequencyValue);
      changed = true;
      guard++;
    }
  });
  if(changed) saveData();
}

// Called when you tick the checkbox for a pending recurring-expense occurrence.
function confirmRecurringOccurrence(recurId, occId){
  const r = getRecurring().find(x=>x.id===recurId);
  if(!r) return;
  const occ = (r.pendingOccurrences||[]).find(o=>o.id===occId);
  if(!occ) return;
  const tx = { id: uid(), date: occ.date, type:'expense', category:r.category, description:`Recurring: ${r.name}`, accountId: r.debitAccountId||null, amount: occ.amount, currency: currentCurrency };
  transactions.push(tx);
  applyTxToAccount(tx, 1);
  r.loggedTx.push({ id: tx.id, date: occ.date, amount: occ.amount });
  r.pendingOccurrences = r.pendingOccurrences.filter(o=>o.id!==occId);
  saveData();
  renderAll();
}

document.getElementById('addRecurring').addEventListener('click', ()=>{
  const name = document.getElementById('recurName').value.trim();
  const amount = +document.getElementById('recurAmount').value;
  const category = document.getElementById('recurCategory').value;
  const frequencyUnit = document.getElementById('recurFrequencyType').value;
  const daysN = +document.getElementById('recurDaysN').value;
  const startDate = document.getElementById('recurStartDate').value || todayLocalISO();
  const debitAccountId = document.getElementById('recurDebitAccount').value || null;

  if(!name){ alert('Give this a name.'); return; }
  if(!amount || amount<=0){ alert('Enter an amount greater than zero.'); return; }
  if(frequencyUnit==='days' && (!daysN || daysN<=0)){ alert('Enter how many days between each one.'); return; }

  getRecurring().push({
    id: nwUid(),
    name,
    amount,
    category,
    debitAccountId,
    frequencyUnit,
    frequencyValue: frequencyUnit==='days' ? daysN : 1,
    startDate,
    status: 'active',
    stoppedDate: null,
    nextDueDate: startDate,
    loggedTx: [],
    pendingOccurrences: []
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
  const pending = r.pendingOccurrences||[];
  let badge = 'repaid', badgeText = 'Active';
  if(isStopped){ badge='stopped'; badgeText='Stopped'; }
  else if(pending.length>0){ badge='due-soon'; badgeText='Awaiting confirmation'; }
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
    ${pending.length>0?`<div class="pending-box" id="recurpending-${r.id}"></div>`:''}
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

  const pendingBox = card.querySelector('.pending-box');
  if(pendingBox){
    pending.slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach(occ=>{
      const row = document.createElement('label');
      row.className = 'pending-row';
      row.innerHTML = `<input type="checkbox"><span>Confirm ${fmtAmount(occ.amount)} on ${occ.date} — adds to expenses${r.debitAccountId?' and debits the linked account':''}</span>`;
      row.querySelector('input').addEventListener('change', (e)=>{
        if(e.target.checked) confirmRecurringOccurrence(r.id, occ.id);
      });
      pendingBox.appendChild(row);
    });
  }

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
  populateAccountSelect('recurDebitAccount');
  renderRecurringList();
  renderRecurringSummary();
  renderSummary(); // a newly-logged recurring expense affects income/expense totals too
  renderList();
}

// ---------- SWP (Systematic Withdrawal, optionally feeding into a SIP-style destination) ----------
function getSwps(){ return getNW().swps; }

function swpFrequencyLabel(swp){ return SIP_FREQ_LABEL[`${swp.frequencyUnit}:${swp.frequencyValue}`] || `Every ${swp.frequencyValue} ${swp.frequencyUnit}`; }
function swpMonthlyEquivalent(swp){
  return swp.frequencyUnit==='days' ? swp.amount*(30.44/swp.frequencyValue) : swp.amount/swp.frequencyValue;
}
function swpTotalWithdrawn(swp){ return swp.withdrawals.reduce((s,w)=>s+w.amount,0); }

function populateSwpHoldingSelects(){
  const holdings = getNW().holdings;
  [['swpSourceHolding', false], ['swpDestHolding', true]].forEach(([id, allowNone])=>{
    const sel = document.getElementById(id);
    const prevValue = sel.value;
    sel.innerHTML = allowNone ? '<option value="">— none, just withdraw —</option>' : '';
    holdings.forEach(h=>{
      const opt = document.createElement('option');
      opt.value = h.id;
      opt.textContent = `${h.name} (${ASSET_CLASS_LABELS[h.assetClass]||h.assetClass})`;
      sel.appendChild(opt);
    });
    if(prevValue && [...sel.options].some(o=>o.value===prevValue)) sel.value = prevValue;
  });
}

function syncSwpWithdrawals(){
  const today = todayLocalISO();
  let changed = false;
  getSwps().forEach(swp=>{
    if(swp.status!=='active') return;
    let guard = 0;
    while(swp.nextDueDate<=today && guard<600){
      const date = swp.nextDueDate;
      const source = getNW().holdings.find(h=>h.id===swp.sourceHoldingId);
      const withdrawal = { id: nwUid(), date, amount:0, realizedPL:0, shortfall:true, postedToDest: false };
      if(source){
        const result = withdrawFromHoldingAuto(source, date, swp.amount);
        withdrawal.amount = result.withdrawn;
        withdrawal.realizedPL = result.realizedPL;
        withdrawal.shortfall = result.shortfall;
        if(swp.destHoldingId && result.withdrawn>0){
          const dest = getNW().holdings.find(h=>h.id===swp.destHoldingId);
          if(dest){
            postContributionToHolding(dest, date, result.withdrawn, `SWP transfer: ${swp.name}`);
            withdrawal.postedToDest = true;
          }
        }
      }
      swp.withdrawals.push(withdrawal);
      swp.nextDueDate = advanceDate(swp.nextDueDate, swp.frequencyUnit, swp.frequencyValue);
      changed = true;
      guard++;
    }
  });
  if(changed) saveData();
}

document.getElementById('addSwp').addEventListener('click', ()=>{
  const name = document.getElementById('swpName').value.trim();
  const amount = +document.getElementById('swpAmount').value;
  const sourceHoldingId = document.getElementById('swpSourceHolding').value || null;
  const destHoldingId = document.getElementById('swpDestHolding').value || null;
  const [frequencyUnit, freqValueRaw] = document.getElementById('swpFrequency').value.split(':');
  const frequencyValue = +freqValueRaw;
  const startDate = document.getElementById('swpStartDate').value || todayLocalISO();

  if(!name){ alert('Give this SWP a name.'); return; }
  if(!amount || amount<=0){ alert('Enter an amount greater than zero.'); return; }
  if(!sourceHoldingId){ alert('Pick a holding to withdraw from.'); return; }
  if(sourceHoldingId===destHoldingId){ alert('Source and destination can\'t be the same holding.'); return; }

  getSwps().push({
    id: nwUid(),
    name,
    amount,
    sourceHoldingId,
    destHoldingId,
    frequencyUnit,
    frequencyValue,
    startDate,
    status: 'active',
    stoppedDate: null,
    nextDueDate: startDate,
    withdrawals: []
  });
  saveData();
  document.getElementById('swpName').value = '';
  document.getElementById('swpAmount').value = '';
  document.getElementById('swpStartDate').value = todayLocalISO();
  renderSwps();
});

function stopSwp(id){
  const swp = getSwps().find(x=>x.id===id);
  if(!swp) return;
  if(!confirm(`Stop "${swp.name}"? No more withdrawals will happen automatically after today.`)) return;
  swp.status = 'stopped';
  swp.stoppedDate = todayLocalISO();
  saveData();
  renderSwps();
}
function resumeSwp(id){
  const swp = getSwps().find(x=>x.id===id);
  if(!swp) return;
  swp.status = 'active';
  swp.stoppedDate = null;
  if(swp.nextDueDate < todayLocalISO()) swp.nextDueDate = todayLocalISO();
  saveData();
  renderSwps();
}
function editSwpInfo(id){
  const swp = getSwps().find(x=>x.id===id);
  if(!swp) return;
  const newName = prompt('SWP name:', swp.name);
  if(newName===null) return;
  if(!newName.trim()){ alert('Name can\'t be empty.'); return; }
  const newAmt = prompt(`Amount per ${swpFrequencyLabel(swp).toLowerCase()} withdrawal:`, swp.amount);
  if(newAmt===null) return;
  const amt = +newAmt;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }

  const holdings = getNW().holdings;
  const list = holdings.map((h,i)=>`${i+1}. ${h.name} (${ASSET_CLASS_LABELS[h.assetClass]||h.assetClass})`).join('\n');
  const srcIndex = holdings.findIndex(h=>h.id===swp.sourceHoldingId);
  const srcRaw = holdings.length===0 ? null : prompt(`Withdraw from which holding? Enter its number:\n\n${list}`, srcIndex>=0 ? String(srcIndex+1) : '1');
  if(srcRaw===null) return;
  const srcNum = parseInt(srcRaw, 10);
  const newSourceHoldingId = (!isNaN(srcNum) && srcNum>=1 && srcNum<=holdings.length) ? holdings[srcNum-1].id : swp.sourceHoldingId;

  const destIndex = holdings.findIndex(h=>h.id===swp.destHoldingId);
  const destRaw = holdings.length===0 ? null : prompt(`Invest into which holding (optional)? Enter its number, or 0 for none:\n\n0. — none, just withdraw —\n${list}`, destIndex>=0 ? String(destIndex+2) : '0');
  let newDestHoldingId = swp.destHoldingId;
  if(destRaw!==null){
    const destNum = parseInt(destRaw, 10);
    newDestHoldingId = (!isNaN(destNum) && destNum>=1 && destNum<=holdings.length) ? holdings[destNum-1].id : null;
  }
  if(newSourceHoldingId===newDestHoldingId && newDestHoldingId){ alert('Source and destination can\'t be the same holding — destination link not changed.'); newDestHoldingId = swp.destHoldingId; }

  swp.name = newName.trim();
  swp.amount = amt;
  const destChanged = newDestHoldingId !== (swp.destHoldingId||null);
  swp.sourceHoldingId = newSourceHoldingId;
  swp.destHoldingId = newDestHoldingId;
  saveData();
  if(destChanged && newDestHoldingId){
    backfillSwpWithdrawals(swp.id);
    return;
  }
  renderSwps();
}

// Posts any of this SWP's withdrawals that happened before a destination was
// set (or before it was changed) into the new destination's invested amount —
// mirrors the same fix built for SIPs.
function backfillSwpWithdrawals(swpId){
  const swp = getSwps().find(x=>x.id===swpId);
  if(!swp || !swp.destHoldingId) return;
  const dest = getNW().holdings.find(h=>h.id===swp.destHoldingId);
  if(!dest) return;
  const unposted = swp.withdrawals.filter(w=>!w.postedToDest && w.amount>0);
  if(unposted.length===0){ renderSwps(); return; }
  const total = unposted.reduce((s,w)=>s+w.amount,0);
  if(!confirm(`"${swp.name}" has ${unposted.length} withdrawal(s) totaling ${fmtAmount(total)} that never reached "${dest.name}". Add them to its invested amount now?`)){
    renderSwps();
    return;
  }
  unposted.forEach(w=>{
    postContributionToHolding(dest, w.date, w.amount, `SWP transfer: ${swp.name} (backfilled)`);
    w.postedToDest = true;
  });
  saveData();
  renderAll();
}

function editWithdrawal(swpId, withdrawalId){
  const swp = getSwps().find(x=>x.id===swpId);
  if(!swp) return;
  const w = swp.withdrawals.find(x=>x.id===withdrawalId);
  if(!w) return;
  const amtRaw = prompt('Amount:', w.amount);
  if(amtRaw===null) return;
  const amt = +amtRaw;
  if(!amt || amt<=0){ alert('Enter a valid amount.'); return; }
  const dateRaw = prompt('Date (YYYY-MM-DD):', w.date);
  if(dateRaw===null) return;
  w.amount = amt;
  w.date = dateRaw || w.date;
  saveData();
  renderSwps();
}
function deleteWithdrawal(swpId, withdrawalId){
  const swp = getSwps().find(x=>x.id===swpId);
  if(!swp) return;
  if(!confirm('Delete this withdrawal entry? (This only removes it from the SWP\'s own log — it does not undo the actual withdrawal/transfer already applied to your holdings.)')) return;
  swp.withdrawals = swp.withdrawals.filter(x=>x.id!==withdrawalId);
  saveData();
  renderSwps();
}
function deleteSwp(id){
  const swp = getSwps().find(x=>x.id===id);
  if(!swp) return;
  if(!confirm(`Delete "${swp.name}" entirely, including its withdrawal history? This can't be undone (it won't undo withdrawals already applied to your holdings).`)) return;
  markDeleted(id);
  getNW().swps = getSwps().filter(x=>x.id!==id);
  saveData();
  renderSwps();
}

function buildSwpCard(swp){
  const withdrawn = swpTotalWithdrawn(swp);
  const isStopped = swp.status==='stopped';
  const source = getNW().holdings.find(h=>h.id===swp.sourceHoldingId);
  const dest = swp.destHoldingId ? getNW().holdings.find(h=>h.id===swp.destHoldingId) : null;
  const unpostedCount = swp.destHoldingId ? swp.withdrawals.filter(w=>!w.postedToDest && w.amount>0).length : 0;

  const card = document.createElement('div');
  card.className = 'holding-card';
  card.innerHTML = `
    <div class="hc-top">
      <span class="status-badge ${isStopped?'stopped':'repaid'}">${isStopped?'Stopped':'Active'}</span>
      <span class="h-name">${escapeHtml(swp.name)}</span>
      <span class="h-meta">${escapeHtml(source?source.name:'— missing holding —')}${dest?' → '+escapeHtml(dest.name):''}</span>
    </div>
    ${unpostedCount>0?`<div class="h-note" style="color:var(--brick);">⚠ ${unpostedCount} withdrawal(s) haven't reached "${escapeHtml(dest.name)}" yet — see Backfill below.</div>`:''}
    <div class="hc-stats">
      <div class="h-figure"><span class="lbl">Amount / ${swpFrequencyLabel(swp)}</span>${fmtAmount(swp.amount)}</div>
      <div class="h-figure"><span class="lbl">Started</span>${swp.startDate}</div>
      <div class="h-figure"><span class="lbl">Total withdrawn</span>${fmtAmount(withdrawn)}</div>
      <div class="h-figure"><span class="lbl">Withdrawals</span>${swp.withdrawals.length}</div>
      ${!isStopped?`<div class="h-figure"><span class="lbl">Next due</span>${swp.nextDueDate}</div>`:''}
    </div>
    <div class="h-actions">
      ${isStopped?'<button class="buy" data-action="resume">▶ Resume</button>':'<button data-action="stop">⏸ Stop SWP</button>'}
      <button data-action="edit">✎ Edit</button>
      ${unpostedCount>0?'<button class="buy" data-action="backfill">⏪ Backfill '+unpostedCount+' withdrawal(s)</button>':''}
      <button data-action="log">☰ Withdrawals</button>
      <button data-action="del">× Delete</button>
    </div>
    <div class="h-log" id="swplog-${swp.id}" style="display:none;"></div>
  `;
  const stopBtn = card.querySelector('[data-action=stop]');
  if(stopBtn) stopBtn.addEventListener('click', ()=>stopSwp(swp.id));
  const resumeBtn = card.querySelector('[data-action=resume]');
  if(resumeBtn) resumeBtn.addEventListener('click', ()=>resumeSwp(swp.id));
  card.querySelector('[data-action=edit]').addEventListener('click', ()=>editSwpInfo(swp.id));
  const backfillBtn = card.querySelector('[data-action=backfill]');
  if(backfillBtn) backfillBtn.addEventListener('click', ()=>backfillSwpWithdrawals(swp.id));
  card.querySelector('[data-action=log]').addEventListener('click', ()=>{
    const el = document.getElementById('swplog-'+swp.id);
    el.style.display = el.style.display==='none' ? '' : 'none';
  });
  card.querySelector('[data-action=del]').addEventListener('click', ()=>deleteSwp(swp.id));

  const logEl = card.querySelector('.h-log');
  if(swp.withdrawals.length===0){
    logEl.innerHTML = '<span style="color:var(--ink-soft);">No withdrawals logged yet.</span>';
  }
  swp.withdrawals.slice().sort((a,b)=>b.date.localeCompare(a.date)).forEach(w=>{
    const row = document.createElement('div');
    row.className = 'log-row';
    const shortfallNote = w.shortfall ? ' <span class="dup-badge" title="Not enough balance in the source holding to withdraw the full amount">⚠ partial/shortfall</span>' : '';
    const destNote = swp.destHoldingId ? (w.postedToDest ? ' → invested' : ' → not yet transferred') : '';
    row.innerHTML = `<span>Withdrew ${fmtAmount(w.amount)} on ${w.date}${destNote}${shortfallNote}</span>`;
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎'; editBtn.title = 'Edit this entry';
    editBtn.addEventListener('click', ()=>editWithdrawal(swp.id, w.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = '×'; delBtn.title = 'Delete this entry';
    delBtn.addEventListener('click', ()=>deleteWithdrawal(swp.id, w.id));
    row.appendChild(editBtn); row.appendChild(delBtn);
    logEl.appendChild(row);
  });
  return card;
}

function renderSwpsList(){
  const wrap = document.getElementById('swpList');
  const swps = getSwps();
  if(swps.length===0){
    wrap.innerHTML = '<div class="empty-state">No SWPs logged yet — add one above.</div>';
    return;
  }
  wrap.innerHTML = '';
  swps.slice()
    .sort((a,b)=> (a.status==='active'?0:1) - (b.status==='active'?0:1))
    .forEach(swp=>wrap.appendChild(buildSwpCard(swp)));
}
function renderSwpsSummary(){
  const swps = getSwps();
  const active = swps.filter(s=>s.status==='active');
  document.getElementById('swpActiveCount').textContent = active.length;
  document.getElementById('swpMonthlyTotal').textContent = fmtAmount(active.reduce((s,x)=>s+swpMonthlyEquivalent(x),0));
  document.getElementById('swpTotalWithdrawn').textContent = fmtAmount(swps.reduce((s,x)=>s+swpTotalWithdrawn(x),0));
}
function renderSwps(){
  syncSwpWithdrawals();
  populateSwpHoldingSelects();
  renderSwpsList();
  renderSwpsSummary();
  renderNetWorth(); // a SWP sync may have just withdrawn/invested — keep holdings in sync
}

// ---------- Collapsible sections (Lending / SIPs / Insurance) ----------
// Remembered for the browser session (sessionStorage) so collapsing a
// section you don't use stays collapsed as you keep using the tracker,
// without permanently hiding it forever across visits.
function setupCollapsibleSection(headId, arrowId, bodyId, storageKey){
  const head = document.getElementById(headId);
  const arrow = document.getElementById(arrowId);
  const body = document.getElementById(bodyId);
  const stored = sessionStorage.getItem(storageKey);
  const collapsed = stored===null ? true : stored==='1'; // collapsed by default until you expand it yourself
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
setupCollapsibleSection('remitSectionHead','remitArrow','remitSectionBody','spendingTracker.collapsed.remit');
setupCollapsibleSection('manageCatSectionHead','manageCatArrow','manageCatSectionBody','spendingTracker.collapsed.manageCat');
setupCollapsibleSection('sipsSectionHead','sipsArrow','sipsSectionBody','spendingTracker.collapsed.sips');
setupCollapsibleSection('insuranceSectionHead','insuranceArrow','insuranceSectionBody','spendingTracker.collapsed.insurance');
setupCollapsibleSection('loansSectionHead','loansArrow','loansSectionBody','spendingTracker.collapsed.loans');
setupCollapsibleSection('ccSectionHead','ccArrow','ccSectionBody','spendingTracker.collapsed.cc');
setupCollapsibleSection('recurringSectionHead','recurringArrow','recurringSectionBody','spendingTracker.collapsed.recurring');
setupCollapsibleSection('swpSectionHead','swpArrow','swpSectionBody','spendingTracker.collapsed.swp');
setupCollapsibleSection('budgetSectionHead','budgetArrow','budgetSectionBody','spendingTracker.collapsed.budget');
setupCollapsibleSection('chartsSectionHead','chartsArrow','chartsSectionBody','spendingTracker.collapsed.charts');
setupCollapsibleSection('yearlyStatsSectionHead','yearlyStatsArrow','yearlyStatsSectionBody','spendingTracker.collapsed.yearlyStats');
setupCollapsibleSection('monthlyCatSectionHead','monthlyCatArrow','monthlyCatSectionBody','spendingTracker.collapsed.monthlyCat');
setupCollapsibleSection('tagBreakdownSectionHead','tagBreakdownArrow','tagBreakdownSectionBody','spendingTracker.collapsed.tagBreakdown');
setupCollapsibleSection('incomeCatSectionHead','incomeCatArrow','incomeCatSectionBody','spendingTracker.collapsed.incomeCat');
setupCollapsibleSection('netWorthSectionHead','netWorthArrow','netWorthSectionBody','spendingTracker.collapsed.netWorth');
setupCollapsibleSection('yourDataSectionHead','yourDataArrow','yourDataSectionBody','spendingTracker.collapsed.yourData');

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
  populateTxPaymentSelect();
  renderCategoryManagement();
  renderAccountManagement();
  syncRecurringExpenses(); // before the transaction-dependent renders below, so a fresh auto-logged expense shows up right away
  renderSummary();
  renderList();
  renderBudget();
  renderCategoryChart();
  renderTrendChart();
  renderYearlyStats();
  populateMonthlyCategoryYearFilter();
  renderMonthlyCategoryTable();
  renderTagBreakdown();
  renderIncomeCategoryTotalTable();
  renderIncomeCategoryYearTable();
  syncSipInstallments(); // before renderNetWorth, so a SIP-driven buy shows up in the holdings list right away
  syncSwpWithdrawals(); // same reasoning — a SWP-driven withdrawal/transfer should show up immediately too
  syncLoanEmis(); // same reasoning — a fresh EMI payment should reflect in outstanding balance right away
  syncCreditCardDue(); // same reasoning — a due-date snapshot should be ready before notifications render
  renderNetWorth();
  renderLending();
  renderRemit();
  renderSips();
  renderInsurance();
  renderRecurring();
  renderSwps();
  renderLoans();
  renderCreditCards();
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

// Merges incoming records into a local array by ID. Previously this only
// ever added brand-new records and silently ignored anything whose ID
// already existed locally — which meant an *edit* made on one device would
// never show up on another, only new entries would. When preferIncoming is
// true (the backup being merged in is newer than what this device last saw),
// an existing local record gets overwritten with the incoming version too.
function mergeArrayById(localArr, incomingArr, preferIncoming){
  if(!Array.isArray(incomingArr)) return { added:0, updated:0 };
  const localById = new Map(localArr.map(item=>[item.id, item]));
  let added=0, updated=0;
  incomingArr.forEach(incomingItem=>{
    if(!incomingItem.id || isDeleted(incomingItem.id)) return;
    const localItem = localById.get(incomingItem.id);
    if(!localItem){
      localArr.push(incomingItem);
      added++;
    } else if(preferIncoming){
      Object.assign(localItem, incomingItem);
      updated++;
    }
  });
  return { added, updated };
}

function mergeNetWorthFromBackup(incomingNW, preferIncoming){
  if(!incomingNW) return 0;
  let addedHoldings = 0;
  ['INR','USD'].forEach(cur=>{
    const incomingBucket = incomingNW[cur];
    if(!incomingBucket) return;
    const localBucket = netWorthData[cur];
    if(Array.isArray(incomingBucket.holdings)){
      const migrated = incomingBucket.holdings.map(migrateHolding);
      const result = mergeArrayById(localBucket.holdings, migrated, preferIncoming);
      addedHoldings += result.added;
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
    if(incomingBucket.liabilities){
      if(preferIncoming) Object.assign(localBucket.liabilities, incomingBucket.liabilities);
      else Object.keys(incomingBucket.liabilities).forEach(k=>{ if(localBucket.liabilities[k]===undefined) localBucket.liabilities[k]=incomingBucket.liabilities[k]; });
    }
    if(Array.isArray(incomingBucket.lending)){
      if(!localBucket.lending) localBucket.lending = [];
      mergeArrayById(localBucket.lending, incomingBucket.lending.map(migrateLending), preferIncoming);
    }
    if(Array.isArray(incomingBucket.sips)){
      if(!localBucket.sips) localBucket.sips = [];
      mergeArrayById(localBucket.sips, incomingBucket.sips, preferIncoming);
    }
    if(Array.isArray(incomingBucket.insurance)){
      if(!localBucket.insurance) localBucket.insurance = [];
      mergeArrayById(localBucket.insurance, incomingBucket.insurance, preferIncoming);
    }
    if(Array.isArray(incomingBucket.recurringExpenses)){
      if(!localBucket.recurringExpenses) localBucket.recurringExpenses = [];
      mergeArrayById(localBucket.recurringExpenses, incomingBucket.recurringExpenses, preferIncoming);
    }
    if(Array.isArray(incomingBucket.swps)){
      if(!localBucket.swps) localBucket.swps = [];
      mergeArrayById(localBucket.swps, incomingBucket.swps, preferIncoming);
    }
    if(Array.isArray(incomingBucket.loansTaken)){
      if(!localBucket.loansTaken) localBucket.loansTaken = [];
      mergeArrayById(localBucket.loansTaken, incomingBucket.loansTaken, preferIncoming);
    }
    if(Array.isArray(incomingBucket.creditCards)){
      if(!localBucket.creditCards) localBucket.creditCards = [];
      mergeArrayById(localBucket.creditCards, incomingBucket.creditCards, preferIncoming);
    }
    if(Array.isArray(incomingBucket.wealthSnapshots)){
      if(!localBucket.wealthSnapshots) localBucket.wealthSnapshots = [];
      const localByMonth = new Map(localBucket.wealthSnapshots.map(s=>[s.month, s]));
      incomingBucket.wealthSnapshots.forEach(s=>{
        const existing = localByMonth.get(s.month);
        if(!existing) localBucket.wealthSnapshots.push(s);
        else if(preferIncoming) Object.assign(existing, s);
      });
    }
  });
  return addedHoldings;
}

document.getElementById('exportJson').addEventListener('click', ()=>{
  const payload = { transactions, categories, netWorthData, budgets, deletedIds: [...deletedIds], remittances, exportedAt: new Date().toISOString() };
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
      const existingTxIds = new Set(transactions.map(t=>t.id));
      const overlapCount = incoming.filter(t=>t.id && existingTxIds.has(t.id)).length;
      if(!confirm(`Import ${incoming.length} transaction(s)${nwCount?` and up to ${nwCount} holding(s)`:''}?`)) return;
      let overwriteExisting = false;
      if(overlapCount>0){
        overwriteExisting = confirm(`${overlapCount} record(s) in this file share an ID with something already here (likely the same item, possibly edited since). Click OK to overwrite those with the imported version, or Cancel to only add new records and leave existing ones untouched.`);
      }
      applyIncomingTombstones(data.deletedIds);
      incoming.forEach(t=>{ if(!t.currency) t.currency='INR'; });
      mergeArrayById(transactions, incoming, overwriteExisting);
      if(data.categories){
        ['income','expense'].forEach(type=>{
          if(Array.isArray(data.categories[type])){
            data.categories[type].forEach(c=>{ if(!categories[type].includes(c)) categories[type].push(c); });
          }
        });
      }
      mergeNetWorthFromBackup(data.netWorthData, overwriteExisting);
      if(data.budgets){
        if(overwriteExisting){
          Object.assign(budgets.INR, data.budgets.INR||{});
          Object.assign(budgets.USD, data.budgets.USD||{});
        } else {
          Object.keys(data.budgets.INR||{}).forEach(k=>{ if(budgets.INR[k]===undefined) budgets.INR[k]=data.budgets.INR[k]; });
          Object.keys(data.budgets.USD||{}).forEach(k=>{ if(budgets.USD[k]===undefined) budgets.USD[k]=data.budgets.USD[k]; });
        }
      }
      mergeArrayById(remittances, data.remittances, overwriteExisting);
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

// The OAuth Client ID — set once here, works on every device automatically.
// This is a public identifier (Google's own docs call it non-secret), so
// there's nothing sensitive about it living in this file. Who can actually
// sign in is controlled entirely by the "Test users" list on the OAuth
// consent screen in Google Cloud Console — add a Gmail address there to let
// that person sync to their own Drive using this same Client ID.
const GOOGLE_CLIENT_ID = '383914037063-7j0fpcpltj1dlvglhrsn27inf1h9juff.apps.googleusercontent.com';

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
  if(!window.google) return false;
  gsiClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/drive.file openid email',
    callback: () => {} // overwritten per-call below
  });
  return true;
}

function requestDriveToken(onGranted){
  // Fast path: script + client already prepared (the common case) — call
  // requestAccessToken() synchronously within this click so the browser
  // still treats the popup as user-initiated and doesn't silently block it.
  if(gsiClient){
    let settled = false;
    // If the popup was silently blocked (common on mobile browsers with strict
    // popup settings), Google's callback never fires at all — with no timeout,
    // the UI would just sit there forever with zero indication anything went
    // wrong. This makes that failure visible instead of silent.
    const timeoutId = setTimeout(()=>{
      if(settled) return;
      settled = true;
      setDriveStatus('No popup appeared — your browser likely blocked it. Check your browser\'s site settings and allow popups for this page, then try again.');
    }, 7000);
    gsiClient.callback = (resp)=>{
      if(settled) return; // timeout already fired and reported the failure
      settled = true;
      clearTimeout(timeoutId);
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
    if(!initGsi()){ setDriveStatus('Could not start Google Sign-In.'); return; }
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

// Preload the sign-in script right away so the very first Connect click
// this session still works on the first try.
loadGsiScript(()=>{ initGsi(); setDriveStatus('Ready. Click Connect Google Drive.'); });

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
    const exportedAt = new Date().toISOString();
    const payload = JSON.stringify({ transactions, categories, netWorthData, budgets, deletedIds: [...deletedIds], remittances, exportedAt }, null, 2);
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
      setLastSyncTimestamp(exportedAt); // this device is now caught up to the version it just pushed
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
    // If this backup is newer than what we last synced, overlapping records
    // should be treated as edits (overwrite), not just skipped as duplicates —
    // this is what makes an edit made on another device actually show up here.
    const preferIncoming = !!data.exportedAt && data.exportedAt > getLastSyncTimestamp();
    const incoming = Array.isArray(data.transactions) ? data.transactions : [];
    incoming.forEach(t=>{ if(!t.currency) t.currency='INR'; });
    const txResult = mergeArrayById(transactions, incoming, preferIncoming);
    const added = txResult.added;
    if(data.categories){
      ['income','expense'].forEach(type=>{
        if(Array.isArray(data.categories[type])) data.categories[type].forEach(c=>{ if(!categories[type].includes(c)) categories[type].push(c); });
      });
    }
    const addedHoldings = mergeNetWorthFromBackup(data.netWorthData, preferIncoming);
    if(data.budgets){
      if(preferIncoming){
        Object.assign(budgets.INR, data.budgets.INR||{});
        Object.assign(budgets.USD, data.budgets.USD||{});
      } else {
        Object.keys(data.budgets.INR||{}).forEach(k=>{ if(budgets.INR[k]===undefined) budgets.INR[k]=data.budgets.INR[k]; });
        Object.keys(data.budgets.USD||{}).forEach(k=>{ if(budgets.USD[k]===undefined) budgets.USD[k]=data.budgets.USD[k]; });
      }
    }
    const remitResult = mergeArrayById(remittances, data.remittances, preferIncoming);
    const addedRemit = remitResult.added;
    if(data.exportedAt) setLastSyncTimestamp(data.exportedAt);
    if(added>0 || addedHoldings>0 || addedRemit>0 || txResult.updated>0 || remitResult.updated>0){
      saveDataLocalOnly(); // don't re-trigger a push for data we just pulled
      renderAll();
    }
    if(!silent){
      const updatedTotal = txResult.updated + remitResult.updated;
      const parts = [];
      if(added>0||addedHoldings>0||addedRemit>0) parts.push(`${added} new transaction(s), ${addedHoldings} holding(s), ${addedRemit} remittance(s)`);
      if(updatedTotal>0) parts.push(`${updatedTotal} record(s) updated with newer edits`);
      alert(parts.length ? `Restored from Drive: ${parts.join('; ')}.` : 'Already up to date with Drive.');
    }
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
document.getElementById('swpStartDate').value = todayLocalISO();
document.getElementById('remitDate').value = todayLocalISO();
document.getElementById('loanStartDate').value = todayLocalISO();
document.getElementById('ccNextDueDate').value = addMonthsClamped(todayLocalISO(), 1);
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
