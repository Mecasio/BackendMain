const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const attendanceQrDir = path.join(
  __dirname,
  "..",
  "uploads",
  "AttendanceQrCodes",
);
if (!fs.existsSync(attendanceQrDir))
  fs.mkdirSync(attendanceQrDir, { recursive: true });

// Ensures an exam_attendance row + QR png exist for this applicant/schedule.
//
// Filename is `${applicant_id}_${schedule_id}_attendance.png`, flat under
// AttendanceQrCodes/ — no campus subfolder. schedule_id is kept in the name
// (not just applicant_id) so that if an applicant is later reassigned to a
// different schedule, they get a distinct QR file instead of silently
// reusing/overwriting one that was generated for their old schedule.
//
// IMPORTANT: the filename is deterministic, so if the exam_attendance row
// gets deleted (e.g. manually in MySQL) and then re-created here, a NEW
// token is generated but the OLD png could still be sitting on disk at that
// same path. We must never treat "file exists" as "file matches the
// current token" — regenerate any time the token itself is newly issued,
// not just when the file happens to be missing.
async function ensureAttendanceQr(db, schedule_id, applicant_id) {
  const [[existing]] = await db.query(
    `SELECT qr_token FROM exam_attendance WHERE schedule_id = ? AND applicant_id = ? LIMIT 1`,
    [schedule_id, applicant_id],
  );

  const isNewToken = !existing?.qr_token;
  let token = existing?.qr_token;

  if (isNewToken) {
    token = crypto.randomBytes(20).toString("hex");
    await db.query(
      `INSERT INTO exam_attendance (schedule_id, applicant_id, qr_token, status)
       VALUES (?, ?, ?, 'not_arrived')
       ON DUPLICATE KEY UPDATE qr_token = qr_token`,
      [schedule_id, applicant_id, token],
    );
  }

  const qrFilename = `${applicant_id}_${schedule_id}_attendance.png`;
  const qrPath = path.join(attendanceQrDir, qrFilename);

  // Regenerate whenever the token was just (re)issued, OR the file is
  // simply missing. Do NOT skip generation just because a file happens to
  // exist at this path — a stale file from a deleted-then-recreated row
  // would encode the wrong (old) token and desync from the DB.
  if (isNewToken || !fs.existsSync(qrPath)) {
    await QRCode.toFile(qrPath, token, { width: 300 });
  }

  return { token, qrPath, qrFilename };
}

module.exports = { ensureAttendanceQr };
