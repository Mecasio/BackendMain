const express = require("express");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const { db, db3 } = require("../database/database");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
require("dotenv").config();
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const studentPhotoDir = path.join(__dirname, "..", "..", "uploads", "Student1by1");
if (!fs.existsSync(studentPhotoDir)) {
  fs.mkdirSync(studentPhotoDir, { recursive: true });
}

const studentPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, studentPhotoDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `student_${req.params.person_id}_${Date.now()}${ext}`);
  },
});

const uploadStudentPhoto = multer({
  storage: studentPhotoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Invalid file type. Only JPEG/PNG allowed."));
  },
});

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const insertStudentAccountAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

router.get("/student_list", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const requestedLimit = Number(req.query.limit) || 100;
    const limit = Math.min(Math.max(requestedLimit, 1), 200);
    const search = req.query.search?.trim() || "";

    const offset = (page - 1) * limit;

    let whereClause = "";
    let params = [];

    if (search) {
      whereClause = `
        WHERE 
          snt.student_number LIKE ? OR
          pt.last_name LIKE ? OR
          pt.first_name LIKE ?
      `;

      const searchValue = `${search}%`;
      params = [searchValue, searchValue, searchValue];
    }

  const listSql = `
  SELECT
    snt.student_number,
    pt.campus,
    pt.person_id,
    pt.last_name,
    pt.first_name,
    pt.middle_name,
    pt.emailAddress,
    pt.profile_img,
    ua.status AS account_status
  FROM student_numbering_table snt
  INNER JOIN person_table pt
    ON snt.person_id = pt.person_id
  LEFT JOIN user_accounts ua
    ON ua.person_id = pt.person_id AND ua.role = 'student'
  ${whereClause}
  ORDER BY snt.student_number ASC
  LIMIT ? OFFSET ?
`;

    const [students] = await db3.query(listSql, [...params, limit, offset]);
    let rows = students;

    if (students.length > 0) {
      const studentNumbers = students.map((student) => student.student_number);
      const placeholders = studentNumbers.map(() => "?").join(", ");

      const metadataSql = `
        SELECT
          latest.student_number,
          pgt.program_code,
          pgt.program_id,
          pgt.program_description,
          pgt.major,
          dt.dprtmnt_name,
          dt.dprtmnt_id
        FROM (
          SELECT
            es.student_number,
            MAX(es.id) AS enrolled_subject_id
          FROM enrolled_subject es
          WHERE es.student_number IN (${placeholders})
          GROUP BY es.student_number
        ) latest
        INNER JOIN enrolled_subject es
          ON es.id = latest.enrolled_subject_id
        LEFT JOIN curriculum_table ct
          ON es.curriculum_id = ct.curriculum_id
        LEFT JOIN program_table pgt
          ON ct.program_id = pgt.program_id
        LEFT JOIN dprtmnt_curriculum_table dct
          ON ct.curriculum_id = dct.curriculum_id
        LEFT JOIN dprtmnt_table dt
          ON dct.dprtmnt_id = dt.dprtmnt_id
      `;

      const [metadataRows] = await db3.query(metadataSql, studentNumbers);
      const metadataByStudentNumber = new Map(
        metadataRows.map((row) => [row.student_number, row]),
      );

      rows = students.map((student) => {
        const metadata = metadataByStudentNumber.get(student.student_number);
        return {
          ...student,
          program_code: metadata?.program_code || null,
          program_id: metadata?.program_id || null,
          program_description: metadata?.program_description || null,
          major: metadata?.major || null,
          dprtmnt_name: metadata?.dprtmnt_name || null,
          dprtmnt_id: metadata?.dprtmnt_id || null,
        };
      });
    }

    let countSql = `
      SELECT COUNT(*) as total
      FROM student_numbering_table snt
      INNER JOIN person_table pt 
        ON snt.person_id = pt.person_id
      ${whereClause}
    `;

    const [countRows] = await db3.query(countSql, params);

    res.json({
      data: rows,
      total: countRows[0].total,
      page,
      totalPages: Math.ceil(countRows[0].total / limit),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

router.get("/student_list/:student_number", async (req, res) => {
  const { student_number } = req.params;

  try {
    const sql = `
      SELECT
        snt.student_number,
        pt.person_id,
        pt.last_name,
        pt.first_name,
        pt.middle_name,
        pt.emailAddress,
        pgt.program_code,
        pgt.program_description,
        dt.dprtmnt_name,
        ylt.year_level_description
      FROM student_numbering_table snt
      INNER JOIN person_table pt
        ON snt.person_id = pt.person_id
      LEFT JOIN enrolled_subject es
        ON es.id = (
          SELECT MAX(es2.id)
          FROM enrolled_subject es2
          WHERE es2.student_number = snt.student_number
        )
      LEFT JOIN curriculum_table ct
        ON es.curriculum_id = ct.curriculum_id
      LEFT JOIN program_table pgt
        ON ct.program_id = pgt.program_id
      LEFT JOIN dprtmnt_curriculum_table dct
        ON ct.curriculum_id = dct.curriculum_id
      LEFT JOIN dprtmnt_table dt
        ON dct.dprtmnt_id = dt.dprtmnt_id
      LEFT JOIN student_status_table sts
        ON sts.id = (
          SELECT MAX(sst.id)
          FROM student_status_table sst
          WHERE sst.student_number = snt.student_number
        )
      LEFT JOIN year_level_table ylt
        ON sts.year_level_id = ylt.year_level_id
      WHERE snt.student_number = ?
      LIMIT 1
    `;

    const [rows] = await db3.query(sql, [student_number]);
    res.json(rows);
  } catch (error) {
    console.error("FULL ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// ── Single, merged PUT handler (duplicate removed) ──────────────────────────
router.put(
  "/student_account/:person_id",
  uploadStudentPhoto.single("student_photo"),
  async (req, res) => {
    const { person_id } = req.params;
    const { email, password, first_name, middle_name, last_name } = req.body;
    const status = req.body.status !== undefined ? Number(req.body.status) : 1;

    let conn;

    try {
      const normalizedEmail = String(email || "").trim().toLowerCase();

      if (!person_id || !normalizedEmail) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          success: false,
          message: "Person ID and email are required",
        });
      }

      conn = await db3.getConnection();
      await conn.beginTransaction();

      const [personRows] = await conn.query(
        `SELECT person_id, first_name, middle_name, last_name, profile_img
         FROM person_table
         WHERE person_id = ?
         LIMIT 1`,
        [person_id],
      );

      if (personRows.length === 0) {
        await conn.rollback();
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(404).json({ success: false, message: "Student not found" });
      }

      const [duplicateAccounts] = await conn.query(
        `SELECT ua.id
         FROM user_accounts ua
         WHERE LOWER(ua.email) = ?
           AND ua.person_id != ?
         LIMIT 1`,
        [normalizedEmail, person_id],
      );

      if (duplicateAccounts.length > 0) {
        await conn.rollback();
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ success: false, message: "Email already exists" });
      }

      const current = personRows[0];
      const nextFirstName = first_name ?? current.first_name;
      const nextMiddleName = middle_name ?? current.middle_name;
      const nextLastName = last_name ?? current.last_name;
      const nextProfileImg = req.file ? req.file.filename : current.profile_img;

      await conn.query(
        `UPDATE person_table
         SET first_name = ?, middle_name = ?, last_name = ?, emailAddress = ?, profile_img = ?
         WHERE person_id = ?`,
        [nextFirstName, nextMiddleName || null, nextLastName, normalizedEmail, nextProfileImg, person_id],
      );

      const [accountRows] = await conn.query(
        `SELECT id, profile_picture
         FROM user_accounts
         WHERE person_id = ? AND role = 'student'
         LIMIT 1`,
        [person_id],
      );

      const hashedPassword = password ? await bcrypt.hash(String(password), 10) : null;

      // ── Track the account id no matter which branch runs ──────────────────
      let accountId = accountRows.length > 0 ? accountRows[0].id : null;

      if (accountRows.length > 0) {
        const params = [nextLastName, nextMiddleName || null, nextFirstName, normalizedEmail, status];
        let passwordSql = "";
        let photoSql = "";

        if (hashedPassword) {
          passwordSql = ", password = ?";
          params.push(hashedPassword);
        }
        if (req.file) {
          photoSql = ", profile_picture = ?";
          params.push(req.file.filename);
        }

        params.push(accountRows[0].id);

        await conn.query(
          `UPDATE user_accounts
           SET last_name = ?, middle_name = ?, first_name = ?, email = ?, status = ?${passwordSql}${photoSql}
           WHERE id = ?`,
          params,
        );

        if (hashedPassword) {
          await conn.query(
            `UPDATE user_accounts
             SET force_password_change = 1, totp_enabled = 1
             WHERE id = ?`,
            [accountRows[0].id],
          );
        }

        // clean up the old photo file if we just replaced it
        if (req.file && accountRows[0].profile_picture) {
          fs.unlink(path.join(studentPhotoDir, accountRows[0].profile_picture), () => {});
        }
      } else {
        // ── Always create the account row, even without a password ──────────
        const [insertResult] = await conn.query(
          `INSERT INTO user_accounts
            (person_id, role, last_name, middle_name, first_name, email, password, profile_picture, status, force_password_change, totp_enabled)
           VALUES (?, 'student', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            person_id,
            nextLastName,
            nextMiddleName || null,
            nextFirstName,
            normalizedEmail,
            hashedPassword || null,
            req.file ? req.file.filename : null,
            status,
            hashedPassword ? 1 : 0,
            1,
          ],
        );
        accountId = insertResult.insertId;
      }

      await conn.commit();

      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      const studentLabel = [nextLastName, nextFirstName, nextMiddleName].filter(Boolean).join(", ");
      await insertStudentAccountAuditLog({
        req,
        action: hashedPassword ? "STUDENT_ACCOUNT_SAVE_WITH_PASSWORD" : "STUDENT_ACCOUNT_SAVE",
        message: `${roleLabel} (${actorId}) saved student account for Student (${studentLabel || `person_id ${person_id}`}).`,
      });

      res.json({
        success: true,
        message: hashedPassword
          ? "Student account saved successfully"
          : "Student information saved successfully",
        profile_img: nextProfileImg,
        id: accountId,
        person_id: Number(person_id),
      });
    } catch (error) {
      if (conn) await conn.rollback();
      if (req.file) fs.unlink(req.file.path, () => {});
      console.error("Student account save error:", error);
      res.status(500).json({ success: false, message: "Failed to save student account" });
    } finally {
      if (conn) conn.release();
    }
  },
);

// ── Restored: was missing from the last paste ────────────────────────────────
router.post("/send_student_password_reminder", async (req, res) => {
  const { person_id, email, password } = req.body;

  let conn;
  let emailDeliveryAttempted = false;

  try {
    if (!person_id || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    conn = await db3.getConnection();

    const [student] = await conn.query(
      `
      SELECT
        pt.person_id,
        pt.first_name,
        pt.last_name,
        pt.middle_name,
        snt.student_number
      FROM person_table pt
      LEFT JOIN student_numbering_table snt
        ON pt.person_id = snt.person_id
      WHERE pt.person_id = ?
      `,
      [person_id],
    );

    if (student.length === 0) {
      return res.json({ success: false, message: "Student not found" });
    }

    const [companyRows] = await db.query(`
      SELECT company_name, short_term FROM company_settings LIMIT 1
    `);

    const company_name = companyRows[0]?.company_name || "Company";
    const short_term = companyRows[0]?.short_term || "System";

    let frontendUrl = (process.env.FRONTEND_URL || "").trim();
    // Same scheme guard as /graduate-qr — a bare host:port with no http(s)://
    // produces a QR code that scanners treat as plain text, not a link.
    if (frontendUrl && !/^https?:\/\//i.test(frontendUrl)) {
      frontendUrl = `http://${frontendUrl}`;
    }

    const { first_name, last_name, middle_name, student_number } = student[0];
    const fullName = `${last_name}, ${first_name} ${middle_name || ""}`.trim();

    // ── Generate QR codes (Student QR + TOR QR) ──────────────────────────────
    if (student_number) {
      try {
        // Uses FRONTEND_URL (same source of truth as /graduate-qr) instead of
        // DB_HOST_LOCAL + hardcoded :5173, which only worked while the Vite
        // dev server was running and would break entirely once deployed.
        const qrData = `${frontendUrl}/student_qr_information/${student_number}`;
        const torQrData = `${frontendUrl}/tor_qr_information/${student_number}`;

        const qrFilename = `${student_number}_qrcode.png`;
        const torQrFilename = `${student_number}_tor_qrcode.png`;

        const studentQrDir = path.join(__dirname, "..", "..", "uploads", "StudentQRCodeGenerated");
        const torQrDir = path.join(__dirname, "..", "..", "uploads", "TORStudentQRCodeGenerated");

        if (!fs.existsSync(studentQrDir)) fs.mkdirSync(studentQrDir, { recursive: true });
        if (!fs.existsSync(torQrDir)) fs.mkdirSync(torQrDir, { recursive: true });

        const qrPath = path.join(studentQrDir, qrFilename);
        const torQrPath = path.join(torQrDir, torQrFilename);

        await QRCode.toFile(qrPath, qrData, {
          color: { dark: "#000", light: "#FFF" },
          width: 300,
        });

        await QRCode.toFile(torQrPath, torQrData, {
          color: { dark: "#000", light: "#FFF" },
          width: 300,
        });
      } catch (qrErr) {
        console.error("[send_student_password_reminder] QR generation failed:", qrErr);
        // non-fatal — still send the email even if QR generation fails
      }
    } else {
      console.warn(
        `[send_student_password_reminder] No student_number found for person_id=${person_id}; skipping QR generation.`,
      );
    }

    emailDeliveryAttempted = true;
    await transporter.sendMail({
      from: `"${short_term} — Password Security" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `${short_term} — Action Required: Change Your Password`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; color: #222;">
          <h2 style="margin-bottom: 4px;">${company_name} Student Portal</h2>
          <p style="color: #777; margin-top: 0; font-size: 13px;">Password change reminder</p>

          <p>Hello <strong>${fullName}</strong>,</p>

          <p style="color: #555;">
            This is a reminder that your account is currently using a
            <strong style="color: #222;">temporary password</strong>.
            For the security of your account, you are required to update
            your password as soon as possible.
          </p>

          <table style="background: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 6px;
                         width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr>
              <td style="padding: 12px 16px; font-weight: bold; font-size: 14px;"
                  colspan="2">Account details</td>
            </tr>
            <tr>
              <td style="padding: 6px 16px; color: #777; width: 40%; font-size: 13px;">Username</td>
              <td style="padding: 6px 16px; font-size: 13px;">
                ${email} / ${student_number || "N/A"}
              </td>
            </tr>
            <tr>
              <td style="padding: 6px 16px; color: #777; font-size: 13px;">Temporary password</td>
              <td style="padding: 6px 16px; font-family: monospace; font-size: 13px;">${password}</td>
            </tr>
            <tr>
              <td style="padding: 6px 16px; color: #777; font-size: 13px;">Account type</td>
              <td style="padding: 6px 16px; font-size: 13px;">Student</td>
            </tr>
            <tr>
              <td style="padding: 6px 16px; color: #777; font-size: 13px;">Status</td>
              <td style="padding: 6px 16px; font-size: 13px;">
                <span style="background: #fff8e1; color: #856404; font-size: 12px;
                              padding: 2px 10px; border-radius: 4px;">
                  Requires password change
                </span>
              </td>
            </tr>
          </table>

          <p style="font-weight: bold; font-size: 14px; margin-bottom: 6px;">
            Steps to change your password
          </p>
          <ol style="color: #555; font-size: 13px; line-height: 2;">
            <li>Go to the login page using the link below</li>
            <li>Log in with your username and temporary password</li>
            <li>You will be prompted to set a new password immediately</li>
            <li>Choose a strong password (min. 8 characters, with letters, numbers, and symbols)</li>
          </ol>

          <div style="border-left: 3px solid #dc3545; padding-left: 12px; margin: 16px 0;">
            <p style="color: #dc3545; font-size: 13px; margin: 0; line-height: 1.6;">
              Do not share your password with anyone. This system will never ask
              for your password via email or phone.
            </p>
          </div>

          <p style="font-size: 13px;">
            Login link:<br/>
           https://ap.earist.edu.ph/login
          </p>

          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;" />
          <p style="font-size: 12px; color: #aaa;">
            If you did not request this or believe this was sent in error, please
            contact the system administrator immediately. Do not reply to this email.
          </p>
        </div>
      `,
    });

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertStudentAccountAuditLog({
      req,
      action: "STUDENT_ACCOUNT_PASSWORD_REMINDER",
      message: `${roleLabel} (${actorId}) sent student account password reminder to Student (${student_number || person_id}).`,
    });

    res.json({
      success: true,
      message: "Student password reset reminder sent",
    });
  } catch (error) {
    console.error("EMAIL ERROR:", error);
    res.status(500).json({
      success: false,
      message: emailDeliveryAttempted
        ? "Email delivery failed. Check SMTP account credentials and connection."
        : "Unable to prepare the student password email.",
    });
  } finally {
    if (conn) conn.release();
  }
});


module.exports = router;