Auth.requireLogin();

const ACADEMY_NAME = 'Westford Sports - Indian Academy';
const SESSION_OPTIONS = [8, 12, 16, 24];
const SPORTS = ['badminton', 'football', 'cricket', 'swimming'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

let currentUser = null;
let trainersCache = [];
let feeMatrixCache = null;
let scheduleCache = {}; // activity -> { day: [{label, restrictedToTrainers}] }
let currentPhotoDataUrl = null;

/* Reads an image file, downsizes it to fit within maxW x maxH, and returns a compressed
   JPEG data URL - keeps profile pictures small whether stored in the DB (registration)
   or sent over the wire (attendance-table photo change). */
function resizeImageFile(file, maxW = 240, maxH = 240, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not load that image.'));
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width, maxH / img.height);
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------------- Shell: header, tabs, auth ---------------- */

function initShell() {
  currentUser = Auth.getUser();
  document.getElementById('whoAmI').textContent =
    `Signed in as ${currentUser.username} (${currentUser.role === 'admin' ? 'Main Admin' : 'Trainer'})`;

  if (currentUser.role !== 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.remove());
  }

  document.getElementById('logoutBtn').addEventListener('click', () => Auth.logout());

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Trainers have no Registration tab (removed above), so their default view is Attendance.
  if (currentUser.role === 'trainer') {
    switchTab('attendance');
  }
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));
  if (tab === 'attendance') loadStudents();
  if (tab === 'schedule') loadScheduleConfig();
  if (tab === 'fees') loadFees();
  if (tab === 'trainers') loadTrainers();
}

function escapeHtml(x) { return String(x ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function capitalize(x) { return x ? x.charAt(0).toUpperCase() + x.slice(1) : ''; }

/* ---------------- Registration form ---------------- */

async function initRegistrationForm() {
  trainersCache = await api('/trainers');
  feeMatrixCache = await api('/fees');

  document.getElementById('sport').addEventListener('change', onSportChange);
  document.getElementById('trainer').addEventListener('change', updateScheduleRows);
  document.getElementById('dob').addEventListener('change', onDobChange);
  document.getElementById('registrationType').addEventListener('change', onRegTypeChange);
  document.getElementById('sessionCount').addEventListener('change', updateFeeDisplay);
  document.getElementById('discountCard').addEventListener('change', updateFeeDisplay);
  document.getElementById('photoInput').addEventListener('change', onPhotoInputChange);

  // A trainer login can only register students under their own activity/name -
  // lock the Activity dropdown to their assigned activity so this is clear up front
  // rather than only being enforced silently on submit.
  if (currentUser.role === 'trainer' && currentUser.trainerActivity) {
    const sportSelect = document.getElementById('sport');
    [...sportSelect.options].forEach(o => { if (o.value && o.value !== currentUser.trainerActivity) o.remove(); });
    sportSelect.value = currentUser.trainerActivity;
    sportSelect.disabled = true;
    await onSportChange();
  }

  buildDayCheckboxes();
  onRegTypeChange();
  document.getElementById('regForm').addEventListener('submit', submitRegistration);
}

async function onPhotoInputChange(e) {
  const file = e.target.files[0];
  const wrap = document.getElementById('photoPreviewWrap');
  if (!file) { currentPhotoDataUrl = null; wrap.classList.add('hidden'); return; }
  try {
    currentPhotoDataUrl = await resizeImageFile(file);
    document.getElementById('photoPreview').src = currentPhotoDataUrl;
    wrap.classList.remove('hidden');
  } catch (err) {
    alert(err.message);
    e.target.value = '';
    currentPhotoDataUrl = null;
    wrap.classList.add('hidden');
  }
}

function buildDayCheckboxes() {
  const box = document.getElementById('dayCheckboxes');
  box.innerHTML = DAYS.map(d => `<label><input type="checkbox" value="${d}"> ${d}</label>`).join('');
  box.querySelectorAll('input').forEach(cb => cb.addEventListener('change', updateScheduleRows));
}

function onRegTypeChange() {
  const isTrial = document.getElementById('registrationType').value === 'Trial';
  const group = document.getElementById('referredByGroup');
  group.style.display = isTrial ? '' : 'none';
  document.getElementById('referredBy').required = isTrial;
  if (!isTrial) document.getElementById('referredBy').value = '';
}

function onDobChange() {
  const dob = document.getElementById('dob').value;
  document.getElementById('age').value = dob ? computeAgeClient(dob) : '';
}

function computeAgeClient(dobStr, asOf = new Date()) {
  const dob = new Date(dobStr);
  if (isNaN(dob)) return '';
  let age = asOf.getFullYear() - dob.getFullYear();
  const m = asOf.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && asOf.getDate() < dob.getDate())) age--;
  return age;
}

async function onSportChange() {
  const sport = document.getElementById('sport').value;
  const trainerSelect = document.getElementById('trainer');
  trainerSelect.innerHTML = '<option value="" disabled selected>Select trainer...</option>';
  const eligibleTrainers = currentUser.role === 'trainer'
    ? trainersCache.filter(t => t.activity === sport && t.active && t.id === currentUser.trainerId)
    : trainersCache.filter(t => t.activity === sport && t.active);
  eligibleTrainers.forEach(t => {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name; o.dataset.name = t.name;
    trainerSelect.appendChild(o);
  });
  if (currentUser.role === 'trainer' && eligibleTrainers.length === 1) {
    trainerSelect.value = eligibleTrainers[0].id;
    trainerSelect.disabled = true;
  }
  if (!scheduleCache[sport]) scheduleCache[sport] = await api(`/schedule/${sport}`);
  document.querySelectorAll('#dayCheckboxes input').forEach(cb => cb.checked = false);
  document.getElementById('scheduleRows').innerHTML = '';
  updateFeeDisplay();
}

function updateScheduleRows() {
  const sport = document.getElementById('sport').value;
  const trainerOpt = document.getElementById('trainer').selectedOptions[0];
  const trainerName = trainerOpt ? trainerOpt.dataset.name : '';
  const checked = [...document.querySelectorAll('#dayCheckboxes input:checked')].map(x => x.value);
  const slotsByDay = scheduleCache[sport] || {};

  document.getElementById('scheduleRows').innerHTML = checked.map(day => {
    const slots = (slotsByDay[day] || []).filter(s => !s.restrictedToTrainers || s.restrictedToTrainers.includes(trainerName));
    const opts = slots.map(s => `<option value="${escapeHtml(s.label)}">${escapeHtml(s.label)}</option>`).join('');
    return `<div class="schedule-row"><strong>${day}</strong>
      <select class="schedule-time" data-day="${day}" required>
        <option value="">Select time slot...</option>${opts}
      </select></div>`;
  }).join('');
}

function getScheduleFromForm() {
  return [...document.querySelectorAll('#scheduleRows .schedule-time')]
    .map(el => ({ day: el.dataset.day, time: el.value }))
    .filter(x => x.time);
}

function calcFeeClient(activity, sessions, discountCard, opts = {}) {
  const includeRegistrationFee = opts.includeRegistrationFee !== false;
  const matrixFee = (feeMatrixCache && activity && sessions && feeMatrixCache.matrix[activity]) ? Number(feeMatrixCache.matrix[activity][sessions] || 0) : 0;
  let regFee = 0, waiver = 0;
  if (includeRegistrationFee) {
    regFee = feeMatrixCache ? feeMatrixCache.registrationFee : 0;
    waiver = (discountCard === 'fazza' || discountCard === 'enbd') ? regFee : 0;
  }
  const netReg = regFee - waiver;
  const vat = matrixFee * 0.05;
  const total = matrixFee + netReg + vat;
  return { sessionFee: matrixFee, registrationFee: regFee, waiver, subtotal: matrixFee + netReg, vat, total };
}

function updateFeeDisplay() {
  if (!feeMatrixCache) return;
  const sport = document.getElementById('sport').value;
  const sessions = document.getElementById('sessionCount').value;
  const discountCard = document.getElementById('discountCard').value;
  const fee = calcFeeClient(sport, sessions, discountCard);
  document.getElementById('lblSessionFee').textContent = fee.sessionFee.toFixed(2) + ' AED';
  document.getElementById('lblRegFee').textContent = fee.registrationFee.toFixed(2) + ' AED';
  document.getElementById('lblWaiver').textContent = '-' + fee.waiver.toFixed(2) + ' AED';
  document.getElementById('lblSubtotal').textContent = fee.subtotal.toFixed(2) + ' AED';
  document.getElementById('lblVatFee').textContent = fee.vat.toFixed(2) + ' AED';
  document.getElementById('lblTotalFee').textContent = fee.total.toFixed(2) + ' AED';
}

async function submitRegistration(e) {
  e.preventDefault();
  const msg = document.getElementById('regMsg');
  msg.innerHTML = '';
  const trainerSelect = document.getElementById('trainer');
  const schedule = getScheduleFromForm();

  const payload = {
    fullName: document.getElementById('fullName').value.trim(),
    gender: document.getElementById('gender').value,
    dob: document.getElementById('dob').value,
    registrationType: document.getElementById('registrationType').value,
    referredBy: document.getElementById('referredBy').value.trim(),
    activity: document.getElementById('sport').value,
    trainerId: trainerSelect.value ? Number(trainerSelect.value) : null,
    schedule,
    sessionPackage: document.getElementById('sessionCount').value ? Number(document.getElementById('sessionCount').value) : null,
    additionalSessions: Number(document.getElementById('additionalSessions').value || 0),
    discountCard: document.getElementById('discountCard').value,
    cardNumber: document.getElementById('cardNumber').value.trim(),
    rrn: document.getElementById('rrn').value.trim(),
    phone: document.getElementById('phone').value.trim(),
    notes: document.getElementById('notes').value.trim(),
    photo: currentPhotoDataUrl || null
  };

  try {
    const result = await api('/students', { method: 'POST', body: payload });
    msg.innerHTML = `<div class="success-msg">Student registered successfully. Student ID: <strong>${result.studentCode}</strong></div>`;
    e.target.reset();
    document.getElementById('scheduleRows').innerHTML = '';
    document.querySelectorAll('#dayCheckboxes input').forEach(cb => cb.checked = false);
    currentPhotoDataUrl = null;
    document.getElementById('photoPreviewWrap').classList.add('hidden');
    onRegTypeChange();
    updateFeeDisplay();
  } catch (err) {
    msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

/* ---------------- Attendance & Renewals ---------------- */

async function loadStudents() {
  const body = document.getElementById('studentTableBody');
  body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#64748b;padding:20px">Loading…</td></tr>';
  const activity = document.getElementById('attendanceSportFilter').value;
  const search = document.getElementById('studentSearch').value;
  const params = new URLSearchParams({ activity, search });
  const students = await api(`/students?${params.toString()}`);

  if (!students.length) {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#64748b;padding:20px">No students found.</td></tr>';
    return;
  }

  body.innerHTML = students.map(s => {
    const used = s.attendance.filter(a => a.present === true).length;
    const pct = s.total_sessions ? Math.round((used / s.total_sessions) * 100) : 0;
    const scheduleText = (s.schedule || []).map(x => `${escapeHtml(x.day)}: ${escapeHtml(x.time)}`).join('<br>') || 'Not set';
    const rows = s.attendance.map((a, i) => {
      const slotOptions = (s.schedule || []).map(x => {
        const val = `${x.day}|${x.time}`;
        const selected = a.slot === val ? 'selected' : '';
        return `<option value="${escapeHtml(val)}" ${selected}>${escapeHtml(x.time)} (${escapeHtml(x.day)})</option>`;
      }).join('');
      return `<div class="attendance-row">
        <span class="session-no">#${i + 1}</span>
        <input type="date" value="${escapeHtml(a.date || '')}" onchange="updateAttendanceField(${s.id},${i},'date',this.value)">
        <select onchange="updateAttendanceField(${s.id},${i},'slot',this.value)">
          <option value="">Select time slot...</option>${slotOptions}
        </select>
        <div class="attendance-btn-row">
          <button type="button" class="attendance-btn ${a.present === true ? 'present' : ''}" onclick="markAttendance(${s.id},${i},true)">Present</button>
        </div>
      </div>`;
    }).join('');

    const badgeClass = s.registration_type === 'Trial' ? 'trial' : s.registration_type === 'Renewal' ? 'renewal' : 'newreg';
    const initial = (s.full_name || '?').trim().charAt(0).toUpperCase();
    const photoHtml = s.photo
      ? `<img src="${s.photo}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:50%;border:1px solid #cbd5e1">`
      : `<div style="width:44px;height:44px;border-radius:50%;background:#e2e8f0;color:#64748b;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px">${escapeHtml(initial)}</div>`;

    return `<tr>
      <td><strong>${escapeHtml(s.student_code)}</strong></td>
      <td>
        <div style="display:flex;gap:8px;align-items:flex-start">
          ${photoHtml}
          <div>
            ${escapeHtml(s.full_name)}<br><span class="small-note">Age ${s.age}, ${escapeHtml(s.gender)}</span><br>
            <label class="small-note" style="cursor:pointer;color:var(--primary-color)">${s.photo ? 'Change Photo' : 'Add Photo'}
              <input type="file" accept="image/*" class="hidden" onchange="handlePhotoChange(${s.id}, this)">
            </label>
          </div>
        </div>
      </td>
      <td>${capitalize(s.activity)}<br><span class="small-note">Trainer: ${escapeHtml(s.trainer_name)}</span><br><span class="small-note">${scheduleText}</span></td>
      <td><span class="badge ${badgeClass}">${escapeHtml(s.registration_type)}</span>${s.referred_by ? `<br><span class="small-note">Ref: ${escapeHtml(s.referred_by)}</span>` : ''}</td>
      <td>${used}/${s.total_sessions}<br><span class="small-note">Paid ${s.session_package} + Free ${s.additional_sessions}</span></td>
      <td>
        <div class="progress-bar"><div class="progress-fill ${pct >= 80 ? 'over80' : ''}" style="width:${pct}%"></div></div>
        <div class="progress-text">${pct}% (${used}/${s.total_sessions})</div>
        <div class="attendance-strip">${rows}</div>
      </td>
      <td>
        <button class="btn-secondary" onclick="openProfileModal(${s.id})">View Profile</button><br><br>
        <button class="btn-secondary" onclick="sendReminder(${s.id})">Reminder</button>
        ${currentUser.role === 'admin' ? `<br><br><button class="btn-success" onclick="openRenewModal(${s.id})">Renew</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  window._studentsCache = students;
}

async function updateAttendanceField(studentId, index, field, value) {
  await api(`/students/${studentId}/attendance/${index}`, { method: 'PUT', body: { [field]: value } });
}

async function markAttendance(studentId, index, present) {
  await api(`/students/${studentId}/attendance/${index}`, { method: 'PUT', body: { present } });
  loadStudents();
}

async function handlePhotoChange(studentId, inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImageFile(file);
    await api(`/students/${studentId}/photo`, { method: 'PUT', body: { photo: dataUrl } });
    loadStudents();
  } catch (err) {
    alert(err.message || 'Could not update the photo.');
  }
}

function sendReminder(studentId) {
  const s = (window._studentsCache || []).find(x => Number(x.id) === Number(studentId));
  if (!s) {
    alert('Could not find this student\'s details - try refreshing the Attendance tab and clicking Reminder again.');
    return;
  }
  const used = s.attendance.filter(a => a.present === true).length;
  const remaining = Math.max(0, s.total_sessions - used);
  const messageText = `Hello ${s.full_name},\n\nThis is a friendly reminder from ${ACADEMY_NAME}. Your ${capitalize(s.activity)} training package (${s.student_code}) has ${remaining} session(s) remaining. Please contact us to renew your sessions.\n\nThank you!`;

  let phone = (s.phone || '').replace(/[^0-9]/g, '');
  if (!phone) { alert('This student has no phone number on file.'); return; }
  if (phone.startsWith('00')) phone = phone.slice(2);
  if (phone.startsWith('0')) phone = '971' + phone.slice(1);
  else if (phone.length <= 9) phone = '971' + phone; // assume a local UAE mobile with no leading 0 / country code
  if (phone.length < 10 || phone.length > 15) {
    alert(`This student's phone number ("${s.phone}") doesn't look like a valid number once cleaned up ("${phone}"). Please check/update it before sending a reminder.`);
    return;
  }

  openWhatsAppLink(phone, messageText);
}

/* Opens a wa.me link via a real, temporary <a> click instead of window.open() -
   more reliably respected as a genuine user-initiated navigation across mobile
   browsers (Safari/Chrome on iOS in particular can silently swallow window.open
   in some contexts even from a direct click handler). */
function openWhatsAppLink(phone, messageText) {
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(messageText)}`;
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function openProfileModal(studentId) {
  const s = (window._studentsCache || []).find(x => Number(x.id) === Number(studentId));
  if (!s) return;

  let renewals = [];
  try {
    renewals = await api(`/students/${studentId}/renewals`);
  } catch (err) {
    // non-fatal - profile still shows without renewal history if this fails
  }

  const initial = (s.full_name || '?').trim().charAt(0).toUpperCase();
  const photoHtml = s.photo
    ? `<img src="${s.photo}" alt="" style="width:96px;height:96px;object-fit:cover;border-radius:50%;border:1px solid #cbd5e1">`
    : `<div style="width:96px;height:96px;border-radius:50%;background:#e2e8f0;color:#64748b;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:32px">${escapeHtml(initial)}</div>`;

  const scheduleText = (s.schedule || []).map(x => `${escapeHtml(x.day)}: ${escapeHtml(x.time)}`).join('<br>') || 'Not set';
  const presentSessions = s.attendance.filter(a => a.present === true);
  const presentDates = presentSessions.map(a => `${escapeHtml(a.date || 'no date')}${a.slot ? ' (' + escapeHtml(a.slot) + ')' : ''}`).join('<br>') || 'None yet';

  const field = (label, value) => `<p style="margin-bottom:8px"><strong>${label}:</strong> ${value || '—'}</p>`;

  const renewalsHtml = renewals.length
    ? simpleTable(renewals, ['date', 'previousPackage', 'newPackage', 'paymentMode', 'rrn', 'processedBy'])
    : '<p class="small-note">No renewals yet.</p>';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:999;padding:20px';
  overlay.innerHTML = `
    <div class="card" style="max-width:600px;max-height:90vh;overflow:auto">
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:16px">
        ${photoHtml}
        <div>
          <h1 style="font-size:20px">${escapeHtml(s.full_name)}</h1>
          <div class="small-note">${escapeHtml(s.student_code)} · <span class="badge ${s.registration_type === 'Trial' ? 'trial' : s.registration_type === 'Renewal' ? 'renewal' : 'newreg'}">${escapeHtml(s.registration_type)}</span></div>
        </div>
      </div>

      <h3 class="section-title" style="font-size:15px">Personal Details</h3>
      ${field('Gender', escapeHtml(s.gender))}
      ${field('Date of Birth', escapeHtml(s.dob))}
      ${field('Age', s.age)}
      ${field('Phone', escapeHtml(s.phone))}
      ${field('Referred By', s.referred_by ? escapeHtml(s.referred_by) : null)}

      <h3 class="section-title" style="font-size:15px">Training Details</h3>
      ${field('Activity', capitalize(s.activity))}
      ${field('Trainer', escapeHtml(s.trainer_name))}
      ${field('Schedule', scheduleText)}
      ${field('Session Package', `${s.session_package} paid + ${s.additional_sessions} free = ${s.total_sessions} total`)}

      <h3 class="section-title" style="font-size:15px">Payment Details</h3>
      ${field('Discount Card', s.discount_card && s.discount_card !== 'none' ? escapeHtml(s.discount_card) : 'None')}
      ${field('Card / Membership ID', s.card_number ? escapeHtml(s.card_number) : null)}
      ${field('RRN', s.rrn ? escapeHtml(s.rrn) : null)}
      ${field('Final Fee', s.final_fee != null ? `${Number(s.final_fee).toFixed(2)} AED` : null)}
      ${field('Registered On', escapeHtml((s.created_at || '').slice(0, 10)))}

      <h3 class="section-title" style="font-size:15px">Attendance</h3>
      ${field('Sessions Present', `${presentSessions.length} / ${s.total_sessions}`)}
      <p style="margin-bottom:8px"><strong>Present Dates:</strong><br>${presentDates}</p>

      ${s.notes ? `<h3 class="section-title" style="font-size:15px">Notes</h3><p style="margin-bottom:8px">${escapeHtml(s.notes)}</p>` : ''}

      <h3 class="section-title" style="font-size:15px">Renewal History</h3>
      ${renewalsHtml}

      <button class="btn-secondary btn-block" id="closeProfileBtn" style="margin-top:16px">Close</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#closeProfileBtn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

async function openRenewModal(studentId) {
  const s = (window._studentsCache || []).find(x => Number(x.id) === Number(studentId));
  if (!s) return;
  if (!scheduleCache[s.activity]) scheduleCache[s.activity] = await api(`/schedule/${s.activity}`);

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:999;padding:20px';
  overlay.innerHTML = `
    <div class="card" style="max-width:520px;max-height:90vh;overflow:auto">
      <h1 style="font-size:18px">Renew ${escapeHtml(s.full_name)} (${escapeHtml(s.student_code)})</h1>
      <label>New Session Package</label>
      <select id="renewPackage">${SESSION_OPTIONS.map(n => `<option value="${n}" ${n === s.session_package ? 'selected' : ''}>${n} Sessions</option>`).join('')}</select>
      <label>Additional Free Sessions</label>
      <input type="number" id="renewAdditional" min="0" value="0">
      <label>Training Schedule <span class="small-note">Select days and slots for the new cycle.</span></label>
      <div id="renewDayCheckboxes" class="day-checkboxes">${DAYS.map(d => `<label><input type="checkbox" value="${d}" ${((s.schedule || []).some(x => x.day === d)) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
      <div id="renewScheduleRows" class="schedule-rows"></div>
      <label>Discount Card Waiver Choice</label>
      <select id="renewDiscountCard">
        <option value="none">None (Standard Fee)</option>
        <option value="fazza">Fazza Card (Waiver Registration Fee)</option>
        <option value="enbd">ENBD Platinum Card (Waiver Registration Fee)</option>
      </select>
      <div class="fee-breakdown" style="margin-top:12px">
        <p><span>Session Package Fee:</span> <span id="renewLblSessionFee">0.00 AED</span></p>
        <p><span>One-Time Registration Fee (No VAT):</span> <span id="renewLblRegFee">0.00 AED</span></p>
        <p><span>Waiver Discount:</span> <span id="renewLblWaiver">-0.00 AED</span></p>
        <p><span>Subtotal:</span> <span id="renewLblSubtotal">0.00 AED</span></p>
        <p><span>VAT (5% — Session Fee only):</span> <span id="renewLblVatFee">0.00 AED</span></p>
        <p class="total-row"><span>Grand Total:</span> <span id="renewLblTotalFee">0.00 AED</span></p>
      </div>
      <label>Payment Mode *</label>
      <select id="renewPaymentMode">
        <option value="cash">Cash</option>
        <option value="card">Card</option>
      </select>
      <div id="renewCardFieldsGroup" class="hidden">
        <label>Card / Membership ID</label>
        <input type="text" id="renewCardNumber">
        <label>Payment RRN / Ref Number</label>
        <input type="text" id="renewRrn">
      </div>
      <div id="renewMsg"></div>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="btn" id="confirmRenewBtn" style="flex:1">Confirm Renewal</button>
        <button class="btn-secondary" id="cancelRenewBtn" style="flex:1">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#renewDiscountCard').value = s.discount_card && s.discount_card !== 'none' ? s.discount_card : 'none';

  function renderRenewFee() {
    const sessions = Number(overlay.querySelector('#renewPackage').value);
    const discountCard = overlay.querySelector('#renewDiscountCard').value;
    const fee = calcFeeClient(s.activity, sessions, discountCard);
    overlay.querySelector('#renewLblSessionFee').textContent = fee.sessionFee.toFixed(2) + ' AED';
    overlay.querySelector('#renewLblRegFee').textContent = fee.registrationFee.toFixed(2) + ' AED';
    overlay.querySelector('#renewLblWaiver').textContent = '-' + fee.waiver.toFixed(2) + ' AED';
    overlay.querySelector('#renewLblSubtotal').textContent = fee.subtotal.toFixed(2) + ' AED';
    overlay.querySelector('#renewLblVatFee').textContent = fee.vat.toFixed(2) + ' AED';
    overlay.querySelector('#renewLblTotalFee').textContent = fee.total.toFixed(2) + ' AED';
  }
  overlay.querySelector('#renewPackage').addEventListener('change', renderRenewFee);
  overlay.querySelector('#renewDiscountCard').addEventListener('change', renderRenewFee);
  renderRenewFee();

  function renderRenewRows() {
    const checked = [...overlay.querySelectorAll('#renewDayCheckboxes input:checked')].map(x => x.value);
    const slotsByDay = scheduleCache[s.activity] || {};
    overlay.querySelector('#renewScheduleRows').innerHTML = checked.map(day => {
      const slots = (slotsByDay[day] || []).filter(sl => !sl.restrictedToTrainers || sl.restrictedToTrainers.includes(s.trainer_name));
      const existing = (s.schedule || []).find(x => x.day === day);
      const opts = slots.map(sl => `<option value="${escapeHtml(sl.label)}" ${existing && existing.time === sl.label ? 'selected' : ''}>${escapeHtml(sl.label)}</option>`).join('');
      return `<div class="schedule-row"><strong>${day}</strong><select class="renew-time" data-day="${day}"><option value="">Select time slot...</option>${opts}</select></div>`;
    }).join('');
  }
  overlay.querySelectorAll('#renewDayCheckboxes input').forEach(cb => cb.addEventListener('change', renderRenewRows));
  renderRenewRows();

  overlay.querySelector('#renewPaymentMode').addEventListener('change', (e) => {
    overlay.querySelector('#renewCardFieldsGroup').classList.toggle('hidden', e.target.value !== 'card');
  });

  overlay.querySelector('#cancelRenewBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#confirmRenewBtn').addEventListener('click', async () => {
    const newSchedule = [...overlay.querySelectorAll('.renew-time')]
      .map(el => ({ day: el.dataset.day, time: el.value })).filter(x => x.time);
    const renewMsg = overlay.querySelector('#renewMsg');
    if (!newSchedule.length) {
      renewMsg.innerHTML = '<div class="error-msg">Select at least one day/time slot.</div>';
      return;
    }
    const paymentMode = overlay.querySelector('#renewPaymentMode').value;
    const cardNumber = overlay.querySelector('#renewCardNumber').value.trim();
    const rrn = overlay.querySelector('#renewRrn').value.trim();
    if (paymentMode === 'card' && (!cardNumber || !rrn)) {
      renewMsg.innerHTML = '<div class="error-msg">Card Number and RRN are required when Payment Mode is Card.</div>';
      return;
    }
    try {
      await api(`/students/${studentId}/renew`, {
        method: 'POST',
        body: {
          newSessionPackage: Number(overlay.querySelector('#renewPackage').value),
          additionalSessions: Number(overlay.querySelector('#renewAdditional').value || 0),
          newSchedule,
          discountCard: overlay.querySelector('#renewDiscountCard').value,
          paymentMode,
          cardNumber: paymentMode === 'card' ? cardNumber : null,
          rrn: paymentMode === 'card' ? rrn : null
        }
      });
      overlay.remove();
      loadStudents();
    } catch (err) {
      renewMsg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });
}

/* ---------------- Reports ---------------- */

const REPORT_COLUMNS = {
  attendance: ['studentCode', 'name', 'activity', 'trainer', 'totalSessions', 'sessionsPresent', 'presentDates'],
  trial: ['studentCode', 'name', 'activity', 'trainer', 'referredBy', 'trialStartDate'],
  registration: ['studentCode', 'name', 'gender', 'dob', 'age', 'activity', 'trainer', 'registrationType', 'finalFee', 'registeredAt'],
  renewal: ['studentCode', 'name', 'activity', 'trainer', 'date', 'previousPackage', 'newPackage', 'paymentMode', 'rrn', 'processedBy']
};

let lastReport = null; // { type, activity, period, sections: [{ title, columns, rows }] }

function initReportsPanel() {
  document.getElementById('reportType').addEventListener('change', updateReportControlVisibility);
  document.getElementById('reportPeriod').addEventListener('change', updateReportControlVisibility);
  document.getElementById('runReportBtn').addEventListener('click', runReport);
  document.getElementById('exportExcelBtn').addEventListener('click', exportReportToExcel);
  updateReportControlVisibility();
}

function updateReportControlVisibility() {
  const type = document.getElementById('reportType').value;
  const period = document.getElementById('reportPeriod').value;
  const isDailyRollup = type === 'daily';
  document.getElementById('reportPeriod').classList.toggle('hidden', isDailyRollup);
  document.getElementById('reportDailyDate').classList.toggle('hidden', !isDailyRollup);
  document.getElementById('reportFrom').classList.toggle('hidden', isDailyRollup || period !== 'custom');
  document.getElementById('reportTo').classList.toggle('hidden', isDailyRollup || period !== 'custom');
}

/* Turns the Today / This Week / Custom Period selector into concrete from/to dates. */
function computePeriodRange() {
  const period = document.getElementById('reportPeriod').value;
  const todayStr = new Date().toISOString().slice(0, 10);
  if (period === 'today') return { from: todayStr, to: todayStr };
  if (period === 'week') {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 6);
    return { from: weekAgo.toISOString().slice(0, 10), to: todayStr };
  }
  return { from: document.getElementById('reportFrom').value, to: document.getElementById('reportTo').value };
}

async function fetchTypedReport(type, activity, from, to) {
  const params = new URLSearchParams({ activity });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return api(`/reports/${type}?${params.toString()}`);
}

async function runReport() {
  const type = document.getElementById('reportType').value;
  const activity = document.getElementById('reportActivity').value;
  const output = document.getElementById('reportOutput');
  output.innerHTML = '<p class="small-note">Loading…</p>';

  if (type === 'daily') {
    const date = document.getElementById('reportDailyDate').value || new Date().toISOString().slice(0, 10);
    const params = new URLSearchParams({ activity, date });
    const data = await api(`/reports/daily?${params.toString()}`);
    lastReport = {
      type: 'daily',
      sections: [
        { title: `Registrations — ${data.date}`, columns: ['studentCode', 'name', 'activity', 'trainer', 'fee'], rows: data.registrations },
        { title: `Attendance Marked — ${data.date}`, columns: ['studentCode', 'name', 'activity', 'trainer', 'present'], rows: data.attendanceMarked },
        { title: `Renewals Processed — ${data.date}`, columns: ['studentCode', 'name', 'activity', 'trainer'], rows: data.renewalsProcessed }
      ]
    };
    output.innerHTML = `
      <h3 class="section-title">Daily Rollup Report — ${escapeHtml(data.date)}</h3>
      <p><strong>Revenue that day:</strong> ${data.revenueToday.toFixed(2)} AED</p>
      ${lastReport.sections.map(sec => `<h4 style="margin-top:14px">${escapeHtml(sec.title)} (${sec.rows.length})</h4>${simpleTable(sec.rows, sec.columns)}`).join('')}
    `;
    return;
  }

  const { from, to } = computePeriodRange();
  if (document.getElementById('reportPeriod').value === 'custom' && (!from || !to)) {
    output.innerHTML = '<p class="error-msg">Pick both a From and To date for a custom period.</p>';
    return;
  }

  if (type === 'all') {
    const [attendance, trial, registration, renewal] = await Promise.all([
      fetchTypedReport('attendance', activity, from, to),
      fetchTypedReport('trial', activity, from, to),
      fetchTypedReport('registration', activity, from, to),
      fetchTypedReport('renewal', activity, from, to)
    ]);
    lastReport = {
      type: 'all',
      sections: [
        { title: 'Attendance Report', columns: REPORT_COLUMNS.attendance, rows: attendance },
        { title: 'Trial Report', columns: REPORT_COLUMNS.trial, rows: trial },
        { title: 'Registration Report', columns: REPORT_COLUMNS.registration, rows: registration },
        { title: 'Renewal Report', columns: REPORT_COLUMNS.renewal, rows: renewal }
      ]
    };
    output.innerHTML = `
      <h3 class="section-title">All Reports — ${escapeHtml(from)} to ${escapeHtml(to)}</h3>
      ${lastReport.sections.map(sec => `<h4 style="margin-top:14px">${escapeHtml(sec.title)} (${sec.rows.length})</h4>${simpleTable(sec.rows, sec.columns)}`).join('')}
    `;
    return;
  }

  const rows = await fetchTypedReport(type, activity, from, to);
  const columns = REPORT_COLUMNS[type];
  lastReport = { type, sections: [{ title: reportTitle(type), columns, rows }] };
  output.innerHTML = `<h3 class="section-title">${reportTitle(type)} — ${escapeHtml(from)} to ${escapeHtml(to)}</h3>${simpleTable(rows, columns)}`;
}

function reportTitle(type) {
  return { attendance: 'Attendance Report', trial: 'Trial Report', registration: 'Registration Report', renewal: 'Renewal Report' }[type] || 'Report';
}

function simpleTable(rows, columns) {
  if (!rows || !rows.length) return '<p class="small-note">None.</p>';
  return `<table class="data-table"><thead><tr>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${columns.map(c => `<td>${escapeHtml(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/* Exports whatever report is currently on screen to a .xlsx file (one sheet per section). */
function exportReportToExcel() {
  if (!lastReport || !lastReport.sections.length) {
    alert('Generate a report first, then export it.');
    return;
  }
  const wb = XLSX.utils.book_new();
  lastReport.sections.forEach((sec, i) => {
    const rows = (sec.rows && sec.rows.length) ? sec.rows.map(r => {
      const picked = {};
      sec.columns.forEach(c => { picked[c] = r[c]; });
      return picked;
    }) : [Object.fromEntries(sec.columns.map(c => [c, '']))];
    const ws = XLSX.utils.json_to_sheet(rows);
    const sheetName = (sec.title || `Sheet${i + 1}`).replace(/[\\/*?:[\]]/g, '').slice(0, 31) || `Sheet${i + 1}`;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });
  const filename = `westford-${lastReport.type}-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
}

/* ---------------- Schedule Config (admin) ---------------- */

async function loadScheduleConfig() {
  const activity = document.getElementById('scheduleConfigActivity').value;
  const slots = await api(`/schedule/${activity}`);
  scheduleCache[activity] = slots;
  renderScheduleConfig(activity, slots);
}

function renderScheduleConfig(activity, slots) {
  const out = document.getElementById('scheduleConfigOutput');
  out.innerHTML = DAYS.map(day => {
    const rows = (slots[day] || []).map((s, i) => scheduleConfigRow(day, i, s)).join('');
    return `<div class="mini-card" style="margin-bottom:12px">
      <h4>${day}</h4>
      <div id="cfg-${day}">${rows}</div>
      <button type="button" class="btn-secondary" onclick="addScheduleConfigRow('${day}')">+ Add Slot</button>
    </div>`;
  }).join('');
}

function scheduleConfigRow(day, i, slot) {
  return `<div class="fee-input-group" data-day="${day}" data-idx="${i}">
    <input type="text" class="cfg-label" value="${escapeHtml(slot.label)}" style="width:55%;text-align:left">
    <input type="text" class="cfg-restrict" placeholder="Restricted trainer (optional)" value="${escapeHtml((slot.restrictedToTrainers || []).join(','))}" style="width:35%;text-align:left">
    <button type="button" class="btn-danger" onclick="this.closest('[data-day]').remove()">✕</button>
  </div>`;
}

function addScheduleConfigRow(day) {
  const container = document.getElementById(`cfg-${day}`);
  const i = container.children.length;
  container.insertAdjacentHTML('beforeend', scheduleConfigRow(day, i, { label: '', restrictedToTrainers: null }));
}

async function saveScheduleConfig() {
  const activity = document.getElementById('scheduleConfigActivity').value;
  const payload = {};
  DAYS.forEach(day => {
    const rows = [...document.querySelectorAll(`#cfg-${day} [data-day]`)];
    payload[day] = rows.map(r => {
      const label = r.querySelector('.cfg-label').value.trim();
      const restrict = r.querySelector('.cfg-restrict').value.trim();
      return { label, restrictedToTrainers: restrict ? restrict.split(',').map(x => x.trim()).filter(Boolean) : null };
    }).filter(s => s.label);
  });
  const msg = document.getElementById('scheduleConfigMsg');
  try {
    await api(`/schedule/${activity}`, { method: 'PUT', body: payload });
    scheduleCache[activity] = payload;
    msg.innerHTML = '<div class="success-msg">Schedule configuration saved.</div>';
  } catch (err) {
    msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

/* ---------------- Fee Management (admin) ---------------- */

async function loadFees() {
  const data = await api('/fees');
  feeMatrixCache = data;
  document.getElementById('editRegFee').value = data.registrationFee;
  const grid = document.getElementById('feeMatrixGrid');
  grid.innerHTML = SPORTS.map(sport => `
    <div class="mini-card">
      <h4>${capitalize(sport)} Fees</h4>
      ${SESSION_OPTIONS.map(n => `
        <div class="fee-input-group">
          <label>${n} Sessions:</label>
          <input type="number" id="fee_${sport}_${n}" value="${data.matrix[sport][n]}">
        </div>`).join('')}
    </div>`).join('');
}

async function saveFees() {
  const registrationFee = Number(document.getElementById('editRegFee').value || 0);
  const matrix = {};
  SPORTS.forEach(sport => {
    matrix[sport] = {};
    SESSION_OPTIONS.forEach(n => { matrix[sport][n] = Number(document.getElementById(`fee_${sport}_${n}`).value || 0); });
  });
  const msg = document.getElementById('feeMsg');
  try {
    await api('/fees', { method: 'PUT', body: { registrationFee, matrix } });
    msg.innerHTML = '<div class="success-msg">Fees and pricing rules updated successfully.</div>';
  } catch (err) {
    msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

/* ---------------- Trainers & Access (admin) ---------------- */

async function loadTrainers() {
  const trainers = await api('/trainers');
  trainersCache = trainers;
  const body = document.getElementById('trainerTableBody');
  body.innerHTML = trainers.map(t => `
    <tr>
      <td>${escapeHtml(t.name)}</td>
      <td>${capitalize(t.activity)}</td>
      <td>${t.active ? 'Active' : 'Inactive'}</td>
      <td>${t.active
        ? `<button class="btn-danger" onclick="deactivateTrainer(${t.id})">Deactivate</button>`
        : `<button class="btn-success" onclick="reactivateTrainer(${t.id})">Reactivate</button>`}</td>
    </tr>`).join('');
}

async function addTrainer() {
  const name = document.getElementById('newTrainerName').value.trim();
  const activity = document.getElementById('newTrainerActivity').value;
  const msg = document.getElementById('trainerMsg');
  if (!name) { msg.innerHTML = '<div class="error-msg">Enter a trainer name.</div>'; return; }
  try {
    const result = await api('/trainers', { method: 'POST', body: { name, activity } });
    msg.innerHTML = `<div class="success-msg">Trainer "${escapeHtml(name)}" added. Login username: <strong>${escapeHtml(name)}</strong>, default password: <strong>${escapeHtml(result.defaultPassword)}</strong>.</div>`;
    document.getElementById('newTrainerName').value = '';
    loadTrainers();
  } catch (err) {
    msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

async function deactivateTrainer(id) { await api(`/trainers/${id}`, { method: 'DELETE' }); loadTrainers(); }
async function reactivateTrainer(id) { await api(`/trainers/${id}`, { method: 'PUT', body: { active: true } }); loadTrainers(); }

async function resetPassword() {
  const username = document.getElementById('resetUsername').value.trim();
  const msg = document.getElementById('resetMsg');
  if (!username) { msg.innerHTML = '<div class="error-msg">Enter a username.</div>'; return; }
  try {
    const result = await api('/auth/reset-password', { method: 'POST', body: { username } });
    msg.innerHTML = `<div class="success-msg">Password for "${escapeHtml(username)}" reset to: <strong>${escapeHtml(result.newPassword)}</strong>. They will be asked to change it on next login.</div>`;
  } catch (err) {
    msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

/* ---------------- Bulk Upload (admin) ---------------- */

async function downloadTemplate(e) {
  e.preventDefault();
  const token = Auth.getToken();
  const res = await fetch('/api/upload/template', { headers: { Authorization: `Bearer ${token}` } });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'student-bulk-upload-template.xlsx';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function uploadBulkFile() {
  const fileInput = document.getElementById('uploadFile');
  const msg = document.getElementById('uploadMsg');
  const errBox = document.getElementById('uploadErrors');
  errBox.innerHTML = '';
  if (!fileInput.files.length) { msg.innerHTML = '<div class="error-msg">Choose a file first.</div>'; return; }
  const form = new FormData();
  form.append('file', fileInput.files[0]);
  try {
    const result = await api('/upload/students', { method: 'POST', body: form, isForm: true });
    msg.innerHTML = `<div class="success-msg">${result.inserted} student(s) added. ${result.errorCount} row(s) had errors.</div>`;
    if (result.errors.length) {
      errBox.innerHTML = simpleTable(result.errors, ['row', 'reason']);
    }
  } catch (err) {
    msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

/* ---------------- Boot ---------------- */

document.addEventListener('DOMContentLoaded', async () => {
  initShell();
  await initRegistrationForm();
  initReportsPanel();

  document.getElementById('attendanceSportFilter').addEventListener('change', loadStudents);
  document.getElementById('studentSearch').addEventListener('input', debounce(loadStudents, 300));

  document.getElementById('scheduleConfigActivity').addEventListener('change', loadScheduleConfig);
  document.getElementById('loadScheduleConfigBtn').addEventListener('click', loadScheduleConfig);
  document.getElementById('saveScheduleConfigBtn').addEventListener('click', saveScheduleConfig);

  document.getElementById('saveFeesBtn').addEventListener('click', saveFees);
  document.getElementById('addTrainerBtn').addEventListener('click', addTrainer);
  document.getElementById('resetPasswordBtn').addEventListener('click', resetPassword);

  document.getElementById('downloadTemplateLink').addEventListener('click', downloadTemplate);
  document.getElementById('uploadBtn').addEventListener('click', uploadBulkFile);

  if (currentUser.role === 'admin') {
    loadScheduleConfig();
  }
});

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
