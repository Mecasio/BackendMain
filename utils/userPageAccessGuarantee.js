const { db3 } = require("../routes/database/database");

const USER_PAGE_ACCESS_PAGE_ID = 69;
const ALWAYS_USER_PAGE_ACCESS_ROLES = ["superadmin", "technical"];

const normalizeRole = (role) => String(role || "").trim().toLowerCase();

const isGuaranteedUserPageAccessRole = (role) =>
  ALWAYS_USER_PAGE_ACCESS_ROLES.includes(normalizeRole(role));

const getAccountRoleByEmployeeId = async (employeeId) => {
  const [rows] = await db3.query(
    "SELECT role FROM user_accounts WHERE employee_id = ? LIMIT 1",
    [employeeId],
  );
  return normalizeRole(rows[0]?.role);
};

const hasGuaranteedUserPageAccess = async (employeeId) => {
  const role = await getAccountRoleByEmployeeId(employeeId);
  return isGuaranteedUserPageAccessRole(role);
};

const guaranteedUserPageAccessRow = (employeeId) => ({
  user_id: employeeId,
  page_id: USER_PAGE_ACCESS_PAGE_ID,
  page_privilege: 1,
  can_create: 1,
  can_edit: 1,
  can_delete: 1,
});

const ensureGuaranteedUserPageAccess = async (employeeId, db = db3) => {
  if (!employeeId) return false;
  if (!(await hasGuaranteedUserPageAccess(employeeId))) return false;

  const [existing] = await db.query(
    "SELECT id FROM page_access WHERE user_id = ? AND page_id = ? LIMIT 1",
    [employeeId, USER_PAGE_ACCESS_PAGE_ID],
  );

  if (existing.length > 0) {
    await db.query(
      `UPDATE page_access
       SET page_privilege = 1, can_create = 1, can_edit = 1, can_delete = 1
       WHERE user_id = ? AND page_id = ?`,
      [employeeId, USER_PAGE_ACCESS_PAGE_ID],
    );
  } else {
    await db.query(
      `INSERT INTO page_access (user_id, page_id, page_privilege, can_create, can_edit, can_delete)
       VALUES (?, ?, 1, 1, 1, 1)`,
      [employeeId, USER_PAGE_ACCESS_PAGE_ID],
    );
  }

  return true;
};

const mergeGuaranteedUserPageAccess = (rows, employeeId, hasGuarantee) => {
  if (!hasGuarantee) return rows;

  const list = Array.isArray(rows) ? [...rows] : [];
  const index = list.findIndex(
    (row) => Number(row.page_id) === USER_PAGE_ACCESS_PAGE_ID,
  );
  const guaranteed = guaranteedUserPageAccessRow(employeeId);

  if (index >= 0) {
    list[index] = { ...list[index], ...guaranteed };
  } else {
    list.push(guaranteed);
  }

  return list;
};

module.exports = {
  USER_PAGE_ACCESS_PAGE_ID,
  ALWAYS_USER_PAGE_ACCESS_ROLES,
  isGuaranteedUserPageAccessRole,
  getAccountRoleByEmployeeId,
  hasGuaranteedUserPageAccess,
  ensureGuaranteedUserPageAccess,
  mergeGuaranteedUserPageAccess,
  guaranteedUserPageAccessRow,
};
