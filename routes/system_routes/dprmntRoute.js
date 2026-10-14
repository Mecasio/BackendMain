const express = require("express");
const { db3 } = require("../database/database");
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const router = express.Router();

let isAllowedColumnReady = false;

const ensureDepartmentIsAllowedColumn = async () => {
  if (isAllowedColumnReady) return;

  try {
    await db3.query(`
      ALTER TABLE dprtmnt_table
      ADD COLUMN is_allowed tinyint(1) NOT NULL DEFAULT 1
    `);
  } catch (err) {
    if (err?.code !== "ER_DUP_FIELDNAME") {
      throw err;
    }
  }

  isAllowedColumnReady = true;
};

const ensureDepatmentGrantTableExisted = async () => {
  try{
    await db3.query(`
      CREATE TABLE IF NOT EXISTS dprtmnt_grant_table (
        id INT AUTO_INCREMENT PRIMARY KEY,
        request_dept_id TINYINT(1) NOT NULL DEFAULT 0,
        requesting_dept_id TINYINT(1) NOT NULL DEFAULT 0,
        active_school_year_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_request_grant (request_dept_id, requesting_dept_id, active_school_year_id)
      )
    `);
  } catch (err) {
    console.error("Error creating table:", err);
  }
};

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const formatActorPersonName = (row = {}) => {
  const lastName = String(row.last_name || "").trim();
  const firstName = String(row.first_name || "").trim();
  const middleName = String(row.middle_name || "").trim();
  const middleInitial = middleName
    ? ` ${middleName.charAt(0).toUpperCase()}.`
    : "";

  if (!lastName && !firstName) {
    return String(row.email || "").trim();
  }

  if (!lastName) {
    return `${firstName}${middleInitial}`.trim();
  }

  return `${lastName}, ${firstName}${middleInitial}`.trim();
};

const getAuditActor = resolveAuditActor;

const getActorAuditLabel = async (req) => {
  const { actorId, actorRole } = getAuditActor(req);
  const roleLabel = formatAuditActorRole(actorRole);

  try {
    const [rows] = await db3.query(
      `SELECT ua.employee_id, ua.first_name, ua.middle_name, ua.last_name, ua.email,
              at.access_description
       FROM user_accounts ua
       LEFT JOIN access_table at ON at.access_id = ua.access_level
       WHERE ua.employee_id = ?
          OR ua.person_id = ?
          OR ua.email = ?
       LIMIT 1`,
      [actorId, actorId, actorId],
    );

    if (rows?.[0]) {
      const accessLabel = String(rows[0].access_description || "").trim();
      const personName = formatActorPersonName(rows[0]);
      const employeeId = rows[0].employee_id || actorId;

      if (personName) {
        return `${accessLabel || roleLabel} ${personName} (${employeeId})`;
      }

      return `${accessLabel || roleLabel} (${employeeId})`;
    }
  } catch (err) {
    console.error("Department actor audit lookup failed:", err);
  }

  return `${roleLabel} (${actorId})`;
};

const insertDepartmentAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    message,
    severity: "INFO",
  });
};

// -------------------- CREATE DEPARTMENT --------------------
router.post("/department", CanCreate, async (req, res) => {
  const { dep_name, dep_code, dept_number, components } = req.body;

  if (!dep_name || !dep_code || !dept_number || !components) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const normalized_code = dep_code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

 // Check duplicate department code
const [rows] = await db3.query(
  "SELECT dprtmnt_id FROM dprtmnt_table WHERE dprtmnt_code = ?",
  [normalized_code]
);

if (rows.length > 0) {
  return res.status(400).json({
    message: "Department code already exists",
  });
}

// Check duplicate department number
const [deptNumberRows] = await db3.query(
  "SELECT dprtmnt_id FROM dprtmnt_table WHERE dept_number = ?",
  [dept_number]
);

if (deptNumberRows.length > 0) {
  return res.status(400).json({
    message: "Department number already exists",
  });
}

    const [result] = await db3.query(
      `INSERT INTO dprtmnt_table
   (dprtmnt_name, dprtmnt_code, dept_number, components)
   VALUES (?, ?, ?, ?)`,
      [dep_name, normalized_code, dept_number, components]
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertDepartmentAuditLog({
      req,
      action: "DEPARTMENT_CREATE",
      message: `${roleLabel} (${actorId}) created department ${dep_name} (${normalized_code}).`,
    });

    res.status(200).json({
      message: "Department created successfully",
      insertId: result.insertId,
    });
  } catch (err) {
    console.error("Error creating department:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// -------------------- GET DEPARTMENTS --------------------
router.get("/get_department", async (req, res) => {
  try {
    await ensureDepartmentIsAllowedColumn();
    const [result] = await db3.query(`
      SELECT
        dept.*,
        dean.employee_id AS dean_employee_id,
        TRIM(CONCAT_WS(
          ' ',
          dean_prof.fname,
          CASE
            WHEN NULLIF(TRIM(dean_prof.mname), '') IS NULL THEN NULL
            ELSE CONCAT(LEFT(TRIM(dean_prof.mname), 1), '.')
          END,
          dean_prof.lname
        )) AS dean_name
      FROM dprtmnt_table dept
      LEFT JOIN dprtmnt_org dean
        ON dean.dprtmnt_id = dept.dprtmnt_id
       AND dean.position = 'DEAN'
       AND dean.status = 1
      LEFT JOIN prof_table dean_prof
        ON dean_prof.employee_id = dean.employee_id
      ORDER BY dept.dprtmnt_id
    `);
    res.status(200).json(result);
  } catch (err) {
    console.error("Error fetching departments:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// -------------------- DEPARTMENT ORGANIZATION --------------------
router.get("/department/:id/organization", async (req, res) => {
  const { id } = req.params;

  try {
    const [[department]] = await db3.query(
      `SELECT dprtmnt_id, dprtmnt_name, dprtmnt_code
       FROM dprtmnt_table
       WHERE dprtmnt_id = ?
       LIMIT 1`,
      [id],
    );

    if (!department) {
      return res.status(404).json({ message: "Department not found" });
    }

    const [curricula] = await db3.query(
      `SELECT
         dc.curriculum_id,
         ct.lock_status,
         p.program_code,
         p.program_description,
         p.major,
         y.year_description
       FROM dprtmnt_curriculum_table dc
       INNER JOIN curriculum_table ct ON ct.curriculum_id = dc.curriculum_id
       INNER JOIN program_table p ON p.program_id = ct.program_id
       INNER JOIN year_table y ON y.year_id = ct.year_id
       WHERE dc.dprtmnt_id = ?
         AND ct.lock_status = 1
       ORDER BY p.program_code, y.year_description, dc.curriculum_id`,
      [id],
    );

    const [assignments] = await db3.query(
      `SELECT
         org.dprtmnt_org_id,
         org.dprtmnt_id,
         org.curriculum_id,
         org.employee_id,
         org.position,
         pr.fname,
         pr.mname,
         pr.lname,
         pr.status AS employee_status
       FROM dprtmnt_org org
       LEFT JOIN prof_table pr ON pr.employee_id = org.employee_id
       WHERE org.dprtmnt_id = ? AND org.status = 1
       ORDER BY org.position, org.curriculum_id`,
      [id],
    );

    const assignedEmployeeIds = assignments.map((row) => row.employee_id);
    const facultyParams = assignedEmployeeIds.length ? assignedEmployeeIds : [""];
    const [faculty] = await db3.query(
      `SELECT
         pr.prof_id,
         pr.employee_id,
         pr.fname,
         pr.mname,
         pr.lname,
         pr.status,
         dept.dprtmnt_id,
         dept.dprtmnt_name,
         dept.dprtmnt_code
       FROM prof_table pr
       LEFT JOIN (
         SELECT current_assignment.prof_id, current_assignment.dprtmnt_id
         FROM dprtmnt_profs_table current_assignment
         INNER JOIN (
           SELECT prof_id, MAX(dprtmnt_profs_id) AS latest_id
           FROM dprtmnt_profs_table
           GROUP BY prof_id
         ) latest ON latest.latest_id = current_assignment.dprtmnt_profs_id
       ) faculty_department ON faculty_department.prof_id = pr.prof_id
       LEFT JOIN dprtmnt_table dept ON dept.dprtmnt_id = faculty_department.dprtmnt_id
       WHERE pr.status = 1 OR pr.employee_id IN (?)
       ORDER BY pr.lname, pr.fname, pr.employee_id`,
      [facultyParams],
    );

    return res.json({ department, curricula, assignments, faculty });
  } catch (err) {
    console.error("Error fetching department organization:", err);
    return res.status(500).json({ message: "Failed to load department organization" });
  }
});

router.put("/department/:id/organization", CanEdit, async (req, res) => {
  const { id } = req.params;
  const deanEmployeeId = String(req.body?.dean_employee_id || "").trim();
  const chairs = Array.isArray(req.body?.chairs) ? req.body.chairs : [];
  let connection;

  try {
    connection = await db3.getConnection();
    await connection.beginTransaction();

    const [departmentRows] = await connection.query(
      `SELECT dprtmnt_id, dprtmnt_name, dprtmnt_code
       FROM dprtmnt_table
       WHERE dprtmnt_id = ?
       FOR UPDATE`,
      [id],
    );

    if (!departmentRows.length) {
      await connection.rollback();
      return res.status(404).json({ message: "Department not found" });
    }

    const [curriculumRows] = await connection.query(
      `SELECT dc.curriculum_id
       FROM dprtmnt_curriculum_table dc
       INNER JOIN curriculum_table ct ON ct.curriculum_id = dc.curriculum_id
       WHERE dc.dprtmnt_id = ?
         AND ct.lock_status = 1`,
      [id],
    );
    const allowedCurriculumIds = new Set(
      curriculumRows.map((row) => String(row.curriculum_id)),
    );
    const desiredAssignments = new Map();

    if (deanEmployeeId) {
      desiredAssignments.set("DEAN", {
        position: "DEAN",
        curriculumId: null,
        employeeId: deanEmployeeId,
      });
    }

    for (const chair of chairs) {
      const curriculumId = String(chair?.curriculum_id || "").trim();
      const chairEmployeeId = String(chair?.employee_id || "").trim();

      if (!curriculumId || !chairEmployeeId) continue;
      if (!allowedCurriculumIds.has(curriculumId)) {
        await connection.rollback();
        return res.status(400).json({
          message: `Curriculum ${curriculumId} does not belong to this department`,
        });
      }

      const key = `PROGRAM_CHAIR:${curriculumId}`;
      if (desiredAssignments.has(key)) {
        await connection.rollback();
        return res.status(400).json({
          message: `Only one Program Chair can be assigned to curriculum ${curriculumId}`,
        });
      }

      desiredAssignments.set(key, {
        position: "PROGRAM_CHAIR",
        curriculumId,
        employeeId: chairEmployeeId,
      });
    }

    const desiredEmployeeIds = [
      ...new Set([...desiredAssignments.values()].map((item) => item.employeeId)),
    ];

    if (desiredEmployeeIds.length) {
      const [employeeRows] = await connection.query(
        `SELECT employee_id
         FROM prof_table
         WHERE employee_id IN (?) AND status = 1`,
        [desiredEmployeeIds],
      );
      const activeEmployeeIds = new Set(
        employeeRows.map((row) => String(row.employee_id)),
      );
      const invalidEmployeeId = desiredEmployeeIds.find(
        (employeeId) => !activeEmployeeIds.has(String(employeeId)),
      );

      if (invalidEmployeeId) {
        await connection.rollback();
        return res.status(400).json({
          message: `Faculty employee ${invalidEmployeeId} is not active or does not exist`,
        });
      }
    }

    const [currentRows] = await connection.query(
      `SELECT dprtmnt_org_id, curriculum_id, employee_id, position
       FROM dprtmnt_org
       WHERE dprtmnt_id = ? AND status = 1
       FOR UPDATE`,
      [id],
    );
    const currentAssignments = new Map(
      currentRows.map((row) => [
        row.position === "DEAN"
          ? "DEAN"
          : `PROGRAM_CHAIR:${row.curriculum_id}`,
        row,
      ]),
    );

    for (const [key, current] of currentAssignments) {
      const desired = desiredAssignments.get(key);
      if (!desired || String(desired.employeeId) !== String(current.employee_id)) {
        await connection.query(
          `UPDATE dprtmnt_org
           SET status = 0
           WHERE dprtmnt_org_id = ?`,
          [current.dprtmnt_org_id],
        );
      }
    }

    for (const [key, desired] of desiredAssignments) {
      const current = currentAssignments.get(key);
      if (current && String(current.employee_id) === String(desired.employeeId)) {
        continue;
      }

      await connection.query(
        `INSERT INTO dprtmnt_org
           (dprtmnt_id, curriculum_id, employee_id, position, status)
         VALUES (?, ?, ?, ?, 1)`,
        [id, desired.curriculumId, desired.employeeId, desired.position],
      );
    }

    await connection.commit();

    const department = departmentRows[0];
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertDepartmentAuditLog({
      req,
      action: "DEPARTMENT_ORGANIZATION_UPDATE",
      message: `${roleLabel} (${actorId}) updated the organization assignments for ${department.dprtmnt_name} (${department.dprtmnt_code}).`,
    });

    return res.json({ message: "Department organization saved successfully" });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Error saving department organization:", err);
    return res.status(500).json({ message: "Failed to save department organization" });
  } finally {
    if (connection) connection.release();
  }
});

// -------------------- UPDATE DEPARTMENT --------------------
// -------------------- UPDATE DEPARTMENT --------------------
router.put("/department/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { dep_name, dep_code, dept_number, components } = req.body;

  if (!dep_name || !dep_code || !dept_number || !components) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const normalized_code = dep_code
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase();

    // Check if another department already uses this code
    const [codeRows] = await db3.query(
      `SELECT dprtmnt_id
       FROM dprtmnt_table
       WHERE dprtmnt_code = ?
       AND dprtmnt_id <> ?`,
      [normalized_code, id]
    );

    if (codeRows.length > 0) {
      return res.status(400).json({
        message: "Department code already exists",
      });
    }

    // Check if another department already uses this department number
    const [deptNumberRows] = await db3.query(
      `SELECT dprtmnt_id
       FROM dprtmnt_table
       WHERE dept_number = ?
       AND dprtmnt_id <> ?`,
      [dept_number, id]
    );

    if (deptNumberRows.length > 0) {
      return res.status(400).json({
        message: "Department number already exists",
      });
    }

    const [result] = await db3.query(
      `UPDATE dprtmnt_table
       SET dprtmnt_name = ?,
           dprtmnt_code = ?,
           dept_number = ?,
           components = ?
       WHERE dprtmnt_id = ?`,
      [dep_name, normalized_code, dept_number, components, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Department not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);

    await insertDepartmentAuditLog({
      req,
      action: "DEPARTMENT_UPDATE",
      message: `${roleLabel} (${actorId}) updated department ${dep_name} (${normalized_code}) [Dept No: ${dept_number}].`,
    });

    res.json({
      message: "Department updated successfully",
    });
  } catch (err) {
    console.error("Error updating department:", err);
    res.status(500).json({
      message: "Internal Server Error",
    });
  }
});

// -------------------- DELETE DEPARTMENT --------------------
router.delete("/department/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [departmentRows] = await db3.query(
      "SELECT dprtmnt_name, dprtmnt_code FROM dprtmnt_table WHERE dprtmnt_id = ?",
      [id],
    );

    const [result] = await db3.query(
      "DELETE FROM dprtmnt_table WHERE dprtmnt_id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Department not found" });
    }

    const department = departmentRows[0];
    const departmentLabel = department
      ? `${department.dprtmnt_name} (${department.dprtmnt_code})`
      : `department ID ${id}`;
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertDepartmentAuditLog({
      req,
      action: "DEPARTMENT_DELETE",
      message: `${roleLabel} (${actorId}) deleted ${departmentLabel}.`,
    });

    res.json({ message: "Department deleted successfully" });
  } catch (err) {
    console.error("Error deleting department:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

router.put("/department/:id/is-allowed", CanEdit, async (req, res) => {
  const { id } = req.params;
  const isAllowed = Number(req.body?.is_allowed) === 1 ? 1 : 0;

  try {
    await ensureDepartmentIsAllowedColumn();

    const [departmentRows] = await db3.query(
      "SELECT dprtmnt_name, dprtmnt_code FROM dprtmnt_table WHERE dprtmnt_id = ?",
      [id],
    );

    if (!departmentRows.length) {
      return res.status(404).json({ message: "Department not found" });
    }

    const [result] = await db3.query(
      "UPDATE dprtmnt_table SET is_allowed = ? WHERE dprtmnt_id = ?",
      [isAllowed, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Department not found" });
    }

    const department = departmentRows[0];
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertDepartmentAuditLog({
      req,
      action: "DEPARTMENT_PLOTTING_ACCESS",
      message: `${roleLabel} (${actorId}) ${isAllowed ? "enabled" : "disabled"} schedule plotting for ${department.dprtmnt_name} (${department.dprtmnt_code}).`,
    });

    res.json({
      success: true,
      dprtmnt_id: Number(id),
      is_allowed: isAllowed,
      message: isAllowed
        ? "Department schedule plotting enabled."
        : "Department schedule plotting disabled.",
    });
  } catch (err) {
    console.error("Error updating department plotting access:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post("/department/grant-access", async (req, res) => {
  const { request_dept_id, requesting_dept_id } = req.body;

  console.log("Grant Access Request:", { request_dept_id, requesting_dept_id });
  try{
    await ensureDepatmentGrantTableExisted();

    if(!request_dept_id || !requesting_dept_id){
      return res.status(400).json({ message: "Missing required fields" });
    }

    const [activeYearRows] = await db3.query(
      "SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1"
    );

    if (!activeYearRows.length) {
      return res.status(400).json({ message: "No active school year found" });
    }

    const activeYearId = activeYearRows[0].id;

  

    const [result] = await db3.query(`
      INSERT INTO dprtmnt_grant_table (request_dept_id, requesting_dept_id, active_school_year_id)
      VALUES (?, ?, ?)
    `, [request_dept_id, requesting_dept_id, activeYearId]);

    console.log("Department access granted:", result);

    const actorLabel = await getActorAuditLabel(req);
    await insertDepartmentAuditLog({
      req,
      action: "DEPARTMENT_GRANT_ACCESS",
      message: `${actorLabel} granted access from department ID ${request_dept_id} to department ID ${requesting_dept_id} for school year ID ${activeYearId}.`,
    });

    return res.status(200).json({
      success: true,
      message: "Access granted successfully.",
      insertId: result.insertId,
    });
  } catch (err) {
    console.error("Error granting department access:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

module.exports = router;
module.exports.ensureDepartmentIsAllowedColumn = ensureDepartmentIsAllowedColumn;
