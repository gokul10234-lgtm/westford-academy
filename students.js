const express = require('express');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth-middleware');
const { computeAge, makeStudentCode, calcFee } = require('./utils');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

function scopeToTrainer(req, query, params) {
  // Trainers only ever see their own students; admin sees everyone.
  if (req.user.role === 'trainer') {
    return { query: query + ' AND s.trainer_id = ?', params: [...params, req.user.trainerId] };
  }
  return { query, params };
}

// --- Create / register a student ---
router.post('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const required = ['fullName', 'dob', 'gender', 'activity', 'trainerId', 'sessionPackage', 'registrationType', 'phone', 'schedule'];
  for (const field of required) {
    if (b[field] === undefined || b[field] === null || b[field] === '') {
      return res.status(400).json({ error: `Missing required field: ${field}` });
    }
  }
  if (!Array.isArray(b.schedule) || b.schedule.length === 0) {
    return res.status(400).json({ error: 'At least one training day/time slot must be selected.' });
  }

  // Only admins reach this route (requireAdmin above), so trainerId is trusted as given.
  const trainer = await db.get('SELECT * FROM trainers WHERE id = ?', [b.trainerId]);
  if (!trainer || !trainer.active) return res.status(400).json({ error: 'Selected trainer is not valid.' });

  const age = computeAge(b.dob);
  if (age === null || age < 5 || age > 60) {
    return res.status(400).json({ error: 'Date of birth must produce an age between 5 and 60.' });
  }
  if (b.registrationType === 'Trial' && !b.referredBy) {
    return res.status(400).json({ error: 'Referred By is required for Trial registrations.' });
  }
  if (b.photo && String(b.photo).length > 700000) {
    return res.status(400).json({ error: 'Profile picture is too large. Please use a smaller image.' });
  }

  const additionalSessions = Math.max(0, Number(b.additionalSessions || 0));
  const totalSessions = Number(b.sessionPackage) + additionalSessions;
  const fee = await calcFee(b.activity, Number(b.sessionPackage), b.discountCard);
  const code = await makeStudentCode(b.activity, trainer.name);

  const info = await db.run(`
    INSERT INTO students (student_code, full_name, dob, gender, age, activity, trainer_id, registration_type,
      referred_by, discount_card, card_number, rrn, session_package, additional_sessions, total_sessions,
      schedule, phone, notes, final_fee, photo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    code, b.fullName.trim(), b.dob, b.gender, age, b.activity, trainer.id, b.registrationType,
    b.referredBy || null,
    b.discountCard || 'none', b.cardNumber || null, b.rrn || null, Number(b.sessionPackage), additionalSessions,
    totalSessions, JSON.stringify(b.schedule), b.phone.trim(), b.notes || null, fee.total, b.photo || null
  ]);

  const attStatements = [];
  for (let i = 0; i < totalSessions; i++) {
    attStatements.push({ sql: 'INSERT INTO attendance (student_id, session_index, date, slot, present) VALUES (?,?,?,?,NULL)', args: [info.lastInsertRowid, i, '', ''] });
  }
  if (attStatements.length) await db.transaction(attStatements);

  res.status(201).json({ id: info.lastInsertRowid, studentCode: code, age, fee });
}));

// --- List students (scoped by role), with activity + search filters ---
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  let query = `
    SELECT s.*, t.name as trainer_name FROM students s
    JOIN trainers t ON t.id = s.trainer_id
    WHERE 1=1
  `;
  const params = [];
  if (req.query.activity && req.query.activity !== 'all') {
    query += ' AND s.activity = ?';
    params.push(req.query.activity);
  }
  if (req.query.search) {
    query += ' AND (LOWER(s.full_name) LIKE ? OR LOWER(s.student_code) LIKE ?)';
    const q = `%${req.query.search.toLowerCase()}%`;
    params.push(q, q);
  }
  const scoped = scopeToTrainer(req, query, params);
  const rows = await db.all(scoped.query + ' ORDER BY s.created_at DESC', scoped.params);

  const withAttendance = [];
  for (const r of rows) {
    const attendance = await db.all('SELECT session_index, date, slot, present, updated_by, updated_at FROM attendance WHERE student_id = ? ORDER BY session_index', [r.id]);
    withAttendance.push({
      ...r,
      schedule: JSON.parse(r.schedule || '[]'),
      attendance: attendance.map(a => ({ ...a, present: a.present === null ? null : !!a.present }))
    });
  }
  res.json(withAttendance);
}));

// --- Update one attendance session row ---
router.put('/:id/attendance/:index', requireAuth, asyncHandler(async (req, res) => {
  const student = await db.get('SELECT * FROM students WHERE id = ?', [req.params.id]);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  if (req.user.role === 'trainer' && student.trainer_id !== req.user.trainerId) {
    return res.status(403).json({ error: 'You can only edit attendance for your own students.' });
  }

  const { date, slot, present } = req.body || {};
  const existing = await db.get('SELECT * FROM attendance WHERE student_id = ? AND session_index = ?', [student.id, req.params.index]);
  if (!existing) return res.status(404).json({ error: 'Attendance session not found.' });

  const newDate = date !== undefined ? date : existing.date;
  const newSlot = slot !== undefined ? slot : existing.slot;
  const newPresent = present !== undefined ? (present === null ? null : (present ? 1 : 0)) : existing.present;

  await db.run(`UPDATE attendance SET date = ?, slot = ?, present = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    [newDate, newSlot, newPresent, req.user.username, existing.id]);

  res.json({ ok: true });
}));

// --- Renew a student: change package / schedule / renewal date, preserving history ---
// --- Get a student's renewal history (for the profile view) ---
router.get('/:id/renewals', requireAuth, asyncHandler(async (req, res) => {
  const student = await db.get('SELECT * FROM students WHERE id = ?', [req.params.id]);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  if (req.user.role === 'trainer' && student.trainer_id !== req.user.trainerId) {
    return res.status(403).json({ error: 'You can only view renewals for your own students.' });
  }
  const rows = await db.all('SELECT * FROM renewal_history WHERE student_id = ? ORDER BY date DESC', [student.id]);
  res.json(rows.map(r => ({
    date: r.date, previousPackage: r.previous_package, newPackage: r.new_package,
    paymentMode: r.payment_mode || '', cardNumber: r.card_number || '', rrn: r.rrn || '', processedBy: r.processed_by
  })));
}));

router.post('/:id/renew', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const student = await db.get('SELECT * FROM students WHERE id = ?', [req.params.id]);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  // Only admins reach this route (requireAdmin above) - renewals are admin-only.

  const { newSessionPackage, additionalSessions = 0, newSchedule, paymentMode, cardNumber, rrn } = req.body || {};
  if (!newSessionPackage || !Array.isArray(newSchedule) || newSchedule.length === 0) {
    return res.status(400).json({ error: 'A new session package and at least one schedule slot are required.' });
  }
  if (!paymentMode || !['cash', 'card'].includes(paymentMode)) {
    return res.status(400).json({ error: 'Payment Mode is required and must be Cash or Card.' });
  }
  if (paymentMode === 'card' && (!cardNumber || !rrn)) {
    return res.status(400).json({ error: 'Card Number and RRN are required when Payment Mode is Card.' });
  }

  const extra = Math.max(0, Number(additionalSessions));
  const newTotal = Number(newSessionPackage) + extra;
  const previousTotal = student.total_sessions;
  // Renewals never re-charge the one-time registration fee, and no discount-card
  // waiver applies (that offer only ever applied to the registration fee).
  const fee = await calcFee(student.activity, Number(newSessionPackage), null, { includeRegistrationFee: false });

  const statements = [
    {
      sql: `INSERT INTO renewal_history (student_id, previous_package, new_package, previous_schedule, new_schedule, processed_by, payment_mode, card_number, rrn)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [
        student.id, student.session_package, Number(newSessionPackage), student.schedule, JSON.stringify(newSchedule), req.user.username,
        paymentMode, paymentMode === 'card' ? cardNumber : null, paymentMode === 'card' ? rrn : null
      ]
    },
    {
      sql: `UPDATE students SET registration_type = 'Renewal', session_package = ?, additional_sessions = ?,
            total_sessions = ?, schedule = ?, final_fee = ?, card_number = ?, rrn = ? WHERE id = ?`,
      args: [
        Number(newSessionPackage), extra, newTotal, JSON.stringify(newSchedule), fee.total,
        paymentMode === 'card' ? cardNumber : student.card_number, paymentMode === 'card' ? rrn : student.rrn, student.id
      ]
    }
  ];
  for (let i = previousTotal; i < newTotal; i++) {
    statements.push({ sql: 'INSERT INTO attendance (student_id, session_index, date, slot, present) VALUES (?,?,?,?,NULL)', args: [student.id, i, '', ''] });
  }
  await db.transaction(statements);

  res.json({ ok: true, newTotal, fee });
}));

// --- Update just a student's profile picture (any authorized trainer or admin) ---
router.put('/:id/photo', requireAuth, asyncHandler(async (req, res) => {
  const student = await db.get('SELECT * FROM students WHERE id = ?', [req.params.id]);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  if (req.user.role === 'trainer' && student.trainer_id !== req.user.trainerId) {
    return res.status(403).json({ error: 'You can only update photos for your own students.' });
  }
  const { photo } = req.body || {};
  if (!photo) return res.status(400).json({ error: 'No photo provided.' });
  if (String(photo).length > 700000) {
    return res.status(400).json({ error: 'Profile picture is too large. Please use a smaller image.' });
  }
  await db.run('UPDATE students SET photo = ? WHERE id = ?', [photo, student.id]);
  res.json({ ok: true });
}));

module.exports = router;
