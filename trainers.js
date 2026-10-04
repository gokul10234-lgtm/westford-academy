const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth-middleware');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const rows = await db.all('SELECT id, name, activity, active FROM trainers ORDER BY activity, name');
  res.json(rows);
}));

router.post('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { name, activity } = req.body || {};
  if (!name || !activity) return res.status(400).json({ error: 'Trainer name and activity are required.' });

  const existingUser = await db.get('SELECT id FROM users WHERE username = ?', [name]);
  if (existingUser) return res.status(409).json({ error: 'A login account with that name already exists.' });

  const info = await db.run('INSERT INTO trainers (name, activity) VALUES (?,?)', [name.trim(), activity]);
  const defaultPassword = process.env.DEFAULT_TRAINER_PASSWORD || 'Abc@123';
  const hash = bcrypt.hashSync(defaultPassword, 10);
  await db.run(`INSERT INTO users (username, password_hash, role, linked_trainer_id, must_change_password) VALUES (?,?,?,?,1)`,
    [name.trim(), hash, 'trainer', info.lastInsertRowid]);

  res.status(201).json({ id: info.lastInsertRowid, name, activity, active: 1, defaultPassword });
}));

router.put('/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { name, activity, active } = req.body || {};
  const trainer = await db.get('SELECT * FROM trainers WHERE id = ?', [req.params.id]);
  if (!trainer) return res.status(404).json({ error: 'Trainer not found.' });

  const newName = name !== undefined ? name : trainer.name;
  const newActivity = activity !== undefined ? activity : trainer.activity;
  const newActive = active !== undefined ? (active ? 1 : 0) : trainer.active;

  await db.run('UPDATE trainers SET name = ?, activity = ?, active = ? WHERE id = ?', [newName, newActivity, newActive, trainer.id]);

  if (name && name !== trainer.name) {
    await db.run('UPDATE users SET username = ? WHERE linked_trainer_id = ?', [name, trainer.id]);
  }
  if (active !== undefined) {
    await db.run('UPDATE users SET active = ? WHERE linked_trainer_id = ?', [newActive, trainer.id]);
  }

  res.json({ id: trainer.id, name: newName, activity: newActivity, active: newActive });
}));

router.delete('/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const trainer = await db.get('SELECT * FROM trainers WHERE id = ?', [req.params.id]);
  if (!trainer) return res.status(404).json({ error: 'Trainer not found.' });
  await db.run('UPDATE trainers SET active = 0 WHERE id = ?', [trainer.id]);
  await db.run('UPDATE users SET active = 0 WHERE linked_trainer_id = ?', [trainer.id]);
  res.json({ ok: true });
}));

module.exports = router;
