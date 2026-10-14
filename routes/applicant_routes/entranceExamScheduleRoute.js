const express = require("express");
const crypto = require("crypto");
const { db } = require("../database/database");
const { insertAuditLogAdmission } = require("../../utils/auditLogger");
const { notifyAttendanceUpdated } = require("../../socket/socketService");

module.exports = (io) => {
  const router = express.Router();

  // ------------------------------------------------------------------
  // Helper: create (or fetch existing) attendance token for one applicant
  // on one schedule. Call this right after an exam-schedule email is
  // confirmed sent — see the integration snippet at the bottom of this
  // file / README for where to hook it into send_schedule_emails.
  // ------------------------------------------------------------------
  const ensureAttendanceToken = async (applicant_id, schedule_id) => {
    const [[existing]] = await db.query(
      `SELECT qr_token FROM exam_attendance WHERE applicant_id = ? AND schedule_id = ? LIMIT 1`,
      [applicant_id, schedule_id],
    );
    if (existing) return existing.qr_token;

    const token = crypto.randomBytes(32).toString("hex"); // 64-char token
    await db.query(
      `INSERT INTO exam_attendance (applicant_id, schedule_id, qr_token, status)
       VALUES (?, ?, ?, 'PENDING')
       ON DUPLICATE KEY UPDATE qr_token = qr_token`, // no-op if a race already inserted it
      [applicant_id, schedule_id, token],
    );
    return token;
  };

  // Exported so server.js / the socket handler can call it directly
  // without going through HTTP.
  router.ensureAttendanceToken = ensureAttendanceToken;

  // ------------------------------------------------------------------
  // GET /api/exam/attendance/qr/:applicant_number
  // Used by ExamPermit.jsx to fetch the payload to encode in the QR.
  // Only returns a token if the applicant currently has a *sent*
  // (email_sent = 1) entrance exam schedule — otherwise there's nothing
  // to scan yet.
  // ------------------------------------------------------------------
  router.get("/exam/attendance/qr/:applicant_number", async (req, res) => {
    const { applicant_number } = req.params;

    try {
      const [[assigned]] = await db.query(
        `SELECT schedule_id FROM exam_applicants
         WHERE applicant_id = ? AND COALESCE(email_sent, 0) = 1
         LIMIT 1`,
        [applicant_number],
      );

      if (!assigned) {
        return res.status(404).json({
          error: "No confirmed exam schedule found for this applicant yet.",
        });
      }

      const token = await ensureAttendanceToken(
        applicant_number,
        assigned.schedule_id,
      );

      res.json({
        applicant_number,
        schedule_id: assigned.schedule_id,
        qr_payload: `EARIST-EXAM-ATTENDANCE:${token}`,
      });
    } catch (err) {
      console.error("Error generating attendance QR:", err);
      res.status(500).json({ error: "Server error generating attendance QR" });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/exam/attendance/scan
  // Called by the proctor's scanner (mobile app or the qr_scanner.html
  // page). Body: { qr_payload, scanned_by, scanned_by_role }
  // ------------------------------------------------------------------
  router.post("/exam/attendance/scan", async (req, res) => {
    const { qr_payload, scanned_by, scanned_by_role } = req.body;

    if (!qr_payload) {
      return res.status(400).json({ error: "Missing QR payload." });
    }

    const token = String(qr_payload)
      .replace(/^EARIST-EXAM-ATTENDANCE:/, "")
      .trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return res
        .status(400)
        .json({ error: "Not a valid exam attendance QR code." });
    }

    try {
      const [[record]] = await db.query(
        `SELECT ea.*, ant.person_id
         FROM exam_attendance ea
         LEFT JOIN applicant_numbering_table ant ON ant.applicant_number = ea.applicant_id
         WHERE ea.qr_token = ?
         LIMIT 1`,
        [token],
      );

      if (!record) {
        return res.status(404).json({ error: "QR code not recognized." });
      }

      // Pull applicant + schedule details for the confirmation screen
      const [[details]] = await db.query(
        `SELECT
           p.last_name, p.first_name, p.middle_name, p.program,
           s.proctor, s.building_description, s.room_description,
           s.day_description, s.start_time, s.end_time
         FROM person_table p
         JOIN entrance_exam_schedule s ON s.schedule_id = ?
         WHERE p.person_id = ?
         LIMIT 1`,
        [record.schedule_id, record.person_id],
      );

      if (record.status === "PRESENT") {
        return res.status(409).json({
          error: "Already marked present.",
          scanned_at: record.scanned_at,
          scanned_by: record.scanned_by,
          applicant: details || null,
        });
      }

      await db.query(
        `UPDATE exam_attendance
         SET status = 'PRESENT', scanned_at = NOW(), scanned_by = ?, scanned_by_role = ?
         WHERE attendance_id = ?`,
        [
          scanned_by || "unknown",
          scanned_by_role || "proctor",
          record.attendance_id,
        ],
      );

      await insertAuditLogAdmission({
        actorId: scanned_by || "unknown",
        role: scanned_by_role || "proctor",
        action: "ENTRANCE_EXAM_ATTENDANCE_SCAN",
        severity: "INFO",
        message: `${scanned_by_role || "Proctor"} (${scanned_by || "unknown"}) scanned Applicant (${record.applicant_id}) as PRESENT for entrance exam schedule ${record.schedule_id}.`,
      });

      notifyAttendanceUpdated({
          schedule_id: record.schedule_id,
          applicant_id: record.applicant_id,
          status: "PRESENT",
        });

      res.json({
        success: true,
        message: "Attendance recorded.",
        applicant_number: record.applicant_id,
        applicant: details || null,
      });
    } catch (err) {
      console.error("Error scanning attendance QR:", err);
      res.status(500).json({ error: "Server error scanning attendance QR." });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/exam/attendance/schedule/:schedule_id
  // For the registrar dashboard — full roster + status for one schedule.
  // ------------------------------------------------------------------
  router.get("/exam/attendance/schedule/:schedule_id", async (req, res) => {
    const { schedule_id } = req.params;

    try {
      const [rows] = await db.query(
        `SELECT
           ea.applicant_id, ea.status, ea.scanned_at, ea.scanned_by,
           p.last_name, p.first_name, p.middle_name
         FROM exam_attendance ea
         JOIN applicant_numbering_table ant ON ant.applicant_number = ea.applicant_id
         JOIN person_table p ON p.person_id = ant.person_id
         WHERE ea.schedule_id = ?
         ORDER BY p.last_name, p.first_name`,
        [schedule_id],
      );

      const summary = rows.reduce(
        (acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        },
        { PENDING: 0, PRESENT: 0, ABSENT: 0 },
      );

      res.json({ schedule_id, summary, applicants: rows });
    } catch (err) {
      console.error("Error fetching attendance roster:", err);
      res
        .status(500)
        .json({ error: "Server error fetching attendance roster." });
    }
  });

  // ------------------------------------------------------------------
  // PUT /api/exam/attendance/manual
  // Fallback for the registrar to mark someone PRESENT/ABSENT by hand
  // (lost phone, printed permit not scannable, etc.)
  // Body: { applicant_id, schedule_id, status, actor_id, actor_role }
  // ------------------------------------------------------------------
  router.put("/exam/attendance/manual", async (req, res) => {
    const { applicant_id, schedule_id, status, actor_id, actor_role } =
      req.body;

    if (
      !applicant_id ||
      !schedule_id ||
      !["PRESENT", "ABSENT", "PENDING"].includes(status)
    ) {
      return res
        .status(400)
        .json({
          error: "applicant_id, schedule_id, and a valid status are required.",
        });
    }

    try {
      await ensureAttendanceToken(applicant_id, schedule_id);

      await db.query(
        `UPDATE exam_attendance
         SET status = ?, scanned_at = IF(? = 'PRESENT', NOW(), scanned_at),
             scanned_by = ?, scanned_by_role = ?, scan_note = 'manual override'
         WHERE applicant_id = ? AND schedule_id = ?`,
        [
          status,
          status,
          actor_id || "unknown",
          actor_role || "registrar",
          applicant_id,
          schedule_id,
        ],
      );

      await insertAuditLogAdmission({
        actorId: actor_id || "unknown",
        role: actor_role || "registrar",
        action: "ENTRANCE_EXAM_ATTENDANCE_MANUAL_OVERRIDE",
        severity: "INFO",
        message: `${actor_role || "Registrar"} (${actor_id || "unknown"}) manually set Applicant (${applicant_id}) attendance to ${status} for entrance exam schedule ${schedule_id}.`,
      });

      notifyAttendanceUpdated({ schedule_id, applicant_id, status });

      res.json({ success: true });
    } catch (err) {
      console.error("Error setting manual attendance:", err);
      res
        .status(500)
        .json({ error: "Server error setting manual attendance." });
    }
  });

  return router;
};
