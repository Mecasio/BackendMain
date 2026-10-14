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

/* ============================================================
   🔹 REGISTRAR: GET INFO (Search by Employee ID, Name, Email)
============================================================ */
router.post("/superadmin-get-registrar", async (req, res) => {
  const { search } = req.body;

  try {
    const searchTerm = `%${search}%`;

    const [rows] = await db3.query(
      `
      SELECT 
        employee_id,
        first_name,
        middle_name,
        last_name,
        email,
        status
      FROM user_accounts
      WHERE role IN ('administrator', 'superadmin', 'technical')
      AND (
        employee_id LIKE ? OR
        first_name LIKE ? OR
        middle_name LIKE ? OR
        last_name LIKE ? OR
        email LIKE ?
      )
      LIMIT 1
      `,
      [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Registrar not found" });
    }

    const r = rows[0];

    const fullName = [r.first_name, r.middle_name, r.last_name]
      .filter(Boolean)
      .join(" ");

    res.json({
      employee_id: r.employee_id,
      email: r.email,
      fullName,
      status: r.status ?? 0,
    });

  } catch (err) {
    console.error("Get registrar error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


/* ============================================================
   🔹 REGISTRAR: RESET PASSWORD
============================================================ */
router.post("/superadmin-reset-registrar", async (req, res) => {
  const { email } = req.body;
  let connection;

  try {
    if (!email) {
      return res.status(400).json({
        message: "Email is required.",
      });
    }

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(500).json({
        message: "Email service is not configured. Please set EMAIL_USER and EMAIL_PASS.",
      });
    }

    const [rows] = await db3.query(
      `
      SELECT email
      FROM user_accounts
      WHERE email = ?
      AND role IN ('administrator', 'superadmin', 'technical')
      `,
      [email]
    );

    if (!rows.length) {
      return res.status(404).json({
        message: "Registrar not found.",
      });
    }

    const newPassword = Array.from({ length: 8 }, () =>
      String.fromCharCode(Math.floor(Math.random() * 26) + 65)
    ).join("");

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    let shortTerm = "Institution";

    try {
      const [settings] = await db.query(
        `
        SELECT short_term
        FROM company_settings
        WHERE id = 1
        LIMIT 1
        `
      );

      shortTerm = settings?.[0]?.short_term || "Institution";
    } catch (settingsError) {
      console.error("Company settings error:", settingsError);
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.verify();

    connection = await db3.getConnection();
    await connection.beginTransaction();

    await connection.query(
      `
      UPDATE user_accounts
      SET password = ?,
          force_password_change = 1
      WHERE email = ?
        AND role IN ('administrator', 'superadmin', 'technical')
      `,
      [hashedPassword, email]
    );

    const info = await transporter.sendMail({
      from: `"${shortTerm} - Information System" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Registrar Password Reset",
      text: `Your new temporary password is: ${newPassword}\n\nPlease change it after logging in.`,
    });

    if (info.rejected?.length) {
      throw new Error(`Email was rejected for: ${info.rejected.join(", ")}`);
    }

    await connection.commit();

    console.log("Message sent:", info);

    try {
      const { actorId, actorRole } = getAuditActor(req);

      await insertResetAuditLog({
        req,
        action: "REGISTRAR_PASSWORD_RESET",
        message:
          `${formatAuditActorRole(actorRole)} (${actorId}) ` +
          `reset password for Registrar (${email}).`,
      });
    } catch (auditError) {
      console.error("Audit log error:", auditError);
    }

    return res.json({
      success: true,
      message: "Password reset successfully. Email sent.",
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Reset registrar rollback error:", rollbackError);
      }
    }

    console.error("Reset registrar error:", err);
    console.error(err.stack);

    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  } finally {
    if (connection) connection.release();
  }
});

/* ============================================================
   🔹 REGISTRAR: UPDATE STATUS
============================================================ */
router.post("/superadmin-update-status-registrar", async (req, res) => {
  const { email, status } = req.body;

  try {
    const [result] = await db3.query(
      `UPDATE user_accounts SET status = ? WHERE email = ? AND role IN ('administrator', 'superadmin', 'technical')`,
      [status, email]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Registrar not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertResetAuditLog({
      req,
      action: "REGISTRAR_RESET_STATUS_UPDATE",
      message: `${roleLabel} (${actorId}) set Registrar (${email}) to ${Number(status) === 1 ? "Active" : "Inactive"}.`,
    });

    res.json({
      message: "Registrar status updated successfully",
      status,
    });

  } catch (err) {
    console.error("Update registrar status error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


/* ============================================================
   🔹 REGISTRAR: GET ALL REGISTRARS (TABLE)
============================================================ */
router.get("/superadmin-get-all-registrar", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT 
        employee_id,
        CONCAT(first_name,' ',IFNULL(middle_name,''),' ',last_name) AS fullName,
        email,
        status
      FROM user_accounts
      WHERE role IN ('administrator', 'superadmin', 'technical')
      ORDER BY first_name ASC
    `);

    res.json(rows);

  } catch (err) {
    console.error("Registrar fetch error:", err);
    res.status(500).json({ message: "Server error" });
  }
});


/* ============================================================
   🔹 REGISTRAR: SEARCH TABLE CLICK (LIKE EMPLOYEE)
============================================================ */
router.post("/superadmin-get-registrar-row", async (req, res) => {
  const { search } = req.body;
  const term = `%${search}%`;

  const [rows] = await db3.query(`
    SELECT 
      employee_id,
      CONCAT(first_name,' ',IFNULL(middle_name,''),' ',last_name) AS fullName,
      email,
      status
    FROM user_accounts
    WHERE role IN ('administrator', 'superadmin', 'technical')
    AND (
      employee_id LIKE ? OR
      first_name LIKE ? OR
      last_name LIKE ? OR
      email LIKE ?
    )
    LIMIT 1
  `, [term, term, term, term]);

  if (!rows.length) return res.status(404).json({ message: "Not found" });

  res.json(rows[0]);
});


module.exports = router;
