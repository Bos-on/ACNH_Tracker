import { DATA_MAP } from './data.js';
import { TAB_DEFINITIONS, TABS, monthsForHemisphere } from './schema.js';
import { confirmDialog, escapeHtml, showToast } from './ui.js';
import {
  applyFilters,
  createSafeStorage,
  getCollectionAccess,
  getFilterOptions,
  getStorageModeNotice,
  getTimeRangeLabel,
  makeFilters,
  normalizeCollected,
  normalizeUIState,
  parseBackup,
  serializeBackup,
  setCollectedForIds,
  undoCollectedChanges,
  validateImportFileSize
} from './core.js';

const TAB_NAMES = Object.fromEntries(TABS.map(tab => [tab, TAB_DEFINITIONS[tab].label]));

const CONFIG = {
  STORAGE_KEYS: { collected: 'acnh_collected', hemisphere: 'acnh_hemisphere', ui: 'acnh_ui' },
  TICK_MS: 60000,
  MONTHS: 12,
  HOURS: 24,
  TABS,
  SORT_KEYS: [{key:'name',label:'名称'},{key:'price',label:'价格'},{key:'collected',label:'收集'}],
  STATUS_OPTS: [['all','全部'],['uncollected','未收集'],['collected','已收集']]
};

let storageAccessError = null;
let collectionLoadFailed = false;
let nativeStorage;
try {
  nativeStorage = window.localStorage;
} catch (error) {
  storageAccessError = error;
  nativeStorage = {
    getItem() { throw error; },
    setItem() { throw error; }
  };
}
const storage = createSafeStorage(nativeStorage);

function toggleArrayFilter(name, value){
  const arr = state.filters[state.activeTab][name];
  const idx = arr.indexOf(value);
  idx >= 0 ? arr.splice(idx,1) : arr.push(value);
}

// Shared by the today panel's per-render buttons and the filter bar's
// delegated listener. renderAll() covers every surface that shows hemisphere
// state; the applyFilters recount is just for the toast.
function handleHemisphereChange(hemi){
  if (state.hemisphere === hemi) return;
  const focusRoot = document.activeElement?.closest('#todayPanel')
    ? '#todayPanel'
    : document.activeElement?.closest('#filterBar') ? '#filterBar' : null;
  if (!saveHemisphere(hemi)) return;
  state.hemisphere = hemi;
  renderAll();
  if (focusRoot) document.querySelector(focusRoot+' [data-hemi="'+hemi+'"]')?.focus();
  const remaining = filteredItems(state.activeTab).length;
  const label = state.hemisphere === 'north' ? '北半球' : '南半球';
  showToast(remaining === 0
    ? '已切换到' + label + '，当前筛选条件下没有匹配的生物，可尝试重置筛选'
    : '已切换到' + label + '，当前筛选命中 ' + remaining + ' 条');
}

function hemisphereButtons(activeClass){
  return '<button type="button" class="'+activeClass+(state.hemisphere==='north'?' active':'')+'" data-hemi="north" aria-pressed="'+(state.hemisphere==='north')+'">北半球</button>'
       + '<button type="button" class="'+activeClass+(state.hemisphere==='south'?' active':'')+'" data-hemi="south" aria-pressed="'+(state.hemisphere==='south')+'">南半球</button>';
}

// The today panel re-renders on an hourly cadence, so its hemisphere buttons
// are (re)bound per render; filter-bar hemisphere clicks go through the
// delegated #filterBar listener instead. Both funnel into
// handleHemisphereChange.
function bindHemisphereButtons(root){
  root.querySelectorAll('[data-hemi]').forEach(btn=>{
    btn.addEventListener('click', ()=>handleHemisphereChange(btn.dataset.hemi));
  });
}

// A flat view over all three datasets, tagged with its source tab. The tag
// lives in a wrapper rather than being assigned onto the creature itself:
// mutating the objects in DATA_MAP would make data.js's shape depend on
// app.js having run, which leaks into anything else reading that data.
const ALL_DATA = CONFIG.TABS.flatMap(type => DATA_MAP[type].map(item => ({ type, item })));

// Collected ids are only meaningful if they match a real creature: imports
// are validated against this set so junk ids can't squat in storage forever.
const KNOWN_IDS = new Set(ALL_DATA.map(x => x.item.id));

function loadUIState() {
  const result = storage.getItem(CONFIG.STORAGE_KEYS.ui);
  if (!result.ok) storageAccessError ||= result.error;
  let saved = null;
  try { saved = result.value ? JSON.parse(result.value) : null; } catch {}
  return normalizeUIState(saved, DATA_MAP, getLocalTime());
}

function loadHemisphere() {
  const result = storage.getItem(CONFIG.STORAGE_KEYS.hemisphere);
  if (!result.ok) storageAccessError ||= result.error;
  return result.value === 'south' ? 'south' : 'north';
}

const state = {
  ...loadUIState(),
  hemisphere: loadHemisphere(),
  collected: loadCollected(),
};

function saveUIState() {
  const result = storage.setItem(CONFIG.STORAGE_KEYS.ui, JSON.stringify({
    activeTab: state.activeTab,
    filters: state.filters,
    sort: state.sort,
    todayOpen: state.todayOpen,
    filterOpen: state.filterOpen,
    todayUncollectedOnly: state.todayUncollectedOnly,
    todayGroups: state.todayGroups
  }));
  if (!result.ok) showStorageWarning();
  return result.ok;
}

function loadCollected() {
  const result = storage.getItem(CONFIG.STORAGE_KEYS.collected);
  let readError = result.ok ? null : result.error;
  if (result.value) {
    try {
      const parsed = JSON.parse(result.value);
      if (!Array.isArray(parsed)) throw new Error('invalid collection shape');
      return normalizeCollected(parsed, KNOWN_IDS);
    } catch {
      readError = new Error('浏览器中的收集记录格式损坏');
    }
  }
  // Migrate from the legacy cookie (one-time), then clear it.
  let legacyCookie = '';
  try { legacyCookie = document.cookie; } catch {}
  const m = legacyCookie.split(';').find(c => c.trim().startsWith('acnh_collected='));
  if (m) {
    try {
      const arr = JSON.parse(decodeURIComponent(m.split('=').slice(1).join('=')));
      const set = normalizeCollected(arr, KNOWN_IDS);
      const saved = storage.setItem(CONFIG.STORAGE_KEYS.collected, JSON.stringify([...set]));
      if (saved.ok) {
        document.cookie = 'acnh_collected=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax';
      } else {
        storageAccessError ||= saved.error;
      }
      return set;
    } catch {}
  }
  if (readError) {
    collectionLoadFailed = true;
    storageAccessError ||= readError;
  }
  return new Set();
}

function saveCollected(next) {
  return storage.setItem(CONFIG.STORAGE_KEYS.collected, JSON.stringify([...next]));
}

function showStorageWarning() {
  showToast('浏览器阻止了本地存储，当前更改无法可靠保存', { duration: 6000 });
}

function showCollectionLoadWarning() {
  showToast('未能加载已有收集记录，已暂停导出和修改；可导入有效备份恢复', { duration: 8000 });
}

function renderCollectionViews() {
  renderProgress();
  renderTodayPanel();
  renderList();
}

function commitCollected(next, options = {}) {
  if (!getCollectionAccess(collectionLoadFailed).canEdit && !options.allowRecovery) {
    showCollectionLoadWarning();
    return false;
  }
  const result = saveCollected(next);
  if (!result.ok) {
    showStorageWarning();
    return false;
  }
  const recovered = collectionLoadFailed;
  collectionLoadFailed = false;
  state.collected = next;
  renderCollectionViews();
  if (recovered) renderDataBar();
  return true;
}

function exportCollected() {
  if (!getCollectionAccess(collectionLoadFailed).canExport) {
    showCollectionLoadWarning();
    return;
  }
  const blob = new Blob([serializeBackup(state.collected)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  // Date-stamped so consecutive backups stay distinguishable in Downloads.
  const now = getLocalTime();
  const pad = n => String(n).padStart(2, '0');
  a.download = 'acnh-collected-' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '.json';
  a.href = url;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let importInProgress = false;
function importCollected(e) {
  const input = e.target;
  const file = input.files[0];
  if (!file || importInProgress) return;
  try {
    validateImportFileSize(file.size);
  } catch (error) {
    showToast('导入失败：' + error.message);
    input.value = '';
    return;
  }
  importInProgress = true;
  document.getElementById('importBtn').disabled = true;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const { collected: incoming, dropped } = parseBackup(reader.result, KNOWN_IDS);
      if (state.collected.size > 0) {
        const ok = await confirmDialog('导入将覆盖当前的 ' + state.collected.size + ' 条记录，是否继续？', '覆盖导入');
        if (!ok) return;
      }
      if (commitCollected(incoming, { allowRecovery: true })) {
        showToast('导入成功，共 ' + incoming.size + ' 条记录' + (dropped > 0 ? '（已忽略 ' + dropped + ' 条无法识别的记录）' : ''));
      }
    } catch (err) {
      showToast('导入失败：' + err.message);
    } finally {
      importInProgress = false;
      document.getElementById('importBtn').disabled = false;
      input.value = '';
    }
  };
  reader.onerror = () => {
    showToast('导入失败：无法读取文件');
    importInProgress = false;
    document.getElementById('importBtn').disabled = false;
    input.value = '';
  };
  reader.readAsText(file);
}

function saveHemisphere(next) {
  const result = storage.setItem(CONFIG.STORAGE_KEYS.hemisphere, next);
  if (!result.ok) showStorageWarning();
  return result.ok;
}

function getLocalTime() { return new Date(); }

function isAvailableNow(item) {
  const now = getLocalTime();
  const month = now.getMonth() + 1;
  const hour = now.getHours();
  const months = monthsForHemisphere(item, state.hemisphere);
  return months.includes(month) && item.hours.includes(hour);
}

// Hours arrive sorted 0..23, so a window spanning midnight shows up as two
// separate runs (e.g. [0..4, 21..23]). Splitting them into "0-4时 / 21-23时"
// misreads as two windows, so the head and tail runs are merged back into the
// single wrapping range they represent: "21-4时".
function filteredItems(tab) {
  return applyFilters(DATA_MAP[tab], {
    filters: state.filters[tab],
    hemisphere: state.hemisphere,
    collected: state.collected,
    sort: state.sort
  });
}

function renderNavTabs() {
  document.getElementById('navTabs').innerHTML = CONFIG.TABS.map(t =>
    '<button type="button" class="nav-tab' + (state.activeTab===t?' active':'') + '" data-tab="'+t+'" aria-pressed="'+(state.activeTab===t)+'">' + TAB_NAMES[t] + '</button>'
  ).join('');
}

function renderProgress() {
  const data = DATA_MAP[state.activeTab];
  const total = data.length;
  const collected = data.filter(x => state.collected.has(x.id)).length;
  const pct = total > 0 ? (collected/total*100).toFixed(1) : 0;
  const allTotal = ALL_DATA.length;
  const allCollected = ALL_DATA.filter(x => state.collected.has(x.item.id)).length;
  const allPct = allTotal > 0 ? (allCollected/allTotal*100).toFixed(1) : 0;
  document.getElementById('progressSection').innerHTML =
    '<div class="progress-text"><span class="progress-label">'+TAB_NAMES[state.activeTab]+' 收集进度</span><span class="progress-pct">已收集 '+collected+' / '+total+' （'+pct+'%）</span></div>' +
    '<div class="progress-bar" role="progressbar" aria-label="'+TAB_NAMES[state.activeTab]+'收集进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct+'"><div class="progress-fill" style="width:'+pct+'%"></div></div>' +
    '<div class="progress-text" style="margin-top:14px"><span class="progress-label" style="font-size:13px">总进度</span><span style="font-size:15px;font-weight:700;color:var(--color-primary-dark)">已收集 '+allCollected+' / '+allTotal+' （'+allPct+'%）</span></div>' +
    '<div class="progress-bar" role="progressbar" aria-label="总收集进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+allPct+'"><div class="progress-fill" style="width:'+allPct+'%"></div></div>';
}

function renderTodayPanel() {
  const now = getLocalTime();
  const hour = now.getHours();
  const monStr = now.getFullYear()+'年'+(now.getMonth()+1)+'月'+now.getDate()+'日';

  let nowAvailable = ALL_DATA.filter(x => isAvailableNow(x.item));
  if (state.todayUncollectedOnly) {
    nowAvailable = nowAvailable.filter(x => !state.collected.has(x.item.id));
  }
  const byType = Object.fromEntries(CONFIG.TABS.map(type => [
    type,
    nowAvailable.filter(entry => entry.type === type)
  ]));

  function todayRow(item, tags){
    const timeLabel = getTimeRangeLabel(item.hours);
    const note = item.note ? '<span class="note">'+escapeHtml(item.note)+'</span>' : '';
    return '<div class="today-item"><span style="font-weight:600;min-width:80px">'
      + escapeHtml(item.name) + '</span>' + tags + note
      + '<span style="font-size:12px;color:var(--color-text-muted)">' + timeLabel + '</span>'
      + '<span style="color:var(--color-accent-warm);font-weight:600;margin-left:auto">'
      + item.price + ' 铃钱</span></div>';
  }

  let html = '<button type="button" class="today-header'+(state.todayOpen?' open':'')+'" id="todayHeader" aria-expanded="'+state.todayOpen+'" aria-controls="todayBody"><span class="today-heading"><span class="arrow" aria-hidden="true">▶</span> 今日可捕捉 （'+monStr+' '+hour+'时）</span><span class="today-count">'+nowAvailable.length+' 种生物可捕捉</span></button>';
  html += '<div class="today-body'+(state.todayOpen?' open':'')+'" id="todayBody"'+(state.todayOpen?'':' hidden')+'>';
  html += '<div class="today-info"><span>当前半球：</span>'+hemisphereButtons('hemi-btn')
    + '<label class="today-toggle"><input type="checkbox" id="todayUncollected"'+(state.todayUncollectedOnly?' checked':'')+'>只看未收集</label></div>';

  for (const t of CONFIG.TABS) {
    const items = byType[t];
    const open = state.todayGroups[t];
    html += '<h4><button type="button" class="today-group-header'+(open?' open':'')+'" data-group="'+t+'" aria-expanded="'+open+'" aria-controls="todayGroup-'+t+'"><span class="arrow" aria-hidden="true">▶</span> '+TAB_NAMES[t]+' （'+items.length+'）</button></h4>';
    html += '<div class="today-group-body'+(open?' open':'')+'" id="todayGroup-'+t+'"'+(open?'':' hidden')+'>';
    if (items.length === 0) {
      html += '<div class="today-item" style="color:var(--color-text-muted)">当前时间没有可捕捉的'+TAB_NAMES[t]+'</div>';
    } else {
      items.forEach(({ item }) => {
        let tags = '';
        if (t !== 'sea') tags += '<span class="tag tag-location">'+escapeHtml(item.location)+'</span>';
        if (item.shadowSize) tags += '<span class="tag tag-shadow">'+escapeHtml(item.shadowSize)+'</span>';
        if (item.weather && item.weather !== '无限制') {
          tags += '<span class="tag tag-weather">'+escapeHtml(item.weather)+'</span>';
        }
        html += todayRow(item, tags);
      });
    }
    html += '</div>';
  }
  html += '</div>';

  document.getElementById('todayPanel').innerHTML = html;

  document.getElementById('todayHeader').addEventListener('click', () => {
    state.todayOpen = !state.todayOpen;
    saveUIState();
    renderTodayPanel();
    document.getElementById('todayHeader').focus();
  });
  document.getElementById('todayUncollected').addEventListener('change', e => {
    state.todayUncollectedOnly = e.target.checked;
    saveUIState();
    renderTodayPanel();
    document.getElementById('todayUncollected').focus();
  });
  // Group headers toggle in place (no full re-render); state.todayGroups
  // keeps the choice in sync for the next scheduled panel refresh.
  document.querySelectorAll('#todayPanel .today-group-header').forEach(h => {
    h.addEventListener('click', () => {
      const g = h.dataset.group;
      state.todayGroups[g] = !state.todayGroups[g];
      h.classList.toggle('open', state.todayGroups[g]);
      h.setAttribute('aria-expanded', state.todayGroups[g]);
      const body = document.getElementById('todayGroup-' + g);
      body.classList.toggle('open', state.todayGroups[g]);
      body.hidden = !state.todayGroups[g];
      saveUIState();
    });
  });
  bindHemisphereButtons(document.getElementById('todayPanel'));
}

// No name-search box: deliberate, not an oversight. Search was decided
// against: the filter dimensions (location / shadow / weather / month /
// hour / status) are the intended way to find a creature, and they compose to
// answer the questions this page exists for ("what can I catch right now",
// "what's still missing"). If a future change feels like it needs a search
// box, that decision was made on purpose; don't add one without checking
// with the project owner first.
function renderFilters() {
  const tab = state.activeTab;
  const f = state.filters[tab];
  const definition = TAB_DEFINITIONS[tab];
  const locations = getFilterOptions(DATA_MAP, tab, 'location');
  const shadows = getFilterOptions(DATA_MAP, tab, 'shadowSize');
  const weathers = getFilterOptions(DATA_MAP, tab, 'weather');

  let html = '<button type="button" class="filter-toggle-btn" id="filterToggle" aria-expanded="'+state.filterOpen+'" aria-controls="filterPanel">🔍 筛选条件</button>';
  html += '<div class="filter-panel'+(state.filterOpen?' open':'')+'" id="filterPanel">';

  html += '<div class="filter-row"><span class="filter-label">半球</span><div class="filter-options">';
  html += hemisphereButtons('filter-btn');
  html += '</div></div>';

  html += '<div class="filter-row"><span class="filter-label">收集状态</span><div class="filter-options">';
  for (const [val,label] of CONFIG.STATUS_OPTS) {
    html += '<button type="button" class="filter-btn'+(f.status===val?' active':'')+'" data-filter="status" data-value="'+val+'" aria-pressed="'+(f.status===val)+'">'+label+'</button>';
  }
  html += '</div></div>';

  if (definition.filters.includes('location')) {
    html += '<div class="filter-row"><span class="filter-label">出现场所</span><div class="filter-options">';
    locations.forEach(loc => {
      html += '<button type="button" class="filter-btn'+(f.location.includes(loc)?' active':'')+'" data-filter="location" data-value="'+escapeHtml(loc)+'" aria-pressed="'+f.location.includes(loc)+'">'+escapeHtml(loc)+'</button>';
    });
    html += '</div></div>';
  }

  if (definition.filters.includes('shadowSize')) {
    html += '<div class="filter-row"><span class="filter-label">'+(tab==='sea'?'影子大小':'鱼影尺寸')+'</span><div class="filter-options">';
    shadows.forEach(s => {
      html += '<button type="button" class="filter-btn'+(f.shadowSize.includes(s)?' active':'')+'" data-filter="shadowSize" data-value="'+escapeHtml(s)+'" aria-pressed="'+f.shadowSize.includes(s)+'">'+escapeHtml(s)+'</button>';
    });
    html += '</div></div>';
  }

  if (definition.filters.includes('weather')) {
    html += '<div class="filter-row"><span class="filter-label">天气条件</span><div class="filter-options">';
    weathers.forEach(w => {
      html += '<button type="button" class="filter-btn'+(f.weather.includes(w)?' active':'')+'" data-filter="weather" data-value="'+escapeHtml(w)+'" aria-pressed="'+f.weather.includes(w)+'">'+escapeHtml(w)+'</button>';
    });
    html += '</div></div>';
  }

  html += '<div class="filter-row"><span class="filter-label">出现月份</span><div class="filter-options" id="monthGrid">';
  const curMon = getLocalTime().getMonth() + 1;
  for (let m = 1; m <= CONFIG.MONTHS; m++) {
    html += '<button type="button" class="filter-btn month-grid'+(f.month===m?' active':'')+(m===curMon?' is-now':'')+'" data-filter="month" data-value="'+m+'" aria-pressed="'+(f.month===m)+'">'+m+'</button>';
  }
  html += '</div></div>';

  // The hour row has three non-numeric states, and they are not the same
  // thing: 不限 = no hour filtering at all; 全天出现 = only creatures whose
  // hours cover all 24; and the unmarked default = follow the clock. Hiding
  // "clear" behind a re-tap of the active hour chip (the old behaviour)
  // made none of that discoverable, so 不限 is now an explicit chip.
  html += '<div class="filter-row"><span class="filter-label">出现时间</span><div class="filter-options" id="hourGrid">';
  const curHr = getLocalTime().getHours();
  html += '<button type="button" class="filter-btn'+(f.hour===null?' active':'')+'" data-filter="hour" data-value="none" aria-pressed="'+(f.hour===null)+'">不限</button>';
  html += '<button type="button" class="filter-btn'+(f.hour==='all'?' active':'')+'" data-filter="hour" data-value="all" aria-pressed="'+(f.hour==='all')+'">全天出现</button>';
  for (let h = 0; h < CONFIG.HOURS; h++) {
    html += '<button type="button" class="filter-btn'+(f.hour===h?' active':'')+(h===curHr?' is-now':'')+'" data-filter="hour" data-value="'+h+'" aria-pressed="'+(f.hour===h)+'">'+h+'</button>';
  }
  html += '</div></div>';

  html += '<div class="filter-row"><span style="flex:1"></span>';
  html += '<button type="button" class="filter-reset" id="filterReset">重置全部</button>';
  html += '</div></div>';

  document.getElementById('filterBar').innerHTML = html;
}

// Sync every filter chip's classes against the current state, in place.
// Filter taps and clock changes both land here: a tap only flips chip
// classes (no innerHTML rebuild, so focus and scroll survive), and a clock
// change additionally moves the is-now highlight on the month/hour grids.
function syncFilterChips() {
  const f = state.filters[state.activeTab];
  const curMon = getLocalTime().getMonth() + 1;
  const curHr = getLocalTime().getHours();
  document.querySelectorAll('#filterBar [data-filter]').forEach(btn => {
    const filter = btn.dataset.filter;
    const value = btn.dataset.value;
    let active = false;
    if (filter === 'status') active = f.status === value;
    else if (filter === 'location') active = f.location.includes(value);
    else if (filter === 'shadowSize') active = f.shadowSize.includes(value);
    else if (filter === 'weather') active = f.weather.includes(value);
    else if (filter === 'month') active = f.month === parseInt(value);
    else if (filter === 'hour') {
      active = f.hour === (value === 'all' ? 'all' : value === 'none' ? null : parseInt(value));
    }
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active);
    if (filter === 'month') {
      btn.classList.toggle('is-now', parseInt(value) === curMon);
    } else if (filter === 'hour') {
      btn.classList.toggle('is-now', value !== 'all' && value !== 'none' && parseInt(value) === curHr);
    }
  });
}

// One delegated listener for everything clickable in the filter bar: filter
// chips, hemisphere buttons, the mobile toggle and 重置全部; attached once
// at startup. #filterBar itself is persistent (only its innerHTML is
// re-rendered), so the listener survives re-renders without stacking
// duplicates.
document.getElementById('filterBar').addEventListener('click', e => {
  const hemiBtn = e.target.closest('[data-hemi]');
  if (hemiBtn) return handleHemisphereChange(hemiBtn.dataset.hemi);

  if (e.target.closest('#filterToggle')) {
    state.filterOpen = !state.filterOpen;
    saveUIState();
    const toggle = document.getElementById('filterToggle');
    const panel = document.getElementById('filterPanel');
    toggle.setAttribute('aria-expanded', state.filterOpen);
    panel.classList.toggle('open', state.filterOpen);
    return;
  }

  if (e.target.closest('#filterReset')) {
    // Resetting hands hour control back to the clock, and clears sort too:
    // the button says 重置全部, so leaving sort applied would be a lie.
    state.filters[state.activeTab] = makeFilters(state.activeTab, getLocalTime());
    state.sort = { key: null, dir: 'asc' };
    saveUIState();
    syncFilterChips();
    renderList();
    return;
  }

  const btn = e.target.closest('.filter-btn[data-filter]');
  if (!btn) return;
  const tab = state.activeTab;
  const filter = btn.dataset.filter;
  const value = btn.dataset.value;
  if (filter === 'status') {
    state.filters[tab].status = value;
  } else if (filter === 'location' || filter === 'shadowSize' || filter === 'weather') {
    toggleArrayFilter(filter, value);
  } else if (filter === 'month') {
    state.filters[tab].month = state.filters[tab].month === parseInt(value) ? null : parseInt(value);
  } else if (filter === 'hour') {
    // Any manual hour choice (including 不限 and 全天出现) marks the filter
    // as user-owned so the hourly tick won't clobber it. 不限 is "no hour
    // filter", which is itself a choice, not a request to follow the clock
    // again. Only 重置全部 hands control back to the clock.
    state.filters[tab].hourManual = true;
    if (value === 'none') {
      state.filters[tab].hour = null;
    } else if (value === 'all') {
      state.filters[tab].hour = state.filters[tab].hour === 'all' ? null : 'all';
    } else {
      state.filters[tab].hour = state.filters[tab].hour === parseInt(value) ? null : parseInt(value);
    }
  }
  saveUIState();
  syncFilterChips();
  renderList();
});

// Header and rows live in their own persistent containers so a re-render can
// replace one without destroying the other.
document.getElementById('listSection').innerHTML =
  '<div class="list-header" id="listHeader"></div><div id="listRows"></div>';

// Row elements are cached by creature id and reused across renders. Rebuilding
// #listSection wholesale meant parsing ~69KB of HTML and constructing every
// element again for each filter tap; now a re-render only re-orders nodes that
// already exist. What a row's markup bakes in: the tab, the hemisphere's
// months, the current-month highlight, is tracked in rowCacheSig, and any
// change there invalidates the whole cache.
const rowCache = new Map();
let rowCacheSig = '';
// The bulk buttons act on whatever the last render filtered down to, and they
// are bound once via delegation rather than re-bound per render.
let lastFiltered = [];

function buildRow(item, tab, northern, curMon) {
  let html = '<input class="creature-checkbox sr-only" type="checkbox" data-id="'+item.id+'" aria-label="'+escapeHtml(item.name)+'">'
    + '<span class="check-box" aria-hidden="true"></span><span class="creature-main">';
  html += '<span class="creature-name">'+escapeHtml(item.name)+'</span>';
  // Sea creatures are all 海洋底部: a tag that never varies is pure noise.
  if (tab !== 'sea') {
    html += '<span class="tag tag-location">'+escapeHtml(item.location)+'</span>';
  }
  if (item.shadowSize) {
    html += '<span class="tag tag-shadow">'+escapeHtml(item.shadowSize)+'</span>';
  }
  // Weather is filterable on the bug tab, so it has to be visible on the row:
  // otherwise a user who filters by 雨天 can't tell why a given row matched.
  if (item.weather && item.weather !== '无限制') {
    html += '<span class="tag tag-weather">'+escapeHtml(item.weather)+'</span>';
  }
  html += '<span class="tag-price">'+item.price+' 铃钱</span>';
  // Capture notes are prose, not a filter dimension; rendered as plain text so
  // they read differently from the tags beside them.
  if (item.note) {
    html += '<span class="note">'+escapeHtml(item.note)+'</span>';
  }
  html += '</span><span class="creature-meta"><span class="meta-row"><span class="meta-label">月:</span>';
  const months = monthsForHemisphere(item, northern ? 'north' : 'south');
  for (let m = 1; m <= CONFIG.MONTHS; m++) {
    html += '<span class="heat-cell'+(months.includes(m)?' on':'')+(m===curMon?' current':'')+'">'+m+'</span>';
  }
  // Hour availability as a text range rather than 24 cells per row: the 24-cell
  // grid was ~4800 elements for an 80-row list and dominated both the HTML
  // payload and layout cost.
  html += '</span><span class="meta-row"><span class="meta-label">时:</span><span class="meta-hours">'
    + getTimeRangeLabel(item.hours) + '</span></span></span>';

  const el = document.createElement('label');
  el.className = 'creature-item';
  el.dataset.id = item.id;
  el.innerHTML = html;
  return el;
}

function renderListHeader(count) {
  const editDisabled = getCollectionAccess(collectionLoadFailed).canEdit ? '' : ' disabled';
  let html = '';
  CONFIG.SORT_KEYS.forEach(sk => {
    const arrow = state.sort.key === sk.key ? (state.sort.dir==='asc'?' ▲':' ▼') : '';
    const active = state.sort.key === sk.key;
    const current = active ? '，当前'+(state.sort.dir==='asc'?'升序':'降序') : '';
    html += '<button type="button" class="sort-btn" data-sort="'+sk.key+'" aria-pressed="'+active+'" aria-label="按'+sk.label+'排序'+current+'">'+sk.label+arrow+'</button>';
  });
  html += '<span style="flex:1"></span>';
  html += '<span style="font-size:12px;color:var(--color-text-muted)">共 '+count+' 条</span>';
  html += '<button type="button" class="data-btn" id="markAllVisible" style="margin-left:8px;padding:4px 12px;font-size:12px"'+editDisabled+'>全标</button>';
  html += '<button type="button" class="data-btn" id="unmarkAllVisible" style="padding:4px 12px;font-size:12px"'+editDisabled+'>全取消</button>';
  document.getElementById('listHeader').innerHTML = html;
}

function renderList() {
  const canEdit = getCollectionAccess(collectionLoadFailed).canEdit;
  const focusedId = document.activeElement?.classList.contains('creature-checkbox')
    ? document.activeElement.dataset.id
    : null;
  const focusedSort = document.activeElement?.classList.contains('sort-btn')
    ? document.activeElement.dataset.sort
    : null;
  const tab = state.activeTab;
  const filtered = filteredItems(tab);
  lastFiltered = filtered;
  renderListHeader(filtered.length);

  const rows = document.getElementById('listRows');
  if (filtered.length === 0) {
    rows.innerHTML = '<div class="empty-state">没有符合条件的生物，请调整筛选条件 🔍</div>';
    if (focusedSort) document.querySelector('.sort-btn[data-sort="'+focusedSort+'"]')?.focus();
    return;
  }

  const northern = state.hemisphere === 'north';
  const curMon = getLocalTime().getMonth() + 1;
  const sig = tab + '|' + northern + '|' + curMon;
  if (sig !== rowCacheSig) {
    rowCache.clear();
    rowCacheSig = sig;
  }

  // Appending an existing node to the fragment detaches it from the old list,
  // so reorders and removals fall out of rebuilding this in filtered order.
  const frag = document.createDocumentFragment();
  for (const item of filtered) {
    let el = rowCache.get(item.id);
    if (!el) {
      el = buildRow(item, tab, northern, curMon);
      rowCache.set(item.id, el);
    }
    const collected = state.collected.has(item.id);
    el.classList.toggle('collected', collected);
    const checkbox = el.querySelector('.creature-checkbox');
    checkbox.checked = collected;
    checkbox.disabled = !canEdit;
    frag.appendChild(el);
  }
  rows.replaceChildren(frag);
  if (focusedId) rows.querySelector('.creature-checkbox[data-id="'+focusedId+'"]')?.focus();
  else if (focusedSort) document.querySelector('.sort-btn[data-sort="'+focusedSort+'"]')?.focus();
}

// Bulk actions record only ids whose state actually changed. Undo restores an
// id only while it still has the bulk result, so a later single-row edit wins.
function bulkSetCollected(add) {
  if (lastFiltered.length === 0) return;
  const verb = add ? '标记' : '取消标记';
  const ids = lastFiltered.map(x => x.id);
  const { next, changes } = setCollectedForIds(state.collected, ids, add);
  if (changes.length === 0) {
    showToast(add ? '当前条目均已标记' : '当前条目均未标记');
    return;
  }
  if (!commitCollected(next)) return;
  showToast('已' + verb + ' ' + changes.length + ' 条', {
    duration: 6000,
    action: {
      label: '撤销',
      onClick: () => {
        const undo = undoCollectedChanges(state.collected, changes);
        if (undo.restored > 0 && commitCollected(undo.next)) showToast('已撤销');
        else if (undo.restored === 0) showToast('没有可撤销的条目');
      }
    }
  });
}

// Delegated listener for the bulk buttons, sort headers and creature rows,
// attached once. #listSection is persistent; only its inner containers are
// re-rendered, so this survives re-renders without stacking duplicates.
document.getElementById('listSection').addEventListener('click', e => {
  if (e.target.closest('#markAllVisible')) return bulkSetCollected(true);
  if (e.target.closest('#unmarkAllVisible')) return bulkSetCollected(false);

  const sortEl = e.target.closest('.sort-btn');
  if (sortEl) {
    const key = sortEl.dataset.sort;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sort.key = key;
      state.sort.dir = 'asc';
    }
    saveUIState();
    renderList();
    return;
  }

});

document.getElementById('listSection').addEventListener('change', e => {
  const input = e.target.closest('.creature-checkbox');
  if (!input) return;
  const { next } = setCollectedForIds(state.collected, [input.dataset.id], input.checked);
  if (!commitCollected(next)) input.checked = !input.checked;
});

function renderAll() {
  renderNavTabs();
  renderProgress();
  renderTodayPanel();
  renderFilters();
  renderList();
}

function renderDataBar() {
  const access = getCollectionAccess(collectionLoadFailed);
  const notices = [getStorageModeNotice(window.location.protocol)];
  if (!access.canExport) {
    notices.push('未能加载已有收集记录。为避免生成错误的空备份，导出和修改已暂停；可导入有效备份恢复。');
  }
  const notice = notices.filter(Boolean).join(' ');
  document.getElementById('dataBar').innerHTML =
    (notice ? '<span class="storage-mode-note" id="storageModeNote" role="note">'+escapeHtml(notice)+'</span>' : '') +
    '<button type="button" class="data-btn" id="exportBtn"'+(access.canExport?'':' disabled aria-describedby="storageModeNote"')+'>导出收集记录</button>' +
    '<button type="button" class="data-btn" id="importBtn">导入收集记录</button>' +
    '<input type="file" id="importFile" accept="application/json" aria-label="选择收集记录 JSON 文件" hidden>';
  document.getElementById('exportBtn').addEventListener('click', exportCollected);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', importCollected);
}

document.getElementById('navTabs').addEventListener('click', e => {
  const btn = e.target.closest('.nav-tab');
  if (!btn) return;
  state.activeTab = btn.dataset.tab;
  state.filterOpen = false;
  saveUIState();
  renderAll();
  document.querySelector('.nav-tab[data-tab="'+state.activeTab+'"]').focus();
});

// Everything clock-driven is hour-granular: the today panel filters by hour
// and its header shows no minutes, and the hour filter follows the clock. So
// a minute tick has nothing to update: re-rendering on it only destroyed and
// rebound DOM for an identical result. The stamp also carries the date, so a
// device that sleeps across a whole day (same hour, different day) still
// counts as a change when it wakes.
function clockStamp() {
  const now = getLocalTime();
  return now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate() + 'T' + now.getHours();
}
// Seed from the current clock so the first interval fire is a no-op.
let lastTickStamp = clockStamp();

function onClockChange() {
  const hour = getLocalTime().getHours();
  renderTodayPanel();
  // Follow the clock with the hour filter, but only until the user picks an
  // hour themselves (hourManual; 不限 counts as a pick too). 重置全部 is what
  // hands control back to the clock. Every tab follows, otherwise switching
  // tabs surfaces a stale hour from whenever that tab was last active.
  for (const tab of CONFIG.TABS) {
    if (!state.filters[tab].hourManual) state.filters[tab].hour = hour;
  }
  saveUIState();
  syncFilterChips();
  renderList();
}

setInterval(() => {
  const stamp = clockStamp();
  if (stamp === lastTickStamp) return;
  lastTickStamp = stamp;
  onClockChange();
}, CONFIG.TICK_MS);

// Background tabs get their timers throttled, so the minute tick may fire
// late, or not at all until the tab is visible again. Re-check on visibility
// so the page is correct the moment the user looks at it, not up to a minute
// later.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const stamp = clockStamp();
  if (stamp === lastTickStamp) return;
  lastTickStamp = stamp;
  onClockChange();
});

renderDataBar();
renderAll();
if (collectionLoadFailed) showCollectionLoadWarning();
else if (storageAccessError) showStorageWarning();
