const express = require("express");
const { db3 } = require("../database/database");
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const {
  getScopes,
  isInScope,
  employeeHasAnyScope,
} = require("../../utils/registrarScopeService");

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

const insertSectionSlotAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);
  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    message,
    severity: "INFO",
  });
};

const getEmployeeScope = async (employeeId) => {
  if (!employeeId) return null;

  const scopes = await getScopes(employeeId);
  if (!scopes.length) {
    const [[legacy]] = await db3.query(
      `SELECT employee_id, dprtmnt_id
       FROM user_accounts
       WHERE employee_id = ?
       LIMIT 1`,
      [employeeId],
    );
    return legacy
      ? {
          employee_id: legacy.employee_id,
          dprtmnt_id: legacy.dprtmnt_id,
          program_id: null,
        }
      : null;
  }

  return {
    employee_id: employeeId,
    scopes,
    dprtmnt_id: scopes.length === 1 ? scopes[0].dprtmnt_id : null,
    program_id: scopes.length === 1 ? scopes[0].program_id : null,
  };
};

const enforceReadScope = async (req, res, departmentId, programId) => {
  if (String(req.query.enforceScope) !== "1") return true;

  const employeeId = req.headers["x-employee-id"];
  if (!employeeId) {
    res.status(400).json({ error: "Employee ID is required for scoped access" });
    return false;
  }

  const hasScopeRows = await employeeHasAnyScope(employeeId);
  if (hasScopeRows) {
    const allowed = await isInScope(employeeId, departmentId, programId);
    if (!allowed) {
      res.status(403).json({ error: "You do not have access to this department/program" });
      return false;
    }
    return true;
  }

  const scope = await getEmployeeScope(employeeId);
  if (!scope) {
    res.status(403).json({ error: "Employee scope not found" });
    return false;
  }

  if (scope.dprtmnt_id && String(scope.dprtmnt_id) !== String(departmentId)) {
    res.status(403).json({ error: "You do not have access to this department" });
    return false;
  }

  if (scope.program_id && String(scope.program_id) !== String(programId)) {
    res.status(403).json({ error: "You do not have access to this program" });
    return false;
  }

  return true;
};

const getSectionLabel = async (departmentSectionId) => {
  const [[row]] = await db3.query(
    `SELECT pt.program_code, st.description AS section_description
     FROM dprtmnt_section_table dst
     INNER JOIN curriculum_table ct ON dst.curriculum_id = ct.curriculum_id
     INNER JOIN program_table pt ON ct.program_id = pt.program_id
     INNER JOIN section_table st ON dst.section_id = st.id
     WHERE dst.id = ?
     LIMIT 1`,
    [departmentSectionId],
  );
  if (!row) return `section ID ${departmentSectionId}`;
  return `${row.program_code}-${row.section_description}`;
};

const getCourseLabel = async (courseId) => {
  const [[row]] = await db3.query(
    `SELECT course_code, course_description
     FROM course_table
     WHERE course_id = ?
     LIMIT 1`,
    [courseId],
  );
  if (!row) return `course ID ${courseId}`;
  return `${row.course_code} - ${row.course_description}`;
};

const buildSectionsQuery = (courseFilter) => `
  SELECT
    dst.id AS department_section_id,
    ct.curriculum_id,
    pt.program_code,
    pt.program_description,
    st.description AS section_description,
    sst.id AS section_subject_id,
    sst.tag_source,
    sst.course_id,
    cst.course_code,
    cst.course_description,
    ylt.year_level_description,
    GROUP_CONCAT(
      DISTINCT CONCAT(
        TIME_FORMAT(tt.school_time_start, '%h:%i %p'),
        ' - ',
        TIME_FORMAT(tt.school_time_end, '%h:%i %p')
      )
      ORDER BY tt.school_time_start
      SEPARATOR ', '
    ) AS schedule,
    GROUP_CONCAT(
      DISTINCT NULLIF(
        TRIM(CONCAT(IFNULL(prf.lname, ''), ', ', IFNULL(prf.fname, ''), ' ', IFNULL(prf.mname, ''))),
        ','
      )
      ORDER BY prf.lname, prf.fname
      SEPARATOR ', '
    ) AS faculty_name,
    COALESCE(sst.max_slots, 0) AS max_slots
  FROM dprtmnt_section_table dst
  INNER JOIN dprtmnt_curriculum_table dct ON dst.curriculum_id = dct.curriculum_id
  INNER JOIN section_table st ON dst.section_id = st.id
  INNER JOIN curriculum_table ct ON dct.curriculum_id = ct.curriculum_id
  INNER JOIN program_table pt ON ct.program_id = pt.program_id
  LEFT JOIN section_subject_table sst
    ON dst.id = sst.department_section_id
    AND sst.active_school_year_id = ?
    AND sst.is_active = 1
  LEFT JOIN course_table cst ON sst.course_id = cst.course_id
  LEFT JOIN program_tagging_table ptt
    ON ptt.curriculum_id = dst.curriculum_id
    AND ptt.course_id = sst.course_id
    AND ptt.year_level_id = ?
    AND ptt.semester_id = ?
  LEFT JOIN year_level_table ylt ON ptt.year_level_id = ylt.year_level_id
  LEFT JOIN time_table tt
    ON dst.id = tt.department_section_id
    AND tt.course_id = sst.course_id
    AND tt.school_year_id = ?
  LEFT JOIN prof_table prf ON tt.professor_id = prf.prof_id
  WHERE dct.dprtmnt_id = ?
    AND pt.program_id = ?
    AND ct.curriculum_id = ?
    AND pt.components = ?
    AND (
      dst.year_level_id = ?
      OR (
        dst.year_level_id IS NULL
        AND st.description REGEXP CONCAT('(^|[^0-9])', ?, '([^0-9]|$)')
      )
    )
    AND dst.dsstat = 1
    AND (
      sst.course_id IS NULL
      OR sst.tag_source = 'manual'
      OR ptt.program_tagging_id IS NOT NULL
    )
    ${courseFilter}
  GROUP BY
    dst.id,
    ct.curriculum_id,
    pt.program_code,
    pt.program_description,
    st.description,
    sst.id,
    sst.tag_source,
    sst.course_id,
    cst.course_code,
    cst.course_description,
    ylt.year_level_description,
    COALESCE(sst.max_slots, 0)
  ORDER BY st.description ASC, cst.course_code ASC
`;

router.get("/section-slot/sections", async (req, res) => {
  const {
    departmentId,
    courseId,
    programId,
    curriculumId,
    yearLevelId,
    semesterId,
    campus,
    activeSchoolYearId,
  } = req.query;

  if (
    !departmentId ||
    !programId ||
    !curriculumId ||
    !yearLevelId ||
    !semesterId ||
    !campus ||
    !activeSchoolYearId
  ) {
    return res.status(400).json({
      error:
        "departmentId, programId, curriculumId, yearLevelId, semesterId, campus, and activeSchoolYearId are required",
    });
  }

  const scopeOk = await enforceReadScope(req, res, departmentId, programId);
  if (!scopeOk) return;

  const params = [
    activeSchoolYearId,
    yearLevelId,
    semesterId,
    activeSchoolYearId,
    departmentId,
    programId,
    curriculumId,
    campus,
    yearLevelId,
    yearLevelId,
  ];
  const courseFilter = courseId ? "AND sst.course_id = ?" : "";
  if (courseId) params.push(courseId);

  try {
    const [rows] = await db3.query(buildSectionsQuery(courseFilter), params);
    return res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching section slot rows:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

router.get("/slot-monitoring-sections", async (req, res) => {
  req.query.enforceScope = req.query.enforceScope || "0";
  const {
    departmentId,
    courseId,
    programId,
    curriculumId,
    yearLevelId,
    semesterId,
    campus,
    activeSchoolYearId,
  } = req.query;

  if (
    !departmentId ||
    !programId ||
    !curriculumId ||
    !yearLevelId ||
    !semesterId ||
    !campus ||
    !activeSchoolYearId
  ) {
    return res.status(400).json({
      error:
        "departmentId, programId, curriculumId, yearLevelId, semesterId, campus, and activeSchoolYearId are required",
    });
  }

  const scopeOk = await enforceReadScope(req, res, departmentId, programId);
  if (!scopeOk) return;

  const params = [
    activeSchoolYearId,
    yearLevelId,
    semesterId,
    activeSchoolYearId,
    departmentId,
    programId,
    curriculumId,
    campus,
    yearLevelId,
    yearLevelId,
  ];
  const courseFilter = courseId ? "AND sst.course_id = ?" : "";
  if (courseId) params.push(courseId);

  try {
    const [rows] = await db3.query(buildSectionsQuery(courseFilter), params);
    return res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching slot monitoring sections:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

router.post("/section-slot/enrolled-count", async (req, res) => {
  const { curriculumId, sectionIds, activeSchoolYearId, courseId } = req.body;

  if (!curriculumId || !activeSchoolYearId) {
    return res.status(400).json({
      error: "curriculumId and activeSchoolYearId are required",
    });
  }

  if (!Array.isArray(sectionIds) || sectionIds.length === 0) {
    return res.status(200).json([]);
  }

  const sectionPlaceholders = sectionIds.map(() => "?").join(", ");
  const courseFilter = courseId ? "AND es.course_id = ?" : "";
  const query = `
    SELECT
      es.department_section_id,
      es.course_id,
      COUNT(DISTINCT es.student_number) AS enrolled_student
    FROM enrolled_subject es
    INNER JOIN dprtmnt_section_table dst ON es.department_section_id = dst.id
    WHERE es.curriculum_id = ?
      AND es.department_section_id IN (${sectionPlaceholders})
      AND es.active_school_year_id = ?
      ${courseFilter}
    GROUP BY es.department_section_id, es.course_id
  `;

  try {
    const params = [curriculumId, ...sectionIds, activeSchoolYearId];
    if (courseId) params.push(courseId);
    const [rows] = await db3.query(query, params);
    return res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching enrolled counts:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

router.post("/slot-monitoring-enrolled-count", async (req, res) => {
  const { curriculumId, sectionIds, activeSchoolYearId, courseId } = req.body;

  if (!curriculumId || !activeSchoolYearId) {
    return res.status(400).json({
      error: "curriculumId and activeSchoolYearId are required",
    });
  }

  if (!Array.isArray(sectionIds) || sectionIds.length === 0) {
    return res.status(200).json([]);
  }

  const sectionPlaceholders = sectionIds.map(() => "?").join(", ");
  const courseFilter = courseId ? "AND es.course_id = ?" : "";
  const query = `
    SELECT
      es.department_section_id,
      es.course_id,
      COUNT(DISTINCT es.student_number) AS enrolled_student
    FROM enrolled_subject es
    INNER JOIN dprtmnt_section_table dst ON es.department_section_id = dst.id
    WHERE es.curriculum_id = ?
      AND es.department_section_id IN (${sectionPlaceholders})
      AND es.active_school_year_id = ?
      ${courseFilter}
    GROUP BY es.department_section_id, es.course_id
  `;

  try {
    const params = [curriculumId, ...sectionIds, activeSchoolYearId];
    if (courseId) params.push(courseId);
    const [rows] = await db3.query(query, params);
    return res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching enrolled counts:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

router.post("/section-slot/sync-program", CanCreate, async (req, res) => {
  const {
    departmentId,
    programId,
    curriculumId,
    yearLevelId,
    semesterId,
    campus,
    activeSchoolYearId,
  } = req.body;

  if (
    !departmentId ||
    !programId ||
    !curriculumId ||
    !yearLevelId ||
    !semesterId ||
    !campus ||
    !activeSchoolYearId
  ) {
    return res.status(400).json({
      error:
        "departmentId, programId, curriculumId, yearLevelId, semesterId, campus, and activeSchoolYearId are required",
    });
  }

  let connection;
  try {
    connection = await db3.getConnection();
    await connection.beginTransaction();

    const [sections] = await connection.query(
      `SELECT DISTINCT dst.id AS department_section_id
       FROM dprtmnt_section_table dst
       INNER JOIN dprtmnt_curriculum_table dct
         ON dst.curriculum_id = dct.curriculum_id
       INNER JOIN curriculum_table ct
         ON dst.curriculum_id = ct.curriculum_id
       INNER JOIN program_table pt
         ON ct.program_id = pt.program_id
       INNER JOIN section_table st
         ON dst.section_id = st.id
       WHERE dct.dprtmnt_id = ?
         AND pt.program_id = ?
         AND dst.curriculum_id = ?
         AND pt.components = ?
         AND dst.dsstat = 1
         AND (
           dst.year_level_id = ?
           OR (
             dst.year_level_id IS NULL
             AND st.description REGEXP CONCAT('(^|[^0-9])', ?, '([^0-9]|$)')
           )
         )`,
      [departmentId, programId, curriculumId, campus, yearLevelId, yearLevelId],
    );

    const [programCourses] = await connection.query(
      `SELECT DISTINCT course_id
       FROM program_tagging_table
       WHERE curriculum_id = ?
         AND year_level_id = ?
         AND semester_id = ?`,
      [curriculumId, yearLevelId, semesterId],
    );

    const sectionIds = sections.map((row) => Number(row.department_section_id));
    const courseIds = programCourses.map((row) => Number(row.course_id));
    const { actorId, actorRole } = getAuditActor(req);
    let insertedCount = 0;
    let deactivatedCount = 0;
    let preservedCount = 0;

    if (sectionIds.length > 0 && courseIds.length > 0) {
      const values = sectionIds.flatMap((sectionId) =>
        courseIds.map((courseId) => [
          sectionId,
          courseId,
          curriculumId,
          activeSchoolYearId,
          yearLevelId,
          semesterId,
          actorId,
          "automatic",
          1,
        ]),
      );
      const valuePlaceholders = values.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const [insertResult] = await connection.query(
        `INSERT INTO section_subject_table
          (department_section_id, course_id, curriculum_id, active_school_year_id,
           year_level_id, semester_id, tagged_by, tag_source, is_active)
         VALUES ${valuePlaceholders}
         ON DUPLICATE KEY UPDATE
           is_active = IF(excluded_by = 'program-sync', 1, is_active),
           excluded_by = IF(excluded_by = 'program-sync', NULL, excluded_by),
           excluded_at = IF(excluded_by = 'program-sync', NULL, excluded_at)`,
        values.flat(),
      );
      insertedCount = insertResult.affectedRows;
    }

    if (sectionIds.length > 0) {
      const sectionPlaceholders = sectionIds.map(() => "?").join(", ");
      const desiredFilter = courseIds.length > 0
        ? `AND sst.course_id NOT IN (${courseIds.map(() => "?").join(", ")})`
        : "";
      const staleParams = [
        ...sectionIds,
        activeSchoolYearId,
        curriculumId,
        ...courseIds,
      ];

      const [[staleSummary]] = await connection.query(
        `SELECT
           COUNT(*) AS stale_count,
           SUM(
             CASE WHEN EXISTS (
               SELECT 1 FROM enrolled_subject es
               WHERE es.department_section_id = sst.department_section_id
                 AND es.course_id = sst.course_id
                 AND es.active_school_year_id = sst.active_school_year_id
             ) OR EXISTS (
               SELECT 1 FROM time_table tt
               WHERE tt.department_section_id = sst.department_section_id
                 AND tt.course_id = sst.course_id
                 AND tt.school_year_id = sst.active_school_year_id
             ) THEN 1 ELSE 0 END
           ) AS preserved_count
         FROM section_subject_table sst
         WHERE sst.department_section_id IN (${sectionPlaceholders})
           AND sst.active_school_year_id = ?
           AND sst.curriculum_id = ?
           AND sst.tag_source = 'automatic'
           AND sst.is_active = 1
           ${desiredFilter}`,
        staleParams,
      );
      preservedCount = Number(staleSummary?.preserved_count) || 0;

      const [deactivateResult] = await connection.query(
        `UPDATE section_subject_table sst
         SET sst.is_active = 0,
             sst.excluded_by = 'program-sync',
             sst.excluded_at = NOW()
         WHERE sst.department_section_id IN (${sectionPlaceholders})
           AND sst.active_school_year_id = ?
           AND sst.curriculum_id = ?
           AND sst.tag_source = 'automatic'
           AND sst.is_active = 1
           ${desiredFilter}
           AND NOT EXISTS (
             SELECT 1 FROM enrolled_subject es
             WHERE es.department_section_id = sst.department_section_id
               AND es.course_id = sst.course_id
               AND es.active_school_year_id = sst.active_school_year_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM time_table tt
             WHERE tt.department_section_id = sst.department_section_id
               AND tt.course_id = sst.course_id
               AND tt.school_year_id = sst.active_school_year_id
           )`,
        staleParams,
      );
      deactivatedCount = deactivateResult.affectedRows;
    }

    await connection.commit();

    if (insertedCount > 0 || deactivatedCount > 0) {
      const roleLabel = formatAuditActorRole(actorRole);
      await insertSectionSlotAuditLog({
        req,
        action: "SECTION_SUBJECT_AUTO_SYNC",
        message:
          `${roleLabel} (${actorId}) synchronized Program Tagging subjects to ` +
          `${sectionIds.length} active section(s): ${insertedCount} added, ` +
          `${deactivatedCount} removed, ${preservedCount} retained because they are in use.`,
      });
    }

    return res.status(200).json({
      message: "Program subjects synchronized successfully",
      section_count: sectionIds.length,
      program_course_count: courseIds.length,
      inserted_count: insertedCount,
      deactivated_count: deactivatedCount,
      preserved_count: preservedCount,
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Error synchronizing Program Tagging subjects:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/section-slot/tagged-subjects/:departmentSectionId", async (req, res) => {
  const { departmentSectionId } = req.params;
  const { activeSchoolYearId } = req.query;

  if (!departmentSectionId || !activeSchoolYearId) {
    return res.status(400).json({
      error: "departmentSectionId and activeSchoolYearId are required",
    });
  }

  try {
    const [rows] = await db3.query(
      `SELECT
        sst.id AS section_subject_id,
        sst.department_section_id,
        sst.course_id,
        sst.curriculum_id,
        sst.active_school_year_id,
        sst.tag_source,
        cst.course_code,
        cst.course_description,
        CASE WHEN EXISTS (
          SELECT 1
          FROM time_table tt
          WHERE tt.department_section_id = sst.department_section_id
            AND tt.course_id = sst.course_id
            AND tt.school_year_id = sst.active_school_year_id
        ) THEN 1 ELSE 0 END AS has_schedule
      FROM section_subject_table sst
      INNER JOIN course_table cst ON sst.course_id = cst.course_id
      WHERE sst.department_section_id = ?
        AND sst.active_school_year_id = ?
        AND sst.is_active = 1
      ORDER BY cst.course_code ASC`,
      [departmentSectionId, activeSchoolYearId],
    );
    return res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching tagged subjects:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

// Manually section-tagged courses can be offered to a matching-curriculum
// student only while at least one matching section still has capacity.
// This is read-only and does not add rows to program_tagging_table.
router.get("/section-slot/available-manual-courses/:curriculumId", async (req, res) => {
  const { curriculumId } = req.params;
  const { sectionId } = req.query;
  const includeFull = String(req.query.includeFull || "") === "1";

  if (!/^\d+$/.test(String(curriculumId)) || (sectionId && !/^\d+$/.test(String(sectionId)))) {
    return res.status(400).json({ error: "Valid curriculumId and sectionId are required" });
  }

  try {
    const sectionFilter = sectionId ? "AND sst.department_section_id = ?" : "";
    const capacityFilter = includeFull
      ? ""
      : "HAVING COALESCE(sst.max_slots, 0) > COUNT(DISTINCT es.student_number)";
    const params = sectionId ? [curriculumId, sectionId] : [curriculumId];
    const [rows] = await db3.query(
      `SELECT
         c.course_id,
         c.course_code,
         c.course_description,
         c.course_unit,
         c.lec_unit,
         c.lab_unit,
         c.prereq,
         c.corequisite,
         c.subject_type_id,
         st.subject_type_name,
         c.category_type_id,
         cat.category_type_name,
         sst.curriculum_id,
         sst.department_section_id,
         COALESCE(sst.max_slots, 0) AS max_slots,
         COUNT(DISTINCT es.student_number) AS enrolled_count
       FROM section_subject_table sst
       INNER JOIN dprtmnt_section_table dst
         ON dst.id = sst.department_section_id
        AND dst.curriculum_id = sst.curriculum_id
       INNER JOIN active_school_year_table sy
         ON sy.id = sst.active_school_year_id
        AND sy.astatus = 1
       INNER JOIN course_table c ON c.course_id = sst.course_id
       LEFT JOIN subject_type_table st ON st.subject_type_id = c.subject_type_id
       LEFT JOIN category_type_table cat ON cat.category_type_id = c.category_type_id
       LEFT JOIN enrolled_subject es
         ON es.department_section_id = sst.department_section_id
        AND es.course_id = sst.course_id
        AND es.active_school_year_id = sst.active_school_year_id
       WHERE sst.curriculum_id = ?
         AND sst.is_active = 1
         AND sst.tag_source = 'manual'
         ${sectionFilter}
       GROUP BY
         c.course_id, c.course_code, c.course_description, c.course_unit,
         c.lec_unit, c.lab_unit, c.prereq, c.corequisite, c.subject_type_id,
         st.subject_type_name, c.category_type_id, cat.category_type_name,
         sst.curriculum_id, sst.department_section_id, sst.course_id,
         sst.active_school_year_id, sst.max_slots
       ${capacityFilter}
       ORDER BY c.course_code ASC`,
      params,
    );

    const coursesById = new Map();
    for (const row of rows) {
      const key = String(row.course_id);
      const existing = coursesById.get(key);
      const sectionIdValue = String(row.department_section_id);
      const isSectionFull = Number(row.max_slots) <= 0 ||
        Number(row.enrolled_count) >= Number(row.max_slots);
      if (existing) {
        existing.matching_section_ids.push(sectionIdValue);
        if (!isSectionFull) existing.available_section_ids.push(sectionIdValue);
        existing.section_availability.push({
          department_section_id: sectionIdValue,
          max_slots: Number(row.max_slots) || 0,
          enrolled_count: Number(row.enrolled_count) || 0,
          is_full: isSectionFull,
        });
      } else {
        const availableSectionIds = isSectionFull ? [] : [sectionIdValue];
        coursesById.set(key, {
          ...row,
          available_section_ids: availableSectionIds,
          matching_section_ids: [sectionIdValue],
          section_availability: [{
            department_section_id: sectionIdValue,
            max_slots: Number(row.max_slots) || 0,
            enrolled_count: Number(row.enrolled_count) || 0,
            is_full: isSectionFull,
          }],
          is_full: availableSectionIds.length === 0,
        });
      }
    }

    for (const course of coursesById.values()) {
      course.available_section_ids = [...new Set(course.available_section_ids)];
      course.matching_section_ids = [...new Set(course.matching_section_ids)];
      course.is_full = course.available_section_ids.length === 0;
    }

    return res.status(200).json([...coursesById.values()]);
  } catch (err) {
    console.error("Error fetching available manually tagged courses:", err);
    return res.status(500).json({ error: "Database error", details: err.message });
  }
});

router.post("/section-slot/tag", CanCreate, async (req, res) => {
  const {
    department_section_id,
    curriculum_id,
    active_school_year_id,
    year_level_id,
    semester_id,
    course_ids,
  } = req.body;

  if (
    !department_section_id ||
    !curriculum_id ||
    !active_school_year_id ||
    !Array.isArray(course_ids) ||
    course_ids.length === 0
  ) {
    return res.status(400).json({
      error:
        "department_section_id, curriculum_id, active_school_year_id, and course_ids are required",
    });
  }

  try {
    const [[section]] = await db3.query(
      `SELECT id FROM dprtmnt_section_table WHERE id = ? AND curriculum_id = ? LIMIT 1`,
      [department_section_id, curriculum_id],
    );
    if (!section) {
      return res.status(404).json({ error: "Department section not found" });
    }

    const [[activeYear]] = await db3.query(
      `SELECT id FROM active_school_year_table WHERE id = ? LIMIT 1`,
      [active_school_year_id],
    );
    if (!activeYear) {
      return res.status(404).json({ error: "Active school year not found" });
    }

    const uniqueCourseIds = [
      ...new Set(course_ids.map((id) => Number(id)).filter((id) => !Number.isNaN(id))),
    ];

    if (uniqueCourseIds.length === 0) {
      return res.status(400).json({ error: "No valid course IDs provided" });
    }

    const placeholders = uniqueCourseIds.map(() => "?").join(", ");
    const [existingCourses] = await db3.query(
      `SELECT course_id FROM course_table WHERE course_id IN (${placeholders})`,
      uniqueCourseIds,
    );

    if (existingCourses.length !== uniqueCourseIds.length) {
      return res.status(400).json({ error: "One or more courses were not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const sectionLabel = await getSectionLabel(department_section_id);
    const taggedLabels = [];

    for (const courseId of uniqueCourseIds) {
      const [result] = await db3.query(
        `INSERT INTO section_subject_table
          (department_section_id, course_id, curriculum_id, active_school_year_id,
           year_level_id, semester_id, tagged_by, tag_source, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 1)
         ON DUPLICATE KEY UPDATE
           tag_source = 'manual',
           is_active = 1,
           tagged_by = VALUES(tagged_by),
           excluded_by = NULL,
           excluded_at = NULL`,
        [
          department_section_id,
          courseId,
          curriculum_id,
          active_school_year_id,
          year_level_id || null,
          semester_id || null,
          actorId,
        ],
      );

      if (result.affectedRows > 0) {
        taggedLabels.push(await getCourseLabel(courseId));
      }
    }

    if (taggedLabels.length > 0) {
      await insertSectionSlotAuditLog({
        req,
        action: "SECTION_SUBJECT_TAG",
        message: `${roleLabel} (${actorId}) tagged ${taggedLabels.join(", ")} to ${sectionLabel}.`,
      });
    }

    return res.status(200).json({
      message: "Subjects tagged successfully",
      tagged_count: taggedLabels.length,
    });
  } catch (err) {
    console.error("Error tagging section subjects:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

router.get("/section-slot/tag/:id/check", async (req, res) => {
  const { id } = req.params;

  try {
    const [[tag]] = await db3.query(
      `SELECT department_section_id, course_id, active_school_year_id, tag_source
       FROM section_subject_table
       WHERE id = ?
         AND is_active = 1
       LIMIT 1`,
      [id],
    );

    if (!tag) {
      return res.status(404).json({ error: "Tagged subject not found" });
    }

    const [[enrolled]] = await db3.query(
      `SELECT COUNT(DISTINCT student_number) AS enrolled_count
       FROM enrolled_subject
       WHERE department_section_id = ?
         AND course_id = ?
         AND active_school_year_id = ?`,
      [tag.department_section_id, tag.course_id, tag.active_school_year_id],
    );

    const [[schedule]] = await db3.query(
      `SELECT COUNT(*) AS schedule_count
       FROM time_table
       WHERE department_section_id = ?
         AND course_id = ?
         AND school_year_id = ?`,
      [tag.department_section_id, tag.course_id, tag.active_school_year_id],
    );

    return res.status(200).json({
      enrolled_count: Number(enrolled?.enrolled_count) || 0,
      has_schedule: Number(schedule?.schedule_count) > 0,
      tag_source: tag.tag_source,
    });
  } catch (err) {
    console.error("Error checking tagged subject:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

router.delete("/section-slot/tag/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[tag]] = await db3.query(
      `SELECT sst.id, sst.department_section_id, sst.course_id, sst.active_school_year_id,
              sst.tag_source,
              cst.course_code, cst.course_description
       FROM section_subject_table sst
       LEFT JOIN course_table cst ON sst.course_id = cst.course_id
       WHERE sst.id = ?
       LIMIT 1`,
      [id],
    );

    if (!tag) {
      return res.status(404).json({ error: "Tagged subject not found" });
    }

    const [[enrolled]] = await db3.query(
      `SELECT COUNT(DISTINCT student_number) AS enrolled_count
       FROM enrolled_subject
       WHERE department_section_id = ?
         AND course_id = ?
         AND active_school_year_id = ?`,
      [tag.department_section_id, tag.course_id, tag.active_school_year_id],
    );

    if (Number(enrolled?.enrolled_count) > 0) {
      return res.status(400).json({
        error: "Cannot untag subject while students are enrolled.",
        enrolled_count: Number(enrolled.enrolled_count),
      });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const sectionLabel = await getSectionLabel(tag.department_section_id);
    const courseLabel = `${tag.course_code || ""} - ${tag.course_description || ""}`.trim();

    if (tag.tag_source === "automatic") {
      await db3.query(
        `UPDATE section_subject_table
         SET is_active = 0, excluded_by = ?, excluded_at = NOW()
         WHERE id = ?`,
        [actorId, id],
      );
    } else {
      await db3.query(`DELETE FROM section_subject_table WHERE id = ?`, [id]);
    }

    await insertSectionSlotAuditLog({
      req,
      action: "SECTION_SUBJECT_UNTAG",
      message:
        `${roleLabel} (${actorId}) removed ${courseLabel} from ${sectionLabel}` +
        `${tag.tag_source === "automatic" ? " as a section override" : ""}.`,
    });

    return res.status(200).json({ message: "Subject untagged successfully" });
  } catch (err) {
    console.error("Error untagging section subject:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

router.get("/section-slot/tag/:id/slot-history", CanEdit, async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: "sectionSubjectId is required" });
  }

  try {
    const marker = `[section_subject_id:${id}]`;
    const [rows] = await db3.query(
      `SELECT
         al.audit_id,
         al.actor_id,
         al.role,
         al.message,
         al.timestamp,
         NULLIF(
           TRIM(CONCAT_WS(' ', ua.first_name, ua.middle_name, ua.last_name)),
           ''
         ) AS actor_name
       FROM audit_logs al
       LEFT JOIN user_accounts ua
         ON ua.employee_id = al.actor_id OR ua.email = al.actor_id
       WHERE al.action = 'SECTION_SUBJECT_SLOT_UPDATE'
         AND al.message LIKE ?
       ORDER BY al.timestamp DESC, al.audit_id DESC
       LIMIT 50`,
      [`%${marker}%`],
    );

    const history = rows.map((row) => {
      const values = row.message.match(
        /from\s+(-?\d+(?:\.\d+)?)\s+to\s+(-?\d+(?:\.\d+)?)\s+\(added\s+(-?\d+(?:\.\d+)?)\)/i,
      );

      return {
        audit_id: row.audit_id,
        previous_slots: values ? Number(values[1]) : null,
        current_slots: values ? Number(values[2]) : null,
        added_slots: values ? Number(values[3]) : null,
        actor_id: row.actor_id,
        actor_role: row.role,
        actor_name: row.actor_name,
        timestamp: row.timestamp,
      };
    });

    return res.status(200).json(history);
  } catch (err) {
    console.error("Error fetching subject slot history:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

router.put("/section-slot/tag/:id/max-slots", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { added_slots } = req.body;
  const parsedAddedSlots = Number(added_slots);

  if (
    !id ||
    !Number.isInteger(parsedAddedSlots) ||
    parsedAddedSlots <= 0
  ) {
    return res.status(400).json({
      error: "sectionSubjectId is required and added_slots must be a positive whole number",
    });
  }

  try {
    const [[tag]] = await db3.query(
      `SELECT sst.id, sst.department_section_id, sst.course_id,
              COALESCE(sst.max_slots, 0) AS max_slots
       FROM section_subject_table sst
       WHERE sst.id = ?
       LIMIT 1`,
      [id],
    );

    if (!tag) {
      return res.status(404).json({ error: "Tagged subject not found" });
    }

    const sectionLabel = await getSectionLabel(tag.department_section_id);
    const courseLabel = await getCourseLabel(tag.course_id);
    const previousSlots = Number(tag.max_slots) || 0;
    const currentSlots = previousSlots + parsedAddedSlots;

    const [result] = await db3.query(
      `UPDATE section_subject_table SET max_slots = ? WHERE id = ?`,
      [currentSlots, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Tagged subject not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);

    await insertSectionSlotAuditLog({
      req,
      action: "SECTION_SUBJECT_SLOT_UPDATE",
      message:
        `${roleLabel} (${actorId}) changed max slots of ${courseLabel} in ${sectionLabel} ` +
        `from ${previousSlots} to ${currentSlots} (added ${parsedAddedSlots}). ` +
        `[section_subject_id:${id}]`,
    });

    return res.status(200).json({
      message: "Slots added successfully",
      previous_slots: previousSlots,
      added_slots: parsedAddedSlots,
      current_slots: currentSlots,
      actor_id: actorId,
      actor_role: actorRole,
    });
  } catch (err) {
    console.error("Error updating subject max slots:", err);
    return res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

module.exports = router;
