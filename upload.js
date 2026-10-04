const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth-middleware');
const { computeAge, makeStudentCode, calcFee } = require('./utils');
const asyncHandler = require('./asyncHandler');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const TEMPLATE_COLUMNS = [
  'Full Name', 'DOB (YYYY-MM-DD)', 'Gender', 'Activity', 'Trainer', 'Session Package',
  'Schedule Day', 'Schedule Slot Label', 'Registration Type', 'Referred By', 'Phone', 'Payment Reference'
];

router.get('/template', requireAuth, requireAdmin, (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    TEMPLATE_COLUMNS,
    ['John Doe', '2014-05-12', 'Male', 'badminton', 'Narasimhan', '12', 'Monday', '5:00 PM – 6:00 PM', 'Trial', 'Walk-in', '+971500000000', '']
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="student-bulk-upload-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.post('/students', requireAuth, requireAdmin, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Could not read the uploaded file. Please use the provided template.' });
  }

  const trainers = await db.all('SELECT * FROM trainers WHERE active = 1');
  const validActivities = ['badminton', 'football', 'cricket', 'swimming'];
  const errors = [];
  let inserted = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const rowNum = idx + 2; // account for header row
    const fullName = String(row['Full Name'] || '').trim();
    const dob = String(row['DOB (YYYY-MM-DD)'] || '').trim();
    const gender = String(row['Gender'] || '').trim();
    const activity = String(row['Activity'] || '').trim().toLowerCase();
    const trainerName = String(row['Trainer'] || '').trim();
    const sessionPackage = Number(row['Session Package']);
    const day = String(row['Schedule Day'] || '').trim();
    const slotLabel = String(row['Schedule Slot Label'] || '').trim();
    const registrationType = String(row['Registration Type'] || '').trim() || 'New Registration';
    const referredBy = String(row['Referred By'] || '').trim();
    const phone = String(row['Phone'] || '').trim();

    if (!fullName) { errors.push({ row: rowNum, reason: 'Full Name is required.' }); continue; }
    if (!validActivities.includes(activity)) { errors.push({ row: rowNum, reason: `Activity "${row['Activity']}" is not recognized.` }); continue; }
    const trainer = trainers.find(t => t.name.toLowerCase() === trainerName.toLowerCase() && t.activity === activity);
    if (!trainer) { errors.push({ row: rowNum, reason: `Trainer "${trainerName}" is not recognized for activity "${activity}".` }); continue; }
    const age = computeAge(dob);
    if (age === null || age < 5 || age > 60) { errors.push({ row: rowNum, reason: `DOB "${dob}" is invalid or produces an out-of-range age.` }); continue; }
    if (!sessionPackage || ![8, 12, 16, 24].includes(sessionPackage)) { errors.push({ row: rowNum, reason: `Session Package "${row['Session Package']}" must be one of 8, 12, 16, 24.` }); continue; }
    if (!day || !slotLabel) { errors.push({ row: rowNum, reason: 'Schedule Day and Schedule Slot Label are required.' }); continue; }
    if (registrationType === 'Trial' && !referredBy) { errors.push({ row: rowNum, reason: 'Referred By is required when Registration Type is Trial.' }); continue; }
    if (!phone) { errors.push({ row: rowNum, reason: 'Phone is required.' }); continue; }

    const fee = await calcFee(activity, sessionPackage, 'none');
    const code = await makeStudentCode(activity, trainer.name);
    const schedule = [{ day, time: slotLabel }];

    const info = await db.run(`
      INSERT INTO students (student_code, full_name, dob, gender, age, activity, trainer_id, registration_type,
        referred_by, discount_card, session_package, additional_sessions, total_sessions, schedule, phone, final_fee)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [code, fullName, dob, gender, age, activity, trainer.id, registrationType,
        referredBy || null, 'none', sessionPackage, 0, sessionPackage, JSON.stringify(schedule), phone, fee.total]);

    const attStatements = [];
    for (let i = 0; i < sessionPackage; i++) {
      attStatements.push({ sql: 'INSERT INTO attendance (student_id, session_index, date, slot, present) VALUES (?,?,?,?,NULL)', args: [info.lastInsertRowid, i, '', ''] });
    }
    if (attStatements.length) await db.transaction(attStatements);
    inserted++;
  }

  res.json({ inserted, errorCount: errors.length, errors });
}));

module.exports = router;
