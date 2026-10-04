const express = require('express');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth-middleware');
const asyncHandler = require('./asyncHandler');

const router = express.Router();
const SPORTS = ['badminton', 'football', 'cricket', 'swimming'];
const SESSIONS = [8, 12, 16, 24];

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const regFeeRow = await db.get(`SELECT value FROM settings WHERE key = 'registration_fee'`);
  const matrix = {};
  for (const sport of SPORTS) {
    matrix[sport] = {};
    for (const s of SESSIONS) {
      const row = await db.get('SELECT price FROM fee_matrix WHERE activity = ? AND sessions = ?', [sport, s]);
      matrix[sport][s] = row ? row.price : 0;
    }
  }
  res.json({ registrationFee: regFeeRow ? Number(regFeeRow.value) : 0, matrix });
}));

router.put('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { registrationFee, matrix } = req.body || {};
  if (registrationFee !== undefined) {
    await db.run(`INSERT INTO settings (key, value) VALUES ('registration_fee', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(registrationFee)]);
  }
  if (matrix) {
    for (const [activity, sessions] of Object.entries(matrix)) {
      for (const [count, price] of Object.entries(sessions)) {
        await db.run(`INSERT INTO fee_matrix (activity, sessions, price) VALUES (?,?,?)
                      ON CONFLICT(activity, sessions) DO UPDATE SET price = excluded.price`, [activity, Number(count), Number(price)]);
      }
    }
  }
  res.json({ ok: true });
}));

module.exports = router;
