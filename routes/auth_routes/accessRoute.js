const express = require('express');
const {
  db3,
  ensurePageAccessPermissionColumns,
} = require('../database/database');
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const {
  CanCreate,
  CanEdit,
} = require("../../middleware/pagePermissions");

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    await ensurePageAccessPermissionColumns();
    next();
  } catch (err) {
    console.error("Failed to prepare page_access permission columns:", err);
    res.status(500).json({ error: "Failed to prepare page access permissions" });
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

const insertAccessAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

const normalizeAccessPermissions = (accessPage) => {
  if (!Array.isArray(accessPage)) return null;

  return accessPage
    .map((entry) => {
      if (typeof entry === "number" || typeof entry === "string") {
        const pageId = Number(entry);
        return Number.isInteger(pageId)
          ? {
            page_id: pageId,
            page_privilege: 1,
            can_create: 0,
            can_edit: 0,
            can_delete: 0,
          }
          : null;
      }

      if (!entry || typeof entry !== "object") return null;

      const pageId = Number(entry.page_id ?? entry.pageId ?? entry.id);
      if (!Number.isInteger(pageId)) return null;

      return {
        page_id: pageId,
        page_privilege: Number(entry.page_privilege ?? entry.access ?? 1) === 1 ? 1 : 0,
        can_create: Number(entry.can_create) === 1 ? 1 : 0,
        can_edit: Number(entry.can_edit) === 1 ? 1 : 0,
        can_delete: Number(entry.can_delete) === 1 ? 1 : 0,
      };
    })
    .filter(Boolean);
};

router.post("/access", CanCreate, async (req, res) => {
  const { access_description, access_page } = req.body;
  const normalizedPermissions = normalizeAccessPermissions(access_page);

  if (!access_description || !normalizedPermissions) {
    return res
      .status(400)
      .json({ error: "access_description and access_page are required" });
  }

  try {

    await db3.query(
      "INSERT INTO access_table (access_description, access_page) VALUES (?, ?)",
      [access_description, JSON.stringify(normalizedPermissions)]
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertAccessAuditLog({
      req,
      action: "ACCESS_LEVEL_CREATE",
      message: `${roleLabel} (${actorId}) created access level ${access_description}.`,
    });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save access" });
  }

});

router.get("/access_table", async (req, res) => {
  try {
    const [rows] = await db3.query(
      "SELECT access_id, access_description, access_page FROM access_table ORDER BY access_id ASC"
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch access levels" });
  }
});

router.get("/access_level/:employee_id", async (req, res) => {
  try {
    const { employee_id } = req.params;
    const [rows] = await db3.query(
      `SELECT ua.access_level, at.access_description
       FROM user_accounts ua
       LEFT JOIN access_table at ON ua.access_level = at.access_id
       WHERE ua.employee_id = ?
       LIMIT 1`,
      [employee_id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Employee not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch access level" });
  }
});

router.put("/access/:access_id", CanEdit, async (req, res) => {
  const { access_id } = req.params;
  const { access_description, access_page } = req.body;
  const normalizedPermissions = normalizeAccessPermissions(access_page);

  if (!access_description || !normalizedPermissions) {
    return res
      .status(400)
      .json({ error: "access_description and access_page are required" });
  }

  let conn;
  let committed = false;

  try {
    conn = await db3.getConnection();
    await conn.beginTransaction();

    const [result] = await conn.query(
      "UPDATE access_table SET access_description = ?, access_page = ? WHERE access_id = ?",
      [access_description, JSON.stringify(normalizedPermissions), access_id]
    );

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ error: "Access level not found" });
    }

    const [assignedUsers] = await conn.query(
      "SELECT employee_id FROM user_accounts WHERE access_level = ?",
      [access_id]
    );

    const employeeIds = assignedUsers
      .map((user) => user.employee_id)
      .filter(Boolean);

    if (employeeIds.length > 0) {
      await conn.query("DELETE FROM page_access WHERE user_id IN (?)", [
        employeeIds,
      ]);

      const pagePermissions = normalizedPermissions.filter(
        (permission) => Number(permission.page_privilege ?? permission.access ?? 1) === 1
      );

      if (pagePermissions.length > 0) {
        const values = employeeIds.flatMap((employeeId) =>
          pagePermissions.map((permission) => [
            Number(permission.page_privilege ?? 1),
            Number(permission.page_id),
            employeeId,
            permission.can_create ? 1 : 0,
            permission.can_edit ? 1 : 0,
            permission.can_delete ? 1 : 0,
          ])
        );

        await conn.query(
          `INSERT INTO page_access
           (page_privilege, page_id, user_id, can_create, can_edit, can_delete)
           VALUES ?`,
          [values]
        );
      }
    }

    await conn.commit();
    committed = true;

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertAccessAuditLog({
      req,
      action: "ACCESS_LEVEL_UPDATE",
      message: `${roleLabel} (${actorId}) updated access level ${access_description}.`,
    });

    res.json({ success: true });
  } catch (err) {
    if (conn && !committed) await conn.rollback();
    console.error(err);
    res.status(500).json({ error: "Failed to update access level" });
  } finally {
    if (conn) conn.release();
  }
});


module.exports = router;
