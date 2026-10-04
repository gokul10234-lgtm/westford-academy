const express = require('express');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth-middleware');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

// GET /api/schedule/:activity -> { Monday: [{label, restrictedToTrainers}], ... }
router.get('/:activity', requireAuth, asyncHandler(async (req, res) => {
  const rows = await db.all('SELECT day, label, restricted_to_trainers FROM schedule_slots WHERE activity = ?', [req.params.activity]);
  const grouped = {};
  rows.forEach(r => {
    if (!grouped[r.day]) grouped[r.day] = [];
    grouped[r.day].push({
      label: r.label,
      restrictedToTrainers: r.restricted_to_trainers ? JSON.parse(r.restricted_to_trainers) : null
    });
  });
  res.json(grouped);
}));

// PUT /api/schedule/:activity  body: { Monday: [{label, restrictedToTrainers}], ... }
// Replaces the full slot configuration for that activity (admin only).
router.put('/:activity', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const activity = req.params.activity;
  const body = req.body || {};
  const statements = [{ sql: 'DELETE FROM schedule_slots WHERE activity = ?', args: [activity] }];
  Object.entries(body).forEach(([day, slots]) => {
    (slots || []).forEach(s => {
      statements.push({
        sql: 'INSERT INTO schedule_slots (activity, day, label, restricted_to_trainers) VALUES (?,?,?,?)',
        args: [activity, day, s.label, s.restrictedToTrainers ? JSON.stringify(s.restrictedToTrainers) : null]
      });
    });
  });
  await db.transaction(statements);
  res.json({ ok: true });
}));

module.exports = router;
