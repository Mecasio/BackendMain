const express = require('express');
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");        // ⬅ ADD
require("dotenv").config();                       // ⬅ ADD (safe even if already loaded elsewhere)

const {
  db,
  db3,
  ensurePageAccessPermissionColumns,
} = require('../database/database');
const { CanDelete } = require("../../middleware/pagePermissions");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const {
  ensureRegistrarScopeTable,
  parseScopesFromBody,
  syncScopes,
  buildEmployeeScopePayload,
} = require("../../utils/registrarScopeService");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ⬅ ADD — same transporter config as the faculty route
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

router.use(async (req, res, next) => {
  try {
    await ensurePageAccessPermissionColumns();
    await ensureRegistrarScopeTable();
    next();
  } catch (err) {
    console.error("Failed to prepare page_access permission columns:", err);
    res.status(500).json({ error: "Failed to prepare page access permissions" });
  }
});

const saveRegistrarProfilePicture = async ({ personId, file }) => {
  const [existing] = await db3.query(
    "SELECT * FROM user_accounts WHERE person_id = ? AND role IN ('administrator', 'superadmin', 'technical') LIMIT 1",
    [personId]
  );

  if (!existing.length) {
    const error = new Error("Registrar not found");
    error.status = 404;
    throw error;
  }

  const current = existing[0];
  let finalFilename = current.profile_picture;

  if (file) {
    const ext = path.extname(file.originalname).toLowerCase();
    const year = new Date().getFullYear();
    finalFilename = `${current.employee_id}_1by1_${year}${ext}`;

    const uploadDir = path.join(__dirname, "../../uploads/Admin1by1");
    const finalPath = path.join(uploadDir, finalFilename);

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const files = await fs.promises.readdir(uploadDir);
    for (const f of files) {
      if (f.startsWith(`${current.employee_id}_1by1_`)) {
        await fs.promises.unlink(path.join(uploadDir, f));
      }
    }

    await fs.promises.writeFile(finalPath, file.buffer);
  }

  await db3.query(
    "UPDATE user_accounts SET profile_picture = ? WHERE person_id = ? AND role IN ('administrator', 'superadmin', 'technical')",
    [finalFilename, personId]
  );

  return {
    filename: finalFilename,
    registrar: current,
  };
};

router.post("/update_registrar_profile", upload.single("profile_picture"), async (req, res) => {
  const { person_id } = req.body;

  if (!person_id || !req.file) {
    return res.status(400).json({ message: "Missing person_id or file." });
  }

  try {
    const { filename } = await saveRegistrarProfilePicture({
      personId: person_id,
      file: req.file,
    });

    res.status(200).json({
      success: true,
      message: "Registrar profile picture updated successfully",
      filename,
      profile_image: filename,
    });
  } catch (error) {
    console.error("Registrar profile upload error:", error);
    res
      .status(error.status || 500)
      .json({ message: error.message || "Failed to upload image." });
  }
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

const getRegistrarLabel = (registrar) => {
  if (!registrar) return "Unknown Registrar";
  const name = [registrar.last_name, registrar.first_name, registrar.middle_name]
    .filter(Boolean)
    .join(", ");
  return registrar.employee_id || name || registrar.email || `id ${registrar.id || "unknown"}`;
};

const insertRegistrarAuditLog = async ({ req, action, message, severity = "INFO" }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity,
    message,
  });
};

const parseAccessPages = (rawAccessPage) => {
  if (!rawAccessPage) return [];
  if (Array.isArray(rawAccessPage)) return rawAccessPage;

  try {
    const parsed = JSON.parse(rawAccessPage);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
};

const parseAccessPermissions = (rawAccessPage) =>
  parseAccessPages(rawAccessPage)
    .map((entry) => {
      if (typeof entry === "number" || typeof entry === "string") {
        const pageId = Number(entry);
        return Number.isNaN(pageId)
          ? null
          : {
            page_id: pageId,
            page_privilege: 1,
            can_create: 0,
            can_edit: 0,
            can_delete: 0,
          };
      }

      if (!entry || typeof entry !== "object") return null;

      const pageId = Number(entry.page_id ?? entry.pageId ?? entry.id);
      if (Number.isNaN(pageId)) return null;

      return {
        page_id: pageId,
        page_privilege: Number(entry.page_privilege ?? entry.access ?? 1) === 1 ? 1 : 0,
        can_create: Number(entry.can_create) === 1 ? 1 : 0,
        can_edit: Number(entry.can_edit) === 1 ? 1 : 0,
        can_delete: Number(entry.can_delete) === 1 ? 1 : 0,
      };
    })
    .filter((permission) => permission && permission.page_privilege === 1);

router.get("/get_employee", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT id, employee_id, first_name, last_name, middle_name, email, role AS position, dprtmnt_id FROM user_accounts WHERE role != 'student';  
    `)

    if (rows.length === 0) {
      res.status(400).json({ message: "Theres no employee found in the record" });
    }

    res.json(rows);
    console.log("Data: ", rows);
  } catch (err) {
    res.status(500).json({ message: "Internal Server Error", err });
  }
})

// POST CREATION ONLY
router.post("/register_registrar", upload.single("profile_picture"), async (req, res) => {
  try {
    const {
      employee_id,
      last_name,
      middle_name,
      first_name,
      email,
      password,
      status,
      dprtmnt_id,
      access_level,
      curriculum_id,
      role,
    } = req.body;

    const normalizedRole = String(role || "").trim().toLowerCase();
    if (!["superadmin", "administrator", "technical"].includes(normalizedRole)) {
      return res.status(400).json({ message: "Invalid role selected" });
    }

    const file = req.file;

    if (!employee_id || !last_name || !first_name || !email || !password || !access_level) {
      return res.status(400).json({ message: "All required fields must be filled" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const [existing] = await db3.query(
      "SELECT id FROM user_accounts WHERE LOWER(email) = ?",
      [normalizedEmail]
    );
    if (existing.length > 0) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    let profilePicName = null;

    if (file) {
      const ext = path.extname(file.originalname).toLowerCase();
      const year = new Date().getFullYear();
      profilePicName = `${employee_id}_1by1_${year}${ext}`;

      const uploadDir = path.join(__dirname, "../../uploads/Admin1by1");
      const finalPath = path.join(uploadDir, profilePicName);

      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const files = await fs.promises.readdir(uploadDir);
      for (const f of files) {
        if (f.startsWith(`${employee_id}_1by1_`)) {
          await fs.promises.unlink(path.join(uploadDir, f));
        }
      }

      await fs.promises.writeFile(finalPath, file.buffer);
    }

    const scopes = await parseScopesFromBody(req.body);
    const scopedDepartmentIds = [
      ...new Set(scopes.map((scope) => scope.dprtmnt_id).filter(Boolean)),
    ];
    const deptValue =
      scopedDepartmentIds.length === 1
        ? scopedDepartmentIds[0]
        : dprtmnt_id === "" || dprtmnt_id === undefined
          ? null
          : Number(dprtmnt_id) || null;

    const [registrar] = await db3.query(
      `SELECT MAX(person_id) AS latest_person_id FROM user_accounts;`
    );

    const personIdForRegistrar = registrar[0].latest_person_id;

    await db3.query(
      `INSERT INTO user_accounts 
       (person_id, employee_id, last_name, middle_name, first_name, role, email, password, status, dprtmnt_id, profile_picture, access_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        personIdForRegistrar + 1,
        employee_id,
        last_name,
        middle_name,
        first_name,
        normalizedRole,
        normalizedEmail,
        hashedPassword,
        status || 1,
        deptValue,
        profilePicName,
        Number(access_level),
      ]
    );


    // REPLACE WITH:
    await db3.query(
      `UPDATE user_accounts SET force_password_change = 1, totp_enabled = 0 WHERE employee_id = ? AND role IN ('administrator', 'superadmin', 'technical')`,
      [employee_id]
    );

    await syncScopes(employee_id, scopes);

    const [accessRows] = await db3.query(
      "SELECT access_page FROM access_table WHERE access_id = ?",
      [access_level]
    );

    if (!accessRows.length) {
      return res.status(400).json({ message: "Invalid access level selected" });
    }

    const pagePermissions = parseAccessPermissions(accessRows[0].access_page);
    if (pagePermissions.length) {
      const values = pagePermissions.map((permission) => [
        permission.page_privilege,
        permission.page_id,
        employee_id,
        permission.can_create,
        permission.can_edit,
        permission.can_delete,
      ]);

      await db3.query(
        "INSERT INTO page_access (page_privilege, page_id, user_id, can_create, can_edit, can_delete) VALUES ?",
        [values]
      );
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertRegistrarAuditLog({
      req,
      action: "REGISTRAR_ACCOUNT_CREATE",
      message: `${roleLabel} (${actorId}) created registrar account ${employee_id} - ${last_name}, ${first_name}.`,
    });

    res.status(201).json({ message: "Registrar account created successfully!" });

  } catch (error) {
    console.error("❌ Error creating registrar account:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// POST CREATION AND UPDATE OF PROFILE PICTURE
router.put("/update_registrar/:id", upload.single("profile_picture"), async (req, res) => {
  const { id } = req.params;
  const data = req.body;
  const file = req.file;

  try {
    const [existing] = await db3.query(
      "SELECT * FROM user_accounts WHERE id = ?",
      [id]
    );

    if (!existing.length) {
      return res.status(404).json({ message: "Registrar not found" });
    }

    const current = existing[0];
    const normalizedRole = String(data.role || current.role || "")
      .trim()
      .toLowerCase();
    if (!["superadmin", "administrator", "technical"].includes(normalizedRole)) {
      return res.status(400).json({ message: "Invalid role selected" });
    }
    let finalFilename = current.profile_picture;

    if (file) {
      const ext = path.extname(file.originalname).toLowerCase();
      const year = new Date().getFullYear();
      finalFilename = `${current.employee_id}_1by1_${year}${ext}`;

      const uploadDir = path.join(__dirname, "../../uploads/Admin1by1");
      const finalPath = path.join(uploadDir, finalFilename);

      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const files = await fs.promises.readdir(uploadDir);
      for (const f of files) {
        if (f.startsWith(`${current.employee_id}_1by1_`)) {
          await fs.promises.unlink(path.join(uploadDir, f));
        }
      }

      await fs.promises.writeFile(finalPath, file.buffer);
    }

    const scopes = await parseScopesFromBody(data);
    const passwordValue =
      typeof data.password === "string" ? data.password.trim() : "";
    const hashedPassword = passwordValue
      ? await bcrypt.hash(passwordValue, 10)
      : null;
    const nextEmployeeId = data.employee_id || current.employee_id;
    const nextAccessLevel = data.access_level
      ? Number(data.access_level)
      : current.access_level;
    const accessLevelChanged =
      data.access_level &&
      Number(data.access_level) !== Number(current.access_level);
    const employeeIdChanged =
      String(nextEmployeeId) !== String(current.employee_id);

    await syncScopes(nextEmployeeId, scopes);
    const scopePayload = await buildEmployeeScopePayload(nextEmployeeId, {
      dprtmnt_id: current.dprtmnt_id,
    });

    await db3.query(
      `UPDATE user_accounts 
       SET employee_id=?, last_name=?, middle_name=?, first_name=?, role=?, email=?, password=COALESCE(?, password), status=?, dprtmnt_id=?, profile_picture=?, access_level=?
       WHERE id=?`,
      [
        nextEmployeeId,
        data.last_name || current.last_name,
        data.middle_name || current.middle_name,
        data.first_name || current.first_name,
        normalizedRole,
        data.email?.toLowerCase() || current.email,
        hashedPassword,
        data.status ?? current.status,
        scopePayload.dprtmnt_id ?? null,
        finalFilename,
        nextAccessLevel,
        id
      ]
    );

    if (accessLevelChanged) {
      const [accessRows] = await db3.query(
        "SELECT access_page FROM access_table WHERE access_id = ?",
        [nextAccessLevel]
      );

      if (accessRows.length) {
        const pagePermissions = parseAccessPermissions(accessRows[0].access_page);

        await db3.query("DELETE FROM page_access WHERE user_id IN (?, ?)", [
          current.employee_id,
          nextEmployeeId,
        ]);

        if (pagePermissions.length) {
          const values = pagePermissions.map((permission) => [
            permission.page_privilege,
            permission.page_id,
            nextEmployeeId,
            permission.can_create,
            permission.can_edit,
            permission.can_delete,
          ]);
          await db3.query(
            "INSERT INTO page_access (page_privilege, page_id, user_id, can_create, can_edit, can_delete) VALUES ?",
            [values]
          );
        }
      }
    } else if (employeeIdChanged) {
      await db3.query("UPDATE page_access SET user_id = ? WHERE user_id = ?", [
        nextEmployeeId,
        current.employee_id,
      ]);
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const registrarLabel = getRegistrarLabel({
      employee_id: data.employee_id || current.employee_id,
      last_name: data.last_name || current.last_name,
      first_name: data.first_name || current.first_name,
      middle_name: data.middle_name || current.middle_name,
      email: data.email || current.email,
      id,
    });
    await insertRegistrarAuditLog({
      req,
      action: "REGISTRAR_ACCOUNT_UPDATE",
      message: `${roleLabel} (${actorId}) updated registrar account ${registrarLabel}.`,
    });
    if (passwordValue) {
      await insertRegistrarAuditLog({
        req,
        action: "REGISTRAR_PASSWORD_CHANGE",
        severity: "WARN",
        message: `${roleLabel} (${actorId}) changed the password for registrar account ${registrarLabel}.`,
      });
    }
    if (accessLevelChanged) {
      await insertRegistrarAuditLog({
        req,
        action: "REGISTRAR_ACCESS_LEVEL_CHANGE",
        severity: "WARN",
        message: `${roleLabel} (${actorId}) changed access level for registrar account ${registrarLabel} from ${current.access_level || "none"} to ${nextAccessLevel || "none"}.`,
      });
    }

    res.json({ success: true, message: "Registrar updated successfully" });

  } catch (error) {
    console.error("❌ Error updating registrar:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/delete_registrar/:id", CanDelete, async (req, res) => {
  const { id } = req.params;
  const requestEmployeeId = req.headers["x-employee-id"];
  let conn;

  try {
    conn = await db3.getConnection();
    await conn.beginTransaction();

    // ✅ INNER JOIN access_table instead of hardcoded role IN (...)
    const [registrarRows] = await conn.query(
      `SELECT ua.id, ua.employee_id, ua.first_name, ua.middle_name, ua.last_name, ua.email, ua.profile_picture
       FROM user_accounts ua
       INNER JOIN access_table at ON ua.access_level = at.access_id
       WHERE ua.id = ?
       LIMIT 1`,
      [id],
    );

    if (registrarRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "Registrar not found" });
    }

    const registrar = registrarRows[0];
    if (String(registrar.employee_id) === String(requestEmployeeId)) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own account while logged in.",
      });
    }

    await conn.query("DELETE FROM page_access WHERE user_id = ?", [
      registrar.employee_id,
    ]);
    await conn.query("DELETE FROM user_accounts WHERE id = ?", [id]);

    await conn.commit();

    if (registrar.profile_picture) {
      const imagePath = path.join(
        __dirname,
        "../../uploads/Admin1by1",
        registrar.profile_picture,
      );

      try {
        if (fs.existsSync(imagePath)) {
          await fs.promises.unlink(imagePath);
        }
      } catch (fileErr) {
        console.error("Failed to delete registrar image:", fileErr.message);
      }
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertRegistrarAuditLog({
      req,
      action: "REGISTRAR_ACCOUNT_DELETE",
      severity: "WARN",
      message: `${roleLabel} (${actorId}) deleted registrar account ${getRegistrarLabel(registrar)}.`,
    });

    res.json({ success: true, message: "Registrar deleted successfully" });
  } catch (error) {
    if (conn) await conn.rollback();
    console.error("Error deleting registrar:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete registrar",
    });
  } finally {
    if (conn) conn.release();
  }
});

router.put("/registrar-status/:person_id", async (req, res) => {
  const { person_id } = req.params;
  const { registrar_status } = req.body;

  const allowed = [0, 1, 2];
  if (!allowed.includes(Number(registrar_status))) {
    return res
      .status(400)
      .json({ error: "registrar_status must be 0, 1, or 2" });
  }

  try {
    if (Number(registrar_status) === 1) {
      await db.query(
        `UPDATE admission.requirement_uploads
         SET registrar_status = 1,
             submitted_documents = 1,
             missing_documents = '[]'
         WHERE person_id = ?`,
        [person_id],
      );
    } else {
      await db.query(
        `UPDATE admission.requirement_uploads
         SET registrar_status = 0,
             submitted_documents = 0,
             missing_documents = NULL
         WHERE person_id = ?`,
        [person_id],
      );
    }

    res.json({
      message: "âœ… Registrar status updated for all docs",
      registrar_status,
    });
  } catch (err) {
    console.error("âŒ Error updating registrar status:", err);
    res.status(500).json({ error: "Failed to update registrar status" });
  }
});

router.post("/send_registrar_password_reminder", async (req, res) => {
  const { employee_id, email, password } = req.body;

  try {
    if (!employee_id || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const [registrarRows] = await db3.query(
      `SELECT first_name, middle_name, last_name, employee_id
       FROM user_accounts
       WHERE employee_id = ? AND role IN ('administrator', 'superadmin', 'technical')
       LIMIT 1`,
      [employee_id]
    );

    if (registrarRows.length === 0) {
      return res.json({ success: false, message: "Registrar not found" });
    }

    const [companyRows] = await db.query(`
      SELECT company_name, short_term FROM company_settings LIMIT 1
    `);

    const company_name = companyRows[0]?.company_name || "Company";
    const short_term = companyRows[0]?.short_term || "System";

    const { first_name, middle_name, last_name, employee_id: empId } = registrarRows[0];
    const fullName = `${last_name}, ${first_name} ${middle_name || ""}`.trim();

    await transporter.sendMail({
      from: `"${short_term} — Password Security" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `${short_term} — Action Required: Change Your Password`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; color: #222;">
          <h2 style="margin-bottom: 4px;">${company_name} Registrar Portal</h2>
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
              <td style="padding: 12px 16px; font-weight: bold; font-size: 14px;" colspan="2">
                Account details
              </td>
            </tr>
            <tr>
              <td style="padding: 6px 16px; color: #777; width: 40%; font-size: 13px;">Username</td>
              <td style="padding: 6px 16px; font-size: 13px;">${email} / ${empId}</td>
            </tr>
            <tr>
              <td style="padding: 6px 16px; color: #777; font-size: 13px;">Temporary password</td>
              <td style="padding: 6px 16px; font-family: monospace; font-size: 13px;">${password}</td>
            </tr>
            <tr>
              <td style="padding: 6px 16px; color: #777; font-size: 13px;">Account type</td>
              <td style="padding: 6px 16px; font-size: 13px;">Registrar</td>
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

    res.json({ success: true, message: "Registrar password reset reminder sent" });
  } catch (error) {
    console.error("EMAIL ERROR:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
