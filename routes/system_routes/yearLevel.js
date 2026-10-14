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

const insertYearLevelAuditLog = async ({ req, action, message }) => {
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

router.get("/year-levels", async (req, res) => {
  try {
    const [rows] = await db3.query(
      `SELECT year_level_id, year_level_description, level_type
   FROM year_level_table 
   WHERE level_type IN ('year', 'graduate')
   ORDER BY year_level_id`
    );

    res.json(rows);
  } catch (err) {
    console.error("Error fetching year levels:", err);
    res.status(500).json({ message: "Failed to fetch year levels" });
  }
});

router.post("/years_level", CanCreate, async (req, res) => {
  const { year_level_description, level_type, ordinal_label } = req.body;

  if (!year_level_description) {
    return res
      .status(400)
      .json({ error: "year_level_description is required" });
  }

  const query =
    "INSERT INTO year_level_table (year_level_description, level_type, ordinal_label) VALUES (?, ?, ?)";

  try {
    const [result] = await db3.query(query, [
      year_level_description,
      level_type || "year",
      ordinal_label || null,
    ]);

    const { actorId, roleLabel } = getActorLabel(req);
    await insertYearLevelAuditLog({
      req,
      action: "YEAR_LEVEL_CREATE",
      message: `${roleLabel} (${actorId}) created year level ${year_level_description}.`,
    });

    res.status(201).json({
      year_level_id: result.insertId,
      year_level_description,
      level_type,
      ordinal_label,
    });
  } catch (err) {
    console.error("Insert error:", err);
    res.status(500).json({ error: "Insert failed", details: err.message });
  }
});

router.put("/years_level/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { year_level_description, level_type, ordinal_label } = req.body;

  if (!year_level_description) {
    return res.status(400).json({ error: "Description is required" });
  }

  try {
    const [result] = await db3.query(
      `UPDATE year_level_table 
       SET year_level_description = ?, level_type = ?, ordinal_label = ? 
       WHERE year_level_id = ?`,
      [year_level_description, level_type, ordinal_label || null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Year level not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertYearLevelAuditLog({
      req,
      action: "YEAR_LEVEL_UPDATE",
      message: `${roleLabel} (${actorId}) updated year level ${year_level_description}.`,
    });

    res.json({ message: "Updated successfully" });
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ error: "Update failed" });
  }
});

router.delete("/years_level/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[yearLevel]] = await db3.query(
      "SELECT year_level_description FROM year_level_table WHERE year_level_id = ? LIMIT 1",
      [id]
    );

    const [result] = await db3.query(
      "DELETE FROM year_level_table WHERE year_level_id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Year level not found" });
    }

    const yearLevelLabel = yearLevel?.year_level_description || `year level ID ${id}`;
    const { actorId, roleLabel } = getActorLabel(req);
    await insertYearLevelAuditLog({
      req,
      action: "YEAR_LEVEL_DELETE",
      message: `${roleLabel} (${actorId}) deleted year level ${yearLevelLabel}.`,
    });

    res.json({ message: "Deleted successfully" });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

module.exports = router;
