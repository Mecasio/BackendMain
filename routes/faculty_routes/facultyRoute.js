const express = require("express");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const { db, db3 } = require("../database/database");
const { CanCreate, CanDelete } = require("../../middleware/pagePermissions");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");

require("dotenv").config();

const router = express.Router();
const facultyImageUploadDir = path.join(__dirname, "../../uploads/Faculty1by1");

const ensureFacultyImageUploadDir = async () => {
  await fs.promises.mkdir(facultyImageUploadDir, { recursive: true });
};

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const upload = multer({ storage: multer.memoryStorage() });

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const getProfessorLabel = (prof) => {
  if (!prof) return "Unknown Professor";
  const name = [prof.lname, prof.fname, prof.mname].filter(Boolean).join(", ");
  return prof.employee_id || name || prof.email || `prof_id ${prof.prof_id || "unknown"}`;
};

const insertFacultyAuditLog = async ({ req, action, message, severity = "INFO" }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity,
    message,
  });
};

const generateTemporaryPassword = (length = 10) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let password = "";
  for (let i = 0; i < length; i += 1) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

const normalizeImportText = (value) => String(value ?? "").trim();

router.post("/update_faculty", upload.single("profile_picture"), async (req, res) => {
  const { employee_id } = req.body;

  if (!employee_id || !req.file) {
    return res.status(400).send("Missing employee_id or file.");
  }

  try {
    // ✅ Get student_number from person_id
    const [rows] = await db3.query(
      "SELECT employee_id FROM prof_table WHERE employee_id = ?",
      [employee_id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Faculty not found for employee_id " + employee_id });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const year = new Date().getFullYear();
    const filename = `${employee_id}_1by1_${year}${ext}`;
    await ensureFacultyImageUploadDir();
    const finalPath = path.join(facultyImageUploadDir, filename);

    const files = await fs.promises.readdir(facultyImageUploadDir);
    for (const file of files) {
      if (file.startsWith(`${employee_id}_1by1_`)) {
        await fs.promises.unlink(path.join(facultyImageUploadDir, file));
      }
    }

    await fs.promises.writeFile(finalPath, req.file.buffer);

    await db3.query("UPDATE prof_table SET profile_image = ? WHERE employee_id = ?", [filename, employee_id]);

    res.status(200).json({ message: "Uploaded successfully", filename });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Failed to upload image.");
  }
});

router.post("/professors/export-audit", async (req, res) => {
  const exportedCount = Number(req.body?.exported_count || 0);
  const fileName = normalizeImportText(req.body?.file_name) || "professors.csv";

  try {
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertFacultyAuditLog({
      req,
      action: "PROFESSOR_ACCOUNT_EXPORT",
      message: `${roleLabel} (${actorId}) exported ${exportedCount} professor account record(s) to ${fileName}.`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to insert professor export audit log:", err);
    res.status(500).json({
      success: false,
      message: "Failed to insert export audit log",
    });
  }
});

// Fetch all professors
router.get("/professors", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT
        pft.prof_id,
        pft.person_id,
        pft.employee_id,
        pft.fname,
        pft.mname,
        pft.lname,
        pft.email,
        pft.role,
        pft.status,
        pft.profile_image,
        dpt.dprtmnt_id,
        dpt.dprtmnt_name,
        dpt.dprtmnt_code
      FROM prof_table AS pft
      LEFT JOIN (
        SELECT dpft_current.*
        FROM dprtmnt_profs_table AS dpft_current
        INNER JOIN (
          SELECT prof_id, MAX(dprtmnt_profs_id) AS latest_id
          FROM dprtmnt_profs_table
          GROUP BY prof_id
        ) AS latest_dpft
          ON latest_dpft.latest_id = dpft_current.dprtmnt_profs_id
      ) AS dpft
        ON dpft.prof_id = pft.prof_id
      LEFT JOIN dprtmnt_table AS dpt 
        ON dpft.dprtmnt_id = dpt.dprtmnt_id
      ORDER BY pft.prof_id DESC
    `);

    res.json(rows);
  } catch (err) {
    res.status(500).json({
      error: "Failed to retrieve professors",
      details: err.message
    });
  }
});

// ADD PROFESSOR ROUTE (Consistent with /api)
router.post(
  "/register_prof",
  upload.single("profileImage"),
  async (req, res) => {
    try {
      const {
        person_id,
        employee_id,
        fname,
        mname,
        lname,
        email,
        password,
        dprtmnt_id,
        role,
      } = req.body;

      if (!employee_id || !fname || !lname || !email || !password || !dprtmnt_id) {
        return res.status(400).json({
          success: false,
          error: "Employee ID, first name, last name, email, password, and department are required.",
        });
      }

      const [existingUser] = await db3.query(
        "SELECT * FROM prof_table WHERE email = ? OR employee_id = ?",
        [email, employee_id],
      );

      if (existingUser.length > 0) {
        return res.json({
          success: false,
          error: "Email or Employee ID already exists. Please use different credentials.",
        });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      let profileImage = "";
      if (req.file) {
        const year = new Date().getFullYear();
        const ext = path.extname(req.file.originalname).toLowerCase();
        const filename = `${employee_id}_ProfessorProfile_${year}${ext}`;
        await ensureFacultyImageUploadDir();
        const filePath = path.join(facultyImageUploadDir, filename);
        await fs.promises.writeFile(filePath, req.file.buffer);
        profileImage = filename;
      }

      const sql = `INSERT INTO prof_table (person_id, employee_id, fname, mname, lname, email, password, role, profile_image, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      const values = [
        person_id || null,
        employee_id,
        fname,
        mname,
        lname,
        email,
        hashedPassword,
        role,
        profileImage,
        1,  // ✅ status = Active by default
      ];

      const [result] = await db3.query(sql, values);
      const prof_id = result.insertId;

      // ✅ New account: force password change + require OTP setup on first login
      await db3.query(
        `UPDATE prof_table SET force_password_change = 1, totp_enabled = 1 WHERE prof_id = ?`,
        [prof_id]
      );

      const sql2 = `INSERT INTO dprtmnt_profs_table (dprtmnt_id, prof_id) VALUES (?, ?)`;
      await db3.query(sql2, [dprtmnt_id, prof_id]);

      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      await insertFacultyAuditLog({
        req,
        action: "PROFESSOR_ACCOUNT_CREATE",
        message: `${roleLabel} (${actorId}) created professor account ${employee_id} - ${lname}, ${fname}.`,
      });

      res.status(201).json({ success: true, message: "Professor added successfully", prof_id });
    } catch (err) {
      console.error("Insert error:", err);
      res.json({ success: false, error: "Failed to add professor" });
    }
  },
);

// Update professor info
router.put(
  "/update_prof/:id",
  upload.single("profileImage"),
  async (req, res) => {
    const id = req.params.id;
    const {
      employee_id,
      fname,
      mname,
      lname,
      email,
      password,
      dprtmnt_id,
      role,
    } = req.body;

    try {
      if (!employee_id || !fname || !lname || !email || !dprtmnt_id) {
        return res.status(400).json({
          success: false,
          error: "Employee ID, first name, last name, email, and department are required.",
        });
      }

      const checkSQL = `SELECT * FROM prof_table WHERE (email = ? OR employee_id = ?) AND prof_id != ?`;
      const [existingRows] = await db3.query(checkSQL, [email, employee_id, id]);

      if (existingRows.length > 0) {
        return res.json({
          success: false,
          error: "Email or Employee ID already exists for another professor.",
        });
      }

      let profileImage = null;

      if (req.file) {
        const year = new Date().getFullYear();
        const ext = path.extname(req.file.originalname).toLowerCase();
        const filename = `${employee_id}_ProfessorProfile_${year}${ext}`;
        await ensureFacultyImageUploadDir();
        const filePath = path.join(facultyImageUploadDir, filename);
        await fs.promises.writeFile(filePath, req.file.buffer);
        profileImage = filename;
      }

      let updateSQL;
      let values;

      if (password && profileImage) {
        const hashedPassword = await bcrypt.hash(password, 10);
        updateSQL = `
          UPDATE prof_table
          SET employee_id = ?, fname = ?, mname = ?, lname = ?, email = ?, password = ?, role = ?, profile_image = ?
          WHERE prof_id = ?
        `;
        values = [employee_id, fname, mname, lname, email, hashedPassword, role, profileImage, id];
      } else if (password) {
        const hashedPassword = await bcrypt.hash(password, 10);
        updateSQL = `
          UPDATE prof_table
          SET employee_id = ?, fname = ?, mname = ?, lname = ?, email = ?, password = ?, role = ?
          WHERE prof_id = ?
        `;
        values = [employee_id, fname, mname, lname, email, hashedPassword, role, id];
      } else if (profileImage) {
        updateSQL = `
          UPDATE prof_table
          SET employee_id = ?, fname = ?, mname = ?, lname = ?, email = ?, role = ?, profile_image = ?
          WHERE prof_id = ?
        `;
        values = [employee_id, fname, mname, lname, email, role, profileImage, id];
      } else {
        updateSQL = `
          UPDATE prof_table
          SET employee_id = ?, fname = ?, mname = ?, lname = ?, email = ?, role = ?
          WHERE prof_id = ?
        `;
        values = [employee_id, fname, mname, lname, email, role, id];
      }

      await db3.query(updateSQL, values);

      // ✅ If admin set a new password, force password change + require OTP setup
      if (password) {
        await db3.query(
          `UPDATE prof_table SET force_password_change = 1, totp_enabled = 1 WHERE prof_id = ?`,
          [id]
        );
      }

      if (dprtmnt_id) {
        const [existing] = await db3.query(
          `SELECT * FROM dprtmnt_profs_table WHERE prof_id = ?`,
          [id],
        );

        if (existing.length > 0) {
          await db3.query(
            `UPDATE dprtmnt_profs_table SET dprtmnt_id = ? WHERE prof_id = ?`,
            [dprtmnt_id, id],
          );
        } else {
          await db3.query(
            `INSERT INTO dprtmnt_profs_table (dprtmnt_id, prof_id) VALUES (?, ?)`,
            [dprtmnt_id, id],
          );
        }
      }

      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      await insertFacultyAuditLog({
        req,
        action: "PROFESSOR_ACCOUNT_UPDATE",
        message: `${roleLabel} (${actorId}) updated professor account ${employee_id} - ${lname}, ${fname}.`,
      });

      res.json({ success: true, message: "Professor updated successfully." });
    } catch (err) {
      res.json({ success: false, error: "Internal server error." });
    }
  },
);

// Toggle professor status (Active/Inactive)
router.put("/update_prof_status/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const [profRows] = await db3.query(
      "SELECT prof_id, employee_id, fname, mname, lname, email FROM prof_table WHERE prof_id = ? LIMIT 1",
      [id],
    );

    const [result] = await db3.query(
      "UPDATE prof_table SET status = ? WHERE prof_id = ?",
      [status, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Professor not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertFacultyAuditLog({
      req,
      action: "PROFESSOR_ACCOUNT_STATUS_UPDATE",
      message: `${roleLabel} (${actorId}) set professor account ${getProfessorLabel(profRows[0])} to ${Number(status) === 1 ? "Active" : "Inactive"}.`,
    });

    res.json({ message: "Status updated successfully" });
  } catch (err) {
    console.error("Status update error:", err);
    res
      .status(500)
      .json({ error: "Failed to update status", details: err.message });
  }
});

router.delete("/delete_prof/:id", CanDelete, async (req, res) => {
  const { id } = req.params;
  let conn;

  try {
    conn = await db3.getConnection();
    await conn.beginTransaction();

    const [profRows] = await conn.query(
      "SELECT prof_id, employee_id, fname, mname, lname, email, profile_image FROM prof_table WHERE prof_id = ? LIMIT 1",
      [id],
    );

    if (profRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, error: "Professor not found" });
    }

    const [scheduleRows] = await conn.query(
      "SELECT id FROM time_table WHERE professor_id = ? LIMIT 1",
      [id],
    );

    if (scheduleRows.length > 0) {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        error: "Professor cannot be deleted because they are assigned to a schedule.",
      });
    }

    await conn.query("DELETE FROM dprtmnt_profs_table WHERE prof_id = ?", [id]);
    await conn.query("DELETE FROM prof_table WHERE prof_id = ?", [id]);

    await conn.commit();

    const profileImage = profRows[0].profile_image;
    if (profileImage) {
      const uploadDirs = [
        facultyImageUploadDir,
      ];

      for (const uploadDir of uploadDirs) {
        const imagePath = path.join(uploadDir, profileImage);
        try {
          if (fs.existsSync(imagePath)) {
            await fs.promises.unlink(imagePath);
          }
        } catch (fileErr) {
          console.error("Failed to delete professor image:", fileErr.message);
        }
      }
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertFacultyAuditLog({
      req,
      action: "PROFESSOR_ACCOUNT_DELETE",
      severity: "WARN",
      message: `${roleLabel} (${actorId}) deleted professor account ${getProfessorLabel(profRows[0])}.`,
    });

    res.json({ success: true, message: "Professor deleted successfully" });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("Professor delete error:", err);
    res.status(500).json({
      success: false,
      error: "Failed to delete professor",
      details: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});


router.post("/import_professors", CanCreate, async (req, res) => {
  const { professors } = req.body;

  let conn;

  try {
    if (!Array.isArray(professors) || professors.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No professors to import",
      });
    }

    conn = await db3.getConnection();
    await conn.beginTransaction();

    const [existingRows] = await conn.query(
      `SELECT email, employee_id FROM prof_table`
    );

    const existingEmails = new Set(
      existingRows
        .map((e) => normalizeImportText(e.email).toLowerCase())
        .filter(Boolean)
    );
    const existingEmpIds = new Set(
      existingRows
        .map((e) => normalizeImportText(e.employee_id).toLowerCase())
        .filter(Boolean)
    );

    const [departmentRows] = await conn.query(
      `SELECT dprtmnt_id, dprtmnt_code, dprtmnt_name FROM dprtmnt_table`
    );
    const departmentByKey = new Map();
    departmentRows.forEach((department) => {
      [
        department.dprtmnt_id,
        department.dprtmnt_code,
        department.dprtmnt_name,
      ].forEach((value) => {
        const key = normalizeImportText(value).toLowerCase();
        if (key) departmentByKey.set(key, department.dprtmnt_id);
      });
    });

    const values = [];
    const imported = [];
    const skipped = [];

    for (const prof of professors) {
      const employee_id = normalizeImportText(prof.employeeNumber || prof.employee_id);
      const fname = normalizeImportText(prof.firstName || prof.fname);
      const mname = normalizeImportText(prof.middleName || prof.mname);
      const lname = normalizeImportText(prof.lastName || prof.lname);
      const email = normalizeImportText(prof.email);
      const departmentKey = normalizeImportText(
        prof.departmentId || prof.dprtmnt_id || prof.departmentCode || prof.departmentName
      ).toLowerCase();
      const dprtmnt_id = departmentKey ? departmentByKey.get(departmentKey) : null;
      const employeeKey = employee_id.toLowerCase();
      const emailKey = email.toLowerCase();

      if (!employee_id || !fname || !lname || !email) {
        skipped.push({ employee_id, email, reason: "Missing fields" });
        continue;
      }

      if (existingEmails.has(emailKey) || existingEmpIds.has(employeeKey)) {
        skipped.push({ employee_id, email, reason: "Duplicate" });
        continue;
      }

      if (departmentKey && !dprtmnt_id) {
        skipped.push({
          employee_id,
          email,
          reason: `Department not found: ${departmentKey}`,
        });
        continue;
      }

      const temporaryPassword = generateTemporaryPassword();
      const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

      values.push([
        employee_id,
        fname,
        mname,
        lname,
        email,
        hashedPassword,
        1,         // status
        "faculty", // role
        1,         // totp_enabled — required starting from first login
        1          // force_password_change
      ]);

      imported.push({ employee_id, email, password: temporaryPassword, dprtmnt_id });
    }

    if (values.length > 0) {
      // REPLACE WITH:
      await conn.query(
        `INSERT INTO prof_table 
  (employee_id, fname, mname, lname, email, password, status, role, totp_enabled, force_password_change)
  VALUES ?`,
        [values]
      );

      const importedEmployeeIds = imported.map((prof) => prof.employee_id);
      const [insertedProfessors] = await conn.query(
        `SELECT prof_id, employee_id FROM prof_table WHERE employee_id IN (?)`,
        [importedEmployeeIds]
      );
      const professorIdByEmployeeId = new Map(
        insertedProfessors.map((prof) => [prof.employee_id, prof.prof_id])
      );
      const departmentValues = imported
        .filter((prof) => prof.dprtmnt_id)
        .map((prof) => [
          prof.dprtmnt_id,
          professorIdByEmployeeId.get(prof.employee_id),
        ])
        .filter(([, profId]) => profId);

      if (departmentValues.length > 0) {
        await conn.query(
          `INSERT INTO dprtmnt_profs_table (dprtmnt_id, prof_id) VALUES ?`,
          [departmentValues]
        );
      }
    }

    await conn.commit();

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertFacultyAuditLog({
      req,
      action: "PROFESSOR_ACCOUNT_IMPORT",
      message: `${roleLabel} (${actorId}) imported ${imported.length} professor account(s). Skipped row(s): ${skipped.length}.`,
    });

    res.json({
      success: true,
      importedCount: imported.length,
      skippedCount: skipped.length,
      imported,
      skipped,
    });

  } catch (error) {
    if (conn) await conn.rollback();
    console.error("IMPORT ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Import failed",
      error: error.message,
    });
  } finally {
    if (conn) conn.release();
  }
});


// ─── Faculty: Password Reset Reminder ───────────────────────────────────────
router.post("/send_faculty_password_reminder", async (req, res) => {
  const { employee_id, email, password } = req.body;

  let conn;

  try {
    if (!employee_id || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    conn = await db3.getConnection();

    const [prof] = await conn.query(
      `SELECT fname, mname, lname, employee_id
       FROM prof_table
       WHERE employee_id = ?`,
      [employee_id]
    );

    if (prof.length === 0) {
      return res.json({ success: false, message: "Professor not found" });
    }

    const [companyRows] = await db.query(`
      SELECT company_name, short_term FROM company_settings LIMIT 1
    `);

    const company_name = companyRows[0]?.company_name || "Company";
    const short_term = companyRows[0]?.short_term || "System";
    const frontendUrl = process.env.FRONTEND_URL;

    const { fname, mname, lname, employee_id: empId } = prof[0];
    const fullName = `${lname}, ${fname} ${mname || ""}`.trim();

    await transporter.sendMail({
      from: `"${short_term} — Password Security" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `${short_term} — Action Required: Change Your Password`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; color: #222;">
          <h2 style="margin-bottom: 4px;">${company_name} Faculty Portal</h2>
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
                ${email} / ${empId}
              </td>
            </tr>
            <tr>
              <td style="padding: 6px 16px; color: #777; font-size: 13px;">Temporary password</td>
              <td style="padding: 6px 16px; font-family: monospace; font-size: 13px;">${password}</td>
            </tr>
            <tr>
              <td style="padding: 6px 16px; color: #777; font-size: 13px;">Account type</td>
              <td style="padding: 6px 16px; font-size: 13px;">Faculty</td>
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
      `
    });

    res.json({ success: true, message: "Faculty password reset reminder sent" });

  } catch (error) {
    console.error("EMAIL ERROR:", error);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    if (conn) conn.release();
  }
});

const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const parts = String(timeStr).trim().split(" ");
  let [hours, minutes] = parts[0].split(":").map(Number);
  const modifier = parts[1] ? parts[1].toUpperCase() : null;
  if (modifier) {
    if (modifier === "PM" && hours !== 12) hours += 12;
    if (modifier === "AM" && hours === 12) hours = 0;
  }
  return hours * 60 + (minutes || 0);
};

const minutesToHours = (mins) => Math.round((mins / 60) * 10) / 10;

const DAY_LABELS = {
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  THUR: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
  SUN: "Sunday",
};

const normalizeDayLabel = (day) => {
  const key = String(day || "").trim().toUpperCase();
  return DAY_LABELS[key] || day || "Unknown";
};

const formatScheduleRange = (day, start, end) => {
  const shortDay = String(day || "").trim().slice(0, 3);
  const capDay = shortDay.charAt(0) + shortDay.slice(1).toLowerCase();
  return `${capDay} ${start}-${end}`;
};

const getEvaluationStatus = (avg) => {
  if (avg >= 4.5) return "Excellent";
  if (avg >= 3.5) return "Good";
  if (avg >= 2.5) return "Needs Improvement";
  if (avg > 0) return "Critical";
  return "No responses";
};

const sumScheduleHours = (rows) =>
  rows.reduce((sum, row) => {
    const start = timeToMinutes(row.school_time_start);
    const end = timeToMinutes(row.school_time_end);
    return sum + Math.max(0, end - start);
  }, 0);

const isBreakWorkload = (row) => {
  const workloadLabel = `${row.workload_description || ""} ${row.workload_code || ""}`
    .toUpperCase();
  return workloadLabel.includes("BREAK") || /\bBRKS?\b/.test(workloadLabel);
};

const isDesignationWorkload = (row) => {
  if (
    Number(row.ishonorarium) === 1 ||
    Number(row.is_servicecredit) === 1 ||
    Number(row.is_temporary_substitution) === 1
  ) {
    return false;
  }

  const description = String(row.workload_description || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  const code = String(row.workload_code || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  const separateCategoryTokens = [
    "RESEARCH", "RES", "EXTENSION", "EXT", "PRODUCTION", "PROD",
    "ACCREDITATION", "ACC", "CONSULTATION", "CONS", "LESSONPREPARATION", "LPOC",
  ];

  return !(
    separateCategoryTokens.some((token) => description === token || description.startsWith(token)) ||
    separateCategoryTokens.includes(code)
  );
};

const buildDailyHours = (rows) => {
  const buckets = {};
  rows.forEach((row) => {
    const label = normalizeDayLabel(row.day);
    const start = timeToMinutes(row.school_time_start);
    const end = timeToMinutes(row.school_time_end);
    buckets[label] = (buckets[label] || 0) + Math.max(0, end - start);
  });

  const order = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];

  return order.map((day) => ({
    day,
    hours: minutesToHours(buckets[day] || 0),
  }));
};

router.get("/faculty_dashboard_summary/:prof_id", async (req, res) => {
  const { prof_id } = req.params;
  const schoolYearId = req.query.school_year_id || null;

  try {
    const [[profRow]] = await db3.query(
      `
      SELECT
        pt.prof_id,
        pt.employee_id,
        pt.fname,
        pt.mname,
        pt.lname,
        dt.dprtmnt_name,
        dt.dprtmnt_code
      FROM prof_table AS pt
      LEFT JOIN dprtmnt_profs_table AS dpt ON dpt.prof_id = pt.prof_id
      LEFT JOIN dprtmnt_table AS dt ON dt.dprtmnt_id = dpt.dprtmnt_id
      WHERE pt.prof_id = ?
      LIMIT 1
      `,
      [prof_id],
    );

    if (!profRow) {
      return res.status(404).json({ success: false, message: "Professor not found" });
    }

    const [[activeYear]] = schoolYearId
      ? await db3.query(
        `
        SELECT
          sy.id AS school_year_id,
          sy.year_id,
          sy.semester_id,
          yt.year_description,
          smt.semester_description
        FROM active_school_year_table AS sy
        LEFT JOIN year_table AS yt ON sy.year_id = yt.year_id
        LEFT JOIN semester_table AS smt ON sy.semester_id = smt.semester_id
        WHERE sy.id = ?
        LIMIT 1
        `,
        [schoolYearId],
      )
      : await db3.query(
        `
        SELECT
          sy.id AS school_year_id,
          sy.year_id,
          sy.semester_id,
          yt.year_description,
          smt.semester_description
        FROM active_school_year_table AS sy
        LEFT JOIN year_table AS yt ON sy.year_id = yt.year_id
        LEFT JOIN semester_table AS smt ON sy.semester_id = smt.semester_id
        WHERE sy.astatus = 1
        LIMIT 1
        `,
      );

    if (!activeYear) {
      return res.json({
        success: true,
        prof_id: Number(prof_id),
        employee_id: profRow.employee_id,
        faculty_name: {
          fname: profRow.fname,
          mname: profRow.mname,
          lname: profRow.lname,
        },
        department: profRow.dprtmnt_name || profRow.dprtmnt_code || "N/A",
        school_year: null,
        designation: { total_hours: 0 },
        teaching_load: {
          total_units: 0,
          lecture_units: 0,
          lab_units: 0,
          total_classes: 0,
        },
        my_students: {
          total_students: 0,
          active_students: 0,
          irregular_students: 0,
          dropped_students: 0,
        },
        grades_encoded: {
          completed_percent: 0,
          encoded: 0,
          total: 0,
          pending: 0,
          not_started: 0,
        },
        faculty_evaluation: {
          overall_rating: 0,
          rating_scale: 5,
          total_evaluations: 0,
          response_rate_percent: 0,
          status: "No responses",
        },
        working_hours: { total_hours: 0, daily: [] },
        my_classes: [],
      });
    }

    const syId = activeYear.school_year_id;

    const [
      [teachingClasses],
      [studentSummary],
      [gradesSummary],
      [evaluationSummary],
      [classRows],
      [workloadHourRows],
    ] = await Promise.all([
      db3.query(
        `
        SELECT DISTINCT
          tt.course_id,
          tt.department_section_id,
          ct.course_unit,
          ct.lab_unit
        FROM time_table AS tt
        INNER JOIN course_table AS ct ON tt.course_id = ct.course_id
        WHERE tt.professor_id = ?
          AND tt.school_year_id = ?
          AND ct.office_duty = 0
        `,
        [prof_id, syId],
      ),
      db3.query(
        `
        SELECT
          COUNT(DISTINCT es.student_number) AS total_students,
          COUNT(DISTINCT CASE WHEN es.en_remarks = 0 THEN es.student_number END) AS active_students,
          COUNT(DISTINCT CASE WHEN es.is_regular = 0 THEN es.student_number END) AS irregular_students,
          COUNT(DISTINCT CASE WHEN es.en_remarks = 4 THEN es.student_number END) AS dropped_students
        FROM enrolled_subject AS es
        INNER JOIN time_table AS tt
          ON es.course_id = tt.course_id
         AND es.department_section_id = tt.department_section_id
         AND es.active_school_year_id = tt.school_year_id
        WHERE tt.professor_id = ?
          AND es.active_school_year_id = ?
        `,
        [prof_id, syId],
      ),
      db3.query(
        `
        SELECT
          COUNT(*) AS total,
          SUM(
            CASE
              WHEN es.final_grade IS NOT NULL
               AND es.final_grade <> 0
               AND es.final_grade <> '' THEN 1
              ELSE 0
            END
          ) AS encoded,
          SUM(
            CASE
              WHEN (es.final_grade IS NULL OR es.final_grade = 0 OR es.final_grade = '')
               AND (es.midterm IS NOT NULL OR es.finals IS NOT NULL) THEN 1
              ELSE 0
            END
          ) AS pending,
          SUM(
            CASE
              WHEN (es.final_grade IS NULL OR es.final_grade = 0 OR es.final_grade = '')
               AND es.midterm IS NULL
               AND es.finals IS NULL THEN 1
              ELSE 0
            END
          ) AS not_started
        FROM enrolled_subject AS es
        INNER JOIN time_table AS tt
          ON es.course_id = tt.course_id
         AND es.department_section_id = tt.department_section_id
         AND es.active_school_year_id = tt.school_year_id
        WHERE tt.professor_id = ?
          AND es.active_school_year_id = ?
        `,
        [prof_id, syId],
      ),
      db3.query(
        `
        SELECT
          AVG(se.question_answer) AS overall_rating,
          COUNT(DISTINCT se.student_number) AS total_evaluations
        FROM student_evaluation_table AS se
        WHERE se.prof_id = ?
          AND se.school_year_id = ?
        `,
        [prof_id, syId],
      ),
      db3.query(
        `
        SELECT
          ct.course_id,
          ct.course_code AS code,
          ct.course_description AS subject,
          CONCAT(pgt.program_code, ' ', st.description) AS section,
          rdt.description AS day,
          tt.school_time_start AS time_start,
          tt.school_time_end AS time_end,
          COALESCE(rt.room_description, 'TBA') AS room,
          tt.department_section_id,
          (
            SELECT COUNT(DISTINCT es.student_number)
            FROM enrolled_subject AS es
            WHERE es.course_id = tt.course_id
              AND es.department_section_id = tt.department_section_id
              AND es.active_school_year_id = tt.school_year_id
          ) AS enrolled
        FROM time_table AS tt
        INNER JOIN course_table AS ct ON tt.course_id = ct.course_id
        LEFT JOIN dprtmnt_section_table AS dst ON tt.department_section_id = dst.id
        LEFT JOIN section_table AS st ON dst.section_id = st.id
        LEFT JOIN curriculum_table AS cct ON dst.curriculum_id = cct.curriculum_id
        LEFT JOIN program_table AS pgt ON cct.program_id = pgt.program_id
        LEFT JOIN room_day_table AS rdt ON tt.room_day = rdt.id
        LEFT JOIN room_table AS rt ON tt.department_room_id = rt.room_id
        WHERE tt.professor_id = ?
          AND tt.school_year_id = ?
          AND ct.office_duty = 0
        ORDER BY
          FIELD(rdt.description, 'MON', 'TUE', 'WED', 'THU', 'THUR', 'FRI', 'SAT', 'SUN'),
          tt.school_time_start
        `,
        [prof_id, syId],
      ),
      db3.query(
        `
        SELECT
          rdt.description AS day,
          tt.school_time_start,
          tt.school_time_end,
          tt.department_section_id,
          tt.ishonorarium,
          tt.is_servicecredit,
          tt.is_temporary_substitution,
          COALESCE(ct.course_description, wt.workload_description) AS workload_description,
          COALESCE(ct.course_code, wt.workload_code) AS workload_code
        FROM time_table AS tt
        LEFT JOIN course_table AS ct
          ON tt.course_id = ct.course_id
          AND tt.department_section_id IS NOT NULL
          AND tt.department_section_id <> 0
        LEFT JOIN workload_type AS wt
          ON tt.course_id = wt.id
          AND (tt.department_section_id IS NULL OR tt.department_section_id = 0)
        LEFT JOIN room_day_table AS rdt ON tt.room_day = rdt.id
        WHERE tt.professor_id = ?
          AND tt.school_year_id = ?
        `,
        [prof_id, syId],
      ),
    ]);

    const lectureUnits = teachingClasses.reduce(
      (sum, row) => sum + (Number(row.course_unit) || 0),
      0,
    );
    const labUnits = teachingClasses.reduce(
      (sum, row) => sum + (Number(row.lab_unit) || 0),
      0,
    );

    const grades = gradesSummary[0] || {};
    const totalGrades = Number(grades.total) || 0;
    const encodedGrades = Number(grades.encoded) || 0;
    const pendingGrades = Number(grades.pending) || 0;
    const notStartedGrades = Number(grades.not_started) || 0;

    const students = studentSummary[0] || {};
    const totalStudents = Number(students.total_students) || 0;
    const totalEvaluations = Number(evaluationSummary[0]?.total_evaluations) || 0;
    const overallRating = Number(evaluationSummary[0]?.overall_rating) || 0;
    const responseRate = totalStudents
      ? Math.round((totalEvaluations / totalStudents) * 100)
      : 0;

    const workloadHourSlots = workloadHourRows.filter((row) => !isBreakWorkload(row));
    const designationSlots = workloadHourSlots.filter(
      (row) =>
        (row.department_section_id == null || Number(row.department_section_id) === 0) &&
        isDesignationWorkload(row),
    );
    const totalWorkloadMinutes = sumScheduleHours(workloadHourSlots);
    const designationMinutes = sumScheduleHours(designationSlots);
    const dailyHours = buildDailyHours(workloadHourSlots);

    const classMap = new Map();
    classRows.forEach((row) => {
      const key = `${row.course_id}-${row.department_section_id}-${row.day}-${row.time_start}`;
      if (classMap.has(key)) return;
      classMap.set(key, {
        course_id: row.course_id,
        code: row.code,
        subject: row.subject,
        section: row.section,
        schedule: formatScheduleRange(row.day, row.time_start, row.time_end),
        day: row.day,
        time_start: row.time_start,
        time_end: row.time_end,
        room: row.room,
        enrolled: Number(row.enrolled) || 0,
        department_section_id: row.department_section_id,
      });
    });

    res.json({
      success: true,
      prof_id: Number(prof_id),
      employee_id: profRow.employee_id,
      faculty_name: {
        fname: profRow.fname,
        mname: profRow.mname,
        lname: profRow.lname,
      },
      department: profRow.dprtmnt_name || profRow.dprtmnt_code || "N/A",
      school_year: {
        school_year_id: activeYear.school_year_id,
        year_id: activeYear.year_id,
        semester_id: activeYear.semester_id,
        year_description: activeYear.year_description,
        semester_description: activeYear.semester_description,
      },
      designation: {
        total_hours: minutesToHours(designationMinutes),
      },
      teaching_load: {
        total_units: lectureUnits + labUnits,
        lecture_units: lectureUnits,
        lab_units: labUnits,
        total_classes: teachingClasses.length,
      },
      my_students: {
        total_students: totalStudents,
        active_students: Number(students.active_students) || 0,
        irregular_students: Number(students.irregular_students) || 0,
        dropped_students: Number(students.dropped_students) || 0,
      },
      grades_encoded: {
        completed_percent: totalGrades
          ? Math.round((encodedGrades / totalGrades) * 100)
          : 0,
        encoded: encodedGrades,
        total: totalGrades,
        pending: pendingGrades,
        not_started: notStartedGrades,
      },
      faculty_evaluation: {
        overall_rating: Math.round(overallRating * 100) / 100,
        rating_scale: 5,
        total_evaluations: totalEvaluations,
        response_rate_percent: responseRate,
        status: getEvaluationStatus(overallRating),
      },
      working_hours: {
        total_hours: minutesToHours(totalWorkloadMinutes),
        daily: dailyHours,
      },
      my_classes: Array.from(classMap.values()),
    });
  } catch (err) {
    console.error("Faculty dashboard summary error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load faculty dashboard summary",
      error: err.message,
    });
  }
});

module.exports = router;
