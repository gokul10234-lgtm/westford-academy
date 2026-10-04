const express = require('express');
const db = require('./db');
const { requireAuth } = require('./auth-middleware');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

function baseStudentQuery(req) {
  let query = `SELECT s.*, t.name as trainer_name FROM students s JOIN trainers t ON t.id = s.trainer_id WHERE 1=1`;
  const params = [];
  if (req.query.activity && req.query.activity !== 'all') {
    query += ' AND s.activity = ?';
    params.push(req.query.activity);
  }
  if (req.query.from) { query += ' AND date(s.created_at) >= date(?)'; params.push(req.query.from); }
  if (req.query.to) { query += ' AND date(s.created_at) <= date(?)'; params.push(req.query.to); }
  if (req.user.role === 'trainer') { query += ' AND s.trainer_id = ?'; params.push(req.user.trainerId); }
  return { query, params };
}

router.get('/attendance', requireAuth, asyncHandler(async (req, res) => {
  const { query, params } = baseStudentQuery(req);
  const students = await db.all(query, params);
  const report = [];
  for (const s of students) {
    const attendance = await db.all('SELECT date, slot, present FROM attendance WHERE student_id = ? ORDER BY session_index', [s.id]);
    const presentSessions = attendance.filter(a => a.present === 1);
    const presentDates = presentSessions
      .map(a => `${a.date || 'no date'}${a.slot ? ` (${a.slot})` : ''}`)
      .join('; ');
    report.push({
      studentCode: s.student_code, name: s.full_name, activity: s.activity, trainer: s.trainer_name,
      totalSessions: s.total_sessions, sessionsPresent: presentSessions.length,
      presentDates: presentDates || '—'
    });
  }
  res.json(report);
}));

router.get('/trial', requireAuth, asyncHandler(async (req, res) => {
  const { query, params } = baseStudentQuery(req);
  const students = await db.all(query + ` AND s.registration_type = 'Trial'`, params);
  res.json(students.map(s => ({
    studentCode: s.student_code, name: s.full_name, activity: s.activity, trainer: s.trainer_name,
    referredBy: s.referred_by, trialStartDate: s.created_at
  })));
}));

router.get('/registration', requireAuth, asyncHandler(async (req, res) => {
  const { query, params } = baseStudentQuery(req);
  const students = await db.all(query, params);
  res.json(students.map(s => ({
    studentCode: s.student_code, name: s.full_name, gender: s.gender, dob: s.dob, age: s.age,
    activity: s.activity, trainer: s.trainer_name, registrationType: s.registration_type,
    finalFee: s.final_fee, registeredAt: s.created_at
  })));
}));

router.get('/renewal', requireAuth, asyncHandler(async (req, res) => {
  let query = `
    SELECT r.*, s.student_code, s.full_name, s.activity, t.name as trainer_name
    FROM renewal_history r
    JOIN students s ON s.id = r.student_id
    JOIN trainers t ON t.id = s.trainer_id
    WHERE 1=1
  `;
  const params = [];
  if (req.query.activity && req.query.activity !== 'all') { query += ' AND s.activity = ?'; params.push(req.query.activity); }
  if (req.query.from) { query += ' AND date(r.date) >= date(?)'; params.push(req.query.from); }
  if (req.query.to) { query += ' AND date(r.date) <= date(?)'; params.push(req.query.to); }
  if (req.user.role === 'trainer') { query += ' AND s.trainer_id = ?'; params.push(req.user.trainerId); }
  query += ' ORDER BY r.date DESC';
  const rows = await db.all(query, params);
  res.json(rows.map(r => ({
    studentCode: r.student_code, name: r.full_name, activity: r.activity, trainer: r.trainer_name,
    date: r.date, previousPackage: r.previous_package, newPackage: r.new_package,
    paymentMode: r.payment_mode || '', cardNumber: r.card_number || '', rrn: r.rrn || '',
    processedBy: r.processed_by
  })));
}));

// Daily rollup: today's registrations, today's attendance marks, renewals due/overdue, today's revenue.
router.get('/daily', requireAuth, asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const activityFilter = req.query.activity && req.query.activity !== 'all' ? req.query.activity : null;
  const trainerFilter = req.user.role === 'trainer' ? req.user.trainerId : null;

  let regQuery = `SELECT s.*, t.name as trainer_name FROM students s JOIN trainers t ON t.id=s.trainer_id WHERE date(s.created_at) = date(?)`;
  const regParams = [date];
  if (activityFilter) { regQuery += ' AND s.activity = ?'; regParams.push(activityFilter); }
  if (trainerFilter) { regQuery += ' AND s.trainer_id = ?'; regParams.push(trainerFilter); }
  const registrations = await db.all(regQuery, regParams);

  let attQuery = `
    SELECT a.*, s.student_code, s.full_name, s.activity, t.name as trainer_name
    FROM attendance a JOIN students s ON s.id = a.student_id JOIN trainers t ON t.id = s.trainer_id
    WHERE a.date = ?
  `;
  const attParams = [date];
  if (activityFilter) { attQuery += ' AND s.activity = ?'; attParams.push(activityFilter); }
  if (trainerFilter) { attQuery += ' AND s.trainer_id = ?'; attParams.push(trainerFilter); }
  const attendanceToday = await db.all(attQuery, attParams);

  let renQuery = `
    SELECT r.*, s.student_code, s.full_name, s.activity, t.name as trainer_name
    FROM renewal_history r JOIN students s ON s.id = r.student_id JOIN trainers t ON t.id = s.trainer_id
    WHERE date(r.date) = date(?)
  `;
  const renParams = [date];
  if (activityFilter) { renQuery += ' AND s.activity = ?'; renParams.push(activityFilter); }
  if (trainerFilter) { renQuery += ' AND s.trainer_id = ?'; renParams.push(trainerFilter); }
  const renewalsToday = await db.all(renQuery, renParams);

  const revenueToday = registrations.reduce((sum, s) => sum + (s.final_fee || 0), 0);

  res.json({
    date,
    registrations: registrations.map(s => ({ studentCode: s.student_code, name: s.full_name, activity: s.activity, trainer: s.trainer_name, fee: s.final_fee })),
    attendanceMarked: attendanceToday.map(a => ({ studentCode: a.student_code, name: a.full_name, activity: a.activity, trainer: a.trainer_name, present: a.present === null ? null : !!a.present })),
    renewalsProcessed: renewalsToday.map(r => ({ studentCode: r.student_code, name: r.full_name, activity: r.activity, trainer: r.trainer_name })),
    revenueToday: Math.round(revenueToday * 100) / 100
  });
}));

module.exports = router;
