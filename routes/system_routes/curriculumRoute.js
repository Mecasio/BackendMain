const express = require("express");
const { db, db3 } = require("../database/database");
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");
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

const getCurriculumLabel = async (curriculumId, fallback = {}) => {
  try {
    const [rows] = await db3.query(
      `
      SELECT
        ct.curriculum_id,
        p.program_code,
        p.program_description,
        p.major,
        y.year_description
      FROM curriculum_table ct
      LEFT JOIN program_table p ON p.program_id = ct.program_id
      LEFT JOIN year_table y ON y.year_id = ct.year_id
      WHERE ct.curriculum_id = ?
      LIMIT 1
      `,
      [curriculumId],
    );

    const curriculum = rows?.[0];
    if (curriculum) {
      const programCode = curriculum.program_code || "N/A";
      const programDescription =
        curriculum.program_description || "Unknown Program";
      const major = curriculum.major ? ` (${curriculum.major})` : "";
      const year = curriculum.year_description || "Unknown Year";
      return `${programCode} - ${programDescription}${major}, ${year}`;
    }
  } catch (err) {
    console.error("Curriculum audit label lookup failed:", err);
  }

  return `Curriculum ${curriculumId || fallback.curriculum_id || "unknown"}`;
};

const insertCurriculumAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

router.post("/curriculum", CanCreate, async (req, res) => {
  const { year_id, program_id } = req.body;

  if (!year_id || !program_id) {
    return res
      .status(400)
      .json({ error: "Year ID and Program ID are required" });
  }

  try {
    const [rows] = await db3.query(
      "SELECT * FROM curriculum_table WHERE year_id = ? AND program_id = ?",
      [year_id, program_id],
    );
    if (rows.length > 0) {
      return res
        .status(400)
        .json({ message: "This curriculum is already existed" });
    }
    const sql =
      "INSERT INTO curriculum_table (year_id, program_id) VALUES (?, ?)";
    const [result] = await db3.query(sql, [year_id, program_id]);
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const curriculumLabel = await getCurriculumLabel(result.insertId, {
      curriculum_id: result.insertId,
    });

    await insertCurriculumAuditLog({
      req,
      action: "CURRICULUM_CREATE",
      message: `${roleLabel} (${actorId}) created curriculum ${curriculumLabel}.`,
    });

    res.status(201).json({
      message: "Curriculum created successfully",
      curriculum_id: result.insertId,
    });
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({
      error: "Internal Server Error",
      details: err.message,
    });
  }
});

// CURRICULUM LIST (UPDATED!)
router.get("/get_curriculum", async (req, res) => {
  const readQuery = `
    SELECT ct.*, p.*, y.* 
    FROM curriculum_table ct 
    INNER JOIN program_table p ON ct.program_id = p.program_id
    INNER JOIN year_table y ON ct.year_id = y.year_id
  `;

  try {
    const [result] = await db3.query(readQuery);
    res.status(200).json(result);
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({
      error: "Internal Server Error",
      details: err.message,
    });
  }
});

// ✅ UPDATE Curriculum lock_status (0 = inactive, 1 = active)
router.put("/update_curriculum/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { lock_status } = req.body;

  try {
    // Ensure valid input
    if (lock_status !== 0 && lock_status !== 1) {
      return res
        .status(400)
        .json({ message: "Invalid status value (must be 0 or 1)" });
    }

    const sql =
      "UPDATE curriculum_table SET lock_status = ? WHERE curriculum_id = ?";
    const [result] = await db3.query(sql, [lock_status, id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Curriculum not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const curriculumLabel = await getCurriculumLabel(id);
    await insertCurriculumAuditLog({
      req,
      action: "CURRICULUM_STATUS_UPDATE",
      message: `${roleLabel} (${actorId}) set curriculum ${curriculumLabel} to ${lock_status === 1 ? "Active" : "Inactive"}.`,
    });

    res.status(200).json({ message: "Curriculum status updated successfully" });
  } catch (error) {
    console.error("❌ Error updating curriculum status:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

router.put("/update_curriculum_data/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { year_id, program_id } = req.body;

  try {
    const [result] = await db3.query(
      "UPDATE curriculum_table SET year_id = ?, program_id = ? WHERE curriculum_id = ?",
      [year_id, program_id, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Curriculum not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const curriculumLabel = await getCurriculumLabel(id);
    await insertCurriculumAuditLog({
      req,
      action: "CURRICULUM_UPDATE",
      message: `${roleLabel} (${actorId}) updated curriculum ${curriculumLabel}.`,
    });

    res.json({ message: "Curriculum updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Update failed" });
  }
});

router.delete("/delete_curriculum/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const curriculumLabel = await getCurriculumLabel(id);
    const [result] = await db3.query(
      "DELETE FROM curriculum_table WHERE curriculum_id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Curriculum not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertCurriculumAuditLog({
      req,
      action: "CURRICULUM_DELETE",
      message: `${roleLabel} (${actorId}) deleted curriculum ${curriculumLabel}.`,
    });

    res.json({ message: "Curriculum deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Delete failed" });
  }
});

router.get("/get_active_curriculum", async (req, res) => {
  const readQuery = `
    SELECT ct.*, p.*, y.*, dct.dprtmnt_id
    FROM curriculum_table ct 
    INNER JOIN program_table p ON ct.program_id = p.program_id
    INNER JOIN year_table y ON ct.year_id = y.year_id
    LEFT JOIN dprtmnt_curriculum_table dct ON dct.curriculum_id = ct.curriculum_id
    WHERE ct.lock_status = 1
  `;

  try {
    const [result] = await db3.query(readQuery);
    res.status(200).json(result);
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
