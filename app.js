/* BHPauzes - Copyright © 2026 Abel Doolaard. All Rights Reserved. */
const STORAGE_KEY = 'bhpauzes.state.v1';
const FIFTEEN = 15;
const NOTIFICATION_OFFSETS = [-5, 0, 5, 10];

const $ = (selector) => document.querySelector(selector);
const panels = ['dashboard', 'breaks', 'employees', 'shifts', 'settings'];
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

function createDefaultState() {
  const morningId = uid('shift');
  const afternoonId = uid('shift');
  return {
    version: 1,
    event: {
      name: 'Nieuw evenement',
      date: formatDateInput(),
      maxConcurrentBreaks: 3,
    },
    shifts: [
      { id: morningId, name: 'Ochtend', startTime: '08:00', endTime: '17:00', defaultBreakMinutes: 60 },
      { id: afternoonId, name: 'Middag', startTime: '10:00', endTime: '19:00', defaultBreakMinutes: 60 },
    ],
    employees: [],
    breaks: [],
    notifications: [],
    settings: { notificationsEnabled: false, soundEnabled: false },
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : createDefaultState();
  } catch (error) {
    console.error(error);
    return createDefaultState();
  }
}

function normalizeState(data) {
  const fallback = createDefaultState();
  return {
    ...fallback,
    ...data,
    event: { ...fallback.event, ...(data.event || {}) },
    shifts: Array.isArray(data.shifts) ? data.shifts : fallback.shifts,
    employees: Array.isArray(data.employees) ? data.employees : [],
    breaks: Array.isArray(data.breaks) ? data.breaks : [],
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
    settings: { ...fallback.settings, ...(data.settings || {}) },
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function mutate(callback) {
  callback();
  saveState();
  render();
}

function getShift(employee) {
  return state.shifts.find((shift) => shift.id === employee.shiftId);
}

function getEmployeeBreaks(employeeId) {
  return state.breaks.filter((entry) => entry.employeeId === employeeId).sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
}

function getActiveBreak(employeeId) {
  return state.breaks.find((entry) => entry.employeeId === employeeId && !entry.endedAt);
}

function getActiveBreaks() {
  return state.breaks.filter((entry) => !entry.endedAt).sort((a, b) => new Date(a.expectedReturnAt) - new Date(b.expectedReturnAt));
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
  const totalRequired = state.employees.reduce((sum, employee) => sum + employee.requiredBreakMinutes, 0);
  const totalCompleted = state.employees.reduce((sum, employee) => sum + completedMinutes(employee.id), 0);
  const complete = state.employees.filter((employee) => remainingMinutes(employee) === 0).length;
  const partial = state.employees.filter((employee) => completedMinutes(employee.id) > 0 && remainingMinutes(employee) > 0).length;
  const none = state.employees.filter((employee) => completedMinutes(employee.id) === 0 && !getActiveBreak(employee.id)).length;
  const late = getActiveBreaks().filter((entry) => new Date(entry.expectedReturnAt) < now()).length;
  const percentage = totalRequired ? Math.round((totalCompleted / totalRequired) * 100) : 0;
  const status = late > 0 || percentage < expectedProgressPercentage() - 20 ? 'Achter op schema' : percentage < expectedProgressPercentage() - 8 ? 'Let op' : 'Op schema';
  return { totalRequired, totalCompleted, complete, partial, none, late, percentage: clamp(percentage, 0, 100), status };
}

function expectedProgressPercentage() {
  if (!state.employees.length) return 0;
  const shiftValues = state.employees.map((employee) => {
    const shift = getShift(employee);
    if (!shift) return 0;
    const start = timeToMinutes(shift.startTime);
    const end = timeToMinutes(shift.endTime);
    const current = now().getHours() * 60 + now().getMinutes();
    return clamp(((current - start) / Math.max(1, end - start)) * 100, 0, 100);
  });
  return shiftValues.reduce((sum, value) => sum + value, 0) / shiftValues.length;
}

function adviceList() {
  const activeCount = getActiveBreaks().length;
  const room = Math.max(0, state.event.maxConcurrentBreaks - activeCount);
  if (!room) return [];
  const current = now();
  return state.employees
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

function render() {
  renderDashboard();
  renderBreaks();
  renderEmployees();
  renderShifts();
  renderSettings();
  scheduleNotificationChecks();
}

function renderDashboard() {
  const stats = progressStats();
  const statusClass = stats.status === 'Op schema' ? 'status-ok' : stats.status === 'Let op' ? 'status-warn' : 'status-late';
  const advice = adviceList();
  $('#dashboard').innerHTML = `
    <div class="card">
      <div class="card-title">
        <div><h2>${escapeHtml(state.event.name)}</h2><p class="muted small">${state.event.date} · max. ${state.event.maxConcurrentBreaks} tegelijk op pauze</p></div>
        <span class="status-pill ${statusClass}">${stats.status}</span>
      </div>
      <div class="grid two four">
        ${stat('Medewerkers', state.employees.length)}
        ${stat('Volledig klaar', stats.complete)}
        ${stat('Gedeeltelijk klaar', stats.partial)}
        ${stat('Zonder pauze', stats.none)}
      </div>
    </div>
    <div class="desktop-columns">
      <div>
        <div class="card">
          <div class="card-title"><h3>Voortgang</h3><strong>${stats.percentage}%</strong></div>
          <div class="progress-wrap"><div class="progress-bar" style="width:${stats.percentage}%"></div></div>
          <p class="muted small">${stats.totalCompleted} van ${stats.totalRequired} geplande pauzeminuten afgerond.</p>
        </div>
        <div class="card">
          <div class="grid two">
            ${stat('Actieve pauzes', getActiveBreaks().length)}
            ${stat('Te laat terug', stats.late)}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title"><h3>Slim pauzeadvies</h3><span class="pill">ruimte: ${Math.max(0, state.event.maxConcurrentBreaks - getActiveBreaks().length)}</span></div>
        ${advice.length ? advice.map((item, index) => `
          <div class="advice-item">
            <div class="row between"><strong>${index + 1}. ${escapeHtml(item.employee.name)}</strong><span class="pill">${remainingMinutes(item.employee)} min over</span></div>
            <p class="muted small">${item.workedMinutes} minuten gewerkt sinds laatste pauze.</p>
          </div>`).join('') : '<div class="empty">Geen advies beschikbaar. Voeg medewerkers toe of wacht tot er pauzeruimte is.</div>'}
      </div>
    </div>`;
}

function renderBreaks() {
  const active = getActiveBreaks();
  const selected = state.employees.filter((employee) => selectedEmployees.has(employee.id));
  $('#breaks').innerHTML = `
    <div class="card">
      <div class="card-title"><h2>Pauzes</h2><span class="pill">${active.length}/${state.event.maxConcurrentBreaks} actief</span></div>
      <div class="row">
        ${[15, 30, 45, 60].map((duration) => `<button type="button" data-bulk-start="${duration}" ${selected.length ? '' : 'disabled'}>${duration} min</button>`).join('')}
      </div>
      <p class="muted small">Geselecteerd: ${selected.length ? selected.map((employee) => escapeHtml(employee.name)).join(', ') : 'geen medewerkers'}</p>
    </div>
    <div class="card">
      <div class="card-title"><h3>Actieve pauzes</h3><span class="pill">nu</span></div>
      <div class="grid">${active.length ? active.map(renderActiveBreak).join('') : '<div class="empty">Niemand is momenteel op pauze.</div>'}</div>
    </div>
    <div class="card">
      <div class="card-title"><h3>Alle medewerkers</h3><button class="light" type="button" data-clear-selection>Wis selectie</button></div>
      <div class="grid">${state.employees.length ? state.employees.map(renderEmployeeBreakRow).join('') : '<div class="empty">Voeg eerst medewerkers toe.</div>'}</div>
    </div>`;
}

function renderEmployeeBreakRow(employee) {
  return `<div class="employee">
    <div class="employee-head">
      <label class="checkbox-row"><input type="checkbox" data-select-employee="${employee.id}" ${selectedEmployees.has(employee.id) ? 'checked' : ''}><span class="employee-name">${escapeHtml(employee.name)}</span></label>
      <span class="pill">${remainingMinutes(employee)} min over</span>
    </div>
    ${renderBlocks(employee)}
    <div class="row">
      ${[15, 30].map((duration) => `<button class="light" type="button" data-start-break="${employee.id}" data-duration="${duration}" ${canStartBreak(employee, duration) ? '' : 'disabled'}>${duration} min</button>`).join('')}
      <button class="light" type="button" data-history="${employee.id}">Historie</button>
    </div>
  </div>`;
}

function renderActiveBreak(entry) {
  const employee = state.employees.find((item) => item.id === entry.employeeId);
  const remaining = Math.ceil((new Date(entry.expectedReturnAt) - now()) / 60000);
  const color = remaining < 0 ? 'red' : remaining <= 5 ? 'orange' : 'green';
  return `<div class="active-break ${color}">
    <div class="row between"><strong>${escapeHtml(employee?.name || 'Onbekend')}</strong><span class="pill">${remaining < 0 ? `+${Math.abs(remaining)} min te laat` : `${remaining} min over`}</span></div>
    <div class="grid three">
      <span><b>Start</b><br>${formatTime(entry.startedAt)}</span>
      <span><b>Terug</b><br>${formatTime(entry.expectedReturnAt)}</span>
      <span><b>Duur</b><br>${entry.plannedMinutes} min</span>
    </div>
    <button type="button" data-return-break="${entry.id}">✓ Terug</button>
  </div>`;
}

function renderEmployees() {
  $('#employees').innerHTML = `
    <div class="card">
      <div class="card-title"><h2>Medewerkers</h2><span class="pill">${state.employees.length}</span></div>
      <form id="employeeForm" class="form">
        <label>Naam<input name="name" required placeholder="Bijv. Lisa"></label>
        <label>Shift<select name="shiftId" required>${state.shifts.map((shift) => `<option value="${shift.id}">${escapeHtml(shift.name)} (${shift.startTime}-${shift.endTime})</option>`).join('')}</select></label>
        <button type="submit">Medewerker toevoegen</button>
      </form>
    </div>
    <div class="grid">${state.employees.length ? state.employees.map((employee) => {
      const shift = getShift(employee);
      return `<div class="employee">
        <div class="employee-head"><div><div class="employee-name">${escapeHtml(employee.name)}</div><p class="muted small">${escapeHtml(shift?.name || 'Geen shift')} · ${employee.startTime}-${employee.endTime} · ${employee.requiredBreakMinutes} min pauze</p></div><button class="danger" type="button" data-delete-employee="${employee.id}">Verwijder</button></div>
        ${renderBlocks(employee)}
        ${renderHistory(employee.id)}
      </div>`;
    }).join('') : '<div class="card empty">Nog geen medewerkers.</div>'}</div>`;
}

function renderShifts() {
  $('#shifts').innerHTML = `
    <div class="card">
      <div class="card-title"><h2>Shifts</h2><span class="pill">${state.shifts.length}</span></div>
      <form id="shiftForm" class="form">
        <label>Naam<input name="name" required placeholder="Bijv. Avond"></label>
        <div class="grid two"><label>Starttijd<input name="startTime" type="time" required value="12:00"></label><label>Eindtijd<input name="endTime" type="time" required value="18:00"></label></div>
        <label>Standaard pauzeduur<select name="defaultBreakMinutes">${[30,45,60,75,90].map((m) => `<option value="${m}">${m} minuten</option>`).join('')}</select></label>
        <button type="submit">Shift toevoegen</button>
      </form>
    </div>
    <div class="grid">${state.shifts.map((shift) => `<div class="shift-card">
      <div class="row between"><strong>${escapeHtml(shift.name)}</strong><button class="danger" type="button" data-delete-shift="${shift.id}">Verwijder</button></div>
      <p class="muted">${shift.startTime} - ${shift.endTime} · ${shift.defaultBreakMinutes} minuten pauze</p>
    </div>`).join('')}</div>`;
}

function renderSettings() {
  $('#settings').innerHTML = `
    <div class="card">
      <div class="card-title"><h2>Instellingen</h2></div>
      <form id="eventForm" class="form">
        <label>Evenementnaam<input name="name" required value="${escapeAttr(state.event.name)}"></label>
        <label>Datum<input name="date" type="date" required value="${state.event.date}"></label>
        <label>Maximale gelijktijdige pauzes<input name="maxConcurrentBreaks" type="number" min="1" max="40" required value="${state.event.maxConcurrentBreaks}"></label>
        <button type="submit">Evenement opslaan</button>
      </form>
    </div>
    <div class="card">
      <div class="card-title"><h3>Notificaties</h3><span class="pill">${'Notification' in window ? Notification.permission : 'niet ondersteund'}</span></div>
      <label class="checkbox-row"><input type="checkbox" data-setting="notificationsEnabled" ${state.settings.notificationsEnabled ? 'checked' : ''}>Browser notificaties aan</label>
      <label class="checkbox-row"><input type="checkbox" data-setting="soundEnabled" ${state.settings.soundEnabled ? 'checked' : ''}>Geluid aan</label>
      <button type="button" data-request-notifications>Notificaties toestaan</button>
      <p class="muted small">Meldingen verschijnen 5 minuten voor terugkomst, op terugkomsttijd, 5 en 10 minuten te laat.</p>
    </div>
    <div class="card">
      <div class="card-title"><h3>Gegevens</h3></div>
      <div class="row"><button type="button" data-export>JSON export</button><button class="secondary" type="button" data-import>JSON import</button><button class="danger" type="button" data-reset>Reset</button></div>
    </div>
    <div class="card compact"><p class="muted small">Copyright © 2026 Abel Doolaard · All Rights Reserved · source-available.</p></div>`;
}

function stat(label, value) {
  return `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`;
}

function renderBlocks(employee) {
  const total = Math.ceil(employee.requiredBreakMinutes / FIFTEEN);
  const done = Math.floor(completedMinutes(employee.id) / FIFTEEN);
  const active = Math.ceil(activeMinutes(employee.id) / FIFTEEN);
  return `<div class="blocks" aria-label="Pauzeblokjes">${Array.from({ length: total }, (_, index) => {
    const cls = index < done ? 'done' : index < done + active ? 'active' : '';
    return `<span class="block ${cls}" title="${cls || 'niet gestart'}"></span>`;
  }).join('')}</div>`;
}

function renderHistory(employeeId) {
  const rows = getEmployeeBreaks(employeeId).filter((entry) => entry.endedAt);
  if (!rows.length) return '<div class="empty">Nog geen pauzegeschiedenis.</div>';
  return `<div class="grid">${rows.map((entry) => {
    const delta = minutesBetween(entry.expectedReturnAt, entry.endedAt);
    return `<div class="history-row small">
      <strong>${formatTime(entry.startedAt)} - ${formatTime(entry.endedAt)}</strong>
      <span>Gepland terug: ${formatTime(entry.expectedReturnAt)} · Werkelijk: ${formatTime(entry.endedAt)}</span>
      <span class="${delta > 0 ? 'late-text' : ''}">${delta === 0 ? 'Op tijd' : delta > 0 ? `+${delta} minuten te laat` : `${Math.abs(delta)} minuten te vroeg`}</span>
    </div>`;
  }).join('')}</div>`;
}

function canStartBreak(employee, duration) {
  return remainingMinutes(employee) >= duration && !getActiveBreak(employee.id) && getActiveBreaks().length < state.event.maxConcurrentBreaks;
}

function startBreak(employeeId, duration) {
  const employee = state.employees.find((item) => item.id === employeeId);
  if (!employee || !canStartBreak(employee, duration)) return false;
  const startedAt = now();
  const expectedReturnAt = addMinutes(startedAt, duration);
  state.breaks.push({ id: uid('break'), employeeId, startedAt: startedAt.toISOString(), plannedMinutes: duration, expectedReturnAt: expectedReturnAt.toISOString(), endedAt: null, minutesLate: null, notificationsSent: [] });
  return true;
}

function returnBreak(breakId) {
  const entry = state.breaks.find((item) => item.id === breakId);
  if (!entry || entry.endedAt) return;
  const endedAt = now();
  entry.endedAt = endedAt.toISOString();
  entry.minutesLate = minutesBetween(entry.expectedReturnAt, endedAt);
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `bhpauzes-${state.event.date || 'event'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = normalizeState(JSON.parse(reader.result));
      selectedEmployees = new Set();
      saveState();
      render();
      showToast('Import voltooid.');
    } catch (error) {
      showToast('Import mislukt: geen geldige JSON.');
    }
  };
  reader.readAsText(file);
}

function scheduleNotificationChecks() {
  if (!state.settings.notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  const current = now();
  let changed = false;
  getActiveBreaks().forEach((entry) => {
    const employee = state.employees.find((item) => item.id === entry.employeeId);
    const diff = minutesBetween(entry.expectedReturnAt, current);
    NOTIFICATION_OFFSETS.forEach((offset) => {
      if (diff >= offset && !entry.notificationsSent.includes(offset)) {
        entry.notificationsSent.push(offset);
        changed = true;
        const body = offset < 0 ? `${employee?.name} moet over ${Math.abs(offset)} minuten terug zijn.` : offset === 0 ? `${employee?.name} moet nu terugkomen.` : `${employee?.name} is ${offset} minuten te laat.`;
        new Notification('BHPauzes', { body, icon: 'icons/icon.svg' });
        if (state.settings.soundEnabled) beep();
      }
    });
  });
  if (changed) saveState();
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

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
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
    if (target.dataset.bulkStart) {
      const duration = Number(target.dataset.bulkStart);
      mutate(() => {
        let started = 0;
        Array.from(selectedEmployees).forEach((id) => { if (startBreak(id, duration)) started += 1; });
        showToast(`${started} pauze(s) gestart.`);
      });
    }
    if (target.dataset.startBreak) mutate(() => { startBreak(target.dataset.startBreak, Number(target.dataset.duration)); });
    if (target.dataset.returnBreak) mutate(() => { returnBreak(target.dataset.returnBreak); showToast('Medewerker teruggemeld.'); });
    if (target.dataset.clearSelection !== undefined) { selectedEmployees.clear(); render(); }
    if (target.dataset.deleteEmployee) mutate(() => {
      state.employees = state.employees.filter((employee) => employee.id !== target.dataset.deleteEmployee);
      state.breaks = state.breaks.filter((entry) => entry.employeeId !== target.dataset.deleteEmployee);
      selectedEmployees.delete(target.dataset.deleteEmployee);
    });
    if (target.dataset.deleteShift) mutate(() => {
      if (state.employees.some((employee) => employee.shiftId === target.dataset.deleteShift)) return showToast('Shift is nog in gebruik.');
      state.shifts = state.shifts.filter((shift) => shift.id !== target.dataset.deleteShift);
    });
    if (target.dataset.export !== undefined) exportJson();
    if (target.dataset.import !== undefined) $('#importFile').click();
    if (target.dataset.reset !== undefined && confirm('Alle lokale gegevens wissen?')) mutate(() => { state = createDefaultState(); selectedEmployees.clear(); });
    if (target.dataset.requestNotifications !== undefined) requestNotifications();
    if (target.id === 'installBtn' && deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt = null;
      target.classList.add('hidden');
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.dataset.selectEmployee) {
      event.target.checked ? selectedEmployees.add(event.target.dataset.selectEmployee) : selectedEmployees.delete(event.target.dataset.selectEmployee);
      renderBreaks();
    }
    if (event.target.dataset.setting) mutate(() => { state.settings[event.target.dataset.setting] = event.target.checked; });
  });

  document.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.id === 'employeeForm') addEmployee(new FormData(event.target));
    if (event.target.id === 'shiftForm') addShift(new FormData(event.target));
    if (event.target.id === 'eventForm') updateEvent(new FormData(event.target));
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

function addEmployee(formData) {
  const shift = state.shifts.find((item) => item.id === formData.get('shiftId'));
  if (!shift) return;
  mutate(() => {
    state.employees.push({ id: uid('employee'), name: formData.get('name').trim(), shiftId: shift.id, startTime: shift.startTime, endTime: shift.endTime, requiredBreakMinutes: Number(shift.defaultBreakMinutes) });
    showToast('Medewerker toegevoegd.');
  });
}

function addShift(formData) {
  mutate(() => {
    state.shifts.push({ id: uid('shift'), name: formData.get('name').trim(), startTime: formData.get('startTime'), endTime: formData.get('endTime'), defaultBreakMinutes: Number(formData.get('defaultBreakMinutes')) });
    showToast('Shift toegevoegd.');
  });
}

function updateEvent(formData) {
  mutate(() => {
    state.event.name = formData.get('name').trim();
    state.event.date = formData.get('date');
    state.event.maxConcurrentBreaks = Number(formData.get('maxConcurrentBreaks'));
    showToast('Evenement opgeslagen.');
  });
}

async function requestNotifications() {
  if (!('Notification' in window)) return showToast('Notificaties worden niet ondersteund.');
  const permission = await Notification.requestPermission();
  mutate(() => { state.settings.notificationsEnabled = permission === 'granted'; });
  showToast(permission === 'granted' ? 'Notificaties toegestaan.' : 'Notificaties geweigerd.');
}

function setTab(tab) {
  panels.forEach((panel) => {
    $(`#${panel}`).classList.toggle('active', panel === tab);
    $(`[data-tab="${panel}"]`).classList.toggle('active', panel === tab);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

bindEvents();
render();
setInterval(render, 30000);
