const state = {
  supabase: null,
  user: null,
  household: null,
  members: [],
  chores: [],
  completions: [],
  currentFilter: 'all',
  currentScheduleDate: todayISO()
};

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

const priorityRank = { urgent: 4, high: 3, normal: 2, low: 1 };
const priorityLabel = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };

function saveLocalConfig(url, key) {
  localStorage.setItem('homeops_supabase_url', url.trim());
  localStorage.setItem('homeops_supabase_key', key.trim());
}
function getLocalConfig() {
  return {
    url: localStorage.getItem('homeops_supabase_url') || '',
    key: localStorage.getItem('homeops_supabase_key') || ''
  };
}
function initSupabase() {
  const { url, key } = getLocalConfig();
  if (!url || !key) return false;
  state.supabase = window.supabase.createClient(url, key);
  return true;
}

async function boot() {
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
  const { data, error } = await state.supabase
    .from('household_members')
    .select('*, households(*)')
    .eq('user_id', state.user.id)
    .limit(1)
    .maybeSingle();
  if (error) return toast(error.message);
  if (!data) return;
  state.household = data.households;
  await loadAllData();
  showOnly('appScreen');
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

async function loadAllData() {
  await Promise.all([loadMembers(), loadChores(), loadCompletions()]);
  $('householdName').textContent = state.household.name;
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
  const { data, error } = await state.supabase.from('chores').select('*').eq('household_id', state.household.id).eq('active', true).order('next_due_date');
  if (error) return toast(error.message);
  state.chores = (data || []).sort(compareChores);
}
async function loadCompletions() {
  const { data, error } = await state.supabase
    .from('chore_completions')
    .select('*, chores(title, weight), household_members(display_name)')
    .eq('household_id', state.household.id)
    .order('completed_at', { ascending: false })
    .limit(50);
  if (error) return toast(error.message);
  state.completions = data || [];
}

function fillAssignedOptions() {
  const select = $('assignedToInput');
  select.innerHTML = '';
  ['Anyone', 'Both', 'Rotating'].forEach(v => select.append(new Option(v, v)));
  state.members.forEach(m => select.append(new Option(m.display_name, m.user_id)));
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['home', 'schedule', 'chores', 'people', 'settings'].forEach(t => $(`${t}Tab`).classList.toggle('hidden', t !== tab));
  if (tab === 'schedule') renderSchedule();
}

function renderAll() {
  renderHome();
  renderSchedule();
  renderChores();
  renderPeople();
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

function renderHome() {
  const sorted = [...state.chores].sort(compareChores);
  const due = sorted.filter(c => c.next_due_date <= todayISO());
  const upcoming = sorted.filter(c => c.next_due_date > todayISO()).slice(0, 8);
  const overdue = sorted.filter(c => c.next_due_date < todayISO());
  $('todayCount').textContent = state.chores.filter(c => c.next_due_date === todayISO()).length;
  $('overdueCount').textContent = overdue.length;
  $('upcomingCount').textContent = state.chores.filter(c => c.next_due_date > todayISO()).length;
  $('weekPoints').textContent = state.completions.filter(c => c.completed_at.slice(0,10) >= weekStartISO()).reduce((sum, c) => sum + (c.chores?.weight || 0), 0);
  $('dueNowList').innerHTML = due.length ? due.map(choreCard).join('') : empty('Nothing due right now.');
  $('upcomingList').innerHTML = upcoming.length ? upcoming.map(choreCard).join('') : empty('No upcoming chores.');
}

function renderSchedule() {
  if (!$('scheduleList')) return;
  $('scheduleDateInput').value = state.currentScheduleDate;
  const chores = state.chores.filter(c => c.next_due_date === state.currentScheduleDate).sort(compareChores);
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
        ${choreCard(c)}
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
    byUser[c.completed_by].points += c.chores?.weight || 0;
    byUser[c.completed_by].count += 1;
  });
  $('peopleList').innerHTML = Object.values(byUser).map(p => `
    <div class="item"><div class="item-top"><div><h3>${escapeHtml(p.name)}</h3><p class="muted">${p.count} completions this week</p></div><strong>${p.points} pts</strong></div></div>
  `).join('') || empty('No household members yet.');
  $('completionList').innerHTML = state.completions.length ? state.completions.slice(0, 12).map(c => `
    <div class="item"><div class="item-top"><div><h3>${escapeHtml(c.chores?.title || 'Deleted chore')}</h3><p class="muted">Completed by ${escapeHtml(c.household_members?.display_name || 'Unknown')} on ${fmtDate(c.completed_at.slice(0,10))}</p></div><span class="pill done">${c.chores?.weight || 0} pts</span></div></div>
  `).join('') : empty('No completions yet.');
}

function choreCard(c) {
  const status = dueStatus(c);
  const statusText = status === 'overdue' ? `Overdue · due ${fmtDate(c.next_due_date)}` : status === 'today' ? 'Due today' : `Due ${fmtDate(c.next_due_date)}`;
  const priority = c.priority || 'normal';
  return `
    <div class="item">
      <div class="item-top">
        <div>
          <h3>${escapeHtml(c.title)}</h3>
          <p class="muted">${escapeHtml(assignedName(c.assigned_to))} · every ${c.frequency_interval} ${c.frequency_type}${c.frequency_interval > 1 ? 's' : ''}</p>
        </div>
        <span class="pill ${status}">${statusText}</span>
      </div>
      <div class="pills">
        <span class="pill priority-${priority}">${escapeHtml(priorityLabel[priority] || 'Normal')}</span>
        <span class="pill">${escapeHtml(scheduleLabel(c))}</span>
        <span class="pill">${escapeHtml(c.category)}</span>
        <span class="pill">${c.weight} pts</span>
        <span class="pill">${c.recurrence_mode}</span>
      </div>
      ${c.notes ? `<p class="small muted">${escapeHtml(c.notes)}</p>` : ''}
      <div class="item-actions">
        <button onclick="completeChore('${c.id}')">Complete</button>
        <button class="secondary" onclick="openChoreDialog('${c.id}')">Edit</button>
        <button class="ghost danger" onclick="archiveChore('${c.id}')">Archive</button>
      </div>
    </div>
  `;
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
  const c = id ? state.chores.find(x => x.id === id) : null;
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
  const { error: choreError } = await state.supabase.from('chores').update({ last_completed_date: todayISO(), next_due_date: nextDue }).eq('id', c.id);
  if (choreError) return toast(choreError.message);
  await loadAllData();
  toast('Chore completed.');
}
window.completeChore = completeChore;

async function archiveChore(id) {
  if (!confirm('Archive this chore? It will stop appearing but completion history stays.')) return;
  const { error } = await state.supabase.from('chores').update({ active: false }).eq('id', id);
  if (error) return toast(error.message);
  await loadAllData();
  toast('Chore archived.');
}
window.archiveChore = archiveChore;

function exportJson() {
  const backup = {
    exported_at: new Date().toISOString(),
    household: state.household,
    members: state.members,
    chores: state.chores,
    completions: state.completions
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
