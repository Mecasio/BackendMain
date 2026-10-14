const express = require("express");
const path = require("path");
const fs = require("fs");
const {
  db,
  db3,
  ensurePageAccessPermissionColumns,
} = require("../database/database");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const {
  getScopesForEmployees,
  buildEmployeeScopePayload,
  ensureRegistrarScopeTable,
  formatScopesSummary,
} = require("../../utils/registrarScopeService");
const {
  CanCreate,
  CanDelete,
  CanEdit,
  CanManageUserPagePermissions,
} = require("../../middleware/pagePermissions");
const {
  notifyPageAccessGranted,
  notifyPageAccessRevoked,
  notifyPageAccessChanged,
} = require("../../socket/socketService");
const {
  USER_PAGE_ACCESS_PAGE_ID,
  hasGuaranteedUserPageAccess,
  ensureGuaranteedUserPageAccess,
  mergeGuaranteedUserPageAccess,
  guaranteedUserPageAccessRow,
} = require("../../utils/userPageAccessGuarantee");

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

const insertAccountManagementAuditLog = async ({
  req,
  action,
  message,
  severity = "INFO",
}) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity,
    message,
  });
};

const getPageLabel = async (pageId) => {
  try {
    const [rows] = await db3.query(
      "SELECT id, page_description FROM page_table WHERE id = ? LIMIT 1",
      [pageId],
    );
    const page = rows?.[0];
    if (!page) return `Page ${pageId}`;
    return `${page.id} - ${page.page_description}`;
  } catch (err) {
    console.error("Page audit label lookup failed:", err);
    return `Page ${pageId}`;
  }
};

const normalizePageIds = (pageIds) => {
  if (!Array.isArray(pageIds)) return null;
  return [
    ...new Set(
      pageIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
};

const formatPageScopeLabel = (pageIds, pageGroup) => {
  const groupLabel = String(pageGroup || "").trim();
  if (groupLabel) return groupLabel;
  if (Array.isArray(pageIds) && pageIds.length > 0) {
    return `${pageIds.length} selected page${pageIds.length === 1 ? "" : "s"}`;
  }
  return "all pages";
};

router.post("/pages", CanCreate, async (req, res) => {
  const { id, page_description, page_group } = req.body;

  try {
    // Check duplicate ID
    const [exists] = await db3.query("SELECT id FROM page_table WHERE id = ?", [
      id,
    ]);

    if (exists.length > 0) {
      return res.status(400).json({ error: "ID already exists" });
    }

    // Insert page
    await db3.query(
      "INSERT INTO page_table (id, page_description, page_group) VALUES (?, ?, ?)",
      [id, page_description, page_group],
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertAccountManagementAuditLog({
      req,
      action: "PAGE_CREATE",
      message: `${roleLabel} (${actorId}) created page ${id} - ${page_description}.`,
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error adding page:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/pages", async (req, res) => {
  try {
    const [rows] = await db3.query(
      `SELECT * FROM page_table ORDER BY created_at DESC`,
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching pages:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.put("/pages/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { page_description, page_group } = req.body;

  try {
    const [result] = await db3.query(
      `UPDATE page_table SET page_description = ?, page_group = ? WHERE id = ?`,
      [page_description, page_group, id],
    );

    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      await insertAccountManagementAuditLog({
        req,
        action: "PAGE_UPDATE",
        message: `${roleLabel} (${actorId}) updated page ${id} - ${page_description}.`,
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating page:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.delete("/pages/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const pageLabel = await getPageLabel(id);
    const [result] = await db3.query(`DELETE FROM page_table WHERE id = ?`, [id]);
    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      await insertAccountManagementAuditLog({
        req,
        action: "PAGE_DELETE",
        severity: "WARN",
        message: `${roleLabel} (${actorId}) deleted page ${pageLabel}.`,
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting page:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ✅ Get all access for one user
router.get("/page_access/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    await ensureGuaranteedUserPageAccess(userId);
    const [rows] = await db3.query(
      "SELECT * FROM page_access WHERE user_id = ?",
      [userId],
    );
    const hasGuarantee = await hasGuaranteedUserPageAccess(userId);
    res.json(mergeGuaranteedUserPageAccess(rows, userId, hasGuarantee));
  } catch (err) {
    console.error("Error fetching access:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/page_access/:userId/:pageId", CanCreate, async (req, res) => {
  const { userId, pageId } = req.params;

  try {
    const [existing] = await db3.query(
      "SELECT id FROM page_access WHERE user_id = ? AND page_id = ? LIMIT 1",
      [userId, pageId],
    );

    if (existing.length > 0) {
      await db3.query(
        `UPDATE page_access
         SET page_privilege = 1, can_create = 0, can_edit = 0, can_delete = 0
         WHERE user_id = ? AND page_id = ?`,
        [userId, pageId],
      );
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      const pageLabel = await getPageLabel(pageId);
      await insertAccountManagementAuditLog({
        req,
        action: "USER_PAGE_ACCESS_GRANT",
        message: `${roleLabel} (${actorId}) granted page access ${pageLabel} to User (${userId}).`,
      });
      notifyPageAccessGranted(userId, {
        page_id: pageId,
        page_name: pageLabel,
      });
      await ensureGuaranteedUserPageAccess(userId);
      return res.json({ success: true, action: "updated" });
    }

    await db3.query(
      `INSERT INTO page_access (user_id, page_id, page_privilege, can_create, can_edit, can_delete)
       VALUES (?, ?, 1, 0, 0, 0)`,
      [userId, pageId],
    );

    // ✅ If query succeeded (affected rows > 0)
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const pageLabel = await getPageLabel(pageId);
    await insertAccountManagementAuditLog({
      req,
      action: "USER_PAGE_ACCESS_GRANT",
      message: `${roleLabel} (${actorId}) granted page access ${pageLabel} to User (${userId}).`,
    });

    notifyPageAccessGranted(userId, {
      page_id: pageId,
      page_name: pageLabel,
    });

    await ensureGuaranteedUserPageAccess(userId);
    res.json({ success: true, action: "inserted" });
  } catch (err) {
    console.error("Error inserting access:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/access-level/bulk-permission-audit", async (req, res) => {
  const {
    modal_context,
    permission,
    enabled,
    access_id,
    access_description,
    affected_count,
  } = req.body;
  const allowedPermissions = ["can_create", "can_edit", "can_delete"];
  const allowedContexts = ["create_access", "edit_access_level"];

  if (!allowedPermissions.includes(permission)) {
    return res.status(400).json({ error: "Invalid permission" });
  }

  if (!allowedContexts.includes(modal_context)) {
    return res.status(400).json({ error: "Invalid modal context" });
  }

  try {
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const actionLabel = permission.replace("can_", "").toUpperCase();
    const contextLabel =
      modal_context === "create_access"
        ? "Create Access modal"
        : `Edit Access Level modal${access_id ? ` for access level ${access_id}` : ""}`;
    const descriptionLabel = access_description
      ? ` (${access_description})`
      : "";

    await insertAccountManagementAuditLog({
      req,
      action: Number(enabled) === 1
        ? `ACCESS_LEVEL_${actionLabel}_GRANT_ALL_CLICK`
        : `ACCESS_LEVEL_${actionLabel}_CLOSE_ALL_CLICK`,
      severity: Number(enabled) === 1 ? "INFO" : "WARN",
      message: `${roleLabel} (${actorId}) clicked ${Number(enabled) === 1 ? "Grant All" : "Close All"} ${actionLabel.toLowerCase()} in ${contextLabel}${descriptionLabel}. Affected page count: ${Number(affected_count || 0)}.`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error inserting access level bulk permission audit:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.put("/page_access/:userId/bulk-permission", CanManageUserPagePermissions, async (req, res) => {
  const { userId } = req.params;
  const { permission, enabled, pageIds: rawPageIds, pageGroup } = req.body;
  const allowedPermissions = ["can_create", "can_edit", "can_delete"];

  if (!allowedPermissions.includes(permission)) {
    return res.status(400).json({ error: "Invalid permission" });
  }

  const pageIds = normalizePageIds(rawPageIds);
  if (Array.isArray(pageIds) && pageIds.length === 0) {
    return res.json({ success: true, affected: 0 });
  }

  let conn;

  try {
    conn = await db3.getConnection();
    await conn.beginTransaction();

    const permissionValue = Number(enabled) === 1 ? 1 : 0;
    const scopeSql = pageIds
      ? `UPDATE page_access
         SET ${permission} = ?
         WHERE user_id = ? AND page_privilege = 1 AND page_id IN (?)`
      : `UPDATE page_access
         SET ${permission} = ?
         WHERE user_id = ? AND page_privilege = 1`;
    const scopeParams = pageIds
      ? [permissionValue, userId, pageIds]
      : [permissionValue, userId];

    await conn.query(scopeSql, scopeParams);

    await conn.commit();

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const actionLabel = permission.replace("can_", "").toUpperCase();
    const scopeLabel = formatPageScopeLabel(pageIds, pageGroup);
    await insertAccountManagementAuditLog({
      req,
      action: Number(enabled) === 1
        ? `USER_PAGE_${actionLabel}_GRANT_ALL`
        : `USER_PAGE_${actionLabel}_CLOSE_ALL`,
      severity: Number(enabled) === 1 ? "INFO" : "WARN",
      message: `${roleLabel} (${actorId}) ${Number(enabled) === 1 ? "granted" : "closed"} ${actionLabel.toLowerCase()} permissions in ${scopeLabel} for User (${userId}).`,
    });

    notifyPageAccessChanged(
      userId,
      Number(enabled) === 1 ? "granted" : "revoked",
      { page_id: pageIds ? pageIds.join(",") : "all", page_name: `${actionLabel} permissions (${scopeLabel})` },
    );

    await ensureGuaranteedUserPageAccess(userId);
    res.json({ success: true });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("Error updating bulk page permission:", err);
    res.status(500).json({ error: "Database error" });
  } finally {
    if (conn) conn.release();
  }
});

router.put("/page_access/:userId/:pageId", CanManageUserPagePermissions, async (req, res) => {
  const { userId, pageId } = req.params;
  const {
    page_privilege = 0,
    can_create = 0,
    can_edit = 0,
    can_delete = 0,
  } = req.body;

  try {
    const [existing] = await db3.query(
      "SELECT id FROM page_access WHERE user_id = ? AND page_id = ? LIMIT 1",
      [userId, pageId],
    );

    if (existing.length > 0) {
      await db3.query(
        `UPDATE page_access
         SET page_privilege = ?, can_create = ?, can_edit = ?, can_delete = ?
         WHERE user_id = ? AND page_id = ?`,
        [
          Number(page_privilege),
          Number(can_create),
          Number(can_edit),
          Number(can_delete),
          userId,
          pageId,
        ],
      );

      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      const pageLabel = await getPageLabel(pageId);
      await insertAccountManagementAuditLog({
        req,
        action: "USER_PAGE_PERMISSION_UPDATE",
        message: `${roleLabel} (${actorId}) updated page permissions ${pageLabel} for User (${userId}).`,
      });

      notifyPageAccessChanged(
        userId,
        Number(page_privilege) === 1 ? "granted" : "revoked",
        { page_id: pageId, page_name: pageLabel },
      );

      await ensureGuaranteedUserPageAccess(userId);
      return res.json({ success: true, action: "updated" });
    }

    await db3.query(
      `INSERT INTO page_access
       (user_id, page_id, page_privilege, can_create, can_edit, can_delete)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        pageId,
        Number(page_privilege),
        Number(can_create),
        Number(can_edit),
        Number(can_delete),
      ],
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const pageLabel = await getPageLabel(pageId);
    await insertAccountManagementAuditLog({
      req,
      action: "USER_PAGE_PERMISSION_UPDATE",
      message: `${roleLabel} (${actorId}) updated page permissions ${pageLabel} for User (${userId}).`,
    });

    notifyPageAccessChanged(
      userId,
      Number(page_privilege) === 1 ? "granted" : "revoked",
      { page_id: pageId, page_name: pageLabel },
    );

    await ensureGuaranteedUserPageAccess(userId);
    res.json({ success: true, action: "inserted" });
  } catch (err) {
    console.error("Error updating access:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.delete("/page_access/:userId/:pageId", CanDelete, async (req, res) => {
  const { userId, pageId } = req.params;
  try {
    const pageLabel = await getPageLabel(pageId);
    const [result] = await db3.query(
      "DELETE FROM page_access WHERE user_id = ? AND page_id = ?",
      [userId, pageId],
    );
    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      await insertAccountManagementAuditLog({
        req,
        action: "USER_PAGE_ACCESS_REVOKE",
        severity: "WARN",
        message: `${roleLabel} (${actorId}) revoked page access ${pageLabel} from User (${userId}).`,
      });
      notifyPageAccessRevoked(userId, {
        page_id: pageId,
        page_name: pageLabel,
      });
    }
    await ensureGuaranteedUserPageAccess(userId);
    res.json({ success: true, action: "deleted" });
  } catch (err) {
    console.error("Error deleting access:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/page_access/:userId/:pageId", async (req, res) => {
  const { userId, pageId } = req.params;
  try {
    if (
      Number(pageId) === USER_PAGE_ACCESS_PAGE_ID &&
      (await hasGuaranteedUserPageAccess(userId))
    ) {
      await ensureGuaranteedUserPageAccess(userId);
      return res.json(guaranteedUserPageAccessRow(userId));
    }

    const [rows] = await db3.query(
      `SELECT
          pa.page_privilege,
          pa.can_create,
          pa.can_edit,
          pa.can_delete,
          at.access_description
       FROM page_access pa
       LEFT JOIN user_accounts ua ON ua.employee_id = pa.user_id
       LEFT JOIN access_table at ON at.access_id = ua.access_level
       WHERE pa.user_id = ? AND pa.page_id = ?`,
      [userId, pageId],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "The user has not been given a privilege to access this page.",
        hasAccess: false,
      });
    }

    res.json(rows[0]);
    console.log(rows[0]);
  } catch (err) {
    console.error("Error checking access:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/page_access/grant-all", CanCreate, async (req, res) => {
  const { userId, pageIds: rawPageIds, pageGroup } = req.body;
  const pageIds = normalizePageIds(rawPageIds);

  try {
    let pages;
    if (pageIds) {
      if (pageIds.length === 0) {
        return res.json({ success: true, affected: 0 });
      }
      pages = pageIds.map((id) => ({ id }));
    } else {
      [pages] = await db3.query("SELECT id FROM page_table");
    }

    if (!pages.length) {
      return res.json({ success: true });
    }

    for (const page of pages) {
      const [existing] = await db3.query(
        "SELECT id FROM page_access WHERE user_id = ? AND page_id = ? LIMIT 1",
        [userId, page.id],
      );

      if (existing.length > 0) {
        await db3.query(
          `UPDATE page_access
           SET page_privilege = 1, can_create = 0, can_edit = 0, can_delete = 0
           WHERE user_id = ? AND page_id = ?`,
          [userId, page.id],
        );
      } else {
        await db3.query(
          `INSERT INTO page_access
           (user_id, page_id, page_privilege, can_create, can_edit, can_delete)
           VALUES (?, ?, 1, 0, 0, 0)`,
          [userId, page.id],
        );
      }
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const scopeLabel = formatPageScopeLabel(pageIds, pageGroup);
    await insertAccountManagementAuditLog({
      req,
      action: "USER_PAGE_ACCESS_GRANT_ALL",
      message: `${roleLabel} (${actorId}) granted page access in ${scopeLabel} to User (${userId}).`,
    });

    notifyPageAccessGranted(userId, {
      page_id: pageIds ? pageIds.join(",") : "all",
      page_name: scopeLabel,
    });

    await ensureGuaranteedUserPageAccess(userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/page_access/revoke-all", CanDelete, async (req, res) => {
  const { userId, pageIds: rawPageIds, pageGroup } = req.body;
  const pageIds = normalizePageIds(rawPageIds);

  try {
    if (pageIds) {
      if (pageIds.length === 0) {
        return res.json({ success: true, affected: 0 });
      }
      await db3.query(
        "DELETE FROM page_access WHERE user_id = ? AND page_id IN (?)",
        [userId, pageIds],
      );
    } else {
      await db3.query(
        "DELETE FROM page_access WHERE user_id = ?",
        [userId],
      );
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const scopeLabel = formatPageScopeLabel(pageIds, pageGroup);
    await insertAccountManagementAuditLog({
      req,
      action: "USER_PAGE_ACCESS_REVOKE_ALL",
      severity: "WARN",
      message: `${roleLabel} (${actorId}) revoked page access in ${scopeLabel} from User (${userId}).`,
    });

    notifyPageAccessRevoked(userId, {
      page_id: pageIds ? pageIds.join(",") : "all",
      page_name: scopeLabel,
    });

    await ensureGuaranteedUserPageAccess(userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});


router.get("/registrars", async (req, res) => {
  try {
    const sql = `
      SELECT
        ua.id,
        ua.employee_id,
        ua.profile_picture,
        ua.first_name,
        ua.middle_name,
        ua.last_name,
        ua.email,
        ua.access_level,
        ua.dprtmnt_id,
        at.access_description,
        ua.role,
        ua.status,
        d.dprtmnt_name,
        d.dprtmnt_code
      FROM user_accounts ua
      INNER JOIN access_table at ON ua.access_level = at.access_id
      LEFT JOIN dprtmnt_table d ON ua.dprtmnt_id = d.dprtmnt_id
      WHERE ua.role IN ('administrator', 'superadmin', 'technical')
      ORDER BY ua.id DESC;
    `;

    const [results] = await db3.query(sql);
    const scopeMap = await getScopesForEmployees(
      results.map((row) => row.employee_id),
    );

    const enriched = await Promise.all(
      results.map(async (row) => {
        const scopes = scopeMap.get(String(row.employee_id)) || [];
        const scopePayload = await buildEmployeeScopePayload(row.employee_id, row);
        const primaryScope = scopes[0];

        return {
          ...row,
          scopes,
          scopes_summary: formatScopesSummary(scopes),
          dprtmnt_id: scopePayload.dprtmnt_id ?? row.dprtmnt_id ?? null,
          curriculum_id: scopePayload.curriculum_id ?? null,
          dprtmnt_name: primaryScope?.dprtmnt_name || row.dprtmnt_name || null,
          dprtmnt_code: primaryScope?.dprtmnt_code || row.dprtmnt_code || null,
          program_code:
            scopes.length === 1 ? primaryScope?.program_code || null : null,
          program_description:
            scopes.length === 1
              ? primaryScope?.program_description || null
              : null,
          major: scopes.length === 1 ? primaryScope?.major || null : null,
          program_id: scopes.length === 1 ? primaryScope?.program_id || null : null,
        };
      }),
    );

    res.json(enriched);
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: "Server error" });
  }
});


router.put("/update_registrar_status/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const [registrarRows] = await db3.query(
      "SELECT id, employee_id, first_name, middle_name, last_name, email FROM user_accounts WHERE id = ? LIMIT 1",
      [id],
    );
    const [result] = await db3.query("UPDATE user_accounts SET status=? WHERE id=?", [
      Number(status),
      id,
    ]);
    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      const registrar = registrarRows?.[0] || {};
      const registrarLabel =
        registrar.employee_id ||
        [registrar.last_name, registrar.first_name, registrar.middle_name]
          .filter(Boolean)
          .join(", ") ||
        registrar.email ||
        `id ${id}`;
      await insertAccountManagementAuditLog({
        req,
        action: "REGISTRAR_ACCOUNT_STATUS_UPDATE",
        message: `${roleLabel} (${actorId}) set registrar account ${registrarLabel} to ${Number(status) === 1 ? "Active" : "Inactive"}.`,
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

router.get("/employee/:employee_id", async (req, res) => {
  try {
    const { employee_id } = req.params;
    await ensureRegistrarScopeTable();

    const [[userAccount]] = await db3.query(
      `SELECT employee_id, dprtmnt_id
       FROM user_accounts
       WHERE employee_id = ?
       LIMIT 1`,
      [employee_id],
    );

    if (!userAccount) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    // get all page_ids assigned to this employee
    const [rows] = await db3.query(
      "SELECT page_id FROM page_access WHERE user_id = ?",
      [employee_id],
    );

    const accessList = rows.map((r) => r.page_id);
    const scopePayload = await buildEmployeeScopePayload(
      userAccount.employee_id,
      userAccount,
    );

    res.json({
      success: true,
      accessList,
      employee_id: userAccount.employee_id,
      dprtmnt_id: scopePayload.dprtmnt_id ?? userAccount.dprtmnt_id ?? null,
      dprtmnt_ids: scopePayload.dprtmnt_ids,
      curriculum_id: scopePayload.curriculum_id ?? null,
      scopes: scopePayload.scopes,
      allowed_curriculum_ids: scopePayload.allowed_curriculum_ids,
    });
  } catch (err) {
    console.error("Error fetching employee access:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
