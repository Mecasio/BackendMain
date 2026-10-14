const express = require("express");
const { db3 } = require("../database/database");
const { CanCreate, CanEdit, CanDelete } = require("../../middleware/pagePermissions");
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

const logTypeAudit = async (req, action, buildMessage) => {
  const { actorId, actorRole } = resolveAuditActor(req);
  const roleLabel = formatAuditActorRole(actorRole);
  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message: buildMessage(roleLabel, actorId),
  });
};

/**
 * Registers GET/POST/PUT/DELETE routes for a simple "type" lookup table
 * (subject_type_table, category_type_table, ...). Both tables share the
 * same shape: an id column, a unique name column, and an is_default flag
 * that protects the seeded defaults (Regular, Major, ACADEMIC, ...) from
 * being deleted out from under everyone.
 */
const createTypeRouter = ({
  routeBase,     // e.g. "subject-types"
  table,         // e.g. "subject_type_table"
  idColumn,      // e.g. "subject_type_id"
  nameColumn,    // e.g. "subject_type_name"
  auditLabel,    // e.g. "Subject Type"
  actionPrefix,  // e.g. "SUBJECT_TYPE"
}) => {
  // ------------------------------------------------------------------
  // LIST — anyone with page access can read the options
  // ------------------------------------------------------------------
  router.get(`/${routeBase}`, async (req, res) => {
    try {
      const [rows] = await db3.query(
        `SELECT * FROM ${table} ORDER BY is_default DESC, ${nameColumn} ASC`
      );
      res.status(200).json(rows);
    } catch (err) {
      console.error(`Error fetching ${table}:`, err);
      res.status(500).json({ message: `Failed to fetch ${auditLabel.toLowerCase()}s` });
    }
  });

  // ------------------------------------------------------------------
  // CREATE — "[New Subject Type]" / "[New Category Type]"
  // ------------------------------------------------------------------
  router.post(`/${routeBase}`, CanCreate, async (req, res) => {
    const rawName = String(req.body?.name || "").trim();
    if (!rawName) {
      return res.status(400).json({ message: `${auditLabel} name is required` });
    }

    try {
      const [existing] = await db3.query(
        `SELECT ${idColumn} FROM ${table} WHERE LOWER(${nameColumn}) = LOWER(?)`,
        [rawName]
      );
      if (existing.length > 0) {
        return res.status(400).json({ message: `${auditLabel} already exists` });
      }

      const [result] = await db3.query(
        `INSERT INTO ${table} (${nameColumn}, is_default) VALUES (?, 0)`,
        [rawName]
      );

      await logTypeAudit(req, `${actionPrefix}_CREATE`, (roleLabel, actorId) =>
        `${roleLabel} (${actorId}) added a new ${auditLabel.toLowerCase()}: "${rawName}".`
      );

      res.status(200).json({
        message: `✅ ${auditLabel} added successfully`,
        [idColumn]: result.insertId,
        [nameColumn]: rawName,
      });
    } catch (err) {
      console.error(`Error creating ${table} entry:`, err);
      res.status(500).json({ message: `Failed to add ${auditLabel.toLowerCase()}` });
    }
  });

  // ------------------------------------------------------------------
  // UPDATE — "[Edit Subject Type]" / "[Edit Category Type]"
  // ------------------------------------------------------------------
  router.put(`/${routeBase}/:id`, CanEdit, async (req, res) => {
    const { id } = req.params;
    const rawName = String(req.body?.name || "").trim();
    if (!rawName) {
      return res.status(400).json({ message: `${auditLabel} name is required` });
    }

    try {
      const [rows] = await db3.query(`SELECT * FROM ${table} WHERE ${idColumn} = ?`, [id]);
      const current = rows[0];
      if (!current) {
        return res.status(404).json({ message: `${auditLabel} not found` });
      }

      const [dupe] = await db3.query(
        `SELECT ${idColumn} FROM ${table} WHERE LOWER(${nameColumn}) = LOWER(?) AND ${idColumn} != ?`,
        [rawName, id]
      );
      if (dupe.length > 0) {
        return res.status(400).json({ message: `${auditLabel} already exists` });
      }

      await db3.query(`UPDATE ${table} SET ${nameColumn} = ? WHERE ${idColumn} = ?`, [rawName, id]);

      await logTypeAudit(req, `${actionPrefix}_UPDATE`, (roleLabel, actorId) =>
        `${roleLabel} (${actorId}) renamed ${auditLabel.toLowerCase()} "${current[nameColumn]}" to "${rawName}".`
      );

      res.status(200).json({ message: `✅ ${auditLabel} updated successfully` });
    } catch (err) {
      console.error(`Error updating ${table} entry:`, err);
      res.status(500).json({ message: `Failed to update ${auditLabel.toLowerCase()}` });
    }
  });

  // ------------------------------------------------------------------
  // DELETE — "[Delete Subject Type]" / "[Delete Category Type]"
  // Defaults (Regular, Major, ACADEMIC, ...) are protected from deletion
  // so the base list always stays intact. Remove this guard if you'd
  // rather let admins delete anything.
  // ------------------------------------------------------------------
  router.delete(`/${routeBase}/:id`, CanDelete, async (req, res) => {
    const { id } = req.params;

    try {
      const [rows] = await db3.query(`SELECT * FROM ${table} WHERE ${idColumn} = ?`, [id]);
      const current = rows[0];
      if (!current) {
        return res.status(404).json({ message: `${auditLabel} not found` });
      }

      if (Number(current.is_default) === 1) {
        return res.status(400).json({
          message: `"${current[nameColumn]}" is a default ${auditLabel.toLowerCase()} and cannot be deleted`,
        });
      }

      await db3.query(`DELETE FROM ${table} WHERE ${idColumn} = ?`, [id]);

      await logTypeAudit(req, `${actionPrefix}_DELETE`, (roleLabel, actorId) =>
        `${roleLabel} (${actorId}) deleted ${auditLabel.toLowerCase()} "${current[nameColumn]}".`
      );

      res.status(200).json({ message: `✅ ${auditLabel} deleted successfully` });
    } catch (err) {
      console.error(`Error deleting ${table} entry:`, err);
      if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
        return res.status(400).json({
          message: `This ${auditLabel.toLowerCase()} is currently used by one or more courses and cannot be deleted`,
        });
      }
      res.status(500).json({ message: `Failed to delete ${auditLabel.toLowerCase()}` });
    }
  });
};

createTypeRouter({
  routeBase: "subject-types",
  table: "subject_type_table",
  idColumn: "subject_type_id",
  nameColumn: "subject_type_name",
  auditLabel: "Subject Type",
  actionPrefix: "SUBJECT_TYPE",
});

createTypeRouter({
  routeBase: "category-types",
  table: "category_type_table",
  idColumn: "category_type_id",
  nameColumn: "category_type_name",
  auditLabel: "Category",
  actionPrefix: "CATEGORY_TYPE",
});

module.exports = router;
