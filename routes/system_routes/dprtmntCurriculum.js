const express = require('express');
const { db, db3 } = require('../database/database');
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

const insertDepartmentCurriculumAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    message,
    severity: "INFO",
  });
};

const getDepartmentCurriculumLabel = async ({ dprtmntId, curriculumId, mappingId }) => {
  const values = [];
  let whereClause = "";

  if (mappingId) {
    whereClause = "dc.dprtmnt_curriculum_id = ?";
    values.push(mappingId);
  } else {
    whereClause = "dc.dprtmnt_id = ? AND dc.curriculum_id = ?";
    values.push(dprtmntId, curriculumId);
  }

  const [rows] = await db3.execute(
    `SELECT dt.dprtmnt_name, dt.dprtmnt_code, y.year_description, p.program_code
     FROM dprtmnt_curriculum_table dc
     INNER JOIN dprtmnt_table dt ON dc.dprtmnt_id = dt.dprtmnt_id
     INNER JOIN curriculum_table c ON dc.curriculum_id = c.curriculum_id
     INNER JOIN year_table y ON c.year_id = y.year_id
     INNER JOIN program_table p ON c.program_id = p.program_id
     WHERE ${whereClause}
     LIMIT 1`,
    values,
  );

  if (!rows[0]) {
    return {
      departmentLabel: `department ID ${dprtmntId || "unknown"}`,
      curriculumLabel: `curriculum ID ${curriculumId || "unknown"}`,
    };
  }

  return {
    departmentLabel: `${rows[0].dprtmnt_name} (${rows[0].dprtmnt_code})`,
    curriculumLabel: `${rows[0].year_description} ${rows[0].program_code}`,
  };
};

// GET mappings for a department
router.get("/dprtmnt_curriculum/:dprtmnt_id", async (req, res) => {
  const { dprtmnt_id } = req.params;
  try {
    const query = `
      SELECT
        dc.dprtmnt_curriculum_id,
        dc.dprtmnt_id,
        dc.curriculum_id,
        dt.dprtmnt_name,
        dt.dprtmnt_code,
        ct.curriculum_id AS ct_curriculum_id,
        ct.year_id,
        y.year_description,
        ct.program_id,
        ct.lock_status,
        p.program_description AS p_description,
        p.program_code AS p_code,
          p.major AS p_major
      FROM dprtmnt_curriculum_table AS dc
      INNER JOIN dprtmnt_table AS dt
        ON dc.dprtmnt_id = dt.dprtmnt_id
      INNER JOIN curriculum_table AS ct
        ON dc.curriculum_id = ct.curriculum_id
      INNER JOIN program_table AS p
        ON ct.program_id = p.program_id
      INNER JOIN year_table AS y
        ON ct.year_id = y.year_id
      WHERE dc.dprtmnt_id = ?
      ORDER BY
        COALESCE(p_code, ''),
        dc.curriculum_id;
    `;

    const [rows] = await db3.execute(query, [dprtmnt_id]);
    res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching dprtmnt_curriculum:", err);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

// POST add mapping (dprtmnt_id + curriculum_id)
router.post("/dprtmnt_curriculum", CanCreate, async (req, res) => {
  const { dprtmnt_id, curriculum_id } = req.body;
  if (!dprtmnt_id || !curriculum_id) {
    return res
      .status(400)
      .json({ error: "dprtmnt_id and curriculum_id are required" });
  }

  try {
    // prevent duplicate mapping
    const [exists] = await db3.execute(
      "SELECT * FROM dprtmnt_curriculum_table WHERE dprtmnt_id = ? AND curriculum_id = ?",
      [dprtmnt_id, curriculum_id],
    );
    if (exists.length > 0) {
      return res.status(409).json({ message: "Mapping already exists" });
    }

    const [result] = await db3.execute(
      "INSERT INTO dprtmnt_curriculum_table (dprtmnt_id, curriculum_id) VALUES (?, ?)",
      [dprtmnt_id, curriculum_id],
    );

    const { departmentLabel, curriculumLabel } = await getDepartmentCurriculumLabel({
      dprtmntId: dprtmnt_id,
      curriculumId: curriculum_id,
    });
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertDepartmentCurriculumAuditLog({
      req,
      action: "DEPARTMENT_CURRICULUM_ASSIGN",
      message: `${roleLabel} (${actorId}) assigned curriculum ${curriculumLabel} to ${departmentLabel}.`,
    });

    // return inserted id
    res.status(201).json({
      message: "Mapping created",
      dprtmnt_curriculum_id: result.insertId,
    });
  } catch (err) {
    console.error("Error creating mapping:", err);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

// DELETE mapping by mapping id
router.delete("/dprtmnt_curriculum/:id", CanDelete, async (req, res) => {
  const { id } = req.params;
  try {
    const { departmentLabel, curriculumLabel } = await getDepartmentCurriculumLabel({
      mappingId: id,
    });

    const [result] = await db3.execute(
      "DELETE FROM dprtmnt_curriculum_table WHERE dprtmnt_curriculum_id = ?",
      [id],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Mapping not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertDepartmentCurriculumAuditLog({
      req,
      action: "DEPARTMENT_CURRICULUM_REMOVE",
      message: `${roleLabel} (${actorId}) removed curriculum ${curriculumLabel} from ${departmentLabel}.`,
    });
    res.status(200).json({ message: "Mapping deleted" });
  } catch (err) {
    console.error("Error deleting mapping:", err);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

router.put("/dprtmnt_curriculum/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { curriculum_id, dprtmnt_id } = req.body;

  if (!curriculum_id || !dprtmnt_id) {
    return res
      .status(400)
      .json({ message: "curriculum_id and dprtmnt_id required" });
  }

  try {
    // Check duplicate mapping
    const [exists] = await db3.execute(
      `SELECT * FROM dprtmnt_curriculum_table
       WHERE dprtmnt_id = ? AND curriculum_id = ? AND dprtmnt_curriculum_id != ?`,
      [dprtmnt_id, curriculum_id, id],
    );

    if (exists.length > 0) {
      return res.status(409).json({ message: "Mapping already exists" });
    }

    const [result] = await db3.execute(
      `UPDATE dprtmnt_curriculum_table
       SET curriculum_id = ?
       WHERE dprtmnt_curriculum_id = ?`,
      [curriculum_id, id],
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Mapping ID not found" });

    res.json({ message: "Mapping updated" });
  } catch (err) {
    console.error("Update error:", err);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});


module.exports = router;
