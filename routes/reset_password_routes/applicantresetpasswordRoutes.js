const express = require("express");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const { db } = require("../database/database");
const { insertAuditLogAdmission, resolveAuditActor } = require("../../utils/auditLogger");

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

  await insertAuditLogAdmission({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};


// ---------------- Applicant: Get Info ----------------
router.post("/superadmin-get-applicant", async (req, res) => {
  const { email } = req.body;

  try {
    const search = `%${email}%`;

    const [rows] = await db.query(
      `SELECT 
          ant.applicant_number,
          ua.email,
          ua.status,
          pt.first_name,
          pt.middle_name,
          pt.last_name,
          pt.birthOfDate
       FROM user_accounts ua
       JOIN person_table pt ON ua.person_id = pt.person_id
       LEFT JOIN applicant_numbering_table ant ON ant.person_id = pt.person_id
       WHERE ua.role = 'applicant'
         AND (
              pt.first_name LIKE ? OR
              pt.middle_name LIKE ? OR
              pt.last_name LIKE ? OR
              ua.email LIKE ? OR
              ant.applicant_number LIKE ?
         )
       LIMIT 1`,
      [search, search, search, search, search]
    );

    if (!rows.length)
      return res.status(404).json({ message: "Applicant not found" });

    const user = rows[0];

    res.json({
      applicant_number: user.applicant_number,
      email: user.email,
      fullName:
        `${user.last_name}, ${user.first_name} ${user.middle_name || ""}`.trim(),
      birthdate: user.birthOfDate,
      status: user.status,
    });

  } catch (err) {
    console.error("Get applicant error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


// ---------------- SUPER ADMIN - RESET APPLICANT PASSWORD ----------------
router.post("/superadmin-reset-applicant", async (req, res) => {
  const { email } = req.body;
  try {
    const [rows] = await db.query(
      `SELECT user_id FROM user_accounts WHERE email = ? AND role = 'applicant'`,
      [email]
    );
    if (!rows.length) return res.status(404).json({ message: "Applicant not found" });

    const newPassword = Array.from({ length: 8 }, () =>
      String.fromCharCode(Math.floor(Math.random() * 26) + 65)
    ).join("");
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // ✅ Set force_password_change = 1
    await db.query(
      `UPDATE user_accounts SET password = ?, force_password_change = 1 WHERE email = ?`,
      [hashedPassword, email]
    );

    const [settings] = await db.query("SELECT short_term FROM company_settings WHERE id = 1");
    const shortTerm = settings[0]?.short_term || "Institution";

    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
    await transporter.sendMail({
      from: `"${shortTerm} - Information System" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Your Password has been Reset",
      text: `Your new temporary password is: ${newPassword}\n\nPlease change it after logging in.`,
    });

    const { actorId, actorRole } = getAuditActor(req);
    await insertResetAuditLog({ req, action: "APPLICANT_PASSWORD_RESET", message: `${formatAuditActorRole(actorRole)} (${actorId}) reset password for Applicant (${email}).` });

    res.json({ message: "Password reset successfully. Check your email for the new password." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ---------------- Applicant: Update Status ----------------
router.post("/superadmin-update-status-applicant", async (req, res) => {
  const { email, status } = req.body;

  try {
    const [result] = await db.query(
      `UPDATE user_accounts SET status = ? WHERE email = ? AND role = 'applicant'`,
      [status, email]
    );

    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      await insertResetAuditLog({
        req,
        action: "APPLICANT_RESET_STATUS_UPDATE",
        message: `${roleLabel} (${actorId}) set Applicant (${email}) to ${Number(status) === 1 ? "Active" : "Inactive"}.`,
      });
    }

    res.json({ message: "Applicant status updated successfully" });

  } catch (err) {
    console.error("Update applicant status error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ---------------- SUPER ADMIN: GET ALL APPLICANTS ----------------
router.get("/superadmin-get-all-applicants", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        ant.applicant_number,
        pt.first_name,
        pt.middle_name,
        pt.last_name,
        pt.birthOfDate,
        ua.email,
        ua.status
      FROM user_accounts ua
      JOIN person_table pt ON ua.person_id = pt.person_id
      LEFT JOIN applicant_numbering_table ant ON ant.person_id = pt.person_id
      WHERE ua.role = 'applicant'
      ORDER BY ant.applicant_number ASC
    `);

    const formatted = rows.map((user) => ({
      applicant_number: user.applicant_number,
      fullName: `${user.last_name}, ${user.first_name} ${user.middle_name || ""}`.trim(),
      birthdate: user.birthOfDate,
      email: user.email,
      status: user.status,
    }));

    res.json(formatted);

  } catch (err) {
    console.error("Get all applicants error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
