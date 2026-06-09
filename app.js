/* BHPauzes - Copyright © 2026 Abel Doolaard. All Rights Reserved. */
const STORAGE_KEY = 'bhpauzes.state.v2';
const LEGACY_STORAGE_KEY = 'bhpauzes.state.v1';
const FIFTEEN = 15;
const WARNING_OFFSETS = [-5, 0, 5, 10, 15];
const PANELS = ['dashboard', 'breaks', 'employees', 'shifts', 'settings'];

const $ = (selector) => document.querySelector(selector);
let selectedEmployees = new Set();
let deferredInstallPrompt = null;
let toastTimer;

const now = () => new Date();
const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);
const addMinutes = (date, minutes) => new Date(new Date(date).getTime() + minutes * 60000);
const formatTime = (value) => new Date(value).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const formatDateInput = (date = new Date()) => date.toISOString().slice(0, 10);
const timeToMinutes = (time) => {
  const [hours, minutes] = (time || '00:00').split(':').map(Number);
  return hours * 60 + minutes;
};

function createDefaultShifts() {
  return [
    { id: uid('shift'), name: 'Ochtend', startTime: '08:00', endTime: '17:00', defaultBreakMinutes: 60 },
    { id: uid('shift'), name: 'Middag', startTime: '10:00', endTime: '19:00', defaultBreakMinutes: 60 },
  ];
}

function createEvent(name = 'Nieuw evenement') {
  return {
    id: uid('event'),
    name,
    date: formatDateInput(),
    maxConcurrentBreaks: 3,
    archived: false,
    createdAt: now().toISOString(),
    archivedAt: null,
    shifts: createDefaultShifts(),
    employees: [],
    breaks: [],
  };
}

function createBar(name = 'Hoofdbar') {
  const event = createEvent('Nieuw evenement');
  return { id: uid('bar'), name, createdAt: now().toISOString(), events: [event] };
}

function createDefaultState() {
  const bar = createBar('Hoofdbar');
  return {
    version: 2,
    bars: [bar],
    ui: {
      activeBarId: bar.id,
      activeEventId: bar.events[0].id,
      activeTab: 'dashboard',
      showArchived: false,
      drafts: {
        employee: { name: '', shiftId: bar.events[0].shifts[0]?.id || '' },
        shift: { name: '', startTime: '12:00', endTime: '18:00', defaultBreakMinutes: 60 },
        event: {},
        newEventName: '',
        newBarName: '',
        lastBreakDuration: 30,
      },
    },
    settings: { notificationsEnabled: false, soundEnabled: false, inAppAlertsEnabled: true },
  };
}

let state = loadState();
let showBarSelector = state.bars.length > 1;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    return legacy ? migrateV1(JSON.parse(legacy)) : createDefaultState();
  } catch (error) {
    console.error(error);
    return createDefaultState();
  }
}

function migrateV1(data) {
  const fallback = createDefaultState();
  const event = {
    id: uid('event'),
    name: data?.event?.name || 'Geïmporteerd evenement',
    date: data?.event?.date || formatDateInput(),
    maxConcurrentBreaks: Number(data?.event?.maxConcurrentBreaks || 3),
    archived: false,
    createdAt: now().toISOString(),
    archivedAt: null,
    shifts: Array.isArray(data?.shifts) ? data.shifts : createDefaultShifts(),
    employees: Array.isArray(data?.employees) ? data.employees : [],
    breaks: Array.isArray(data?.breaks) ? data.breaks : [],
  };
  const bar = { id: uid('bar'), name: 'Hoofdbar', createdAt: now().toISOString(), events: [event] };
  return normalizeState({ ...fallback, bars: [bar], ui: { ...fallback.ui, activeBarId: bar.id, activeEventId: event.id }, settings: { ...fallback.settings, ...(data?.settings || {}) } });
}

function normalizeState(data) {
  const fallback = createDefaultState();
  const normalized = {
    version: 2,
    bars: Array.isArray(data?.bars) && data.bars.length ? data.bars : fallback.bars,
    ui: { ...fallback.ui, ...(data?.ui || {}) },
    settings: { ...fallback.settings, ...(data?.settings || {}) },
  };
  normalized.bars = normalized.bars.map((bar) => ({
    id: bar.id || uid('bar'),
    name: bar.name || 'Naamloze bar',
    createdAt: bar.createdAt || now().toISOString(),
    events: (Array.isArray(bar.events) && bar.events.length ? bar.events : [createEvent('Nieuw evenement')]).map((event) => ({
      id: event.id || uid('event'),
      name: event.name || 'Naamloos evenement',
      date: event.date || formatDateInput(),
      maxConcurrentBreaks: Number(event.maxConcurrentBreaks || 3),
      archived: Boolean(event.archived),
      createdAt: event.createdAt || now().toISOString(),
      archivedAt: event.archivedAt || null,
      shifts: Array.isArray(event.shifts) && event.shifts.length ? event.shifts : createDefaultShifts(),
      employees: Array.isArray(event.employees) ? event.employees : [],
      breaks: Array.isArray(event.breaks) ? event.breaks.map((entry) => ({ notificationsSent: [], alertsSent: [], ...entry })) : [],
    })),
  }));
  if (!normalized.bars.some((bar) => bar.id === normalized.ui.activeBarId)) normalized.ui.activeBarId = normalized.bars[0].id;
  const bar = normalized.bars.find((item) => item.id === normalized.ui.activeBarId);
  const activeEvents = bar.events.filter((event) => !event.archived);
  if (!bar.events.some((event) => event.id === normalized.ui.activeEventId) || bar.events.find((event) => event.id === normalized.ui.activeEventId)?.archived) {
    normalized.ui.activeEventId = (activeEvents[0] || bar.events[0]).id;
  }
  normalized.ui.activeTab = PANELS.includes(normalized.ui.activeTab) ? normalized.ui.activeTab : 'dashboard';
  normalized.ui.drafts = { ...fallback.ui.drafts, ...(normalized.ui.drafts || {}) };
  saveState(normalized);
  return normalized;
}

function saveState(value = state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

function mutate(callback, options = {}) {
  callback();
  saveState();
  render(options);
}

function activeBar() {
  return state.bars.find((bar) => bar.id === state.ui.activeBarId) || state.bars[0];
}

function activeEvent() {
  const bar = activeBar();
  return bar.events.find((event) => event.id === state.ui.activeEventId) || bar.events.find((event) => !event.archived) || bar.events[0];
}

function activeEvents() {
  return activeBar().events.filter((event) => !event.archived);
}

function getShift(employee) {
  return activeEvent().shifts.find((shift) => shift.id === employee.shiftId);
}

function getEmployeeBreaks(employeeId) {
  return activeEvent().breaks.filter((entry) => entry.employeeId === employeeId).sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
}

function getActiveBreak(employeeId) {
  return activeEvent().breaks.find((entry) => entry.employeeId === employeeId && !entry.endedAt);
}

function getActiveBreaks() {
  return activeEvent().breaks.filter((entry) => !entry.endedAt).sort((a, b) => new Date(a.expectedReturnAt) - new Date(b.expectedReturnAt));
}

function completedMinutes(employeeId) {
  return getEmployeeBreaks(employeeId).filter((entry) => entry.endedAt).reduce((total, entry) => total + entry.plannedMinutes, 0);
}

function activeMinutes(employeeId) {
  const active = getActiveBreak(employeeId);
  return active ? active.plannedMinutes : 0;
}

function remainingMinutes(employee) {
  return Math.max(0, employee.requiredBreakMinutes - completedMinutes(employee.id) - activeMinutes(employee.id));
}

function progressStats() {
  const event = activeEvent();
  const totalRequired = event.employees.reduce((sum, employee) => sum + employee.requiredBreakMinutes, 0);
  const totalCompleted = event.employees.reduce((sum, employee) => sum + completedMinutes(employee.id), 0);
  const complete = event.employees.filter((employee) => remainingMinutes(employee) === 0).length;
  const partial = event.employees.filter((employee) => completedMinutes(employee.id) > 0 && remainingMinutes(employee) > 0).length;
  const none = event.employees.filter((employee) => completedMinutes(employee.id) === 0 && !getActiveBreak(employee.id)).length;
  const late = getActiveBreaks().filter((entry) => new Date(entry.expectedReturnAt) < now()).length;
  const percentage = totalRequired ? Math.round((totalCompleted / totalRequired) * 100) : 0;
  const expected = expectedProgressPercentage();
  const status = late > 0 || percentage < expected - 20 ? 'Achter op schema' : percentage < expected - 8 ? 'Let op' : 'Op schema';
  return { totalRequired, totalCompleted, complete, partial, none, late, percentage: clamp(percentage, 0, 100), status };
}

function expectedProgressPercentage() {
  const event = activeEvent();
  if (!event.employees.length) return 0;
  const current = now().getHours() * 60 + now().getMinutes();
  const values = event.employees.map((employee) => {
    const shift = getShift(employee);
    const start = timeToMinutes(shift?.startTime);
    const end = timeToMinutes(shift?.endTime);
    return clamp(((current - start) / Math.max(1, end - start)) * 100, 0, 100);
  });
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function adviceList() {
  const event = activeEvent();
  const room = Math.max(0, event.maxConcurrentBreaks - getActiveBreaks().length);
  if (!room) return [];
  const current = now();
  return event.employees
    .filter((employee) => remainingMinutes(employee) > 0 && !getActiveBreak(employee.id))
    .map((employee) => {
      const history = getEmployeeBreaks(employee.id).filter((entry) => entry.endedAt);
      const lastBreakEnd = history.length ? new Date(history[history.length - 1].endedAt) : shiftStartToday(employee);
      const workedMinutes = Math.max(0, minutesBetween(lastBreakEnd, current));
      const shift = getShift(employee);
      const score = timeToMinutes(shift?.startTime) * -0.08 + workedMinutes * 2 + remainingMinutes(employee) * 1.4 - completedMinutes(employee.id);
      return { employee, score, workedMinutes };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, room || 3);
}

function shiftStartToday(employee) {
  const shift = getShift(employee);
  const base = new Date();
  const [hours, minutes] = (shift?.startTime || employee.startTime || '00:00').split(':').map(Number);
  base.setHours(hours, minutes, 0, 0);
  return base;
}

function ensureAppPanels() {
  const main = document.querySelector('main');
  if ($('#dashboard') && $('#breaks') && $('#employees') && $('#shifts') && $('#settings')) return;
  main.innerHTML = PANELS.map((panel) => `<section id="${panel}" class="tab-panel" aria-labelledby="tab-${panel}"></section>`).join('');
}

function render(options = {}) {
  if (shouldShowBarSelection()) {
    renderBarSelection();
    return;
  }
  $('.app-shell').classList.remove('selector-mode');
  ensureAppPanels();
  $('#barSelector')?.remove();
  renderContextBar();
  renderDashboard();
  renderBreaks();
  renderEmployees(options.keepFormFocus);
  renderShifts(options.keepFormFocus);
  renderSettings(options.keepFormFocus);
  setTab(state.ui.activeTab, false);
  scheduleNotificationChecks();
}

function shouldShowBarSelection() {
  return state.bars.length > 1 && (showBarSelector || !state.ui.activeBarId);
}

function renderBarSelection() {
  $('.app-shell').classList.add('selector-mode');
  document.querySelector('main').innerHTML = `<section id="barSelector" class="tab-panel active">
    <div class="card hero-card">
      <p class="eyebrow">Kies bar</p>
      <h2>Met welke bar wil je werken?</h2>
      <p class="muted">Alle evenementen, shifts, medewerkers en pauzes blijven per bar gescheiden.</p>
      <div class="grid">${state.bars.map((bar) => `<button type="button" class="selector-button ${bar.id === state.ui.activeBarId ? 'active' : ''}" data-select-bar="${bar.id}">${escapeHtml(bar.name)}<span>${bar.events.filter((event) => !event.archived).length} actieve evenementen</span></button>`).join('')}</div>
      <form id="barForm" class="form inline-form"><label>Nieuwe bar<input name="name" required placeholder="Bijv. Cocktailbar" value="${escapeAttr(state.ui.drafts.newBarName || '')}"></label><button type="submit">Nieuwe bar</button></form>
    </div>
  </section>`;
  document.querySelector('.bottom-nav').classList.add('hidden');
}

function renderContextBar() {
  document.querySelector('.bottom-nav').classList.remove('hidden');
  const bar = activeBar();
  const event = activeEvent();
  let context = $('#contextBar');
  if (!context) {
    context = document.createElement('div');
    context.id = 'contextBar';
    context.className = 'context-bar';
    document.querySelector('.topbar').after(context);
  }
  context.innerHTML = `<div><strong>${escapeHtml(bar.name)}</strong><span>${escapeHtml(event.name)} · ${event.date}</span></div><button type="button" class="ghost" data-open-bar-selector>Wissel bar</button>`;
}

function renderDashboard() {
  const event = activeEvent();
  const stats = progressStats();
  const statusClass = stats.status === 'Op schema' ? 'status-ok' : stats.status === 'Let op' ? 'status-warn' : 'status-late';
  const advice = adviceList();
  $('#dashboard').innerHTML = `
    <div class="card">
      <div class="card-title">
        <div><h2>${escapeHtml(event.name)}</h2><p class="muted small">${escapeHtml(activeBar().name)} · ${event.date} · max. ${event.maxConcurrentBreaks} tegelijk op pauze</p></div>
        <span class="status-pill ${statusClass}">${stats.status}</span>
      </div>
      ${renderWarningStrip()}
      <div class="grid two four">${stat('Medewerkers', event.employees.length)}${stat('Volledig klaar', stats.complete)}${stat('Gedeeltelijk klaar', stats.partial)}${stat('Zonder pauze', stats.none)}</div>
    </div>
    <div class="desktop-columns">
      <div>
        <div class="card"><div class="card-title"><h3>Voortgang</h3><strong>${stats.percentage}%</strong></div><div class="progress-wrap"><div class="progress-bar" style="width:${stats.percentage}%"></div></div><p class="muted small">${stats.totalCompleted} van ${stats.totalRequired} geplande pauzeminuten afgerond.</p></div>
        <div class="card"><div class="grid two">${stat('Actieve pauzes', getActiveBreaks().length)}${stat('Te laat terug', stats.late)}</div></div>
      </div>
      <div class="card"><div class="card-title"><h3>Slim pauzeadvies</h3><span class="pill">ruimte: ${Math.max(0, event.maxConcurrentBreaks - getActiveBreaks().length)}</span></div>
        ${advice.length ? advice.map((item, index) => `<div class="advice-item"><div class="row between"><strong>${index + 1}. ${escapeHtml(item.employee.name)}</strong><span class="pill">${remainingMinutes(item.employee)} min over</span></div><p class="muted small">${item.workedMinutes} minuten gewerkt sinds laatste pauze.</p></div>`).join('') : '<div class="empty">Geen advies beschikbaar. Voeg medewerkers toe of wacht tot er pauzeruimte is.</div>'}
      </div>
    </div>`;
}

function renderWarningStrip() {
  const warnings = getActiveBreaks().map((entry) => ({ entry, employee: activeEvent().employees.find((item) => item.id === entry.employeeId), diff: minutesBetween(entry.expectedReturnAt, now()) })).filter((item) => item.diff >= -5);
  if (!warnings.length) return '';
  return `<div class="warning-strip">${warnings.map((item) => `<span>${escapeHtml(item.employee?.name || 'Onbekend')}: ${item.diff < 0 ? `over ${Math.abs(item.diff)} min terug` : item.diff === 0 ? 'nu terug' : `${item.diff} min te laat`}</span>`).join('')}</div>`;
}

function renderBreaks() {
  const event = activeEvent();
  const active = getActiveBreaks();
  const selected = event.employees.filter((employee) => selectedEmployees.has(employee.id));
  const durations = [15, 30, 45, 60];
  $('#breaks').innerHTML = `
    <div class="card"><div class="card-title"><h2>Pauzes</h2><span class="pill">${active.length}/${event.maxConcurrentBreaks} actief</span></div><div class="row">${durations.map((duration) => `<button type="button" data-bulk-start="${duration}" ${selected.length ? '' : 'disabled'}>${duration} min</button>`).join('')}</div><p class="muted small">Geselecteerd: ${selected.length ? selected.map((employee) => escapeHtml(employee.name)).join(', ') : 'geen medewerkers'}</p></div>
    <div class="card"><div class="card-title"><h3>Actieve pauzes</h3><span class="pill">nu</span></div>${renderWarningStrip()}<div class="grid">${active.length ? active.map(renderActiveBreak).join('') : '<div class="empty">Niemand is momenteel op pauze.</div>'}</div></div>
    <div class="card"><div class="card-title"><h3>Alle medewerkers</h3><button class="light" type="button" data-clear-selection>Wis selectie</button></div><div class="grid">${event.employees.length ? event.employees.map(renderEmployeeBreakRow).join('') : '<div class="empty">Voeg eerst medewerkers toe.</div>'}</div></div>`;
}

function renderEmployeeBreakRow(employee) {
  const lastDuration = Number(state.ui.drafts.lastBreakDuration || 30);
  const durations = Array.from(new Set([lastDuration, 15, 30, 45, 60])).filter((duration) => duration > 0);
  return `<div class="employee"><div class="employee-head"><label class="checkbox-row"><input type="checkbox" data-select-employee="${employee.id}" ${selectedEmployees.has(employee.id) ? 'checked' : ''}><span class="employee-name">${escapeHtml(employee.name)}</span></label><span class="pill">${remainingMinutes(employee)} min over</span></div>${renderBlocks(employee)}<div class="row">${durations.slice(0, 4).map((duration) => `<button class="light" type="button" data-start-break="${employee.id}" data-duration="${duration}" ${canStartBreak(employee, duration) ? '' : 'disabled'}>${duration} min</button>`).join('')}</div></div>`;
}

function renderActiveBreak(entry) {
  const employee = activeEvent().employees.find((item) => item.id === entry.employeeId);
  const remaining = Math.ceil((new Date(entry.expectedReturnAt) - now()) / 60000);
  const color = remaining < 0 ? 'red' : remaining <= 5 ? 'orange' : 'green';
  return `<div class="active-break ${color}"><div class="row between"><strong>${escapeHtml(employee?.name || 'Onbekend')}</strong><span class="pill">${remaining < 0 ? `+${Math.abs(remaining)} min te laat` : `${remaining} min over`}</span></div><div class="grid three"><span><b>Start</b><br>${formatTime(entry.startedAt)}</span><span><b>Terug</b><br>${formatTime(entry.expectedReturnAt)}</span><span><b>Duur</b><br>${entry.plannedMinutes} min</span></div><button type="button" data-return-break="${entry.id}">✓ Terug</button></div>`;
}

function renderEmployees(keepFormFocus = false) {
  if (keepFormFocus && document.activeElement?.closest('#employeeForm')) return;
  const event = activeEvent();
  const draft = state.ui.drafts.employee || {};
  const selectedShiftId = event.shifts.some((shift) => shift.id === draft.shiftId) ? draft.shiftId : event.shifts[0]?.id || '';
  $('#employees').innerHTML = `<div class="card"><div class="card-title"><h2>Medewerkers</h2><span class="pill">${event.employees.length}</span></div><form id="employeeForm" class="form"><label>Naam<input name="name" required placeholder="Bijv. Lisa" value="${escapeAttr(draft.name || '')}"></label><label>Shift<select name="shiftId" required>${event.shifts.map((shift) => `<option value="${shift.id}" ${shift.id === selectedShiftId ? 'selected' : ''}>${escapeHtml(shift.name)} (${shift.startTime}-${shift.endTime})</option>`).join('')}</select></label><button type="submit">Medewerker toevoegen</button></form></div><div class="grid">${event.employees.length ? event.employees.map((employee) => { const shift = getShift(employee); return `<div class="employee"><div class="employee-head"><div><div class="employee-name">${escapeHtml(employee.name)}</div><p class="muted small">${escapeHtml(shift?.name || 'Geen shift')} · ${employee.startTime}-${employee.endTime} · ${employee.requiredBreakMinutes} min pauze</p></div><button class="danger" type="button" data-delete-employee="${employee.id}">Verwijder</button></div>${renderBlocks(employee)}${renderHistory(employee.id)}</div>`; }).join('') : '<div class="card empty">Nog geen medewerkers.</div>'}</div>`;
}

function renderShifts(keepFormFocus = false) {
  if (keepFormFocus && document.activeElement?.closest('#shiftForm')) return;
  const event = activeEvent();
  const draft = state.ui.drafts.shift || {};
  $('#shifts').innerHTML = `<div class="card"><div class="card-title"><h2>Shifts</h2><span class="pill">${event.shifts.length}</span></div><form id="shiftForm" class="form"><label>Naam<input name="name" required placeholder="Bijv. Avond" value="${escapeAttr(draft.name || '')}"></label><div class="grid two"><label>Starttijd<input name="startTime" type="time" required value="${draft.startTime || '12:00'}"></label><label>Eindtijd<input name="endTime" type="time" required value="${draft.endTime || '18:00'}"></label></div><label>Standaard pauzeduur<select name="defaultBreakMinutes">${[30,45,60,75,90].map((m) => `<option value="${m}" ${Number(draft.defaultBreakMinutes || 60) === m ? 'selected' : ''}>${m} minuten</option>`).join('')}</select></label><button type="submit">Shift toevoegen</button></form></div><div class="grid">${event.shifts.map((shift) => `<div class="shift-card"><div class="row between"><strong>${escapeHtml(shift.name)}</strong><button class="danger" type="button" data-delete-shift="${shift.id}">Verwijder</button></div><p class="muted">${shift.startTime} - ${shift.endTime} · ${shift.defaultBreakMinutes} minuten pauze</p></div>`).join('')}</div>`;
}

function renderSettings(keepFormFocus = false) {
  if (keepFormFocus && document.activeElement?.closest('#settings')) return;
  const bar = activeBar();
  const event = activeEvent();
  const archived = bar.events.filter((item) => item.archived);
  $('#settings').innerHTML = `<div class="card"><div class="card-title"><h2>Instellingen</h2><span class="pill">${escapeHtml(bar.name)}</span></div><form id="barNameForm" class="form"><label>Barnaam<input name="name" required value="${escapeAttr(bar.name)}"></label><button type="submit">Bar opslaan</button></form></div>
    <div class="card"><div class="card-title"><h3>Actief evenement</h3></div><label>Kies evenement<select data-active-event>${activeEvents().map((item) => `<option value="${item.id}" ${item.id === event.id ? 'selected' : ''}>${escapeHtml(item.name)} (${item.date})</option>`).join('')}</select></label><form id="eventForm" class="form"><label>Evenementnaam<input name="name" required value="${escapeAttr(event.name)}"></label><label>Datum<input name="date" type="date" required value="${event.date}"></label><label>Maximale gelijktijdige pauzes<input name="maxConcurrentBreaks" type="number" min="1" max="40" required value="${event.maxConcurrentBreaks}"></label><button type="submit">Evenement opslaan</button></form><div class="row"><button class="secondary" type="button" data-archive-event="${event.id}">Archiveer evenement</button></div></div>
    <div class="card"><div class="card-title"><h3>Nieuw evenement</h3></div><form id="newEventForm" class="form inline-form"><label>Naam<input name="name" required placeholder="Bijv. North Sea Jazz Zaterdag" value="${escapeAttr(state.ui.drafts.newEventName || '')}"></label><button type="submit">Evenement aanmaken</button></form></div>
    <div class="card"><div class="card-title"><h3>Archief</h3><span class="pill">${archived.length}</span></div>${archived.length ? `<div class="grid">${archived.map((item) => `<div class="history-row"><strong>${escapeHtml(item.name)}</strong><span>${item.date} · ${item.employees.length} medewerkers · ${item.breaks.length} pauzes</span><div class="row"><button type="button" data-restore-event="${item.id}">Terugzetten</button><button class="danger" type="button" data-delete-event="${item.id}">Definitief verwijderen</button></div></div>`).join('')}</div>` : '<div class="empty">Geen gearchiveerde evenementen.</div>'}</div>
    <div class="card"><div class="card-title"><h3>Bars</h3></div><div class="grid">${state.bars.map((item) => `<button type="button" class="selector-button ${item.id === bar.id ? 'active' : ''}" data-select-bar="${item.id}">${escapeHtml(item.name)}<span>${item.events.filter((entry) => !entry.archived).length} actief</span></button>`).join('')}</div><form id="barForm" class="form inline-form"><label>Nieuwe bar<input name="name" required placeholder="Bijv. Wijnbar" value="${escapeAttr(state.ui.drafts.newBarName || '')}"></label><button type="submit">Nieuwe bar</button></form></div>
    <div class="card"><div class="card-title"><h3>Notificaties</h3><span class="pill">${notificationStatusLabel()}</span></div>${notificationHint()}<label class="checkbox-row"><input type="checkbox" data-setting="notificationsEnabled" ${state.settings.notificationsEnabled ? 'checked' : ''}>Browser notificaties aan</label><label class="checkbox-row"><input type="checkbox" data-setting="inAppAlertsEnabled" ${state.settings.inAppAlertsEnabled ? 'checked' : ''}>In-app waarschuwingen en badges aan</label><label class="checkbox-row"><input type="checkbox" data-setting="soundEnabled" ${state.settings.soundEnabled ? 'checked' : ''}>Geluid aan</label><button type="button" data-request-notifications>Notificaties toestaan</button><p class="muted small">Meldingen verschijnen 5 minuten voor terugkomst, op terugkomsttijd en 5, 10 en 15 minuten te laat. Als browsermeldingen niet werken, blijven in-app waarschuwingen zichtbaar.</p></div>
    <div class="card"><div class="card-title"><h3>Gegevens</h3></div><div class="row"><button type="button" data-export>JSON export</button><button class="secondary" type="button" data-import>JSON import</button><button class="danger" type="button" data-reset>Reset</button></div></div><div class="card compact"><p class="muted small">Copyright © 2026 Abel Doolaard · All Rights Reserved · source-available.</p></div>`;
}

function stat(label, value) { return `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`; }

function renderBlocks(employee) {
  const total = Math.ceil(employee.requiredBreakMinutes / FIFTEEN);
  const done = Math.floor(completedMinutes(employee.id) / FIFTEEN);
  const active = Math.ceil(activeMinutes(employee.id) / FIFTEEN);
  return `<div class="blocks" aria-label="Pauzeblokjes">${Array.from({ length: total }, (_, index) => `<span class="block ${index < done ? 'done' : index < done + active ? 'active' : ''}"></span>`).join('')}</div>`;
}

function renderHistory(employeeId) {
  const rows = getEmployeeBreaks(employeeId).filter((entry) => entry.endedAt);
  if (!rows.length) return '<div class="empty">Nog geen pauzegeschiedenis.</div>';
  return `<div class="grid">${rows.map((entry) => { const delta = minutesBetween(entry.expectedReturnAt, entry.endedAt); return `<div class="history-row small"><strong>${formatTime(entry.startedAt)} - ${formatTime(entry.endedAt)}</strong><span>Gepland terug: ${formatTime(entry.expectedReturnAt)} · Werkelijk: ${formatTime(entry.endedAt)}</span><span class="${delta > 0 ? 'late-text' : ''}">${delta === 0 ? 'Op tijd' : delta > 0 ? `+${delta} minuten te laat` : `${Math.abs(delta)} minuten te vroeg`}</span></div>`; }).join('')}</div>`;
}

function canStartBreak(employee, duration) {
  const event = activeEvent();
  return remainingMinutes(employee) >= duration && !getActiveBreak(employee.id) && getActiveBreaks().length < event.maxConcurrentBreaks;
}

function startBreak(employeeId, duration) {
  const event = activeEvent();
  const employee = event.employees.find((item) => item.id === employeeId);
  if (!employee || !canStartBreak(employee, duration)) return false;
  const startedAt = now();
  event.breaks.push({ id: uid('break'), employeeId, startedAt: startedAt.toISOString(), plannedMinutes: duration, expectedReturnAt: addMinutes(startedAt, duration).toISOString(), endedAt: null, minutesLate: null, notificationsSent: [], alertsSent: [] });
  state.ui.drafts.lastBreakDuration = duration;
  return true;
}

function returnBreak(breakId) {
  const entry = activeEvent().breaks.find((item) => item.id === breakId);
  if (!entry || entry.endedAt) return;
  const endedAt = now();
  entry.endedAt = endedAt.toISOString();
  entry.minutesLate = minutesBetween(entry.expectedReturnAt, endedAt);
}

function addEmployee(formData) {
  const event = activeEvent();
  const shift = event.shifts.find((item) => item.id === formData.get('shiftId'));
  const name = formData.get('name').trim();
  if (!shift || !name) return;
  mutate(() => {
    event.employees.push({ id: uid('employee'), name, shiftId: shift.id, startTime: shift.startTime, endTime: shift.endTime, requiredBreakMinutes: Number(shift.defaultBreakMinutes) });
    state.ui.drafts.employee = { name: '', shiftId: shift.id };
    showToast('Medewerker toegevoegd. Shift is onthouden.');
  });
}

function addShift(formData) {
  const event = activeEvent();
  const shift = { id: uid('shift'), name: formData.get('name').trim(), startTime: formData.get('startTime'), endTime: formData.get('endTime'), defaultBreakMinutes: Number(formData.get('defaultBreakMinutes')) };
  if (!shift.name) return;
  mutate(() => {
    event.shifts.push(shift);
    state.ui.drafts.shift = { name: '', startTime: shift.startTime, endTime: shift.endTime, defaultBreakMinutes: shift.defaultBreakMinutes };
    state.ui.drafts.employee.shiftId = shift.id;
    showToast('Shift toegevoegd. Laatste waarden zijn onthouden.');
  });
}

function updateEvent(formData) {
  mutate(() => {
    const event = activeEvent();
    event.name = formData.get('name').trim();
    event.date = formData.get('date');
    event.maxConcurrentBreaks = Number(formData.get('maxConcurrentBreaks'));
    showToast('Evenement opgeslagen.');
  });
}

function createNewEvent(formData) {
  const name = formData.get('name').trim();
  if (!name) return;
  mutate(() => {
    const event = createEvent(name);
    activeBar().events.push(event);
    state.ui.activeEventId = event.id;
    state.ui.drafts.newEventName = '';
    state.ui.drafts.employee = { name: '', shiftId: event.shifts[0]?.id || '' };
    selectedEmployees.clear();
    showToast('Evenement aangemaakt.');
  });
}

function addBar(formData) {
  const name = formData.get('name').trim();
  if (!name) return;
  mutate(() => {
    const bar = createBar(name);
    state.bars.push(bar);
    state.ui.activeBarId = bar.id;
    state.ui.activeEventId = bar.events[0].id;
    state.ui.drafts.newBarName = '';
    selectedEmployees.clear();
    showBarSelector = false;
    showToast('Bar aangemaakt.');
  });
}

function selectBar(barId) {
  const bar = state.bars.find((item) => item.id === barId);
  if (!bar) return;
  mutate(() => {
    state.ui.activeBarId = bar.id;
    state.ui.activeEventId = (bar.events.find((event) => !event.archived) || bar.events[0]).id;
    selectedEmployees.clear();
    showBarSelector = false;
  });
}

function archiveEvent(eventId) {
  const event = activeBar().events.find((item) => item.id === eventId);
  if (!event) return;
  if (activeEvents().length <= 1) return showToast('Maak eerst een ander actief evenement aan.');
  mutate(() => {
    event.archived = true;
    event.archivedAt = now().toISOString();
    state.ui.activeEventId = activeEvents()[0].id;
    selectedEmployees.clear();
    showToast('Evenement gearchiveerd.');
  });
}

function restoreEvent(eventId) {
  mutate(() => {
    const event = activeBar().events.find((item) => item.id === eventId);
    if (!event) return;
    event.archived = false;
    event.archivedAt = null;
    state.ui.activeEventId = event.id;
    selectedEmployees.clear();
    showToast('Evenement teruggezet.');
  });
}

function deleteEvent(eventId) {
  const bar = activeBar();
  const event = bar.events.find((item) => item.id === eventId && item.archived);
  if (!event || !confirm(`Evenement "${event.name}" definitief verwijderen? Dit kan niet ongedaan gemaakt worden.`)) return;
  mutate(() => {
    bar.events = bar.events.filter((item) => item.id !== eventId);
    if (!bar.events.length) bar.events.push(createEvent('Nieuw evenement'));
    if (!bar.events.some((item) => item.id === state.ui.activeEventId)) state.ui.activeEventId = (bar.events.find((item) => !item.archived) || bar.events[0]).id;
    showToast('Evenement definitief verwijderd.');
  });
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `bhpauzes-v2-${formatDateInput()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      {
        const parsed = JSON.parse(reader.result);
        state = parsed?.bars ? normalizeState(parsed) : migrateV1(parsed);
      }
      selectedEmployees = new Set();
      render();
      showToast('Import voltooid.');
    } catch (error) {
      showToast('Import mislukt: geen geldige JSON.');
    }
  };
  reader.readAsText(file);
}

async function requestNotifications() {
  if (!('Notification' in window)) {
    mutate(() => { state.settings.notificationsEnabled = false; state.settings.inAppAlertsEnabled = true; });
    return showToast('Browsernotificaties niet beschikbaar. In-app waarschuwingen blijven actief.');
  }
  if (!window.isSecureContext) showToast('Browsernotificaties werken alleen via HTTPS of localhost.');
  const permission = await Notification.requestPermission();
  mutate(() => { state.settings.notificationsEnabled = permission === 'granted'; state.settings.inAppAlertsEnabled = true; });
  showToast(permission === 'granted' ? 'Notificaties toegestaan.' : 'Notificaties geweigerd. In-app waarschuwingen blijven actief.');
}

function scheduleNotificationChecks() {
  const browserReady = state.settings.notificationsEnabled && 'Notification' in window && Notification.permission === 'granted' && window.isSecureContext;
  let changed = false;
  getActiveBreaks().forEach((entry) => {
    const employee = activeEvent().employees.find((item) => item.id === entry.employeeId);
    const diff = minutesBetween(entry.expectedReturnAt, now());
    WARNING_OFFSETS.forEach((offset) => {
      if (diff >= offset && !(entry.alertsSent || []).includes(offset)) {
        entry.alertsSent = entry.alertsSent || [];
        entry.alertsSent.push(offset);
        changed = true;
        const body = notificationBody(employee?.name || 'Medewerker', offset);
        if (browserReady && !(entry.notificationsSent || []).includes(offset)) {
          entry.notificationsSent = entry.notificationsSent || [];
          entry.notificationsSent.push(offset);
          new Notification('BHPauzes', { body, icon: 'icons/icon.svg', badge: 'icons/icon.svg', tag: `bhpauzes-${entry.id}-${offset}` });
        }
        if (state.settings.inAppAlertsEnabled) showToast(body);
        if (state.settings.soundEnabled) beep();
      }
    });
  });
  if (changed) saveState();
}

function notificationBody(name, offset) {
  if (offset < 0) return `${name} moet over ${Math.abs(offset)} minuten terug zijn.`;
  if (offset === 0) return `${name} moet nu terugkomen.`;
  return `${name} is ${offset} minuten te laat.`;
}

function notificationStatusLabel() {
  if (!('Notification' in window)) return 'niet ondersteund';
  if (!window.isSecureContext) return 'HTTPS nodig';
  return Notification.permission;
}

function notificationHint() {
  if (!('Notification' in window)) return '<div class="alert">Browsernotificaties zijn niet beschikbaar in deze browser. BHPauzes gebruikt in-app waarschuwingen, badges en eventueel geluid als fallback.</div>';
  if (!window.isSecureContext) return '<div class="alert">Open de app via HTTPS (zoals GitHub Pages) of localhost om browsernotificaties te gebruiken.</div>';
  if (Notification.permission === 'denied') return '<div class="alert">Notificaties zijn geweigerd. Zet ze aan in de browserinstellingen of gebruik de in-app waarschuwingen.</div>';
  return '<div class="alert ok">Browser ondersteunt notificaties. Vraag toestemming bij eerste gebruik.</div>';
}

function beep() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.frequency.value = 880;
  gain.gain.value = 0.04;
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.15);
}

function setTab(tab, shouldRender = true) {
  if (!PANELS.includes(tab)) return;
  state.ui.activeTab = tab;
  PANELS.forEach((panel) => {
    $(`#${panel}`)?.classList.toggle('active', panel === tab);
    $(`[data-tab="${panel}"]`)?.classList.toggle('active', panel === tab);
  });
  saveState();
  if (shouldRender) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateDraft(form) {
  const data = new FormData(form);
  if (form.id === 'employeeForm') state.ui.drafts.employee = { name: data.get('name'), shiftId: data.get('shiftId') };
  if (form.id === 'shiftForm') state.ui.drafts.shift = { name: data.get('name'), startTime: data.get('startTime'), endTime: data.get('endTime'), defaultBreakMinutes: Number(data.get('defaultBreakMinutes')) };
  if (form.id === 'newEventForm') state.ui.drafts.newEventName = data.get('name');
  if (form.id === 'barForm') state.ui.drafts.newBarName = data.get('name');
  saveState();
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
const escapeAttr = escapeHtml;

function bindEvents() {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.tab) setTab(target.dataset.tab);
    if (target.dataset.selectBar) selectBar(target.dataset.selectBar);
    if (target.dataset.openBarSelector !== undefined) { showBarSelector = true; render(); }
    if (target.dataset.bulkStart) mutate(() => { let started = 0; Array.from(selectedEmployees).forEach((id) => { if (startBreak(id, Number(target.dataset.bulkStart))) started += 1; }); showToast(`${started} pauze(s) gestart.`); });
    if (target.dataset.startBreak) mutate(() => { startBreak(target.dataset.startBreak, Number(target.dataset.duration)); });
    if (target.dataset.returnBreak) mutate(() => { returnBreak(target.dataset.returnBreak); showToast('Medewerker teruggemeld.'); });
    if (target.dataset.clearSelection !== undefined) { selectedEmployees.clear(); render(); }
    if (target.dataset.deleteEmployee) mutate(() => { const event = activeEvent(); event.employees = event.employees.filter((employee) => employee.id !== target.dataset.deleteEmployee); event.breaks = event.breaks.filter((entry) => entry.employeeId !== target.dataset.deleteEmployee); selectedEmployees.delete(target.dataset.deleteEmployee); });
    if (target.dataset.deleteShift) mutate(() => { const event = activeEvent(); if (event.employees.some((employee) => employee.shiftId === target.dataset.deleteShift)) return showToast('Shift is nog in gebruik.'); event.shifts = event.shifts.filter((shift) => shift.id !== target.dataset.deleteShift); });
    if (target.dataset.archiveEvent) archiveEvent(target.dataset.archiveEvent);
    if (target.dataset.restoreEvent) restoreEvent(target.dataset.restoreEvent);
    if (target.dataset.deleteEvent) deleteEvent(target.dataset.deleteEvent);
    if (target.dataset.export !== undefined) exportJson();
    if (target.dataset.import !== undefined) $('#importFile').click();
    if (target.dataset.reset !== undefined && confirm('Alle lokale gegevens wissen?')) mutate(() => { state = createDefaultState(); selectedEmployees.clear(); });
    if (target.dataset.requestNotifications !== undefined) requestNotifications();
    if (target.id === 'installBtn' && deferredInstallPrompt) { deferredInstallPrompt.prompt(); deferredInstallPrompt = null; target.classList.add('hidden'); }
  });

  document.addEventListener('input', (event) => {
    const form = event.target.closest('form');
    if (form) updateDraft(form);
  });

  document.addEventListener('change', (event) => {
    if (event.target.dataset.selectEmployee) {
      event.target.checked ? selectedEmployees.add(event.target.dataset.selectEmployee) : selectedEmployees.delete(event.target.dataset.selectEmployee);
      renderBreaks();
    }
    if (event.target.dataset.setting) mutate(() => { state.settings[event.target.dataset.setting] = event.target.checked; });
    if (event.target.dataset.activeEvent) mutate(() => { state.ui.activeEventId = event.target.value; selectedEmployees.clear(); });
    const form = event.target.closest('form');
    if (form) updateDraft(form);
  });

  document.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.id === 'employeeForm') addEmployee(new FormData(event.target));
    if (event.target.id === 'shiftForm') addShift(new FormData(event.target));
    if (event.target.id === 'eventForm') updateEvent(new FormData(event.target));
    if (event.target.id === 'newEventForm') createNewEvent(new FormData(event.target));
    if (event.target.id === 'barForm') addBar(new FormData(event.target));
    if (event.target.id === 'barNameForm') mutate(() => { activeBar().name = new FormData(event.target).get('name').trim(); showToast('Bar opgeslagen.'); });
  });

  $('#importFile').addEventListener('change', (event) => {
    if (event.target.files?.[0]) importJson(event.target.files[0]);
    event.target.value = '';
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $('#installBtn').classList.remove('hidden');
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

bindEvents();
render();
setInterval(() => render({ keepFormFocus: true }), 30000);
