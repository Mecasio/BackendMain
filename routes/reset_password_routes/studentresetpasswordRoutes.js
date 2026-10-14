const express = require("express");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const { db, db3 } = require("../database/database");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");

const router = express.Router();

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const insertResetAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

/* =====================================
   SUPER ADMIN: GET SINGLE STUDENT
===================================== */
router.post("/superadmin-get-student", async (req, res) => {
  const { search } = req.body;

  try {
    const like = `%${search}%`;

    const [rows] = await db3.query(
      `SELECT 
          ua.status,
          ua.email,
          pt.student_number,
          pt.first_name,
          pt.middle_name,
          pt.last_name,
          pt.birthOfDate
       FROM user_accounts ua
       JOIN person_table pt ON ua.person_id = pt.person_id
       WHERE ua.role = 'student'
         AND (
            pt.student_number LIKE ?
            OR ua.email LIKE ?
            OR pt.first_name LIKE ?
            OR pt.middle_name LIKE ?
            OR pt.last_name LIKE ?
            OR CONCAT(pt.first_name,' ',pt.last_name) LIKE ?
            OR CONCAT(pt.last_name,' ',pt.first_name) LIKE ?
         )
       LIMIT 1`,
      [like, like, like, like, like, like, like]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Student not found" });
    }

    const user = rows[0];

    res.json({
      student_number: user.student_number,
      email: user.email,
      fullName: `${user.first_name} ${user.middle_name || ""} ${user.last_name}`.trim(),
      birthdate: user.birthOfDate,
      status: user.status ?? 0,
    });

  } catch (err) {
    console.error("Get student error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


/* =====================================
   SUPER ADMIN: UPDATE STUDENT STATUS
===================================== */
router.post("/superadmin-update-status-student", async (req, res) => {
  const { email, status } = req.body;

  try {
    const [result] = await db3.query(
      `UPDATE user_accounts 
       SET status = ?
       WHERE email = ? AND role = 'student'`,
      [status, email]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Student not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertResetAuditLog({
      req,
      action: "STUDENT_RESET_STATUS_UPDATE",
      message: `${roleLabel} (${actorId}) set Student (${email}) to ${Number(status) === 1 ? "Active" : "Inactive"}.`,
    });

    res.json({
      message: "Student status updated successfully",
      status,
    });

  } catch (err) {
    console.error("Update student status error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


/* =====================================
   SUPER ADMIN: RESET STUDENT PASSWORD
===================================== */

router.post("/superadmin-reset-student", async (req, res) => {
  const { search } = req.body;
  try {
    if (!search) return res.status(400).json({ message: "Missing search value" });

    const like = `%${search}%`;
    const [rows] = await db3.query(
      `SELECT ua.email
       FROM user_accounts ua
       JOIN person_table pt ON ua.person_id = pt.person_id
       WHERE ua.role = 'student'
         AND (
           pt.student_number LIKE ? OR ua.email LIKE ? OR pt.emailAddress LIKE ?
           OR pt.first_name LIKE ? OR pt.middle_name LIKE ? OR pt.last_name LIKE ?
           OR CONCAT(pt.first_name,' ',pt.last_name) LIKE ?
         )
       LIMIT 1`,
      [like, like, like, like, like, like, like]
    );
    if (!rows.length) return res.status(404).json({ message: "Student not found" });

    const email = rows[0].email;
    if (!email) return res.status(400).json({ message: "No valid email found" });

    const [settings] = await db.query("SELECT short_term FROM company_settings WHERE id = 1");
    const shortTerm = settings[0]?.short_term || "Institution";

    const newPassword = Array.from({ length: 8 }, () =>
      String.fromCharCode(Math.floor(Math.random() * 26) + 65)
    ).join("");
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // ✅ Set force_password_change = 1
    await db3.query(
      "UPDATE user_accounts SET password = ?, force_password_change = 1 WHERE email = ?",
      [hashedPassword, email]
    );

    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
    await transporter.sendMail({
      from: `"${shortTerm} - Information System" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Your Password Has Been Reset",
      text: `Your new temporary password is: ${newPassword}\n\nPlease change it after logging in.`,
    });

    const { actorId, actorRole } = getAuditActor(req);
    await insertResetAuditLog({ req, action: "STUDENT_PASSWORD_RESET", message: `${formatAuditActorRole(actorRole)} (${actorId}) reset password for Student (${email}).` });

    res.json({ message: "Password reset successfully. Check your email." });
  } catch (err) {
    console.error("Reset student error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/* =====================================
   SUPER ADMIN: GET ALL STUDENTS
===================================== */
router.get("/superadmin-get-all-students", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT 
        sn.student_number,
        pt.first_name,
        pt.middle_name,
        pt.last_name,
        pt.birthOfDate,
        ua.email,
        ua.status
      FROM user_accounts ua
      JOIN person_table pt 
        ON ua.person_id = pt.person_id
      LEFT JOIN student_numbering_table sn
        ON pt.person_id = sn.person_id
      WHERE ua.role = 'student'
      ORDER BY sn.student_number ASC
    `);

    const formatted = rows.map((user) => ({
      student_number: user.student_number,
      fullName: `${user.last_name}, ${user.first_name} ${user.middle_name || ""}`.trim(),
      birthdate: user.birthOfDate,
      email: user.email,
      status: user.status,
    }));

    res.json(formatted);

  } catch (err) {
    console.error("Get all students error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


module.exports = router;
