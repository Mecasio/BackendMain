const { db3 } = require("../routes/database/database");

let registrarScopeTableReady;

const ensureRegistrarScopeTable = async () => {
  if (!registrarScopeTableReady) {
    registrarScopeTableReady = (async () => {
      await db3.query(`
        CREATE TABLE IF NOT EXISTS registrar_scope_table (
          id INT AUTO_INCREMENT PRIMARY KEY,
          employee_id VARCHAR(50) NOT NULL,
          dprtmnt_id INT NOT NULL,
          program_id INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_registrar_scope (employee_id, dprtmnt_id, program_id),
          INDEX idx_employee (employee_id),
          INDEX idx_dept_program (dprtmnt_id, program_id)
        )
      `);
    })().catch((error) => {
      registrarScopeTableReady = null;
      throw error;
    });
  }

  return registrarScopeTableReady;
};

const normalizeScopeInput = (scopes = []) => {
  const seen = new Set();
  const normalized = [];

  for (const scope of scopes) {
    const dprtmntId = Number(scope?.dprtmnt_id);
    const programId = Number(scope?.program_id);

    if (!Number.isFinite(dprtmntId) || !Number.isFinite(programId)) continue;

    const key = `${dprtmntId}:${programId}`;
    if (seen.has(key)) continue;

    seen.add(key);
    normalized.push({ dprtmnt_id: dprtmntId, program_id: programId });
  }

  return normalized;
};

const getScopes = async (employeeId) => {
  if (!employeeId) return [];

  await ensureRegistrarScopeTable();

  const [rows] = await db3.query(
    `SELECT
       rst.id,
       rst.employee_id,
       rst.dprtmnt_id,
       rst.program_id,
       d.dprtmnt_name,
       d.dprtmnt_code,
       pt.program_code,
       pt.program_description,
       pt.major
     FROM registrar_scope_table rst
     INNER JOIN dprtmnt_table d ON rst.dprtmnt_id = d.dprtmnt_id
     INNER JOIN program_table pt ON rst.program_id = pt.program_id
     WHERE rst.employee_id = ?
     ORDER BY d.dprtmnt_name, pt.program_code`,
    [employeeId],
  );

  return rows;
};

const getScopesForEmployees = async (employeeIds = []) => {
  const uniqueIds = [
    ...new Set(
      (Array.isArray(employeeIds) ? employeeIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  ];

  if (!uniqueIds.length) return new Map();

  await ensureRegistrarScopeTable();

  const [rows] = await db3.query(
    `SELECT
       rst.employee_id,
       rst.dprtmnt_id,
       rst.program_id,
       d.dprtmnt_name,
       d.dprtmnt_code,
       pt.program_code,
       pt.program_description,
       pt.major
     FROM registrar_scope_table rst
     INNER JOIN dprtmnt_table d ON rst.dprtmnt_id = d.dprtmnt_id
     INNER JOIN program_table pt ON rst.program_id = pt.program_id
     WHERE rst.employee_id IN (?)
     ORDER BY d.dprtmnt_name, pt.program_code`,
    [uniqueIds],
  );

  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.employee_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  return grouped;
};

const syncScopes = async (employeeId, scopes = []) => {
  if (!employeeId) return [];

  await ensureRegistrarScopeTable();

  const normalized = normalizeScopeInput(scopes);

  await db3.query("DELETE FROM registrar_scope_table WHERE employee_id = ?", [
    employeeId,
  ]);

  if (normalized.length) {
    await db3.query(
      "INSERT INTO registrar_scope_table (employee_id, dprtmnt_id, program_id) VALUES ?",
      [normalized.map((scope) => [employeeId, scope.dprtmnt_id, scope.program_id])],
    );
  }

  await syncLegacyColumns(employeeId);

  return normalized;
};

const isInScope = async (employeeId, dprtmntId, programId) => {
  if (!employeeId) return false;

  await ensureRegistrarScopeTable();

  const [[row]] = await db3.query(
    `SELECT 1
     FROM registrar_scope_table
     WHERE employee_id = ?
       AND dprtmnt_id = ?
       AND program_id = ?
     LIMIT 1`,
    [employeeId, dprtmntId, programId],
  );

  return Boolean(row);
};

const employeeHasAnyScope = async (employeeId) => {
  if (!employeeId) return false;

  await ensureRegistrarScopeTable();

  const [[row]] = await db3.query(
    `SELECT 1
     FROM registrar_scope_table
     WHERE employee_id = ?
     LIMIT 1`,
    [employeeId],
  );

  return Boolean(row);
};

const getAllowedCurriculumIds = async (employeeId) => {
  if (!employeeId) return [];

  await ensureRegistrarScopeTable();

  const [rows] = await db3.query(
    `SELECT DISTINCT ct.curriculum_id
     FROM registrar_scope_table rst
     INNER JOIN curriculum_table ct ON ct.program_id = rst.program_id
     INNER JOIN dprtmnt_curriculum_table dc ON dc.curriculum_id = ct.curriculum_id
       AND dc.dprtmnt_id = rst.dprtmnt_id
     WHERE rst.employee_id = ?
       AND ct.lock_status = 1`,
    [employeeId],
  );

  return rows.map((row) => row.curriculum_id);
};

const getScopedDepartmentIds = async (employeeId) => {
  if (!employeeId) return [];

  await ensureRegistrarScopeTable();

  const [rows] = await db3.query(
    `SELECT DISTINCT dprtmnt_id
     FROM registrar_scope_table
     WHERE employee_id = ?
     ORDER BY dprtmnt_id`,
    [employeeId],
  );

  return rows.map((row) => row.dprtmnt_id);
};

const resolveProgramFromCurriculum = async (curriculumId) => {
  if (!curriculumId) return null;

  const [[row]] = await db3.query(
    `SELECT
       ct.curriculum_id,
       ct.program_id,
       dc.dprtmnt_id,
       pt.program_code,
       pt.program_description
     FROM curriculum_table ct
     INNER JOIN program_table pt ON ct.program_id = pt.program_id
     LEFT JOIN dprtmnt_curriculum_table dc ON dc.curriculum_id = ct.curriculum_id
     WHERE ct.curriculum_id = ?
     LIMIT 1`,
    [curriculumId],
  );

  return row || null;
};

const getStudentDepartmentFromCurriculum = async (
  studentNumber,
  activeSchoolYearId = null,
) => {
  const schoolYearFilter = activeSchoolYearId
    ? `(ss.id IS NULL OR ss.active_school_year_id = 0 OR sy.astatus = 1 OR ss.active_school_year_id = ?)`
    : `(ss.id IS NULL OR ss.active_school_year_id = 0 OR sy.astatus = 1)`;
  const params = activeSchoolYearId
    ? [activeSchoolYearId, studentNumber]
    : [studentNumber];

  const [rows] = await db3.query(
    `SELECT DISTINCT
       sn.student_number,
       COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program) AS curriculum_id,
       ct.program_id,
       dct.dprtmnt_id,
       pt.program_code,
       pt.program_description,
       pt.major,
       dt.dprtmnt_name,
       dt.dprtmnt_code
     FROM student_numbering_table AS sn
     INNER JOIN person_table AS ptbl ON sn.person_id = ptbl.person_id
     LEFT JOIN student_status_table AS ss ON sn.student_number = ss.student_number
     LEFT JOIN active_school_year_table AS sy ON ss.active_school_year_id = sy.id
     INNER JOIN curriculum_table AS ct
       ON ct.curriculum_id = COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program)
     INNER JOIN program_table AS pt ON ct.program_id = pt.program_id
     INNER JOIN dprtmnt_curriculum_table AS dct ON dct.curriculum_id = ct.curriculum_id
     INNER JOIN dprtmnt_table AS dt ON dt.dprtmnt_id = dct.dprtmnt_id
     WHERE sn.student_number = ?
       AND COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program) IS NOT NULL
       AND COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program) <> 0
       AND ${schoolYearFilter}`,
    params,
  );

  if (rows.length) return rows;

  if (activeSchoolYearId) {
    const [unfilteredRows] = await db3.query(
      `SELECT DISTINCT
         sn.student_number,
         COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program) AS curriculum_id,
         ct.program_id,
         dct.dprtmnt_id,
         pt.program_code,
         pt.program_description,
         pt.major,
         dt.dprtmnt_name,
         dt.dprtmnt_code
       FROM student_numbering_table AS sn
       INNER JOIN person_table AS ptbl ON sn.person_id = ptbl.person_id
       LEFT JOIN student_status_table AS ss ON sn.student_number = ss.student_number
       INNER JOIN curriculum_table AS ct
         ON ct.curriculum_id = COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program)
       INNER JOIN program_table AS pt ON ct.program_id = pt.program_id
       INNER JOIN dprtmnt_curriculum_table AS dct ON dct.curriculum_id = ct.curriculum_id
       INNER JOIN dprtmnt_table AS dt ON dt.dprtmnt_id = dct.dprtmnt_id
       WHERE sn.student_number = ?
         AND COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program) IS NOT NULL
         AND COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program) <> 0`,
      [studentNumber],
    );

    if (unfilteredRows.length) return unfilteredRows;
  }

  const [programOnlyRows] = await db3.query(
    `SELECT DISTINCT
       sn.student_number,
       COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program) AS curriculum_id,
       ct.program_id,
       dct.dprtmnt_id,
       pt.program_code,
       pt.program_description,
       pt.major,
       dt.dprtmnt_name,
       dt.dprtmnt_code
     FROM student_numbering_table AS sn
     INNER JOIN person_table AS ptbl ON sn.person_id = ptbl.person_id
     LEFT JOIN student_status_table AS ss ON sn.student_number = ss.student_number
     INNER JOIN curriculum_table AS ct
       ON ct.curriculum_id = COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program)
     INNER JOIN program_table AS pt ON ct.program_id = pt.program_id
     LEFT JOIN dprtmnt_curriculum_table AS dct ON dct.curriculum_id = ct.curriculum_id
     LEFT JOIN dprtmnt_table AS dt ON dt.dprtmnt_id = dct.dprtmnt_id
     WHERE sn.student_number = ?
       AND COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program) IS NOT NULL
       AND COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program) <> 0`,
    [studentNumber],
  );

  return programOnlyRows;
};

const resolveStudentScopeForEmployee = async (
  employeeId,
  studentNumber,
  { activeSchoolYearId } = {},
) => {
  const contexts = await getStudentDepartmentFromCurriculum(
    studentNumber,
    activeSchoolYearId,
  );

  if (!contexts.length) {
    const [[studentRow]] = await db3.query(
      `SELECT 1 AS found
       FROM student_numbering_table
       WHERE student_number = ?
       LIMIT 1`,
      [studentNumber],
    );

    if (!studentRow?.found) {
      return {
        error: "Student record was not found. Please check the student number.",
      };
    }

    return { error: "This student has no curriculum/program assigned yet." };
  }

  const scopes = employeeId ? await getScopes(employeeId) : [];
  const allowedCurriculumIds = employeeId
    ? await getAllowedCurriculumIds(employeeId)
    : [];
  const scopedDepartmentIds = employeeId
    ? await getScopedDepartmentIds(employeeId)
    : [];

  let matchedContext = null;

  if (scopes.length > 0) {
    const scopedProgramIds = [
      ...new Set(scopes.map((scope) => String(scope.program_id))),
    ];

    matchedContext =
      contexts.find((ctx) =>
        scopes.some(
          (scope) =>
            String(scope.program_id) === String(ctx.program_id) &&
            String(scope.dprtmnt_id) === String(ctx.dprtmnt_id),
        ),
      ) ||
      contexts.find((ctx) =>
        scopedProgramIds.includes(String(ctx.program_id)),
      );

    if (!matchedContext) {
      return { error: "Student is outside your assigned programs." };
    }
  } else if (allowedCurriculumIds.length > 0) {
    matchedContext = contexts.find((ctx) =>
      allowedCurriculumIds.some(
        (curriculumId) => String(curriculumId) === String(ctx.curriculum_id),
      ),
    );

    if (!matchedContext) {
      return { error: "Student is outside your assigned curriculum." };
    }
  } else if (scopedDepartmentIds.length > 0) {
    matchedContext = contexts.find((ctx) =>
      scopedDepartmentIds.some(
        (departmentId) => String(departmentId) === String(ctx.dprtmnt_id),
      ),
    );

    if (!matchedContext) {
      return { error: "Student is not assigned to your department." };
    }
  } else if (!employeeId) {
    return { error: "No department is assigned to your account." };
  } else {
    matchedContext = contexts[0];
  }

  let dprtmntId = matchedContext.dprtmnt_id;
  if (!dprtmntId && scopes.length > 0) {
    const scopeForProgram = scopes.find(
      (scope) =>
        String(scope.program_id) === String(matchedContext.program_id),
    );
    dprtmntId = scopeForProgram?.dprtmnt_id ?? null;
  }

  return {
    dprtmntId,
    curriculumId: matchedContext.curriculum_id,
    programId: matchedContext.program_id,
    context: matchedContext,
  };
};

const syncLegacyColumns = async (employeeId) => {
  const scopes = await getScopes(employeeId);

  if (scopes.length === 1) {
    await db3.query(
      `UPDATE user_accounts
       SET dprtmnt_id = ?
       WHERE employee_id = ?`,
      [scopes[0].dprtmnt_id, employeeId],
    );

    return { dprtmnt_id: scopes[0].dprtmnt_id };
  }

  const dprtmntIds = await getScopedDepartmentIds(employeeId);
  const dprtmntId = dprtmntIds.length === 1 ? dprtmntIds[0] : null;

  await db3.query(
    `UPDATE user_accounts
     SET dprtmnt_id = ?
     WHERE employee_id = ?`,
    [dprtmntId, employeeId],
  );

  return { dprtmnt_id: dprtmntId };
};

const parseScopesFromBody = async (body = {}) => {
  if (body.scopes !== undefined && body.scopes !== null && body.scopes !== "") {
    try {
      const raw =
        typeof body.scopes === "string" ? JSON.parse(body.scopes) : body.scopes;
      return normalizeScopeInput(Array.isArray(raw) ? raw : []);
    } catch (error) {
      return [];
    }
  }

  const deptId = body.dprtmnt_id === "" ? null : Number(body.dprtmnt_id);
  const curriculumId =
    body.curriculum_id === "" || body.curriculum_id === undefined
      ? null
      : Number(body.curriculum_id);

  if (!deptId && !curriculumId) return [];

  if (curriculumId) {
    const resolved = await resolveProgramFromCurriculum(curriculumId);
    if (resolved?.program_id) {
      return normalizeScopeInput([
        {
          dprtmnt_id: resolved.dprtmnt_id || deptId,
          program_id: resolved.program_id,
        },
      ]);
    }
  }

  return [];
};

// Run once before dropping user_accounts.program_id.
const migrateLegacyScopes = async () => {
  await ensureRegistrarScopeTable();

  const [rows] = await db3.query(
    `SELECT ua.employee_id, ua.dprtmnt_id, ua.program_id AS curriculum_id
     FROM user_accounts ua
     WHERE ua.role IN ('administrator', 'superadmin', 'technical')
       AND (ua.dprtmnt_id IS NOT NULL OR ua.program_id IS NOT NULL)`,
  );

  let migrated = 0;

  for (const row of rows) {
    const [[exists]] = await db3.query(
      `SELECT 1 FROM registrar_scope_table WHERE employee_id = ? LIMIT 1`,
      [row.employee_id],
    );

    if (exists) continue;

    const scopes = await parseScopesFromBody({
      dprtmnt_id: row.dprtmnt_id,
      curriculum_id: row.curriculum_id,
    });

    if (scopes.length) {
      await syncScopes(row.employee_id, scopes);
      migrated += 1;
    }
  }

  return { migrated, total: rows.length };
};

const buildEmployeeScopePayload = async (employeeId, legacyAccount = {}) => {
  const scopes = await getScopes(employeeId);
  const allowedCurriculumIds = await getAllowedCurriculumIds(employeeId);
  const dprtmntIds = await getScopedDepartmentIds(employeeId);

  let dprtmntId = legacyAccount.dprtmnt_id ?? null;
  let curriculumId = null;

  if (scopes.length === 1) {
    dprtmntId = scopes[0].dprtmnt_id;
    curriculumId = allowedCurriculumIds.find(Boolean) || null;
  } else if (scopes.length !== 1) {
    dprtmntId = dprtmntIds.length === 1 ? dprtmntIds[0] : null;
    curriculumId = null;
  }

  return {
    scopes: scopes.map((scope) => ({
      dprtmnt_id: scope.dprtmnt_id,
      program_id: scope.program_id,
      dprtmnt_name: scope.dprtmnt_name,
      dprtmnt_code: scope.dprtmnt_code,
      program_code: scope.program_code,
      program_description: scope.program_description,
      major: scope.major,
    })),
    dprtmnt_ids: dprtmntIds,
    allowed_curriculum_ids: allowedCurriculumIds,
    dprtmnt_id: dprtmntId,
    curriculum_id: curriculumId,
  };
};

const formatScopesSummary = (scopes = []) => {
  if (!scopes.length) return "";

  const grouped = new Map();
  for (const scope of scopes) {
    const deptLabel = scope.dprtmnt_name || `Dept ${scope.dprtmnt_id}`;
    if (!grouped.has(deptLabel)) grouped.set(deptLabel, []);
    grouped.get(deptLabel).push(scope.program_code || scope.program_description || scope.program_id);
  }

  return [...grouped.entries()]
    .map(([dept, programs]) => `${dept}: ${programs.join(", ")}`)
    .join(" | ");
};

const resolveRegistrarLoginFields = async (employeeId, role, legacyDprtmntId = null) => {
  if (!["administrator", "superadmin", "technical"].includes(String(role || "").toLowerCase()) || !employeeId) {
    return {
      department: legacyDprtmntId ?? null,
      curriculum_id: null,
    };
  }

  await ensureRegistrarScopeTable();
  const scopePayload = await buildEmployeeScopePayload(employeeId, {
    dprtmnt_id: legacyDprtmntId,
  });

  return {
    department: scopePayload.dprtmnt_id ?? legacyDprtmntId ?? null,
    curriculum_id: scopePayload.curriculum_id ?? null,
  };
};

module.exports = {
  ensureRegistrarScopeTable,
  normalizeScopeInput,
  getScopes,
  getScopesForEmployees,
  syncScopes,
  isInScope,
  employeeHasAnyScope,
  getAllowedCurriculumIds,
  getScopedDepartmentIds,
  resolveProgramFromCurriculum,
  getStudentDepartmentFromCurriculum,
  resolveStudentScopeForEmployee,
  syncLegacyColumns,
  parseScopesFromBody,
  migrateLegacyScopes,
  buildEmployeeScopePayload,
  resolveRegistrarLoginFields,
  formatScopesSummary,
};
