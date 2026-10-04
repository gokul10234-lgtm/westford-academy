require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./auth-routes'));
app.use('/api/trainers', require('./trainers'));
app.use('/api/fees', require('./fees'));
app.use('/api/schedule', require('./schedule'));
app.use('/api/students', require('./students'));
app.use('/api/reports', require('./reports'));
app.use('/api/upload', require('./upload'));
app.use('/api/public', require('./public-status-routes'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Explicit whitelist of servable frontend files. Everything in this project sits in
// one flat folder (no /public subfolder) so uploads can't lose their structure, but
// that means we must NOT serve the whole folder statically - that would expose this
// server's own source code, package.json, and (if ever present) a .env file over
// HTTP. Instead, only these exact public URL paths are servable, each mapped to its
// real on-disk filename.
const STATIC_FILES = {
  '/': 'web-index.html',
  '/index.html': 'web-index.html',
  '/login.html': 'web-login.html',
  '/change-password.html': 'web-change-password.html',
  '/status.html': 'web-status.html',
  '/styles.css': 'web-styles.css',
  '/api.js': 'web-api.js',
  '/app.js': 'web-app.js'
};

app.get(Object.keys(STATIC_FILES), (req, res) => {
  res.sendFile(path.join(__dirname, STATIC_FILES[req.path]));
});

// Any other non-API route falls back to the login page.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'web-login.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

const PORT = process.env.PORT || 4000;

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Westford Sports - Indian Academy server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize the database (check TURSO_DATABASE_URL / TURSO_AUTH_TOKEN in .env):', err);
    process.exit(1);
  });
