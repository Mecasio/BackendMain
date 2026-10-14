const express = require("express");
const { db } = require("../database/database");
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");
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

const insertRequirementAuditLog = async ({ req, action, message }) => {
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
  return {
    actorId,
    roleLabel: formatAuditActorRole(actorRole),
  };
};

const normalizeRequirementPayload = (body = {}) => {
  const description = body.description ?? body.requirements_description ?? null;

  return {
    description,
    short_label: body.short_label ?? null,
    label: body.label ?? null,
    category: body.category || "Regular",
    is_verifiable: body.is_verifiable === undefined ? 1 : body.is_verifiable ? 1 : 0,
    is_optional: body.is_optional ? 1 : 0,
    applicant_type: String(body.applicant_type ?? 0),

    // ✅ NEW FIELD
    selected_copy_type: body.selected_copy_type ?? null
  };
};

router.get("/select-copy", async (req, res) => {
  const { type, req_id, applicant } = req.query;

  if (!["xerox", "original"].includes(type)) {
    return res.status(400).send("Invalid selection");
  }

  try {
    await db.execute(
      `
      INSERT INTO requirement_submissions 
      (applicant_number, requirement_id, copy_type)
      VALUES (?, ?, ?)
      `,
      [applicant, req_id, type]
    );

    res.send(`
      <h2>✅ Submission Recorded</h2>
      <p>You selected: <strong>${type.toUpperCase()}</strong></p>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to save selection");
  }
});

router.post("/requirements", CanCreate, async (req, res) => {
  const payload = normalizeRequirementPayload(req.body);

  if (!payload.description) {
    return res.status(400).json({ error: "Requirement description is required" });
  }

  const query = `
    INSERT INTO requirements_table
    (
      description,
      short_label,
      label,
      category,
      is_verifiable,
      is_optional,
      applicant_type
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  try {
    const [result] = await db.execute(query, [
      payload.description,
      payload.short_label,
      payload.label,
      payload.category,
      payload.is_verifiable,
  
      payload.is_optional,
      payload.applicant_type,
    ]);

    const { actorId, roleLabel } = getActorLabel(req);
    await insertRequirementAuditLog({
      req,
      action: "REQUIREMENT_CREATE",
      message: `${roleLabel} (${actorId}) created requirement ${payload.description}.`,
    });

    res.status(201).json({ requirements_id: result.insertId });
  } catch (err) {
    console.error("Create requirement error:", err);
    res.status(500).json({ error: "Failed to save requirement" });
  }
});

router.get("/requirements", async (req, res) => {
  try {
    const [results] = await db.execute(
      "SELECT * FROM requirements_table ORDER BY id ASC",
    );
    res.json(results);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch requirements" });
  }
});

router.put("/requirements/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const payload = normalizeRequirementPayload(req.body);

  if (!payload.description) {
    return res.status(400).json({ error: "Requirement description is required" });
  }

  const query = `
    UPDATE requirements_table
    SET
      description = ?,
      short_label = ?,
      label = ?,
      category = ?,
      is_verifiable = ?,
 
      is_optional = ?,
      applicant_type = ?
    WHERE id = ?
  `;

  try {
    const [result] = await db.execute(query, [
      payload.description,
      payload.short_label,
      payload.label,
      payload.category,
      payload.is_verifiable,

      payload.is_optional,
      payload.applicant_type,
      id,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Requirement not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertRequirementAuditLog({
      req,
      action: "REQUIREMENT_UPDATE",
      message: `${roleLabel} (${actorId}) updated requirement ${payload.description}.`,
    });

    res.json({ message: "Requirement updated successfully" });
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ error: "Failed to update requirement" });
  }
});

router.delete("/requirements/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[requirement]] = await db.execute(
      "SELECT description FROM requirements_table WHERE id = ? LIMIT 1",
      [id],
    );

    const [result] = await db.execute(
      "DELETE FROM requirements_table WHERE id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Requirement not found" });
    }

    const requirementLabel = requirement?.description || `requirement ID ${id}`;
    const { actorId, roleLabel } = getActorLabel(req);
    await insertRequirementAuditLog({
      req,
      action: "REQUIREMENT_DELETE",
      message: `${roleLabel} (${actorId}) deleted requirement ${requirementLabel}.`,
    });

    res.status(200).json({ message: "Requirement deleted successfully" });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete requirement" });
  }
});

router.get("/requirements/:person_id", async (req, res) => {
  const { person_id } = req.params;

  try {
    const [personRows] = await db.query(
      "SELECT applyingAs FROM person_table WHERE person_id = ?",
      [person_id],
    );

    if (personRows.length === 0) {
      return res.status(404).json({ message: "Applicant type not found." });
    }

    const applyingAs = String(personRows[0].applyingAs);
    const [results] = await db.execute(
      `
        SELECT *
        FROM requirements_table
        WHERE applicant_type = ?
           OR applicant_type = '0'
           OR applicant_type = 0
           OR applicant_type = 'All'
        ORDER BY id ASC
      `,
      [applyingAs],
    );

    res.json(results);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch requirements" });
  }
});

module.exports = router;
