const {
  db3,
  ensurePageAccessPermissionColumns,
} = require("../routes/database/database");
const {
  USER_PAGE_ACCESS_PAGE_ID,
  hasGuaranteedUserPageAccess,
} = require("../utils/userPageAccessGuarantee");

const createPermissionMiddleware = (permissionKey, actionLabel) => {
  return async (req, res, next) => {
    const employeeId = req.headers["x-employee-id"];
    const pageId = req.headers["x-page-id"];

    if (!employeeId || !pageId) {
      return res.status(400).json({
        success: false,
        message: "Employee ID and page ID are required",
      });
    }

    try {
      if (
        Number(pageId) === USER_PAGE_ACCESS_PAGE_ID &&
        (await hasGuaranteedUserPageAccess(employeeId))
      ) {
        req.pageAccess = {
          page_privilege: 1,
          can_create: 1,
          can_edit: 1,
          can_delete: 1,
        };
        return next();
      }

      await ensurePageAccessPermissionColumns();

      const [rows] = await db3.query(
        `SELECT page_privilege, can_create, can_delete, can_edit
         FROM page_access
         WHERE user_id = ? AND page_id = ?
         LIMIT 1`,
        [employeeId, pageId],
      );

      if (rows.length === 0 || Number(rows[0].page_privilege) !== 1) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this page",
        });
      }

      if (Number(rows[0][permissionKey]) !== 1) {
        return res.status(403).json({
          success: false,
          message: `You do not have permission to ${actionLabel}`,
        });
      }

      req.pageAccess = rows[0];
      next();
    } catch (error) {
      console.error(`Permission check failed for ${actionLabel}:`, error);
      res.status(500).json({
        success: false,
        message: "Failed to validate page permissions",
      });
    }
  };
};

const CanCreate = createPermissionMiddleware("can_create", "create items on this page");
const CanDelete = createPermissionMiddleware("can_delete", "delete this item");
const CanEdit = createPermissionMiddleware("can_edit", "edit this item");

const CanManageUserPagePermissions = async (req, res, next) => {
  const employeeId = req.headers["x-employee-id"];
  const pageId = req.headers["x-page-id"];
  const permission = req.body?.permission;

    if (!employeeId || !pageId) {
      return res.status(400).json({
        success: false,
        message: "Employee ID and page ID are required",
      });
    }

    try {
      if (
        Number(pageId) === USER_PAGE_ACCESS_PAGE_ID &&
        (await hasGuaranteedUserPageAccess(employeeId))
      ) {
        req.pageAccess = {
          page_privilege: 1,
          can_create: 1,
          can_edit: 1,
          can_delete: 1,
        };
        return next();
      }

      await ensurePageAccessPermissionColumns();

    const [rows] = await db3.query(
      `SELECT page_privilege, can_create, can_delete, can_edit
       FROM page_access
       WHERE user_id = ? AND page_id = ?
       LIMIT 1`,
      [employeeId, pageId],
    );

    if (rows.length === 0 || Number(rows[0].page_privilege) !== 1) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this page",
      });
    }

    const access = rows[0];
    const hasEdit = Number(access.can_edit) === 1;
    const hasCreate = Number(access.can_create) === 1;
    const hasDelete = Number(access.can_delete) === 1;

    let allowed = hasEdit;

    if (!allowed && permission === "can_create" && hasCreate) {
      allowed = true;
    }

    if (!allowed && permission === "can_delete" && hasDelete) {
      allowed = true;
    }

    if (!allowed && !permission && (hasEdit || hasCreate || hasDelete)) {
      allowed = true;
    }

    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to manage user page permissions",
      });
    }

    req.pageAccess = access;
    next();
  } catch (error) {
    console.error("Permission check failed for user page permission management:", error);
    res.status(500).json({
      success: false,
      message: "Failed to validate page permissions",
    });
  }
};

module.exports = {
  CanCreate,
  CanDelete,
  CanEdit,
  CanManageUserPagePermissions,
};
  
