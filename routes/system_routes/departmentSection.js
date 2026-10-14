const express = require("express");
const { db3 } = require("../database/database");
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

const insertDepartmentSectionAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
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

const getDepartmentSectionLabel = async (departmentSectionId) => {
  const [[details]] = await db3.query(
    `SELECT y.year_description, p.program_code, p.program_description, p.major,
            st.description AS section_description,
            yl.year_level_description
     FROM dprtmnt_section_table dst
     INNER JOIN curriculum_table c ON dst.curriculum_id = c.curriculum_id
     INNER JOIN year_table y ON c.year_id = y.year_id
     INNER JOIN program_table p ON c.program_id = p.program_id
     INNER JOIN section_table st ON dst.section_id = st.id
     LEFT JOIN year_level_table yl ON dst.year_level_id = yl.year_level_id
     WHERE dst.id = ?
     LIMIT 1`,
    [departmentSectionId],
  );

  if (!details) return `department section ID ${departmentSectionId}`;

  const programLabel = [
    details.year_description,
    details.program_code,
    details.program_description,
    details.major,
  ].filter(Boolean).join(" ");

  const yearLevelLabel = details.year_level_description
    ? ` (${details.year_level_description})`
    : "";

  return `${programLabel} - ${details.section_description}${yearLevelLabel}`;
};

// ACTIVE CURRICULUM
router.get("/get_active_curriculum", async (req, res) => {
  const readQuery = `
    SELECT ct.*, p.*, y.*
    FROM curriculum_table ct
    INNER JOIN program_table p ON ct.program_id = p.program_id
    INNER JOIN year_table y ON ct.year_id = y.year_id
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

// SECTIONS - CREATE
router.post("/section_table", async (req, res) => {
  const { description } = req.body;
  if (!description) {
    return res.status(400).json({ error: "Description is required" });
  }

  try {
    const checkQuery = "SELECT * FROM section_table WHERE description = ?";
    const [exists] = await db3.query(checkQuery, [description]);

    if (exists.length > 0) {
      return res.status(409).json({ error: "Section already exists" });
    }

    const insertQuery = "INSERT INTO section_table (description) VALUES (?)";
    const [result] = await db3.query(insertQuery, [description]);

    const { actorId, roleLabel } = getActorLabel(req);
    await insertDepartmentSectionAuditLog({
      req,
      action: "SECTION_CREATE",
      message: `${roleLabel} (${actorId}) created section ${description}.`,
    });

    res.status(201).json({
      message: "Section created successfully",
      sectionId: result.insertId,
    });
  } catch (err) {
    console.error("Error inserting section:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

// SECTIONS - UPDATE
router.put("/section_table/:id", async (req, res) => {
  const { id } = req.params;
  const { description } = req.body;

  if (!description) {
    return res.status(400).json({ error: "Description is required" });
  }

  try {
    const checkQuery =
      "SELECT * FROM section_table WHERE description = ? AND id != ?";
    const [exists] = await db3.query(checkQuery, [description, id]);

    if (exists.length > 0) {
      return res.status(409).json({ error: "Section already exists" });
    }

    const updateQuery = "UPDATE section_table SET description = ? WHERE id = ?";
    const [result] = await db3.query(updateQuery, [description, id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Section not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertDepartmentSectionAuditLog({
      req,
      action: "SECTION_UPDATE",
      message: `${roleLabel} (${actorId}) updated section ${description}.`,
    });

    res.status(200).json({ message: "Section updated successfully" });
  } catch (err) {
    console.error("Error updating section:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// SECTIONS - DELETE
router.delete("/section_table/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [[section]] = await db3.query(
      "SELECT description FROM section_table WHERE id = ? LIMIT 1",
      [id],
    );

    const deleteQuery = "DELETE FROM section_table WHERE id = ?";
    const [result] = await db3.query(deleteQuery, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Section not found" });
    }

    const sectionLabel = section?.description || `section ID ${id}`;
    const { actorId, roleLabel } = getActorLabel(req);
    await insertDepartmentSectionAuditLog({
      req,
      action: "SECTION_DELETE",
      message: `${roleLabel} (${actorId}) deleted section ${sectionLabel}.`,
    });

    res.status(200).json({ message: "Section deleted successfully" });
  } catch (err) {
    console.error("Error deleting section:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// SECTIONS - LIST
router.get("/section_table", async (req, res) => {
  try {
    const query = "SELECT * FROM section_table";
    const [result] = await db3.query(query);
    res.status(200).json(result);
  } catch (err) {
    console.error("Error fetching sections:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

// SECTIONS BY DEPARTMENT
router.get("/section_table/:dprtmnt_id", async (req, res) => {
  const { dprtmnt_id } = req.params;

  try {
    const query = `
      SELECT dst.id AS dep_section_id, dst.curriculum_id, dst.dsstat, st.*, pt.*
      FROM dprtmnt_curriculum_table AS dct
      INNER JOIN dprtmnt_section_table AS dst ON dct.curriculum_id = dst.curriculum_id
      INNER JOIN section_table AS st ON dst.section_id = st.id
      INNER JOIN curriculum_table AS ct ON dct.curriculum_id = ct.curriculum_id
      INNER JOIN program_table AS pt ON ct.program_id = pt.program_id
      WHERE dct.dprtmnt_id = ?
        AND ct.lock_status = 1
      GROUP BY dst.id, dst.curriculum_id, st.id, pt.program_id;
    `;

    const [results] = await db3.query(query, [dprtmnt_id]);
    res.status(200).send(results);
  } catch (error) {
    console.error(error);
    res.status(500).send(error);
  }
});

// DEPARTMENT SECTION - CREATE
router.post("/department_section", CanCreate, async (req, res) => {
  const { curriculum_id, section_id, year_level_id } = req.body;
  const isNstp = Number(req.body.is_nstp ?? 0);

  if (isNstp !== 0 && isNstp !== 1) {
    return res.status(400).json({ error: "NSTP value must be 0 or 1" });
  }

  if (!curriculum_id || !section_id || !year_level_id) {
    return res
      .status(400)
      .json({ error: "Curriculum ID, Section ID, and Year Level are required" });
  }

  try {
    const [existing] = await db3.query(
      `
      SELECT * FROM dprtmnt_section_table
      WHERE curriculum_id = ? AND section_id = ? AND year_level_id = ?
      `,
      [curriculum_id, section_id, year_level_id],
    );

    if (existing.length > 0) {
      return res.status(400).json({
        message: "This department-section-year level combination already exists.",
      });
    }

    const query = `
      INSERT INTO dprtmnt_section_table
        (curriculum_id, section_id, year_level_id, dsstat, is_nstp)
      VALUES (?, ?, ?, 0, ?)
    `;

    const [result] = await db3.query(query, [
      curriculum_id,
      section_id,
      year_level_id,
      isNstp,
    ]);

    const [[details]] = await db3.query(
      `SELECT y.year_description, p.program_code, st.description AS section_description,
              yl.year_level_description
       FROM curriculum_table c
       INNER JOIN year_table y ON c.year_id = y.year_id
       INNER JOIN program_table p ON c.program_id = p.program_id
       INNER JOIN section_table st ON st.id = ?
       LEFT JOIN year_level_table yl ON yl.year_level_id = ?
       WHERE c.curriculum_id = ?`,
      [section_id, year_level_id, curriculum_id],
    );
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const curriculumLabel = details
      ? `${details.year_description} ${details.program_code}`
      : `curriculum ID ${curriculum_id}`;
    const sectionLabel = details?.section_description || `section ID ${section_id}`;
    const yearLevelLabel = details?.year_level_description
      ? ` (${details.year_level_description})`
      : "";
    await insertDepartmentSectionAuditLog({
      req,
      action: "DEPARTMENT_SECTION_CREATE",
      message: `${roleLabel} (${actorId}) created department section ${curriculumLabel} - ${sectionLabel}${yearLevelLabel}.`,
    });

    res.status(201).json({
      message: "Department section created successfully",
      sectionId: result.insertId,
    });
  } catch (err) {
    console.error("Error inserting department section:", err);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

// DEPARTMENT SECTION - UPDATE
router.put("/department_section/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { curriculum_id, section_id, year_level_id } = req.body;
  const isNstp = Number(req.body.is_nstp ?? 0);

  if (isNstp !== 0 && isNstp !== 1) {
    return res.status(400).json({ error: "NSTP value must be 0 or 1" });
  }

  if (!curriculum_id || !section_id || !year_level_id) {
    return res
      .status(400)
      .json({ error: "Curriculum ID, Section ID, and Year Level are required" });
  }

  try {
    const [existing] = await db3.query(
      `SELECT id
       FROM dprtmnt_section_table
       WHERE curriculum_id = ? AND section_id = ? AND year_level_id = ? AND id != ?
       LIMIT 1`,
      [curriculum_id, section_id, year_level_id, id],
    );

    if (existing.length > 0) {
      return res.status(400).json({
        message: "This department-section-year level combination already exists.",
      });
    }

    const beforeLabel = await getDepartmentSectionLabel(id);

    const [result] = await db3.query(
      `UPDATE dprtmnt_section_table
       SET curriculum_id = ?, section_id = ?, year_level_id = ?, is_nstp = ?
       WHERE id = ?`,
      [curriculum_id, section_id, year_level_id, isNstp, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Department section not found" });
    }

    const afterLabel = await getDepartmentSectionLabel(id);
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertDepartmentSectionAuditLog({
      req,
      action: "DEPARTMENT_SECTION_EDIT",
      message: `${roleLabel} (${actorId}) edited department section from ${beforeLabel} to ${afterLabel}.`,
    });

    res.json({ message: "Department section updated successfully" });
  } catch (err) {
    console.error("Error updating department section:", err);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

// DEPARTMENT SECTION - DELETE
router.delete("/department_section/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const sectionLabel = await getDepartmentSectionLabel(id);
    const [result] = await db3.query(
      "DELETE FROM dprtmnt_section_table WHERE id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Department section not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertDepartmentSectionAuditLog({
      req,
      action: "DEPARTMENT_SECTION_DELETE",
      message: `${roleLabel} (${actorId}) deleted department section ${sectionLabel}.`,
    });

    res.json({ message: "Department section deleted successfully" });
  } catch (err) {
    console.error("Error deleting department section:", err);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

// DEPARTMENT SECTION - LIST
router.get("/department_section", async (req, res) => {
  try {
    const query = `
      SELECT
        dst.id as department_section_id,
        dst.dsstat,
        dst.is_nstp,
        dst.year_level_id,
        ylt.year_level_description,
        pt.program_code,
        pt.program_description,
        pt.major,
        ct.curriculum_id,
        st.id AS section_id,
        dct.dprtmnt_id,
        yt.year_description,
        st.description AS section_description
      FROM dprtmnt_section_table dst
      INNER JOIN curriculum_table ct ON dst.curriculum_id = ct.curriculum_id
      LEFT JOIN year_level_table ylt ON dst.year_level_id = ylt.year_level_id
      LEFT JOIN (
        SELECT curriculum_id, MIN(dprtmnt_id) AS dprtmnt_id
        FROM dprtmnt_curriculum_table
        GROUP BY curriculum_id
      ) dct ON dct.curriculum_id = ct.curriculum_id
      INNER JOIN program_table pt ON ct.program_id = pt.program_id
      INNER JOIN year_table yt ON ct.year_id = yt.year_id
      INNER JOIN section_table st ON dst.section_id = st.id
    `;

    const [rows] = await db3.query(query);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// DEPARTMENT SECTION - TOGGLE ACTIVE/INACTIVE STATUS
router.put(
  "/department_section/:id/status",
  CanEdit,
  async (req, res) => {
    const { id } = req.params;
    const { dsstat } = req.body;

    if (dsstat !== 0 && dsstat !== 1) {
      return res.status(400).json({
        message: "Invalid status value.",
      });
    }

    try {
      const beforeLabel = await getDepartmentSectionLabel(id);

      const [result] = await db3.query(
        `
        UPDATE dprtmnt_section_table
        SET dsstat = ?
        WHERE id = ?
        `,
        [dsstat, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          message: "Department section not found.",
        });
      }

      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);

      await insertDepartmentSectionAuditLog({
        req,
        action: "DEPARTMENT_SECTION_STATUS_UPDATE",
        message: `${roleLabel} (${actorId}) changed status of ${beforeLabel} to ${
          dsstat === 1 ? "Active" : "Inactive"
        }.`,
      });

      res.status(200).json({
        message: "Status updated successfully.",
      });
    } catch (err) {
      console.error("Error updating status:", err);

      res.status(500).json({
        error: "Internal Server Error",
        details: err.message,
      });
    }
  }
);

module.exports = router;
