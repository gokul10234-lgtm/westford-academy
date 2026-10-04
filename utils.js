const db = require('./db');

const activityLetters = { swimming: 'S', badminton: 'B', football: 'F', cricket: 'C' };

function computeAge(dobStr, asOf = new Date()) {
  if (!dobStr) return null;
  const dob = new Date(dobStr);
  if (isNaN(dob)) return null;
  let age = asOf.getFullYear() - dob.getFullYear();
  const monthDiff = asOf.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < dob.getDate())) age--;
  return age;
}

async function makeStudentCode(activity, trainerName) {
  const letter = activityLetters[activity] || 'X';
  const second = (trainerName || '').trim().charAt(0).toUpperCase() || 'X';
  const row = await db.get(`
    SELECT COUNT(*) c FROM students s
    JOIN trainers t ON t.id = s.trainer_id
    WHERE s.activity = ? AND t.name = ?
  `, [activity, trainerName]);
  const serial = String((row?.c || 0) + 1).padStart(3, '0');
  return `${letter}${second}${serial}`;
}

async function calcFee(activity, sessionCount, discountCard, opts = {}) {
  const includeRegistrationFee = opts.includeRegistrationFee !== false; // defaults true (registration); pass false for renewals
  const feeRow = await db.get('SELECT price FROM fee_matrix WHERE activity = ? AND sessions = ?', [activity, sessionCount]);
  const sessionFee = feeRow ? feeRow.price : 0;
  let regFee = 0, waiver = 0;
  if (includeRegistrationFee) {
    const regFeeRow = await db.get(`SELECT value FROM settings WHERE key = 'registration_fee'`);
    regFee = regFeeRow ? Number(regFeeRow.value) : 0;
    waiver = (discountCard === 'fazza' || discountCard === 'enbd') ? regFee : 0;
  }
  const netRegFee = regFee - waiver;
  const vat = sessionFee * 0.05;
  const total = sessionFee + netRegFee + vat;
  return {
    sessionFee: round2(sessionFee),
    registrationFee: round2(regFee),
    waiver: round2(waiver),
    subtotal: round2(sessionFee + netRegFee),
    vat: round2(vat),
    total: round2(total)
  };
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

module.exports = { computeAge, makeStudentCode, calcFee, activityLetters, round2 };
