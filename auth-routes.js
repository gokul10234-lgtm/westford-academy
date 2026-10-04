const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth-middleware');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const user = await db.get('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const trainer = user.linked_trainer_id
    ? await db.get('SELECT * FROM trainers WHERE id = ?', [user.linked_trainer_id])
    : null;

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, trainerId: user.linked_trainer_id || null },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({
    token,
    username: user.username,
    role: user.role,
    trainerId: user.linked_trainer_id || null,
    trainerActivity: trainer ? trainer.activity : null,
    mustChangePassword: !!user.must_change_password
  });
}));

router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required.' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });

  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user || !bcrypt.compareSync(oldPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  await db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hash, user.id]);
  await db.run('INSERT INTO password_events (username, action, performed_by) VALUES (?,?,?)', [user.username, 'self_change', user.username]);
  res.json({ ok: true });
}));

// Admin-only: reset any user's password back to the default trainer password.
// (We intentionally do not offer a "view current password" endpoint - passwords are
// stored hashed, not in reversible/plain form. Reset covers the same real need -
// regaining access - without keeping plain-text passwords anywhere. See project README.)
router.post('/reset-password', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { username } = req.body || {};
  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(404).json({ error: 'No account found with that username.' });
  const defaultPassword = process.env.DEFAULT_TRAINER_PASSWORD || 'Abc@123';
  const hash = bcrypt.hashSync(defaultPassword, 10);
  await db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hash, user.id]);
  await db.run('INSERT INTO password_events (username, action, performed_by) VALUES (?,?,?)', [user.username, 'admin_reset', req.user.username]);
  res.json({ ok: true, newPassword: defaultPassword });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role, trainerId: req.user.trainerId });
});

module.exports = router;
