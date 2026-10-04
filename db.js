const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN. Copy .env.example to .env and fill these in (see README section on Turso).');
  process.exit(1);
}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

/* Thin async helpers so route files read like plain SQL instead of a query builder. */
async function run(sql, args = []) {
  const result = await client.execute({ sql, args });
  return { lastInsertRowid: result.lastInsertRowid, changes: result.rowsAffected };
}
async function get(sql, args = []) {
  const result = await client.execute({ sql, args });
  return result.rows[0] || null;
}
async function all(sql, args = []) {
  const result = await client.execute({ sql, args });
  return result.rows;
}
/* Runs a list of {sql, args} statements as one atomic transaction. */
async function transaction(statements) {
  const tx = await client.transaction('write');
  try {
    const results = [];
    for (const s of statements) results.push(await tx.execute(s));
    await tx.commit();
    return results;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','trainer')),
    linked_trainer_id INTEGER,
    must_change_password INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS password_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    performed_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS trainers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    activity TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS fee_matrix (
    activity TEXT NOT NULL,
    sessions INTEGER NOT NULL,
    price REAL NOT NULL,
    PRIMARY KEY (activity, sessions)
  )`,
  `CREATE TABLE IF NOT EXISTS schedule_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity TEXT NOT NULL,
    day TEXT NOT NULL,
    label TEXT NOT NULL,
    restricted_to_trainers TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_code TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    dob TEXT,
    gender TEXT,
    age INTEGER,
    activity TEXT NOT NULL,
    trainer_id INTEGER NOT NULL,
    registration_type TEXT DEFAULT 'Trial',
    referred_by TEXT,
    discount_card TEXT,
    card_number TEXT,
    rrn TEXT,
    session_package INTEGER,
    additional_sessions INTEGER DEFAULT 0,
    total_sessions INTEGER,
    schedule TEXT,
    phone TEXT,
    notes TEXT,
    final_fee REAL,
    photo TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (trainer_id) REFERENCES trainers(id)
  )`,
  `CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    session_index INTEGER NOT NULL,
    date TEXT,
    slot TEXT,
    present INTEGER,
    updated_by TEXT,
    updated_at TEXT,
    UNIQUE(student_id, session_index),
    FOREIGN KEY (student_id) REFERENCES students(id)
  )`,
  `CREATE TABLE IF NOT EXISTS renewal_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    date TEXT DEFAULT (datetime('now')),
    previous_package INTEGER,
    new_package INTEGER,
    previous_schedule TEXT,
    new_schedule TEXT,
    processed_by TEXT,
    payment_mode TEXT,
    card_number TEXT,
    rrn TEXT,
    FOREIGN KEY (student_id) REFERENCES students(id)
  )`
];

async function ensureSchema() {
  for (const stmt of SCHEMA_STATEMENTS) {
    await client.execute(stmt);
  }
  await runMigrations();
}

// Additive, backward-compatible changes for databases that were created before a
// given column existed. Each statement is safe to re-run - "duplicate column" errors
// are swallowed since that just means this migration already applied.
const MIGRATIONS = [
  `ALTER TABLE students ADD COLUMN photo TEXT`,
  `ALTER TABLE renewal_history ADD COLUMN payment_mode TEXT`,
  `ALTER TABLE renewal_history ADD COLUMN card_number TEXT`,
  `ALTER TABLE renewal_history ADD COLUMN rrn TEXT`
];

async function runMigrations() {
  for (const stmt of MIGRATIONS) {
    try {
      await client.execute(stmt);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message || '')) throw e;
    }
  }
}

async function seedIfEmpty() {
  const userCountRow = await get('SELECT COUNT(*) c FROM users');
  if (userCountRow && Number(userCountRow.c) > 0) return; // already seeded

  const defaultTrainerPassword = process.env.DEFAULT_TRAINER_PASSWORD || 'Abc@123';
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';

  await run(`INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?,?,?,0)`,
    [adminUsername, bcrypt.hashSync(adminPassword, 10), 'admin']);

  await run(`INSERT INTO settings (key, value) VALUES ('registration_fee', '60')`);

  const feeMatrix = {
    badminton: { 8: 300, 12: 400, 16: 500, 24: 700 },
    football: { 8: 280, 12: 380, 16: 480, 24: 650 },
    cricket: { 8: 320, 12: 420, 16: 520, 24: 720 },
    swimming: { 8: 360, 12: 480, 16: 600, 24: 800 }
  };
  for (const [activity, sessions] of Object.entries(feeMatrix)) {
    for (const [count, price] of Object.entries(sessions)) {
      await run('INSERT INTO fee_matrix (activity, sessions, price) VALUES (?,?,?)', [activity, Number(count), price]);
    }
  }

  const trainerSeed = [
    { name: 'Devathi', activity: 'swimming' },
    { name: 'KK', activity: 'swimming' },
    { name: 'Amal', activity: 'swimming' },
    { name: 'Narasimhan', activity: 'badminton' },
    { name: 'Siyad', activity: 'football' },
    { name: 'Akhil', activity: 'cricket' }
  ];
  const trainerHash = bcrypt.hashSync(defaultTrainerPassword, 10);
  for (const t of trainerSeed) {
    const info = await run('INSERT INTO trainers (name, activity) VALUES (?,?)', [t.name, t.activity]);
    await run(`INSERT INTO users (username, password_hash, role, linked_trainer_id, must_change_password) VALUES (?,?,?,?,1)`,
      [t.name, trainerHash, 'trainer', info.lastInsertRowid]);
  }

  const swimmingSlots = {
    Monday: [['4:00 PM – 5:00 PM', null], ['5:00 PM – 6:00 PM', null], ['6:00 PM – 7:00 PM', null], ['7:00 PM – 8:00 PM', null], ['8:00 PM – 9:00 PM — Ladies Only', ['Devathi']]],
    Tuesday: [['4:00 PM – 5:00 PM', null], ['5:00 PM – 6:00 PM', null], ['6:00 PM – 7:00 PM', null], ['7:00 PM – 8:00 PM', null]],
    Wednesday: [['4:00 PM – 5:00 PM', null], ['5:00 PM – 6:00 PM', null], ['6:00 PM – 7:00 PM', null], ['7:00 PM – 8:00 PM', null]],
    Thursday: [['4:00 PM – 5:00 PM', null], ['5:00 PM – 6:00 PM', null], ['6:00 PM – 7:00 PM', null], ['7:00 PM – 8:00 PM', null]],
    Friday: [['4:00 PM – 5:00 PM', null], ['5:00 PM – 6:00 PM', null], ['6:00 PM – 7:00 PM', null], ['7:00 PM – 8:00 PM', null]],
    Saturday: [['9:00 AM – 10:00 AM', null], ['10:00 AM – 11:00 AM', null], ['11:00 AM – 12:00 PM', null], ['3:00 PM – 4:00 PM — Ladies Only', ['Devathi']]],
    Sunday: [['9:00 AM – 10:00 AM', null], ['10:00 AM – 11:00 AM', null], ['11:00 AM – 12:00 PM', null], ['3:00 PM – 4:00 PM — Ladies Only', ['Devathi']]]
  };
  for (const [day, slots] of Object.entries(swimmingSlots)) {
    for (const [label, restricted] of slots) {
      await run('INSERT INTO schedule_slots (activity, day, label, restricted_to_trainers) VALUES (?,?,?,?)',
        ['swimming', day, label, restricted ? JSON.stringify(restricted) : null]);
    }
  }

  // Every day of the week gets a full set of slots so the time-slot dropdown never comes up
  // empty for a given day - admins can still add/remove individual slots later from the
  // Schedule Config tab.
  const genericDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const genericHours = [
    '6:00 AM – 7:00 AM', '7:00 AM – 8:00 AM', '8:00 AM – 9:00 AM',
    '4:00 PM – 5:00 PM', '5:00 PM – 6:00 PM', '6:00 PM – 7:00 PM', '7:00 PM – 8:00 PM', '8:00 PM – 9:00 PM'
  ];
  for (const activity of ['badminton', 'football', 'cricket']) {
    for (const day of genericDays) {
      for (const label of genericHours) {
        await run('INSERT INTO schedule_slots (activity, day, label, restricted_to_trainers) VALUES (?,?,?,?)', [activity, day, label, null]);
      }
    }
  }

  console.log(`Database seeded on Turso. Admin login -> username: "${adminUsername}", password: "${adminPassword}" (change this after first login).`);
  console.log(`Trainer accounts created with default password "${defaultTrainerPassword}" for: ${trainerSeed.map(t => t.name).join(', ')}`);
}

async function init() {
  await ensureSchema();
  await seedIfEmpty();
}

module.exports = { client, run, get, all, transaction, init };
