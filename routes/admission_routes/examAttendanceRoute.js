const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const { db } = require("../database/database");
const {
  insertAuditLogAdmission,
  resolveAuditActor,
} = require("../../utils/auditLogger");
const { notifyAttendanceUpdated } = require("../../socket/socketService");

const router = express.Router();

const attendanceQrDir = path.join(
  __dirname,
  "..",
  "..",
  "uploads",
  "AttendanceQrCodes",
);
if (!fs.existsSync(attendanceQrDir))
  fs.mkdirSync(attendanceQrDir, { recursive: true });

const formatActorRole = (role) => {
  const safeRole = String(role || "proctor").trim();
  return safeRole
    .split(/[\s_-]+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
};

// Returns current Asia/Manila datetime as "YYYY-MM-DD HH:mm:ss",
// ready to insert directly into a MySQL DATETIME column. Defined
// here (no separate file needed) so scanned_at is always correct
// PH time regardless of the DB connection's timezone setting.
const nowInManila = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
};

// exam_attendance_routes.js
router.get("/exam-attendance/token/:applicant_number", async (req, res) => {
  const { applicant_number } = req.params;
  try {
    const [[assigned]] = await db.query(
      `SELECT schedule_id FROM exam_applicants
       WHERE applicant_id = ? AND COALESCE(email_sent,0)=1 LIMIT 1`,
      [applicant_number],
    );
    if (!assigned)
      return res.status(404).json({ error: "No confirmed schedule yet." });

    const [[record]] = await db.query(
      `SELECT qr_token, status FROM exam_attendance
       WHERE schedule_id = ? AND applicant_id = ? LIMIT 1`,
      [assigned.schedule_id, applicant_number],
    );
    if (!record)
      return res.status(404).json({ error: "QR not generated yet." });

    res.json({ qr_token: record.qr_token, status: record.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// Manually (re)generate QR for every emailed applicant of a schedule
router.post("/exam-attendance/generate/:schedule_id", async (req, res) => {
  const { schedule_id } = req.params;
  try {
    const [applicants] = await db.query(
      `SELECT applicant_id FROM exam_applicants WHERE schedule_id = ? AND COALESCE(email_sent,0)=1`,
      [schedule_id],
    );
    const results = [];
    for (const row of applicants) {
      const applicant_id = row.applicant_id;
      const [[existing]] = await db.query(
        `SELECT qr_token FROM exam_attendance WHERE schedule_id = ? AND applicant_id = ? LIMIT 1`,
        [schedule_id, applicant_id],
      );
      let token = existing?.qr_token;
      if (!token) {
        token = crypto.randomBytes(20).toString("hex");
        await db.query(
          `INSERT INTO exam_attendance (schedule_id, applicant_id, qr_token, status) VALUES (?,?,?,'not_arrived')`,
          [schedule_id, applicant_id, token],
        );
      }
      const qrFilename = `${applicant_id}_${schedule_id}_attendance.png`;
      await QRCode.toFile(path.join(attendanceQrDir, qrFilename), token, {
        width: 300,
      });
      results.push({
        applicant_id,
        qr_token: token,
        qr_url: `/uploads/AttendanceQrCodes/${qrFilename}`,
      });
    }
    res.json({ success: true, generated: results });
  } catch (err) {
    console.error("Error generating attendance QR codes:", err);
    res.status(500).json({
      success: false,
      error: "Failed to generate attendance QR codes.",
    });
  }
});

// List applicants + status for a schedule (Module 2)
router.get("/exam-attendance/schedule/:schedule_id", async (req, res) => {
  const { schedule_id } = req.params;
  try {
    const [rows] = await db.query(
      `
      SELECT
        ea.applicant_id, ant.person_id,
        pt.last_name, pt.first_name, pt.middle_name, pt.program,
        COALESCE(att.status,'not_arrived') AS status,
        att.scanned_at, att.scanned_by
      FROM exam_applicants ea
      JOIN applicant_numbering_table ant ON ant.applicant_number = ea.applicant_id
      JOIN person_table pt ON pt.person_id = ant.person_id
      LEFT JOIN exam_attendance att
        ON att.schedule_id = ea.schedule_id AND att.applicant_id = ea.applicant_id
      WHERE ea.schedule_id = ? AND COALESCE(ea.email_sent,0)=1
      ORDER BY pt.last_name ASC, pt.first_name ASC
      `,
      [schedule_id],
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching attendance list:", err);
    res.status(500).json({ error: "Failed to fetch attendance list." });
  }
});

// Scan — marks present, one-time use
router.post("/exam-attendance/scan", async (req, res) => {
  const { token, scanned_by, scanned_by_role } = req.body;
  if (!token)
    return res
      .status(400)
      .json({ success: false, message: "No QR token provided." });

  try {
    const [[record]] = await db.query(
      `SELECT ea.*, pt.last_name, pt.first_name, pt.middle_name, pt.program,
              s.day_description, s.room_description
       FROM exam_attendance ea
       JOIN applicant_numbering_table ant ON ant.applicant_number = ea.applicant_id
       JOIN person_table pt ON pt.person_id = ant.person_id
       JOIN entrance_exam_schedule s ON s.schedule_id = ea.schedule_id
       WHERE ea.qr_token = ? LIMIT 1`,
      [token],
    );

    if (!record) {
      return res
        .status(404)
        .json({ success: false, message: "Invalid or unrecognized QR code." });
    }
    if (record.status === "present") {
      return res.status(409).json({
        success: false,
        message: `Already scanned at ${record.scanned_at}. This QR code cannot be used again.`,
        applicant: {
          applicant_id: record.applicant_id,
          name: `${record.last_name}, ${record.first_name} ${record.middle_name || ""}`.trim(),
        },
      });
    }

    // Generate the timestamp in Manila time explicitly instead of
    // trusting the DB connection's timezone via NOW().
    const scannedAtPH = nowInManila();

    const [result] = await db.query(
      `UPDATE exam_attendance SET status='present', scanned_at=?, scanned_by=?
       WHERE qr_token=? AND status != 'present'`,
      [scannedAtPH, scanned_by || "unknown", token],
    );
    if (result.affectedRows === 0) {
      return res
        .status(409)
        .json({ success: false, message: "This QR code was already scanned." });
    }

    const { actorId, actorRole } = resolveAuditActor(req);
    const applicantName =
      `${record.last_name}, ${record.first_name} ${record.middle_name || ""}`.trim();
    await insertAuditLogAdmission({
      actorId: scanned_by || actorId,
      role: scanned_by_role || actorRole,
      action: "EXAM_ATTENDANCE_SCAN",
      severity: "INFO",
      message: `${formatActorRole(scanned_by_role || actorRole)} (${scanned_by || actorId}) scanned Applicant (${record.applicant_id} - ${applicantName}) present for ${record.day_description}, ${record.room_description}.`,
    });

    notifyAttendanceUpdated({
      schedule_id: record.schedule_id,
      applicant_id: record.applicant_id,
      status: "present",
    });

    res.json({
      success: true,
      message: `${applicantName} marked PRESENT.`,
      applicant: {
        applicant_id: record.applicant_id,
        name: applicantName,
        program: record.program,
        room: record.room_description,
        day: record.day_description,
        scanned_at: scannedAtPH,
      },
    });
  } catch (err) {
    console.error("Error scanning attendance QR:", err);
    res
      .status(500)
      .json({ success: false, message: "Server error while scanning." });
  }
});

router.put("/exam-attendance/mark-absent/:schedule_id", async (req, res) => {
  const { schedule_id } = req.params;
  const { audit_actor_id, audit_actor_role } = req.body;
  try {
    const absentAtPH = nowInManila();

    // 1) Flip existing not_arrived rows to absent
    const [updateResult] = await db.query(
      `UPDATE exam_attendance SET status='absent', absent_at=? WHERE schedule_id=? AND status='not_arrived'`,
      [absentAtPH, schedule_id],
    );

    // 2) Applicants with NO exam_attendance row yet (QR never generated/scanned)
    //    also need to be marked absent — UPDATE can't reach them, so INSERT.
    const [applicantsNoRow] = await db.query(
      `SELECT ea.applicant_id
       FROM exam_applicants ea
       LEFT JOIN exam_attendance att
         ON att.schedule_id = ea.schedule_id AND att.applicant_id = ea.applicant_id
       WHERE ea.schedule_id = ? AND COALESCE(ea.email_sent,0)=1 AND att.id IS NULL`,
      [schedule_id],
    );

    let insertedCount = 0;
    for (const row of applicantsNoRow) {
      const token = crypto.randomBytes(20).toString("hex");
      await db.query(
        `INSERT INTO exam_attendance (schedule_id, applicant_id, qr_token, status, absent_at)
         VALUES (?, ?, ?, 'absent', ?)`,
        [schedule_id, row.applicant_id, token, absentAtPH],
      );
      insertedCount++;
    }

    const totalMarked = updateResult.affectedRows + insertedCount;

    await insertAuditLogAdmission({
      actorId: audit_actor_id || "unknown",
      role: audit_actor_role || "registrar",
      action: "EXAM_ATTENDANCE_MARK_ABSENT",
      severity: "INFO",
      message: `${formatActorRole(audit_actor_role)} (${audit_actor_id || "unknown"}) marked ${totalMarked} applicant(s) ABSENT for schedule ${schedule_id}.`,
    });

    notifyAttendanceUpdated({
      schedule_id,
      status: "absent",
      count: totalMarked,
    });
    res.json({ success: true, marked_absent: totalMarked });
  } catch (err) {
    console.error("Error marking absentees:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to mark absentees." });
  }
});

// Manual override — registrar/proctor sets PRESENT or ABSENT by hand
// Body: { schedule_id, applicant_id, status, scanned_by, scanned_by_role }
router.put("/exam-attendance/manual", async (req, res) => {
  const { schedule_id, applicant_id, status, scanned_by, scanned_by_role } =
    req.body;

  if (
    !schedule_id ||
    !applicant_id ||
    !["present", "absent"].includes(status)
  ) {
    return res.status(400).json({
      success: false,
      message:
        "schedule_id, applicant_id, and a valid status ('present' or 'absent') are required.",
    });
  }

  try {
    const [[existing]] = await db.query(
      `SELECT id, qr_token FROM exam_attendance WHERE schedule_id = ? AND applicant_id = ? LIMIT 1`,
      [schedule_id, applicant_id],
    );

    const stampPH = nowInManila();

    if (!existing) {
      // No row yet (QR never generated/scanned) — create one directly at the target status
      const token = crypto.randomBytes(20).toString("hex");
      await db.query(
        `INSERT INTO exam_attendance
           (schedule_id, applicant_id, qr_token, status, scanned_at, scanned_by, absent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          schedule_id,
          applicant_id,
          token,
          status,
          status === "present" ? stampPH : null,
          status === "present" ? scanned_by || "unknown" : null,
          status === "absent" ? stampPH : null,
        ],
      );
    } else {
      await db.query(
        `UPDATE exam_attendance
         SET status = ?,
             scanned_at = IF(? = 'present', ?, scanned_at),
             scanned_by = IF(? = 'present', ?, scanned_by),
             absent_at  = IF(? = 'absent', ?, absent_at)
         WHERE schedule_id = ? AND applicant_id = ?`,
        [
          status,
          status,
          stampPH,
          status,
          scanned_by || "unknown",
          status,
          stampPH,
          schedule_id,
          applicant_id,
        ],
      );
    }

    const { actorId, actorRole } = resolveAuditActor(req);
    await insertAuditLogAdmission({
      actorId: scanned_by || actorId,
      role: scanned_by_role || actorRole,
      action: "EXAM_ATTENDANCE_MANUAL_OVERRIDE",
      severity: "INFO",
      message: `${formatActorRole(scanned_by_role || actorRole)} (${scanned_by || actorId}) manually set Applicant (${applicant_id}) attendance to ${status.toUpperCase()} for schedule ${schedule_id}.`,
    });

    res.json({ success: true, applicant_id, status });
  } catch (err) {
    console.error("Error setting manual attendance:", err);
    res
      .status(500)
      .json({
        success: false,
        message: "Server error setting manual attendance.",
      });
  }
});

module.exports = router;
