const express = require('express');
const db = require('./db');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

// GET /api/public/status?q=... - NO login required.
// Students/parents look themselves up by phone number, student ID, or name.
// Deliberately returns only: name, student ID, activity, photo, and attendance -
// never the phone number, fees, notes, discount/card info, or any other student data.
router.get('/status', asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) {
    return res.status(400).json({ error: 'Enter at least 3 characters (name, student ID, or phone number).' });
  }

  const digitsOnly = q.replace(/[^0-9]/g, '');
  const rows = await db.all(`
    SELECT s.id, s.student_code, s.full_name, s.activity, s.photo, s.total_sessions
    FROM students s
    WHERE LOWER(s.student_code) = LOWER(?)
       OR LOWER(s.full_name) LIKE LOWER(?)
       OR (LENGTH(?) >= 6 AND REPLACE(REPLACE(REPLACE(s.phone,'+',''),' ',''),'-','') LIKE ?)
    LIMIT 10
  `, [q, `%${q}%`, digitsOnly, `%${digitsOnly}%`]);

  const results = [];
  for (const s of rows) {
    const attendance = await db.all('SELECT date, slot, present FROM attendance WHERE student_id = ? ORDER BY session_index', [s.id]);
    const presentSessions = attendance.filter(a => a.present === 1);
    results.push({
      studentCode: s.student_code,
      name: s.full_name,
      activity: s.activity,
      photo: s.photo || null,
      totalSessions: s.total_sessions,
      sessionsPresent: presentSessions.length,
      presentDates: presentSessions.map(a => ({ date: a.date || null, slot: a.slot || null }))
    });
  }
  res.json(results);
}));

module.exports = router;
