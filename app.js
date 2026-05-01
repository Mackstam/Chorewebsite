const APP_VERSION = 'v1.3.4';

const state = {
  supabase: null,
  user: null,
  household: null,
  members: [],
  chores: [],
  archivedChores: [],
  allChores: [],
  completions: [],
  rewards: [],
  rewardRequests: [],
  currentFilter: 'all',
  currentScheduleDate: todayISO(),
  upcomingDays: 7,
  upcomingType: 'all',
  refreshTimer: null
};

// Optional deploy config.
// Preferred setup: put your Supabase details in config.js and do not replace config.js during future updates.
// The anon/public key is safe to use in browser apps when Row Level Security is enabled. Do NOT use the service_role/secret key.
const DEPLOY_SUPABASE_URL = window.HOMEOPS_CONFIG?.SUPABASE_URL || 'https://ezgyyqcfacfxasjjwsqd.supabase.co';
const DEPLOY_SUPABASE_ANON_KEY = window.HOMEOPS_CONFIG?.SUPABASE_ANON_KEY || '';

const $ = (id) => document.getElementById(id);
function todayISO() { return new Date().toISOString().slice(0, 10); }
const fmtDate = (iso) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No date';
const toast = (msg) => {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2600);
};
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

function updateStickyOffset() {
  const header = document.querySelector('.app-header');
  if (!header) return;
  document.documentElement.style.setProperty('--header-height', Math.ceil(header.getBoundingClientRect().height) + 'px');
}
function initStickyOffset() {
  updateStickyOffset();
  window.addEventListener('resize', updateStickyOffset);
  if (window.ResizeObserver) new ResizeObserver(updateStickyOffset).observe(document.querySelector('.app-header'));
}

const priorityRank = { urgent: 4, high: 3, normal: 2, low: 1 };
const priorityLabel = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };

function frequencyLabel(c) {
  const interval = Number(c.frequency_interval || 1);
  const type = c.frequency_type || 'weekly';
  const singular = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[type] || type;
  const simple = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[type];
  if (interval === 1 && simple) return simple;
  return `Every ${interval} ${singular}${interval === 1 ? '' : 's'}`;
}

function saveLocalConfig(url, key) {
  localStorage.setItem('homeops_supabase_url', url.trim());
  localStorage.setItem('homeops_supabase_key', key.trim());
}
function getLocalConfig() {
  const deployUrl = DEPLOY_SUPABASE_URL && DEPLOY_SUPABASE_URL.startsWith('http') ? DEPLOY_SUPABASE_URL.trim() : '';
  const deployKey = DEPLOY_SUPABASE_ANON_KEY && !DEPLOY_SUPABASE_ANON_KEY.includes('PASTE') ? DEPLOY_SUPABASE_ANON_KEY.trim() : '';
  return {
    url: deployUrl || localStorage.getItem('homeops_supabase_url') || '',
    key: deployKey || localStorage.getItem('homeops_supabase_key') || ''
  };
}
function initSupabase() {
  const { url, key } = getLocalConfig();
  if (!url || !key) return false;
  state.supabase = window.supabase.createClient(url, key);
  return true;
}

async function boot() {
  initStickyOffset();
  bindEvents();
  const hasConfig = initSupabase();
  if (!hasConfig) {
    showOnly('configScreen');
    return;
  }
  const { data } = await state.supabase.auth.getSession();
  state.user = data.session?.user || null;
  if (!state.user) {
    showOnly('authScreen');
    return;
  }
  await loadHouseholdOrSetup();
}

function showOnly(screenId) {
  ['configScreen', 'authScreen', 'householdScreen', 'appScreen'].forEach(hide);
  show(screenId);
  $('signOutBtn').classList.toggle('hidden', !state.user);
}

function bindEvents() {
  $('saveConfigBtn').onclick = async () => {
    saveLocalConfig($('supabaseUrlInput').value, $('supabaseKeyInput').value);
    if (!initSupabase()) return toast('Add both Supabase values first.');
    toast('Connected. Now sign in.');
    showOnly('authScreen');
  };

  $('signInBtn').onclick = async () => {
    const { error, data } = await state.supabase.auth.signInWithPassword({ email: $('emailInput').value.trim(), password: $('passwordInput').value });
    if (error) return toast(error.message);
    state.user = data.user;
    await loadHouseholdOrSetup();
  };

  $('signUpBtn').onclick = async () => {
    const { error, data } = await state.supabase.auth.signUp({ email: $('emailInput').value.trim(), password: $('passwordInput').value });
    if (error) return toast(error.message);
    state.user = data.user;
    toast('Account created. If email confirmation is enabled, confirm your email before signing in.');
    await loadHouseholdOrSetup();
  };

  $('signOutBtn').onclick = async () => {
    await state.supabase.auth.signOut();
    state.user = null;
    showOnly('authScreen');
  };

  $('createHouseholdBtn').onclick = createHousehold;
  $('joinHouseholdBtn').onclick = joinHousehold;
  $('addChoreBtn').onclick = () => openChoreDialog();
  $('quickAddBtn').onclick = () => openChoreDialog();
  $('choreForm').onsubmit = saveChore;
  $('rewardForm').onsubmit = saveReward;
  $('addRewardBtn').onclick = () => openRewardDialog();
  $('closeChoreDialogBtn').onclick = () => $('choreDialog').close();
  $('cancelChoreBtn').onclick = () => $('choreDialog').close();
  $('closeRewardDialogBtn').onclick = () => $('rewardDialog').close();
  $('cancelRewardBtn').onclick = () => $('rewardDialog').close();
  $('viewUpcomingBtn').onclick = openUpcomingDialog;
  $('upcomingSummaryCard').onclick = openUpcomingDialog;
  $('closeUpcomingDialogBtn').onclick = () => $('upcomingDialog').close();
  $('upcomingRangeInput').onchange = () => { state.upcomingDays = Number($('upcomingRangeInput').value || 7); renderHome(); };
  $('upcomingTypeInput').onchange = () => { state.upcomingType = $('upcomingTypeInput').value || 'all'; renderHome(); };
  $('refreshCompletedBtn').onclick = async () => { await loadAllData(); toast('Completed tasks refreshed.'); };
  $('timeModeInput').onchange = updateTimeFieldVisibility;
  $('copyInviteBtn').onclick = async () => {
    await navigator.clipboard.writeText(state.household.invite_code);
    toast('Invite code copied.');
  };
  $('exportJsonBtn').onclick = exportJson;
  $('resetConfigBtn').onclick = () => {
    localStorage.removeItem('homeops_supabase_url');
    localStorage.removeItem('homeops_supabase_key');
    location.reload();
  };

  $('scheduleDateInput').value = state.currentScheduleDate;
  $('scheduleDateInput').onchange = () => {
    state.currentScheduleDate = $('scheduleDateInput').value || todayISO();
    renderSchedule();
  };
  $('scheduleTodayBtn').onclick = () => setScheduleDate(todayISO());
  $('prevDayBtn').onclick = () => shiftScheduleDate(-1);
  $('nextDayBtn').onclick = () => shiftScheduleDate(1);

  document.querySelectorAll('.tab').forEach(btn => btn.onclick = () => switchTab(btn.dataset.tab));
  document.querySelectorAll('.filter').forEach(btn => btn.onclick = () => {
    document.querySelectorAll('.filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.currentFilter = btn.dataset.filter;
    renderChores();
  });
}

async function loadHouseholdOrSetup() {
  showOnly('householdScreen');
  const { data: memberRow, error } = await state.supabase
    .from('household_members')
    .select('*')
    .eq('user_id', state.user.id)
    .limit(1)
    .maybeSingle();
  if (error) return toast(error.message);
  if (!memberRow) return;

  const { data: household, error: householdError } = await state.supabase
    .from('households')
    .select('*')
    .eq('id', memberRow.household_id)
    .single();
  if (householdError) return toast(householdError.message);

  state.household = household;
  await loadAllData();
  showOnly('appScreen');
  startAutoRefresh();
}

function makeInviteCode() {
  return `HOME-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function createHousehold() {
  const displayName = $('displayNameInput').value.trim() || state.user.email.split('@')[0];
  const name = $('newHouseholdNameInput').value.trim() || 'Our Home';
  const invite_code = makeInviteCode();
  const { data: household, error: hError } = await state.supabase
    .from('households')
    .insert({ name, invite_code, created_by: state.user.id })
    .select()
    .single();
  if (hError) return toast(hError.message);
  const { error: mError } = await state.supabase
    .from('household_members')
    .insert({ household_id: household.id, user_id: state.user.id, display_name: displayName, role: 'owner' });
  if (mError) return toast(mError.message);
  state.household = household;
  await seedStarterChores();
  await loadAllData();
  showOnly('appScreen');
  startAutoRefresh();
}

async function joinHousehold() {
  const code = $('inviteCodeInput').value.trim().toUpperCase();
  const displayName = $('displayNameInput').value.trim() || state.user.email.split('@')[0];
  const { data: household, error } = await state.supabase.rpc('join_household_by_invite', {
    invite: code,
    display_name: displayName
  });
  if (error || !household) return toast(error?.message || 'Invite code not found.');
  state.household = household;
  await loadAllData();
  showOnly('appScreen');
  startAutoRefresh();
}

async function seedStarterChores() {
  const starter = [
    ['Dishes', 'Daily', 'daily', 1, 'fixed', 1, 'normal', '18:00'],
    ['Wipe kitchen counters', 'Daily', 'daily', 1, 'fixed', 1, 'normal', '19:00'],
    ['Scoop litter', 'Pet Care', 'daily', 1, 'fixed', 2, 'high', '20:00'],
    ['Vacuum main floor', 'Weekly', 'weekly', 1, 'fixed', 3, 'normal', null],
    ['Clean bathrooms', 'Bathroom', 'weekly', 1, 'fixed', 5, 'high', null],
    ['Wash bedding', 'Monthly', 'weekly', 2, 'rolling', 4, 'normal', null],
    ['Clean microwave', 'Kitchen', 'monthly', 1, 'rolling', 3, 'low', null],
    ['Change furnace filter', 'Maintenance', 'monthly', 3, 'rolling', 4, 'high', null],
    ['Test smoke detectors', 'Maintenance', 'monthly', 6, 'rolling', 3, 'high', null]
  ];
  await state.supabase.from('chores').insert(starter.map(([title, category, frequency_type, frequency_interval, recurrence_mode, weight, priority, start_time]) => ({
    household_id: state.household.id,
    title,
    category,
    assigned_to: 'Anyone',
    frequency_type,
    frequency_interval,
    recurrence_mode,
    next_due_date: todayISO(),
    weight,
    priority,
    time_mode: start_time ? 'exact' : 'anytime',
    start_time,
    end_time: null,
    notes: '',
    active: true
  })));
}

function anyDialogOpen() {
  return Array.from(document.querySelectorAll('dialog')).some(d => d.open);
}

function startAutoRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setInterval(() => {
    if (!state.household || document.visibilityState !== 'visible' || anyDialogOpen()) return;
    loadAllData();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.household && !anyDialogOpen()) loadAllData();
  });
}

async function loadAllData() {
  // Load in order so the app does not depend on Supabase/PostgREST relationship schema-cache joins.
  await loadMembers();
  await loadChores();
  await loadCompletions();
  await loadRewards();
  await loadRewardRequests();
  $('householdName').textContent = state.household.name;
  const versionEl = $('appVersion');
  if (versionEl) versionEl.textContent = APP_VERSION;
  $('inviteCodeDisplay').textContent = `Invite code: ${state.household.invite_code}`;
  fillAssignedOptions();
  renderAll();
}

async function loadMembers() {
  const { data, error } = await state.supabase.from('household_members').select('*').eq('household_id', state.household.id).order('created_at');
  if (error) return toast(error.message);
  state.members = data || [];
}
async function loadChores() {
  const { data, error } = await state.supabase
    .from('chores')
    .select('*')
    .eq('household_id', state.household.id)
    .order('next_due_date');
  if (error) return toast(error.message);
  state.allChores = data || [];
  state.chores = state.allChores.filter(c => c.active !== false).sort(compareChores);
  state.archivedChores = state.allChores.filter(c => c.active === false).sort(compareChores);
}
async function loadCompletions() {
  const { data, error } = await state.supabase
    .from('chore_completions')
    .select('*')
    .eq('household_id', state.household.id)
    .order('completed_at', { ascending: false })
    .limit(250);
  if (error) return toast(error.message);
  state.completions = data || [];
}


async function loadRewards() {
  const { data, error } = await state.supabase
    .from('rewards')
    .select('*')
    .eq('household_id', state.household.id)
    .eq('active', true)
    .order('cost', { ascending: true });
  if (error) return toast(error.message);
  state.rewards = data || [];
}

async function loadRewardRequests() {
  const { data, error } = await state.supabase
    .from('reward_requests')
    .select('*')
    .eq('household_id', state.household.id)
    .order('requested_at', { ascending: false })
    .limit(80);
  if (error) return toast(error.message);
  state.rewardRequests = data || [];
}

function fillAssignedOptions() {
  const select = $('assignedToInput');
  select.innerHTML = '';
  ['Anyone', 'Both', 'Rotating'].forEach(v => select.append(new Option(v, v)));
  state.members.forEach(m => select.append(new Option(m.display_name, m.user_id)));
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['home', 'schedule', 'chores', 'people', 'rewards', 'completed', 'settings'].forEach(t => $(`${t}Tab`).classList.toggle('hidden', t !== tab));
  if (tab === 'schedule') renderSchedule();
  if (tab === 'rewards') renderRewards();
  if (tab === 'completed') renderCompleted();
  if (tab === 'settings') renderArchivedChores();
}

function renderAll() {
  renderHome();
  renderSchedule();
  renderChores();
  renderPeople();
  renderRewards();
  renderCompleted();
  renderArchivedChores();
}

function dueStatus(chore) {
  const today = todayISO();
  if (chore.next_due_date < today) return 'overdue';
  if (chore.next_due_date === today) return 'today';
  return 'upcoming';
}
function assignedName(value) {
  if (!value || ['Anyone', 'Both', 'Rotating'].includes(value)) return value || 'Anyone';
  return state.members.find(m => m.user_id === value)?.display_name || 'Unknown';
}

function memberName(userId) {
  return state.members.find(m => m.user_id === userId)?.display_name || 'Unknown';
}
function choreLookup(id) {
  return state.allChores.find(c => c.id === id) || state.chores.find(c => c.id === id) || state.archivedChores.find(c => c.id === id) || null;
}
function completionTitle(c) {
  return c.chores?.title || choreLookup(c.chore_id)?.title || 'Deleted chore';
}
function completionWeight(c) {
  return Number(c.points_awarded ?? c.chores?.weight ?? choreLookup(c.chore_id)?.weight ?? 0);
}
function categoryIcon(category) {
  const icons = {
    'Daily': '✨', 'Weekly': '🧹', 'Monthly': '🗓️', 'Maintenance': '🛠️',
    'Pet Care': '🐾', 'Kitchen': '🍽️', 'Bathroom': '🛁', 'Outdoor': '🌿',
    'Laundry': '🧺', 'Bedroom': '🛏️', 'General': '🏡'
  };
  return icons[category] || '🏡';
}
function pointBalances() {
  const balances = Object.fromEntries(state.members.map(m => [m.user_id, { name: m.display_name, earned: 0, spent: 0, balance: 0 }]));
  state.completions.forEach(c => {
    if (!balances[c.completed_by]) return;
    balances[c.completed_by].earned += completionWeight(c);
  });
  state.rewardRequests.filter(r => r.status === 'fulfilled').forEach(r => {
    if (!balances[r.requested_by]) return;
    balances[r.requested_by].spent += r.reward_cost || 0;
  });
  Object.values(balances).forEach(b => b.balance = b.earned - b.spent);
  return balances;
}
function weekStartISO() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().slice(0, 10);
}
function compareChores(a, b) {
  const dateCompare = String(a.next_due_date).localeCompare(String(b.next_due_date));
  if (dateCompare !== 0) return dateCompare;
  const aAny = !a.start_time || (a.time_mode || 'anytime') === 'anytime';
  const bAny = !b.start_time || (b.time_mode || 'anytime') === 'anytime';
  if (aAny !== bAny) return aAny ? 1 : -1;
  const timeCompare = String(a.start_time || '99:99').localeCompare(String(b.start_time || '99:99'));
  if (timeCompare !== 0) return timeCompare;
  return (priorityRank[b.priority || 'normal'] || 2) - (priorityRank[a.priority || 'normal'] || 2);
}
function formatTime(time) {
  if (!time) return '';
  const [h, m] = String(time).split(':');
  const d = new Date();
  d.setHours(Number(h), Number(m || 0), 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function scheduleLabel(c) {
  const mode = c.time_mode || 'anytime';
  if (mode === 'exact' && c.start_time) return formatTime(c.start_time);
  if (mode === 'window' && c.start_time && c.end_time) return `${formatTime(c.start_time)}–${formatTime(c.end_time)}`;
  if (mode === 'window' && c.start_time) return `${formatTime(c.start_time)} onward`;
  return 'Anytime';
}
function scheduleGroup(c) {
  if (!c.start_time || (c.time_mode || 'anytime') === 'anytime') return 'Anytime';
  const hour = Number(String(c.start_time).split(':')[0]);
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  if (hour < 21) return 'Evening';
  return 'Night';
}
function shiftScheduleDate(days) {
  const d = new Date(`${state.currentScheduleDate}T12:00:00`);
  d.setDate(d.getDate() + days);
  setScheduleDate(d.toISOString().slice(0, 10));
}
function setScheduleDate(iso) {
  state.currentScheduleDate = iso;
  $('scheduleDateInput').value = iso;
  renderSchedule();
}

function daysBetween(startIso, endIso) {
  const a = new Date(`${startIso}T12:00:00`);
  const b = new Date(`${endIso}T12:00:00`);
  return Math.round((b - a) / 86400000);
}
function monthsBetween(startIso, endIso) {
  const a = new Date(`${startIso}T12:00:00`);
  const b = new Date(`${endIso}T12:00:00`);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}
function occursOnDate(c, dateIso) {
  if (!c.next_due_date || dateIso < c.next_due_date) return false;
  const interval = Math.max(1, Number(c.frequency_interval || 1));
  const type = c.frequency_type || 'weekly';
  if (dateIso === c.next_due_date) return true;
  if (type === 'daily') return daysBetween(c.next_due_date, dateIso) % interval === 0;
  if (type === 'weekly') return daysBetween(c.next_due_date, dateIso) % (interval * 7) === 0;
  if (type === 'monthly') {
    const a = new Date(`${c.next_due_date}T12:00:00`);
    const b = new Date(`${dateIso}T12:00:00`);
    return a.getDate() === b.getDate() && monthsBetween(c.next_due_date, dateIso) % interval === 0;
  }
  if (type === 'yearly') {
    const a = new Date(`${c.next_due_date}T12:00:00`);
    const b = new Date(`${dateIso}T12:00:00`);
    const years = b.getFullYear() - a.getFullYear();
    return a.getMonth() === b.getMonth() && a.getDate() === b.getDate() && years % interval === 0;
  }
  return false;
}
function upcomingTypeMatches(chore, type) {
  if (!type || type === 'all') return true;
  if (type === 'maintenance') return String(chore.category || '').toLowerCase() === 'maintenance';
  return String(chore.frequency_type || '').toLowerCase() === type;
}

function upcomingOccurrences(days = 7, limit = 5, type = 'all') {
  const rows = [];
  const start = new Date(`${todayISO()}T12:00:00`);
  const seen = new Set();
  for (let i = 1; i <= days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    state.chores.forEach(chore => {
      if (seen.has(chore.id)) return;
      if (!upcomingTypeMatches(chore, type)) return;
      if (occursOnDate(chore, iso)) {
        rows.push({ chore, date: iso });
        seen.add(chore.id);
      }
    });
  }
  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || compareChores(a.chore, b.chore)).slice(0, limit);
}

function renderHome() {
  const sorted = [...state.chores].sort(compareChores);
  const due = sorted.filter(c => c.next_due_date <= todayISO());
  const days = Number($('upcomingRangeInput')?.value || state.upcomingDays || 7);
  const type = $('upcomingTypeInput')?.value || state.upcomingType || 'all';
  state.upcomingDays = days;
  state.upcomingType = type;
  const allUpcoming = upcomingOccurrences(days, 999, type);
  const upcoming = allUpcoming.slice(0, 5);
  const overdue = sorted.filter(c => c.next_due_date < todayISO());
  const completedToday = state.completions.filter(c => String(c.completed_at).slice(0,10) === todayISO()).slice(0, 5);
  $('todayCount').textContent = state.chores.filter(c => occursOnDate(c, todayISO())).length;
  $('overdueCount').textContent = overdue.length;
  $('upcomingCount').textContent = allUpcoming.length;
  $('weekPoints').textContent = state.completions.filter(c => c.completed_at.slice(0,10) >= weekStartISO()).reduce((sum, c) => sum + completionWeight(c), 0);
  $('dueNowList').innerHTML = due.length ? due.map(c => choreCard(c)).join('') : empty('Nothing due right now.');
  $('completedTodayList').innerHTML = completedToday.length ? completedToday.map(completionCard).join('') : empty('No completed chores yet today.');
  $('upcomingList').innerHTML = upcoming.length ? upcoming.map(row => choreCard(row.chore, { occurrenceDate: row.date, showActions: false })).join('') : empty('No upcoming chores in the selected ' + (days === 1 ? 'day' : days + ' days') + '.');
}

function openUpcomingDialog() {
  const days = Number($('upcomingRangeInput')?.value || state.upcomingDays || 7);
  const type = $('upcomingTypeInput')?.value || state.upcomingType || 'all';
  const rows = upcomingOccurrences(days, 999, type);
  $('upcomingDialogList').innerHTML = rows.length ? rows.map(row => choreCard(row.chore, { occurrenceDate: row.date, showActions: false })).join('') : empty('No upcoming chores for that selection.');
  $('upcomingDialog').showModal();
}
window.openUpcomingDialog = openUpcomingDialog;

function renderSchedule() {
  if (!$('scheduleList')) return;
  $('scheduleDateInput').value = state.currentScheduleDate;
  const chores = state.chores.filter(c => occursOnDate(c, state.currentScheduleDate)).sort(compareChores);
  if (!chores.length) {
    $('scheduleList').innerHTML = empty(`No chores scheduled for ${fmtDate(state.currentScheduleDate)}.`);
    return;
  }
  const groups = ['Morning', 'Afternoon', 'Evening', 'Night', 'Anytime'];
  $('scheduleList').innerHTML = groups.map(group => {
    const groupChores = chores.filter(c => scheduleGroup(c) === group);
    if (!groupChores.length) return '';
    return `<div class="schedule-group"><h3>${group}</h3>${groupChores.map(scheduleRow).join('')}</div>`;
  }).join('');
}

function scheduleRow(c) {
  return `
    <div class="schedule-row item">
      <div class="time-chip">${escapeHtml(scheduleLabel(c))}</div>
      <div class="schedule-row-main">
        ${choreCard(c, { occurrenceDate: state.currentScheduleDate, showActions: state.currentScheduleDate <= todayISO() })}
      </div>
    </div>
  `;
}

function renderChores() {
  let chores = [...state.chores].sort(compareChores);
  if (state.currentFilter !== 'all') chores = chores.filter(c => c.category === state.currentFilter);
  $('choreList').innerHTML = chores.length ? chores.map(choreCard).join('') : empty('No chores found.');
}

function renderPeople() {
  const start = weekStartISO();
  const byUser = Object.fromEntries(state.members.map(m => [m.user_id, { name: m.display_name, points: 0, count: 0 }]));
  state.completions.filter(c => c.completed_at.slice(0,10) >= start).forEach(c => {
    if (!byUser[c.completed_by]) return;
    byUser[c.completed_by].points += completionWeight(c);
    byUser[c.completed_by].count += 1;
  });
  $('peopleList').innerHTML = Object.values(byUser).map(p => `
    <div class="item"><div class="item-top"><div><h3>${escapeHtml(p.name)}</h3><p class="muted">${p.count} completions this week</p></div><strong>${p.points} pts</strong></div></div>
  `).join('') || empty('No household members yet.');
  $('completionList').innerHTML = state.completions.length ? state.completions.slice(0, 12).map(completionCard).join('') : empty('No completions yet.');
}

function renderCompleted() {
  const el = $('completedTaskList');
  if (!el) return;
  el.innerHTML = state.completions.length ? state.completions.map(completionCard).join('') : empty('No completed tasks yet.');
}

function completionCard(c) {
  const completedDate = String(c.completed_at).slice(0, 10);
  const completedTime = new Date(c.completed_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `
    <div class="item"><div class="item-top"><div><h3>${escapeHtml(completionTitle(c))}</h3><p class="muted">Completed by ${escapeHtml(memberName(c.completed_by))} on ${fmtDate(completedDate)} at ${completedTime}</p></div><span class="pill done">${completionWeight(c)} pts</span></div></div>
  `;
}


function renderRewards() {
  if (!$('rewardBalanceList')) return;
  const balances = pointBalances();
  $('rewardBalanceList').innerHTML = Object.entries(balances).map(([userId, b]) => `
    <div class="summary-card reward-balance"><span>${b.balance}</span><small>${escapeHtml(b.name)} available pts</small><p class="small muted">${b.earned} earned · ${b.spent} spent</p></div>
  `).join('') || empty('No people yet.');

  $('rewardShopList').innerHTML = state.rewards.length ? state.rewards.map(rewardCard).join('') : empty('No rewards yet. Add a few rewards to make the points useful.');

  const openRequests = state.rewardRequests.filter(r => ['pending', 'approved'].includes(r.status));
  const history = state.rewardRequests.filter(r => !['pending', 'approved'].includes(r.status));
  $('rewardRequestList').innerHTML = openRequests.length ? openRequests.map(rewardRequestCard).join('') : empty('No open reward requests.');
  $('rewardHistoryList').innerHTML = history.length ? history.slice(0, 12).map(rewardRequestCard).join('') : empty('No reward history yet.');
}

function rewardCard(r) {
  const balances = pointBalances();
  const myBalance = balances[state.user.id]?.balance || 0;
  const canAfford = myBalance >= r.cost;
  return `
    <div class="item reward-card">
      <div class="item-top">
        <div><h3>🎁 ${escapeHtml(r.name)}</h3><p class="muted">${escapeHtml(r.description || 'No description')}</p></div>
        <span class="pill done">${r.cost} pts</span>
      </div>
      <div class="item-actions">
        <button onclick="requestReward('${r.id}')" ${canAfford ? '' : 'disabled'}>${canAfford ? 'Request' : 'Not enough pts'}</button>
        <button class="secondary" onclick="openRewardDialog('${r.id}')">Edit</button>
        <button class="ghost danger" onclick="archiveReward('${r.id}')">Archive</button>
      </div>
    </div>
  `;
}

function rewardRequestCard(r) {
  const statusClass = r.status === 'fulfilled' ? 'done' : r.status === 'declined' || r.status === 'cancelled' ? 'overdue' : 'today';
  return `
    <div class="item reward-request-card">
      <div class="item-top">
        <div>
          <h3>🎀 ${escapeHtml(r.reward_name)}</h3>
          <p class="muted">Requested by ${escapeHtml(memberName(r.requested_by))} on ${fmtDate(String(r.requested_at).slice(0,10))}</p>
        </div>
        <span class="pill ${statusClass}">${escapeHtml(r.status)}</span>
      </div>
      <div class="pills"><span class="pill">${r.reward_cost} pts</span>${r.note ? `<span class="pill">${escapeHtml(r.note)}</span>` : ''}</div>
      <div class="item-actions">
        ${r.status === 'pending' ? `<button class="secondary" onclick="setRewardRequestStatus('${r.id}', 'approved')">Approve</button><button class="ghost danger" onclick="setRewardRequestStatus('${r.id}', 'declined')">Decline</button>` : ''}
        ${['pending', 'approved'].includes(r.status) ? `<button onclick="setRewardRequestStatus('${r.id}', 'fulfilled')">Mark fulfilled</button><button class="secondary" onclick="setRewardRequestStatus('${r.id}', 'cancelled')">Cancel</button>` : ''}
      </div>
    </div>
  `;
}

function choreCard(c, opts = {}) {
  const occurrenceDate = opts.occurrenceDate || c.next_due_date;
  const showActions = opts.showActions !== false;
  const status = occurrenceDate < todayISO() ? 'overdue' : occurrenceDate === todayISO() ? 'today' : 'upcoming';
  const statusText = status === 'overdue' ? `Overdue · due ${fmtDate(occurrenceDate)}` : status === 'today' ? 'Due today' : `Due ${fmtDate(occurrenceDate)}`;
  const priority = c.priority || 'normal';
  const claimedText = c.claimed_by ? `${escapeHtml(memberName(c.claimed_by))} plans to do this` : 'Nobody has claimed this yet';
  const icon = categoryIcon(c.category);
  const futureNote = !showActions ? `<p class="small muted">Preview of this recurring chore. Actions are available when it is due.</p>` : '';
  return `
    <div class="item chore-card">
      <div class="item-top">
        <div>
          <h3><span class="category-icon">${icon}</span> ${escapeHtml(c.title)}</h3>
          <p class="muted">Assigned: ${escapeHtml(assignedName(c.assigned_to))} · ${escapeHtml(frequencyLabel(c))}</p>
        </div>
        <span class="pill ${status}">${statusText}</span>
      </div>
      <div class="claim-line ${c.claimed_by ? 'claimed' : ''}">${claimedText}</div>
      <div class="pills">
        <span class="pill priority-${priority}">${escapeHtml(priorityLabel[priority] || 'Normal')}</span>
        <span class="pill">${escapeHtml(scheduleLabel(c))}</span>
        <span class="pill">${escapeHtml(c.category)}</span>
        <span class="pill">${c.weight} pts</span>
        <span class="pill">${c.recurrence_mode}</span>
      </div>
      ${c.notes ? `<p class="small muted">${escapeHtml(c.notes)}</p>` : ''}
      ${futureNote}
      <div class="item-actions">
        ${showActions ? (c.claimed_by ? `<button class="secondary" onclick="unclaimChore('${c.id}')">Unclaim</button>` : `<button class="secondary" onclick="claimChore('${c.id}')">I'll do it</button>`) : ''}
        ${showActions ? `<button onclick="completeChore('${c.id}')">Complete</button>` : ''}
        <button class="secondary" onclick="duplicateChore('${c.id}')">Duplicate</button>
        <button class="secondary" onclick="openChoreDialog('${c.id}')">Edit</button>
        <button class="ghost danger" onclick="archiveChore('${c.id}')">Archive</button>
      </div>
    </div>
  `;
}

function archivedChoreCard(c) {
  return `
    <div class="item chore-card archived-card">
      <div class="item-top">
        <div><h3>${categoryIcon(c.category)} ${escapeHtml(c.title)}</h3><p class="muted">${escapeHtml(frequencyLabel(c))} · ${escapeHtml(c.category)} · ${c.weight} pts</p></div>
        <span class="pill">Archived</span>
      </div>
      <div class="item-actions">
        <button onclick="restoreChore('${c.id}')">Restore</button>
        <button class="secondary" onclick="duplicateChore('${c.id}')">Duplicate</button>
        <button class="ghost danger" onclick="deleteChore('${c.id}')">Delete forever</button>
      </div>
    </div>
  `;
}

function renderArchivedChores() {
  const el = $('archivedChoreList');
  if (!el) return;
  el.innerHTML = state.archivedChores.length ? state.archivedChores.map(archivedChoreCard).join('') : empty('No archived chores.');
}


function empty(text) { return `<div class="item"><p class="muted">${text}</p></div>`; }
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

function updateTimeFieldVisibility() {
  const mode = $('timeModeInput').value;
  $('startTimeInput').disabled = mode === 'anytime';
  $('endTimeInput').disabled = mode !== 'window';
  if (mode === 'anytime') {
    $('startTimeInput').value = '';
    $('endTimeInput').value = '';
  }
  if (mode === 'exact') $('endTimeInput').value = '';
}

function openChoreDialog(id = null) {
  const c = id ? choreLookup(id) : null;
  $('choreDialogTitle').textContent = c ? 'Edit chore' : 'Add chore';
  $('choreIdInput').value = c?.id || '';
  $('choreTitleInput').value = c?.title || '';
  $('categoryInput').value = c?.category || 'Daily';
  $('assignedToInput').value = c?.assigned_to || 'Anyone';
  $('frequencyTypeInput').value = c?.frequency_type || 'weekly';
  $('frequencyIntervalInput').value = c?.frequency_interval || 1;
  $('nextDueDateInput').value = c?.next_due_date || todayISO();
  $('recurrenceModeInput').value = c?.recurrence_mode || 'fixed';
  $('priorityInput').value = c?.priority || 'normal';
  $('timeModeInput').value = c?.time_mode || 'anytime';
  $('startTimeInput').value = c?.start_time ? String(c.start_time).slice(0,5) : '';
  $('endTimeInput').value = c?.end_time ? String(c.end_time).slice(0,5) : '';
  $('weightInput').value = c?.weight || 2;
  $('notesInput').value = c?.notes || '';
  updateTimeFieldVisibility();
  $('choreDialog').showModal();
  $('choreDialog').scrollTop = 0;
}
window.openChoreDialog = openChoreDialog;

async function saveChore(e) {
  e.preventDefault();
  const timeMode = $('timeModeInput').value;
  const payload = {
    household_id: state.household.id,
    title: $('choreTitleInput').value.trim(),
    category: $('categoryInput').value,
    assigned_to: $('assignedToInput').value,
    frequency_type: $('frequencyTypeInput').value,
    frequency_interval: Number($('frequencyIntervalInput').value || 1),
    next_due_date: $('nextDueDateInput').value,
    recurrence_mode: $('recurrenceModeInput').value,
    priority: $('priorityInput').value,
    time_mode: timeMode,
    start_time: timeMode === 'anytime' ? null : ($('startTimeInput').value || null),
    end_time: timeMode === 'window' ? ($('endTimeInput').value || null) : null,
    weight: Number($('weightInput').value || 1),
    notes: $('notesInput').value.trim(),
    active: true
  };
  const id = $('choreIdInput').value;
  const query = id ? state.supabase.from('chores').update(payload).eq('id', id) : state.supabase.from('chores').insert(payload);
  const { error } = await query;
  if (error) return toast(error.message);
  $('choreDialog').close();
  await loadAllData();
  toast(id ? 'Chore updated.' : 'Chore added.');
}

function addInterval(dateIso, type, interval) {
  const d = new Date(`${dateIso}T12:00:00`);
  if (type === 'daily') d.setDate(d.getDate() + interval);
  if (type === 'weekly') d.setDate(d.getDate() + interval * 7);
  if (type === 'monthly') d.setMonth(d.getMonth() + interval);
  if (type === 'yearly') d.setFullYear(d.getFullYear() + interval);
  return d.toISOString().slice(0, 10);
}


async function claimChore(id) {
  const { error } = await state.supabase.from('chores').update({ claimed_by: state.user.id, claimed_at: new Date().toISOString() }).eq('id', id);
  if (error) return toast(error.message);
  await loadAllData();
  toast('Chore claimed.');
}
window.claimChore = claimChore;

async function unclaimChore(id) {
  const { error } = await state.supabase.from('chores').update({ claimed_by: null, claimed_at: null }).eq('id', id);
  if (error) return toast(error.message);
  await loadAllData();
  toast('Chore unclaimed.');
}
window.unclaimChore = unclaimChore;

async function completeChore(id) {
  const c = state.chores.find(x => x.id === id);
  if (!c) return;
  const completedAt = new Date().toISOString();
  const baseDate = c.recurrence_mode === 'rolling' ? todayISO() : c.next_due_date;
  let nextDue = addInterval(baseDate, c.frequency_type, c.frequency_interval);
  while (nextDue <= todayISO() && c.recurrence_mode === 'fixed') {
    nextDue = addInterval(nextDue, c.frequency_type, c.frequency_interval);
  }
  const { error: compError } = await state.supabase.from('chore_completions').insert({
    chore_id: c.id,
    household_id: state.household.id,
    completed_by: state.user.id,
    completed_at: completedAt,
    notes: ''
  });
  if (compError) return toast(compError.message);
  const { error: choreError } = await state.supabase.from('chores').update({ last_completed_date: todayISO(), next_due_date: nextDue, claimed_by: null, claimed_at: null }).eq('id', c.id);
  if (choreError) return toast(choreError.message);
  await loadAllData();
  toast('Chore completed.');
}
window.completeChore = completeChore;

async function archiveChore(id) {
  if (!confirm('Archive this chore? It will stop appearing but completion history stays.')) return;
  const { error } = await state.supabase.from('chores').update({ active: false, claimed_by: null, claimed_at: null }).eq('id', id);
  if (error) return toast(error.message);
  await loadAllData();
  toast('Chore archived.');
}
window.archiveChore = archiveChore;

async function restoreChore(id) {
  const { error } = await state.supabase.from('chores').update({ active: true }).eq('id', id);
  if (error) return toast(error.message);
  await loadAllData();
  toast('Chore restored.');
}
window.restoreChore = restoreChore;

async function deleteChore(id) {
  const c = choreLookup(id);
  if (!confirm(`Permanently delete "${c?.title || 'this chore'}"? This can also remove its completion history. Archive is safer.`)) return;
  const { error } = await state.supabase.from('chores').delete().eq('id', id);
  if (error) return toast(error.message);
  await loadAllData();
  toast('Chore deleted.');
}
window.deleteChore = deleteChore;

function duplicateChore(id) {
  const c = choreLookup(id);
  if (!c) return toast('Chore not found.');
  openChoreDialog(null);
  $('choreTitleInput').value = c.title;
  $('categoryInput').value = c.category || 'General';
  $('assignedToInput').value = c.assigned_to || 'Anyone';
  $('frequencyTypeInput').value = c.frequency_type || 'weekly';
  $('frequencyIntervalInput').value = c.frequency_interval || 1;
  $('nextDueDateInput').value = c.next_due_date || todayISO();
  $('recurrenceModeInput').value = c.recurrence_mode || 'fixed';
  $('priorityInput').value = c.priority || 'normal';
  $('timeModeInput').value = c.time_mode || 'anytime';
  $('startTimeInput').value = c.start_time ? String(c.start_time).slice(0,5) : '';
  $('endTimeInput').value = c.end_time ? String(c.end_time).slice(0,5) : '';
  $('weightInput').value = c.weight || 2;
  $('notesInput').value = c.notes || '';
  updateTimeFieldVisibility();
  toast('Duplicated. Adjust anything, then save.');
}
window.duplicateChore = duplicateChore;


function openRewardDialog(id = null) {
  const r = id ? state.rewards.find(x => x.id === id) : null;
  $('rewardDialogTitle').textContent = r ? 'Edit reward' : 'Add reward';
  $('rewardIdInput').value = r?.id || '';
  $('rewardNameInput').value = r?.name || '';
  $('rewardCostInput').value = r?.cost || 10;
  $('rewardDescriptionInput').value = r?.description || '';
  $('rewardDialog').showModal();
}
window.openRewardDialog = openRewardDialog;

async function saveReward(e) {
  e.preventDefault();
  const payload = {
    household_id: state.household.id,
    name: $('rewardNameInput').value.trim(),
    cost: Number($('rewardCostInput').value || 1),
    description: $('rewardDescriptionInput').value.trim(),
    active: true
  };
  const id = $('rewardIdInput').value;
  const query = id ? state.supabase.from('rewards').update(payload).eq('id', id) : state.supabase.from('rewards').insert({ ...payload, created_by: state.user.id });
  const { error } = await query;
  if (error) return toast(error.message);
  $('rewardDialog').close();
  await loadAllData();
  toast(id ? 'Reward updated.' : 'Reward added.');
}

async function archiveReward(id) {
  if (!confirm('Archive this reward? Existing request history stays.')) return;
  const { error } = await state.supabase.from('rewards').update({ active: false }).eq('id', id);
  if (error) return toast(error.message);
  await loadAllData();
  toast('Reward archived.');
}
window.archiveReward = archiveReward;

async function requestReward(id) {
  const reward = state.rewards.find(r => r.id === id);
  if (!reward) return;
  const balance = pointBalances()[state.user.id]?.balance || 0;
  if (balance < reward.cost) return toast('Not enough points for that reward yet.');
  const { error } = await state.supabase.from('reward_requests').insert({
    household_id: state.household.id,
    reward_id: reward.id,
    reward_name: reward.name,
    reward_cost: reward.cost,
    requested_by: state.user.id,
    status: 'pending'
  });
  if (error) return toast(error.message);
  await loadAllData();
  toast('Reward requested.');
}
window.requestReward = requestReward;

async function setRewardRequestStatus(id, status) {
  const payload = { status };
  const now = new Date().toISOString();
  if (['approved', 'declined'].includes(status)) {
    payload.decided_by = state.user.id;
    payload.decided_at = now;
  }
  if (status === 'fulfilled') {
    payload.fulfilled_by = state.user.id;
    payload.fulfilled_at = now;
  }
  const { error } = await state.supabase.from('reward_requests').update(payload).eq('id', id);
  if (error) return toast(error.message);
  await loadAllData();
  toast(`Reward ${status}.`);
}
window.setRewardRequestStatus = setRewardRequestStatus;

function exportJson() {
  const backup = {
    exported_at: new Date().toISOString(),
    household: state.household,
    members: state.members,
    chores: state.allChores,
    completions: state.completions,
    rewards: state.rewards,
    rewardRequests: state.rewardRequests
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `homeops-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

boot();
