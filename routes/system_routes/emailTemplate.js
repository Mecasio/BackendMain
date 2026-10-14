const express = require('express');
const { db, db3 } = require('../database/database');
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");
const { insertAuditLogAdmission, resolveAuditActor } = require("../../utils/auditLogger");
const {
  isInScope,
  resolveProgramFromCurriculum,
  ensureRegistrarScopeTable,
} = require("../../utils/registrarScopeService");

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";
  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const insertEmailTemplateAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);
  await insertAuditLogAdmission({
    actorId,
    role: actorRole,
    action,
    message,
    severity: "INFO",
  });
};

const getActorLabel = (req) => {
  const { actorId, actorRole } = getAuditActor(req);
  return { actorId, roleLabel: formatAuditActorRole(actorRole) };
};

const formatPersonName = (row = {}) => {
  const name = [row.first_name, row.middle_name, row.last_name]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return name || row.email || "Unknown Employee";
};

const formatEmployeeLabel = (row = {}) =>
  `${formatPersonName(row)} (${row.employee_id || "unknown"})`;

const getActorAuditLabel = async (req) => {
  const { actorId, roleLabel } = getActorLabel(req);
  try {
    const [rows] = await db3.query(
      `SELECT ua.employee_id, ua.first_name, ua.middle_name, ua.last_name, ua.email,
              at.access_description
       FROM user_accounts ua
       LEFT JOIN access_table at ON at.access_id = ua.access_level
       WHERE ua.employee_id = ?
          OR ua.person_id = ?
          OR ua.email = ?
       LIMIT 1`,
      [actorId, actorId, actorId],
    );
    if (rows?.[0]) {
      const accessLabel = String(rows[0].access_description || "").trim();
      return `${accessLabel || roleLabel} ${formatEmployeeLabel(rows[0])}`;
    }
  } catch (err) {
    console.error("Email template actor audit lookup failed:", err);
  }
  return `${roleLabel} (${actorId})`;
};

const getConfiguredSenderEmails = () =>
  [
    process.env.EMAIL_USER1,
    process.env.EMAIL_USER2,
    process.env.EMAIL_USER3,
    process.env.EMAIL_USER4,
    process.env.EMAIL_USER5,
    process.env.EMAIL_USER6,
    process.env.EMAIL_USER7,
    process.env.EMAIL_USER8,
    process.env.EMAIL_USER9,
    process.env.EMAIL_USER10,
  ]
    .filter(Boolean)
    .map((email) => email.trim().toLowerCase());

const normalizeSenderEmail = (senderEmail) =>
  String(senderEmail || "").trim().toLowerCase();

const isConfiguredSenderEmail = (senderEmail) =>
  getConfiguredSenderEmails().includes(normalizeSenderEmail(senderEmail));

const ensureActiveCurriculum = async (curriculumId) => {
  const [[row]] = await db3.query(
    `SELECT curriculum_id FROM curriculum_table
     WHERE curriculum_id = ? AND lock_status = 1 LIMIT 1`,
    [curriculumId],
  );
  return Boolean(row);
};

const dedupeProgramIds = (program_ids = []) => {
  const seen = new Set();
  const out = [];
  for (const item of program_ids) {
    const curriculumId = String(item.curriculum_id ?? item);
    if (!seen.has(curriculumId)) {
      seen.add(curriculumId);
      out.push({ curriculum_id: curriculumId, dprtmnt_id: item.dprtmnt_id ?? null });
    }
  }
  return out;
};

// ─── GET all templates ────────────────────────────────────────────────────────
// Programs now carry dprtmnt_id from email_template_programs
router.get("/email-templates", async (req, res) => {
  try {
    const [templates] = await db.query(`
      SELECT
        et.template_id,
        et.sender_name,
        et.is_active,
        et.created_at,
        et.updated_at,
        COALESCE(tagged.employee_count, 0) AS tagged_employee_count
      FROM email_templates et
      LEFT JOIN (
        SELECT template_id, COUNT(*) AS employee_count
        FROM email_template_employees
        GROUP BY template_id
      ) tagged ON et.template_id = tagged.template_id
      ORDER BY et.updated_at DESC
    `);

    if (templates.length === 0) return res.json([]);

    // Fetch programs WITH dprtmnt_id for all templates in one query
    const templateIds = templates.map((t) => t.template_id);
    const [progRows] = await db.query(
      `SELECT
         etp.template_id,
         etp.program_id AS curriculum_id,
         etp.dprtmnt_id,
         dt.dprtmnt_name,
         dt.dprtmnt_code,
         pt.program_code,
         pt.program_description,
         pt.major
       FROM email_template_programs etp
       LEFT JOIN enrollment.curriculum_table ct ON etp.program_id = ct.curriculum_id
       LEFT JOIN enrollment.program_table pt ON ct.program_id = pt.program_id
       LEFT JOIN enrollment.dprtmnt_table dt ON etp.dprtmnt_id = dt.dprtmnt_id
       WHERE etp.template_id IN (?)
       ORDER BY dt.dprtmnt_name, pt.program_code`,
      [templateIds],
    );

    // Group programs by template_id
    const programsByTemplate = {};
    for (const row of progRows) {
      if (!programsByTemplate[row.template_id]) {
        programsByTemplate[row.template_id] = [];
      }
      programsByTemplate[row.template_id].push({
        curriculum_id: row.curriculum_id,
        dprtmnt_id: row.dprtmnt_id,
        dprtmnt_name: row.dprtmnt_name,
        dprtmnt_code: row.dprtmnt_code,
        program_code: row.program_code,
        program_description: row.program_description,
        major: row.major,
      });
    }

    // Derive unique departments per template for display
    const result = templates.map((t) => {
      const programs = programsByTemplate[t.template_id] || [];
      // Unique department names for display in the table
      const deptSet = new Map();
      for (const p of programs) {
        if (p.dprtmnt_id && !deptSet.has(p.dprtmnt_id)) {
          deptSet.set(p.dprtmnt_id, p.dprtmnt_name || "Unknown");
        }
      }
      return {
        ...t,
        programs,
        department_names: [...deptSet.values()], // array of dept names for display
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch templates" });
  }
});

// ─── CREATE template ──────────────────────────────────────────────────────────
// program_ids is now an array of { curriculum_id, dprtmnt_id } objects
router.post("/email-templates", CanCreate, async (req, res) => {
  try {
    const {
      sender_name,
      program_ids: rawProgramIds = [],   // array of { curriculum_id, dprtmnt_id }
      employee_ids = [],
      is_active = 1,
    } = req.body;

    const senderEmail = normalizeSenderEmail(sender_name);
    const program_ids = dedupeProgramIds(rawProgramIds);

    if (!senderEmail || !program_ids.length) {
      return res.status(400).json({
        error: "Gmail account and at least one program are required",
      });
    }

    if (!isConfiguredSenderEmail(senderEmail)) {
      return res.status(400).json({
        error: "Gmail account must match a configured sender email in the backend .env file",
      });
    }

    // Validate all programs are active curriculums
    for (const item of program_ids) {
      const curriculumId = item.curriculum_id ?? item;
      const active = await ensureActiveCurriculum(curriculumId);
      if (!active) {
        return res.status(400).json({
          error: `Program (curriculum ID ${curriculumId}) must be an active curriculum`,
        });
      }
    }

    // Insert template — no department_id column needed anymore
    const [result] = await db.query(
      "INSERT INTO email_templates (sender_name, is_active) VALUES (?, ?)",
      [senderEmail, is_active ? 1 : 0],
    );
    const templateId = result.insertId;

    // Insert programs WITH dprtmnt_id (deduped)
    const programRows = program_ids.map((item) => [
      templateId,
      item.curriculum_id ?? item,
      item.dprtmnt_id ?? null,
    ]);
    await db.query(
      "INSERT INTO email_template_programs (template_id, program_id, dprtmnt_id) VALUES ?",
      [programRows],
    );

    // Insert employees if provided
    if (employee_ids.length > 0) {
      const uniqueEmployeeIds = [...new Set(employee_ids.map(String))];
      await db.query(
        "INSERT INTO email_template_employees (template_id, employee_id) VALUES ?",
        [uniqueEmployeeIds.map((eid) => [templateId, eid])],
      );
    }

    const actorLabel = await getActorAuditLabel(req);
    await insertEmailTemplateAuditLog({
      req,
      action: "EMAIL_TEMPLATE_CREATE",
      message: `${actorLabel} created email template for ${senderEmail} with ${program_ids.length} program(s).`,
    });

    res.status(201).json({ template_id: templateId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create template" });
  }
});

// ─── UPDATE template ──────────────────────────────────────────────────────────
router.put("/email-templates/:id", CanEdit, async (req, res) => {
  try {
    const {
      sender_name,
      program_ids: rawProgramIds,    // array of { curriculum_id, dprtmnt_id } (optional)
      employee_ids,
      is_active,
    } = req.body;

    const senderEmail =
      sender_name === undefined ? undefined : normalizeSenderEmail(sender_name);

    const program_ids = Array.isArray(rawProgramIds)
      ? dedupeProgramIds(rawProgramIds)
      : rawProgramIds;

    if (senderEmail !== undefined && !senderEmail) {
      return res.status(400).json({ error: "Gmail account is required" });
    }
    if (senderEmail !== undefined && !isConfiguredSenderEmail(senderEmail)) {
      return res.status(400).json({
        error: "Gmail account must match a configured sender email in the backend .env file",
      });
    }

    // Validate programs if provided
    if (Array.isArray(program_ids) && program_ids.length > 0) {
      for (const item of program_ids) {
        const curriculumId = item.curriculum_id ?? item;
        const active = await ensureActiveCurriculum(curriculumId);
        if (!active) {
          return res.status(400).json({
            error: `Program (curriculum ID ${curriculumId}) must be an active curriculum`,
          });
        }
      }
    }

    // Update main template fields — no department_id column
    const [result] = await db.query(
      `UPDATE email_templates
       SET sender_name = COALESCE(?, sender_name),
           is_active   = COALESCE(?, is_active)
       WHERE template_id = ?`,
      [senderEmail, is_active, req.params.id],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    // Replace programs if provided (deduped)
    if (Array.isArray(program_ids) && program_ids.length > 0) {
      await db.query(
        "DELETE FROM email_template_programs WHERE template_id = ?",
        [req.params.id],
      );
      const programRows = program_ids.map((item) => [
        req.params.id,
        item.curriculum_id ?? item,
        item.dprtmnt_id ?? null,
      ]);
      await db.query(
        "INSERT INTO email_template_programs (template_id, program_id, dprtmnt_id) VALUES ?",
        [programRows],
      );
    }

    // Replace employees if provided
    if (Array.isArray(employee_ids)) {
      const uniqueEmployeeIds = [...new Set(employee_ids.map(String).filter(Boolean))];
      await db.query(
        "DELETE FROM email_template_employees WHERE template_id = ?",
        [req.params.id],
      );
      if (uniqueEmployeeIds.length > 0) {
        await db.query(
          "INSERT INTO email_template_employees (template_id, employee_id) VALUES ?",
          [uniqueEmployeeIds.map((eid) => [req.params.id, eid])],
        );
      }
    }

    const templateLabel = senderEmail || `template ID ${req.params.id}`;
    const actorLabel = await getActorAuditLabel(req);
    await insertEmailTemplateAuditLog({
      req,
      action: "EMAIL_TEMPLATE_UPDATE",
      message: `${actorLabel} updated email template ${templateLabel}.`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update template" });
  }
});

// ─── DELETE template ──────────────────────────────────────────────────────────
router.delete("/email-templates/:id", CanDelete, async (req, res) => {
  try {
    const [[template]] = await db.query(
      "SELECT sender_name FROM email_templates WHERE template_id = ? LIMIT 1",
      [req.params.id],
    );

    await db.query("DELETE FROM email_template_programs WHERE template_id = ?", [req.params.id]);
    await db.query("DELETE FROM email_template_employees WHERE template_id = ?", [req.params.id]);

    const [result] = await db.query(
      "DELETE FROM email_templates WHERE template_id = ?",
      [req.params.id],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    const templateLabel = template?.sender_name || `template ID ${req.params.id}`;
    const actorLabel = await getActorAuditLabel(req);
    await insertEmailTemplateAuditLog({
      req,
      action: "EMAIL_TEMPLATE_DELETE",
      message: `${actorLabel} deleted email template ${templateLabel}.`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete template" });
  }
});

// ─── GET tagged employees for a template ──────────────────────────────────────
router.get("/email-templates/:id/employees", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
         ete.employee_id,
         ua.first_name,
         ua.middle_name,
         ua.last_name,
         ua.email,
         ua.role AS position,
         ua.dprtmnt_id
       FROM email_template_employees ete
       LEFT JOIN enrollment.user_accounts ua ON ete.employee_id = ua.employee_id
       WHERE ete.template_id = ?
       ORDER BY ua.last_name, ua.first_name, ete.employee_id`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch tagged employees" });
  }
});

// ─── PUT tagged employees for a template (replace) ───────────────────────────
router.put("/email-templates/:id/employees", CanEdit, async (req, res) => {
  try {
    const { employee_ids = [] } = req.body;
    const uniqueIds = [...new Set(employee_ids.map(String).filter(Boolean))];

    await db.query(
      "DELETE FROM email_template_employees WHERE template_id = ?",
      [req.params.id],
    );
    if (uniqueIds.length > 0) {
      await db.query(
        "INSERT INTO email_template_employees (template_id, employee_id) VALUES ?",
        [uniqueIds.map((eid) => [req.params.id, eid])],
      );
    }

    const actorLabel = await getActorAuditLabel(req);
    await insertEmailTemplateAuditLog({
      req,
      action: "EMAIL_TEMPLATE_EMPLOYEES_UPDATE",
      message: `${actorLabel} updated tagged employees for template ID ${req.params.id}.`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update tagged employees" });
  }
});

// ─── GET active senders (multi-program aware) ─────────────────────────────────
router.get("/email-templates/active-senders", async (req, res) => {
  const { department_id, program_id, employee_id } = req.query;

  try {
    if (!department_id || !program_id || !employee_id) {
      return res.status(400).json({
        error: "Department, program, and employee are required",
      });
    }

    const [rows] = await db.query(
      `SELECT et.template_id, et.sender_name
       FROM email_templates et
       INNER JOIN email_template_programs etp ON et.template_id = etp.template_id
       INNER JOIN email_template_employees ete ON et.template_id = ete.template_id
       INNER JOIN enrollment.curriculum_table ct ON etp.program_id = ct.curriculum_id
       WHERE et.is_active = 1
         AND ct.lock_status = 1
         AND etp.dprtmnt_id = ?
         AND etp.program_id = ?
         AND ete.employee_id = ?
       ORDER BY et.updated_at DESC`,
      [department_id, program_id, employee_id],
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch active senders" });
  }
});

module.exports = router;