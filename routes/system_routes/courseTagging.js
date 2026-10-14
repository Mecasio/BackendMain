const express = require("express");
const webtoken = require("jsonwebtoken");
const { db3 } = require("../database/database");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const {
  formatCourseList,
  getCourseLabel,
  getDepartmentSectionLabel,
  getSchoolYearLabel,
  getStudentNameByNumber,
  getExpectedTaggedCourseCount,
  logStudentHistoryFromRequest,
} = require("../../utils/studentHistoryLogger");
const {
  resolveStudentScopeForEmployee,
} = require("../../utils/registrarScopeService");
const { autoTagNstpComponent } = require("../../utils/autoTagNstpComponent");

const router = express.Router();

const REGISTRAR_COURSE_TAGGING_PAGE_ID = 17;
const REGISTRAR_COURSE_TAGGING_ROLES = new Set([
  "administrator",
  "superadmin",
  "technical",
]);

const requireRegistrarCourseTaggingAccess = async (req, res, next) => {
  const role = String(req.user?.role || "").trim().toLowerCase();
  const employeeId = req.user?.employee_id;

  if (!REGISTRAR_COURSE_TAGGING_ROLES.has(role) || !employeeId) {
    return res.status(403).json({
      error: "You are not authorized to access registrar course tagging.",
    });
  }

  try {
    const [accessRows] = await db3.query(
      `SELECT page_privilege
       FROM page_access
       WHERE user_id = ? AND page_id = ? AND page_privilege = 1
       LIMIT 1`,
      [employeeId, REGISTRAR_COURSE_TAGGING_PAGE_ID],
    );

    if (!accessRows.length) {
      return res.status(403).json({
        error: "You do not have page access to registrar course tagging.",
      });
    }

    return next();
  } catch (err) {
    console.error("Error checking registrar course tagging access:", err);
    return res.status(500).json({ error: "Failed to verify page access." });
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

const getAuditActor = resolveAuditActor;

const insertCourseTaggingAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

const getRemainingEnrolledCourseLabels = async (
  studentNumber,
  activeSchoolYearId,
  curriculumId,
) => {
  const [rows] = await db3.query(
    `
    SELECT c.course_code, c.course_description
    FROM enrolled_subject es
    LEFT JOIN course_table c ON c.course_id = es.course_id
    WHERE es.student_number = ? AND es.active_school_year_id = ? AND es.curriculum_id = ?
    ORDER BY c.course_code ASC
    `,
    [studentNumber, activeSchoolYearId, curriculumId],
  );

  return rows.map(
    (row) => `${row.course_code || "N/A"} (${row.course_description || "Unknown Course"})`,
  );
};

const getSavedScholarshipDetails = async (studentNumber, activeSchoolYearId = null) => {
  const buildQuery = (tableName) => {
    const schoolYearClause = activeSchoolYearId ? `AND ${tableName}.active_school_year_id = ?` : "";
    const params = activeSchoolYearId ? [studentNumber, activeSchoolYearId] : [studentNumber];

    return {
      sql: `
        SELECT
          ${tableName}.scholarship_id,
          st.scholarship_code,
          st.scholarship_name,
          ${tableName}.active_school_year_id
        FROM ${tableName}
        LEFT JOIN scholarship_type st ON st.id = ${tableName}.scholarship_id
        WHERE ${tableName}.student_number = ?
          AND ${tableName}.status = 1
          ${schoolYearClause}
        ORDER BY ${tableName}.id DESC
        LIMIT 1
      `,
      params,
    };
  };

  const [unifastRows] = await db3.query(
    buildQuery("unifast").sql,
    buildQuery("unifast").params,
  );
  if (unifastRows.length > 0) {
    return { ...unifastRows[0], scholarship_source: "unifast" };
  }

  const [matriculationRows] = await db3.query(
    buildQuery("matriculation").sql,
    buildQuery("matriculation").params,
  );
  if (matriculationRows.length > 0) {
    return { ...matriculationRows[0], scholarship_source: "matriculation" };
  }

  return null;
};

const logCourseTaggingStudentHistory = async ({
  req,
  action,
  studentNumber,
  courseId,
  departmentSectionId,
  activeSchoolYearId,
  courses = [],
  remainingCourses = [],
}) => {
  const [studentName, sectionLabel, schoolYearLabel, courseLabel] =
    await Promise.all([
      getStudentNameByNumber(studentNumber),
      getDepartmentSectionLabel(departmentSectionId),
      getSchoolYearLabel(activeSchoolYearId),
      courseId ? getCourseLabel(courseId) : Promise.resolve(""),
    ]);

  await logStudentHistoryFromRequest({
    req,
    studentNumber,
    action,
    details: {
      student_name: studentName,
      section_label: sectionLabel,
      school_year_label: schoolYearLabel,
      course_label: courseLabel,
      courses,
      remaining_courses: remainingCourses,
    },
  });
};

const getEnrolledSubjectLabel = async (enrolledSubjectId) => {
  const [rows] = await db3.query(
    `SELECT es.id, es.student_number, es.department_section_id, c.course_code, c.course_description
     FROM enrolled_subject es
     LEFT JOIN course_table c ON c.course_id = es.course_id
     WHERE es.id = ?
     LIMIT 1`,
    [enrolledSubjectId],
  );
  const row = rows?.[0];
  if (!row) return null;

  return {
    studentNumber: row.student_number,
    courseLabel: `${row.course_code || "N/A"} - ${row.course_description || "Unknown Course"}`,
  };
};

const getActiveSchoolYearId = async (requestedSchoolYearId) => {
  if (requestedSchoolYearId) return requestedSchoolYearId;

  const [rows] = await db3.query(
    "SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1",
  );

  return rows?.[0]?.id || null;
};

class SectionCapacityError extends Error {
  constructor({ enrolledCount, maxSlots }) {
    super(
      maxSlots <= 0
        ? "Enrollment is closed for this subject because no slots are available."
        : `Section is full for this subject (${enrolledCount}/${maxSlots}).`,
    );
    this.name = "SectionCapacityError";
    this.code = "SECTION_FULL";
    this.statusCode = 409;
    this.enrolledCount = enrolledCount;
    this.maxSlots = maxSlots;
  }
}

const sendCourseTaggingError = (res, err) => {
  if (err?.code === "SECTION_FULL") {
    return res.status(409).json({
      error: err.code,
      message: err.message,
      enrolled_count: err.enrolledCount,
      max_slots: err.maxSlots,
    });
  }

  if (err?.code === "SECTION_NOT_FOUND") {
    return res.status(404).json({
      error: err.code,
      message: err.message,
    });
  }

  return res.status(500).json({
    error: "Database error",
    message: err?.message || "Unable to update course enrollment.",
  });
};

const assertSectionCapacity = async ({
  connection,
  sectionId,
  courseId,
  activeSchoolYearId,
}) => {
  if (!sectionId) return;

  const [slotRows] = await connection.query(
    `
    SELECT
      dst.id AS department_section_id,
      COALESCE(sst.max_slots, 0) AS max_slots
    FROM dprtmnt_section_table dst
    LEFT JOIN section_subject_table sst
      ON sst.department_section_id = dst.id
      AND sst.course_id = ?
      AND sst.active_school_year_id = ?
      AND sst.is_active = 1
    WHERE dst.id = ?
    ORDER BY sst.id DESC
    LIMIT 1
    FOR UPDATE
    `,
    [courseId, activeSchoolYearId, sectionId],
  );

  if (!slotRows.length) {
    const sectionError = new Error("Selected section was not found.");
    sectionError.code = "SECTION_NOT_FOUND";
    throw sectionError;
  }

  const maxSlots = Number(slotRows[0].max_slots) || 0;
  const [[countRow]] = await connection.query(
    `
    SELECT COUNT(DISTINCT student_number) AS enrolled_count
    FROM enrolled_subject
    WHERE department_section_id = ?
      AND course_id = ?
      AND active_school_year_id = ?
    `,
    [sectionId, courseId, activeSchoolYearId],
  );
  const enrolledCount = Number(countRow?.enrolled_count) || 0;

  if (maxSlots <= 0 || enrolledCount >= maxSlots) {
    throw new SectionCapacityError({ enrolledCount, maxSlots });
  }
};

/**
 * Serializes enrollment changes through the section/subject slot row.
 * A max_slots value of 0 (or less) means enrollment is closed.
 */
const runWithSectionCapacity = async ({
  sectionId,
  courseId,
  activeSchoolYearId,
  mutation,
}) => {
  const connection = await db3.getConnection();

  try {
    await connection.beginTransaction();

    await assertSectionCapacity({
      connection,
      sectionId,
      courseId,
      activeSchoolYearId,
    });

    const result = await mutation(connection);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
};

const getStudentSearchFailure = async ({
  studentNumber,
  dprtmntId,
  activeSchoolYearId,
}) => {
  const [studentRows] = await db3.query(
    `SELECT sn.student_number, ptbl.program
     FROM student_numbering_table AS sn
     LEFT JOIN person_table AS ptbl ON sn.person_id = ptbl.person_id
     WHERE sn.student_number = ?
     LIMIT 1`,
    [studentNumber],
  );

  if (studentRows.length === 0) {
    return "Student record was not found. Please check the student number.";
  }

  const effectiveSchoolYearId = await getActiveSchoolYearId(activeSchoolYearId);
  if (!effectiveSchoolYearId) {
    return "No active academic year is configured. Please set an active academic year first.";
  }

  const [statusRows] = await db3.query(
    `SELECT ss.student_number, ss.active_curriculum, ss.year_level_id, ptbl.program
     FROM student_status_table AS ss
     LEFT JOIN student_numbering_table AS sn ON ss.student_number = sn.student_number
     LEFT JOIN person_table AS ptbl ON sn.person_id = ptbl.person_id
     WHERE ss.student_number = ?
       AND (ss.active_school_year_id = 0 OR ss.active_school_year_id = ?)`,
    [studentNumber, effectiveSchoolYearId],
  );

  if (statusRows.length === 0) {
    return "This student has no student status record in the current academic year.";
  }

  const studentStatus = statusRows[0];
  const effectiveCurriculum =
    studentStatus.active_curriculum || studentStatus.program;

  if (!effectiveCurriculum || Number(effectiveCurriculum) === 0) {
    return "This student has no curriculum/program assigned yet.";
  }

  if (!studentStatus.year_level_id) {
    return "This student has no year level assigned for the current academic year.";
  }

  if (dprtmntId != null) {
    const [departmentRows] = await db3.query(
      `SELECT dct.curriculum_id
       FROM dprtmnt_curriculum_table AS dct
       WHERE dct.curriculum_id = ?
         AND dct.dprtmnt_id = ?
       LIMIT 1`,
      [effectiveCurriculum, dprtmntId],
    );

    if (departmentRows.length === 0) {
      return "This student is not assigned to your department or curriculum.";
    }
  }

  return "Student record could not be loaded. Please check the student's academic setup.";
};

// YEAR LEVEL TABLE
router.get("/get_year_level", async (req, res) => {
  const query = "SELECT * FROM year_level_table";

  try {
    const [result] = await db3.query(query);
    res.status(200).json(result);
  } catch (err) {
    console.error("Query error:", err);
    res.status(500).json({
      error: "Failed to retrieve year level data",
      details: err.message,
    });
  }
});

// ACTIVE SEMESTER
router.get("/get_active_semester", async (req, res) => {
  try {
    const semester = await db3.query(`
      SELECT smt.semester_id, smt.semester_description
      FROM active_school_year_table AS sy
      LEFT JOIN semester_table AS smt ON sy.semester_id = smt.semester_id
      WHERE sy.astatus = 1;
    `);

    res.json(semester[0]);
  } catch (err) {
    res.status(500).json(err);
  }
});

// COURSES BY CURRICULUM
router.get("/courses/:currId", async (req, res) => {
  const { currId } = req.params;

  const sql = `
    SELECT
      ctt.program_tagging_id,
      ctt.curriculum_id,
      ctt.course_id,
      ctt.year_level_id,
      ctt.semester_id,
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
      cat.category_type_name
    FROM program_tagging_table ctt
    INNER JOIN course_table c
      ON c.course_id = ctt.course_id
    LEFT JOIN subject_type_table st
      ON st.subject_type_id = c.subject_type_id
    LEFT JOIN category_type_table cat
      ON cat.category_type_id = c.category_type_id
    WHERE ctt.curriculum_id = ?
    ORDER BY c.course_code
  `;

  try {
    const [result] = await db3.query(sql, [currId]);
    res.json(result);
  } catch (err) {
    console.error("Error in fetching courses:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ALL UNIQUE COURSES FROM ACTIVE CURRICULA IN A DEPARTMENT
router.get(
  "/department-active-courses/:departmentId",
  requireRegistrarCourseTaggingAccess,
  async (req, res) => {
    const { departmentId } = req.params;

    if (!departmentId || !/^\d+$/.test(String(departmentId))) {
      return res.status(400).json({ error: "A valid department ID is required." });
    }

    try {
      const [rows] = await db3.query(
        `
        SELECT
          ctt.program_tagging_id,
          ctt.curriculum_id,
          ctt.course_id,
          ctt.year_level_id,
          ctt.semester_id,
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
          cat.category_type_name
        FROM dprtmnt_curriculum_table dc
        INNER JOIN curriculum_table ct
          ON ct.curriculum_id = dc.curriculum_id
         AND ct.lock_status = 1
        INNER JOIN program_tagging_table ctt
          ON ctt.curriculum_id = ct.curriculum_id
        INNER JOIN course_table c
          ON c.course_id = ctt.course_id
        LEFT JOIN subject_type_table st
          ON st.subject_type_id = c.subject_type_id
        LEFT JOIN category_type_table cat
          ON cat.category_type_id = c.category_type_id
        WHERE dc.dprtmnt_id = ?
        ORDER BY c.course_code, ctt.curriculum_id, ctt.year_level_id, ctt.semester_id
        `,
        [departmentId],
      );

      const uniqueCourses = new Map();
      rows.forEach((course) => {
        const key = String(course.course_id);
        if (!uniqueCourses.has(key)) {
          uniqueCourses.set(key, {
            ...course,
            prereq_list: course.prereq
              ? String(course.prereq)
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean)
              : [],
          });
        }
      });

      return res.json(Array.from(uniqueCourses.values()));
    } catch (err) {
      console.error("Error fetching department active courses:", err);
      return res.status(500).json({
        error: "Failed to retrieve department courses.",
        details: err.message,
      });
    }
  },
);

// COURSES BY DEPARTMENT
router.get("/other-departments", async (req, res) => {
  const {deptIds} = req.query;
  try{
    const [activeYearRows] = await db3.query(
      "SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1"
    );

    if (!activeYearRows.length) {
      return res.status(400).json({ message: "No active school year found" });
    }

    const activeYearId = activeYearRows[0].id;

    const [rows] = await db3.query(
      `SELECT request_dept_id FROM dprtmnt_grant_table WHERE requesting_dept_id IN (?) AND active_school_year_id = ?`
    , [deptIds, activeYearId])

    res.json(rows); 
  } catch (err) {
    console.error("Error in fetching courses:", err);
    return res.status(500).json({ error: err.message });
  }
})

router.get("/program-summer-subjects/check", async (req, res) => {
  const { curriculum_id, semester_id, active_school_year_id, year_level_id } =
    req.query;

  if (!curriculum_id) {
    return res.status(400).json({ message: "curriculum_id is required" });
  }

  try {
    let effectiveSemesterId = semester_id;
    let schoolYearLabel = "";

    if (!effectiveSemesterId && active_school_year_id) {
      const [schoolYearRows] = await db3.query(
        `
        SELECT
          asyt.semester_id,
          yt.year_description,
          smt.semester_description
        FROM active_school_year_table asyt
        LEFT JOIN year_table yt ON yt.year_id = asyt.year_id
        LEFT JOIN semester_table smt ON smt.semester_id = asyt.semester_id
        WHERE asyt.id = ?
        LIMIT 1
        `,
        [active_school_year_id],
      );

      effectiveSemesterId = schoolYearRows[0]?.semester_id;
      schoolYearLabel = [
        schoolYearRows[0]?.year_description,
        schoolYearRows[0]?.semester_description,
      ]
        .filter(Boolean)
        .join(", ");
    }

    if (!effectiveSemesterId) {
      return res
        .status(400)
        .json({ message: "semester_id or active_school_year_id is required" });
    }

    const yearLevelClause = year_level_id ? "AND ptt.year_level_id = ?" : "";

    const [rows] = await db3.query(
      `
      SELECT
        COUNT(DISTINCT ptt.course_id) AS subject_count,
        pt.program_code,
        pt.program_description,
        pt.major,
        smt.semester_description
      FROM curriculum_table ct
      LEFT JOIN program_table pt ON pt.program_id = ct.program_id
      LEFT JOIN semester_table smt ON smt.semester_id = ?
      LEFT JOIN program_tagging_table ptt
        ON ptt.curriculum_id = ct.curriculum_id
       AND ptt.semester_id = smt.semester_id
       ${yearLevelClause}
      WHERE ct.curriculum_id = ?
      GROUP BY
        pt.program_code,
        pt.program_description,
        pt.major,
        smt.semester_description
      LIMIT 1
      `,
      year_level_id
        ? [effectiveSemesterId, year_level_id, curriculum_id]
        : [effectiveSemesterId, curriculum_id],
    );

    const row = rows[0] || {};
    const subjectCount = Number(row.subject_count || 0);

    res.json({
      hasSummerSubjects: subjectCount > 0,
      subjectCount,
      curriculum_id: Number(curriculum_id),
      semester_id: Number(effectiveSemesterId),
      year_level_id: year_level_id ? Number(year_level_id) : null,
      programCode: row.program_code || "",
      programDescription: row.program_description || "",
      major: row.major || "",
      semesterDescription: row.semester_description || "",
      schoolYearLabel,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Database error", error: err.message });
  }
});

// ENROLL ALL SUBJECTS (YEAR 1 + ACTIVE SEM)
router.post("/add-all-to-enrolled-courses", async (req, res) => {
  const {
    subject_ids,
    subject_id, // backward-compat single id
    user_id,
    curriculumID,
    departmentSectionID,
    year_level,
    active_school_year_id,
    active_semester_id,
  } = req.body;

  const subjectIdList = Array.isArray(subject_ids)
    ? subject_ids
    : subject_id != null
      ? [subject_id]
      : [];

  if (!subjectIdList.length) {
    return res.status(400).json({ message: "subject_ids is required" });
  }

  try {
    let activeSchoolYearId = active_school_year_id;
    let activeSemesterId = active_semester_id;

    if (activeSchoolYearId && !activeSemesterId) {
      const [schoolYearRows] = await db3.query(
        `SELECT semester_id FROM active_school_year_table WHERE id = ? LIMIT 1`,
        [activeSchoolYearId],
      );
      activeSemesterId = schoolYearRows[0]?.semester_id || null;
    }

    if (!activeSchoolYearId || !activeSemesterId) {
      const [yearResult] = await db3.query(
        `SELECT id, semester_id FROM active_school_year_table WHERE astatus = 1 LIMIT 1`,
      );
      if (yearResult.length === 0) {
        return res.status(404).json({ error: "No active school year found" });
      }
      activeSchoolYearId = activeSchoolYearId || yearResult[0].id;
      activeSemesterId = activeSemesterId || yearResult[0].semester_id;
    }

    // Special year-level bulk enroll must not overwrite the student's real year level
    // (e.g. keep 1st year while tagging Special Program subjects).
    const [yearLevelMeta] = await db3.query(
      `SELECT level_type FROM year_level_table WHERE year_level_id = ? LIMIT 1`,
      [year_level],
    );
    const isSpecialYearLevel =
      String(yearLevelMeta?.[0]?.level_type || "")
        .trim()
        .toLowerCase() === "special";

    const results = [];
    const enrolledLabels = [];

    for (const subject_id of subjectIdList) {
      const [checkResult] = await db3.query(
        `SELECT year_level_id, semester_id, curriculum_id
         FROM program_tagging_table
         WHERE course_id = ? AND curriculum_id = ?
         LIMIT 1`,
        [subject_id, curriculumID],
      );

      if (!checkResult.length) {
        results.push({ subject_id, enrolled: false, skipped: true, reason: "NOT_FOUND" });
        continue;
      }

      const { year_level_id, semester_id, curriculum_id } = checkResult[0];

      if (
        Number(year_level_id) !== Number(year_level) ||
        Number(semester_id) !== Number(activeSemesterId) ||
        Number(curriculum_id) !== Number(curriculumID)
      ) {
        results.push({ subject_id, enrolled: false, skipped: true, reason: "WRONG_YEAR_SEM_CURR" });
        continue;
      }

      const [dupResult] = await db3.query(
        `SELECT * FROM enrolled_subject
         WHERE course_id = ? AND student_number = ? AND active_school_year_id = ?`,
        [subject_id, user_id, activeSchoolYearId],
      );

      if (dupResult.length > 0) {
        results.push({ subject_id, enrolled: false, skipped: true, reason: "ALREADY_ENROLLED" });
        continue;
      }

      try {
        await runWithSectionCapacity({
          sectionId: departmentSectionID,
          courseId: subject_id,
          activeSchoolYearId,
          mutation: async (connection) => {
            const [result] = await connection.query(
              `INSERT INTO enrolled_subject
               (course_id, student_number, active_school_year_id, curriculum_id, department_section_id, status)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                subject_id,
                user_id,
                activeSchoolYearId,
                curriculumID,
                departmentSectionID,
                1,
              ],
            );
            await autoTagNstpComponent({
              connection,
              enrolledSubjectId: result.insertId,
              studentNumber: user_id,
              courseId: subject_id,
              activeSchoolYearId,
            });
            return [result];
          },
        });
      } catch (err) {
        if (err?.code === "SECTION_FULL") {
          results.push({
            subject_id,
            enrolled: false,
            skipped: true,
            reason: "SECTION_FULL",
            message: err.message,
            enrolled_count: err.enrolledCount,
            max_slots: err.maxSlots,
          });
          continue;
        }
        throw err;
      }

      if (isSpecialYearLevel) {
        await db3.query(
          `UPDATE student_status_table
           SET enrolled_status = 1, active_curriculum = ?, active_school_year_id = ?
           WHERE student_number = ?`,
          [curriculumID, activeSchoolYearId, user_id],
        );
      } else {
        await db3.query(
          `UPDATE student_status_table
           SET enrolled_status = 1, active_curriculum = ?, year_level_id = ?, active_school_year_id = ?
           WHERE student_number = ?`,
          [curriculumID, year_level, activeSchoolYearId, user_id],
        );
      }

      const [getStudentNUmber] = await db3.query(
        `SELECT id, person_id FROM student_numbering_table WHERE student_number = ?`,
        [user_id],
      );

      if (getStudentNUmber.length > 0) {
        const student_numbering_id = getStudentNUmber[0].id;
        const person_id = getStudentNUmber[0].person_id;

        const [getDepartmentID] = await db3.query(
          `SELECT dprtmnt_id FROM dprtmnt_curriculum_table WHERE curriculum_id = ?`,
          [curriculumID],
        );

        if (getDepartmentID.length > 0) {
          await db3.query(
            `UPDATE user_accounts SET dprtmnt_id = ? WHERE person_id = ?`,
            [getDepartmentID[0].dprtmnt_id, person_id],
          );
        }

        const [checkExistingCurriculum] = await db3.query(
          `SELECT * FROM student_curriculum_table
           WHERE student_numbering_id = ? AND curriculum_id = ?`,
          [student_numbering_id, curriculum_id],
        );

        if (checkExistingCurriculum.length === 0) {
          await db3.query(
            `INSERT INTO student_curriculum_table (student_numbering_id, curriculum_id) VALUES (?, ?)`,
            [student_numbering_id, curriculum_id],
          );
        }
      }

      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      const courseLabel = await getCourseLabel(subject_id);
      await insertCourseTaggingAuditLog({
        req,
        action: "COURSE_TAGGING_BULK_ENROLL",
        message: `${roleLabel} (${actorId}) enrolled ${courseLabel} to Student (${user_id}) via bulk course tagging.`,
      });

      enrolledLabels.push(courseLabel);
      results.push({ subject_id, enrolled: true, skipped: false });
    }

    if (enrolledLabels.length > 0) {
      await logCourseTaggingStudentHistory({
        req,
        action: "bulk_enroll",
        studentNumber: user_id,
        departmentSectionId: departmentSectionID,
        activeSchoolYearId,
        courses: enrolledLabels,
      });
    }

    res.status(200).json({
      message: "Bulk enrollment processed",
      enrolledCount: enrolledLabels.length,
      fullCount: results.filter((item) => item.reason === "SECTION_FULL").length,
      results,
    });
  } catch (err) {
    console.error("Error:", err);
    return sendCourseTaggingError(res, err);
  }
});

// ENROLL SINGLE SUBJECT
router.post("/add-to-enrolled-courses/:userId/:currId/", async (req, res) => {
  const { subject_id, department_section_id, active_school_year_id } = req.body;
  const { userId, currId } = req.params;

  try {
    let activeSchoolYearId = active_school_year_id;

    if (!activeSchoolYearId) {
      const activeYearSql = `SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1`;
      const [yearResult] = await db3.query(activeYearSql);

      if (yearResult.length === 0) {
        return res.status(404).json({ error: "No active school year found" });
      }

      activeSchoolYearId = yearResult[0].id;
    }

    const sql =
      "INSERT INTO enrolled_subject (course_id, student_number, active_school_year_id, curriculum_id, department_section_id) VALUES (?, ?, ?, ?, ?)";
    await runWithSectionCapacity({
      sectionId: department_section_id,
      courseId: subject_id,
      activeSchoolYearId,
      mutation: async (connection) => {
        const [result] = await connection.query(sql, [
          subject_id,
          userId,
          activeSchoolYearId,
          currId,
          department_section_id,
        ]);
        await autoTagNstpComponent({
          connection,
          enrolledSubjectId: result.insertId,
          studentNumber: userId,
          courseId: subject_id,
          activeSchoolYearId,
        });
        return [result];
      },
    });

    const [getStudentNUmber] = await db3.query(
      `
      SELECT id FROM student_numbering_table WHERE student_number = ?
    `,
      [userId],
    );

    if (getStudentNUmber.length === 0) {
      throw new Error("Student number not found");
    }

    const student_numbering_id = getStudentNUmber[0].id;

    const [checkExistingCurriculum] = await db3.query(
      `
      SELECT * FROM student_curriculum_table
      WHERE student_numbering_id = ? AND curriculum_id = ?
      `,
      [student_numbering_id, currId],
    );

    if (checkExistingCurriculum.length === 0) {
      await db3.query(
        `
        INSERT INTO student_curriculum_table (student_numbering_id, curriculum_id)
        VALUES (?, ?)
        `,
        [student_numbering_id, currId],
      );
    } else {
      console.log(`Curriculum ${currId} already exists for student ${userId}`);
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const courseLabel = await getCourseLabel(subject_id);
    await insertCourseTaggingAuditLog({
      req,
      action: "COURSE_TAGGING_ENROLL",
      message: `${roleLabel} (${actorId}) enrolled ${courseLabel} to Student (${userId}).`,
    });

    await logCourseTaggingStudentHistory({
      req,
      action: "enroll_course",
      studentNumber: userId,
      courseId: subject_id,
      departmentSectionId: department_section_id,
      activeSchoolYearId,
    });

    res.json({ message: "Course enrolled successfully" });
  } catch (err) {
    return sendCourseTaggingError(res, err);
  }
});

// Other-department course enroll: INSERT enrolled_subject only (no curriculum/student side effects)
router.post(
  "/add-other-department-enrolled-course/:userId",
  async (req, res) => {
    const { userId } = req.params;
    const { subject_id, department_section_id, curriculum_id, active_school_year_id } =
      req.body;

    if (!subject_id || !department_section_id || !curriculum_id) {
      return res.status(400).json({
        error:
          "subject_id, department_section_id, and curriculum_id are required",
      });
    }

    try {
      let activeSchoolYearId = active_school_year_id;

      if (!activeSchoolYearId) {
        const [yearResult] = await db3.query(
          `SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1`,
        );

        if (yearResult.length === 0) {
          return res.status(404).json({ error: "No active school year found" });
        }

        activeSchoolYearId = yearResult[0].id;
      }

      await runWithSectionCapacity({
        sectionId: department_section_id,
        courseId: subject_id,
        activeSchoolYearId,
          mutation: async (connection) => {
          const [result] = await connection.query(
            `INSERT INTO enrolled_subject
              (course_id, student_number, active_school_year_id, curriculum_id, department_section_id)
             VALUES (?, ?, ?, ?, ?)`,
            [
              subject_id,
              userId,
              activeSchoolYearId,
              curriculum_id,
              department_section_id,
            ],
          );
          await autoTagNstpComponent({
            connection,
            enrolledSubjectId: result.insertId,
            studentNumber: userId,
            courseId: subject_id,
            activeSchoolYearId,
          });
          return [result];
        },
      });

      res.json({ message: "Other department course enrolled successfully" });
    } catch (err) {
      console.error("Error in /add-other-department-enrolled-course:", err);
      return sendCourseTaggingError(res, err);
    }
  },
);

router.post("/add-student-courses/:userId", async (req, res) => {
  const { subject_id, active_school_year_id, curriculum_id } = req.body;
  const { userId } = req.params;

  try {
    let activeSchoolYearId = active_school_year_id;

    if (!activeSchoolYearId) {
      const [activeYearRows] = await db3.query(
        "SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1",
      );

      if (activeYearRows.length === 0) {
        return res.status(404).json({ message: "No active school year found" });
      }

      activeSchoolYearId = activeYearRows[0].id;
    }

    if (!subject_id || !userId || !curriculum_id) {
      return res.status(400).json({ message: "Missing required course data" });
    }

    const [selectExistingRows] = await db3.query(
      `
        SELECT student_number FROM enrolled_subject WHERE course_id = ? AND student_number = ? AND active_school_year_id = ? AND curriculum_id = ?
      `,
      [subject_id, userId, activeSchoolYearId, curriculum_id],
    );

    if (selectExistingRows.length > 0) {
      return res.status(400).json({ message: "Record already existed" });
    }

    const sql =
      "INSERT INTO enrolled_subject (course_id, student_number, active_school_year_id, curriculum_id, department_section_id) VALUES (?, ?, ?, ?, ?)";

    const [result] = await db3.query(sql, [
      subject_id,
      userId,
      activeSchoolYearId,
      curriculum_id,
      null,
    ]);

    await autoTagNstpComponent({
      connection: db3,
      enrolledSubjectId: result.insertId,
      studentNumber: userId,
      courseId: subject_id,
      activeSchoolYearId,
    });

    res.json({ message: "Course enrolled successfully" });
  } catch (err) {
    return res.status(500).json(err);
  }
});

router.put("/courses/dropped/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const sql = "UPDATE enrolled_subject SET en_remarks = 4 WHERE id = ?";
    await db3.query(sql, [id]);

    res.json({
      message: "Course and related evaluations removed successfully",
    });
  } catch (err) {
    console.error("Error deleting subject:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

router.put("/courses/change/:id", async (req, res) => {
  const { id } = req.params;
  const { course_id } = req.body;

  if (!course_id) {
    return res.status(400).json({ error: "course_id is required" });
  }

  try {
    const sql = "UPDATE enrolled_subject SET course_id = ? WHERE id = ?";
    await db3.query(sql, [course_id, id]);

    res.json({
      message: "Course changed successfully",
    });
  } catch (err) {
    console.error("Error changing subject:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

// Delete a single selected subject + its evaluations
router.delete("/courses/delete/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const enrolledBefore = await getEnrolledSubjectLabel(id);
    const [enrolledMetaRows] = await db3.query(
      `
      SELECT es.student_number, es.active_school_year_id, es.department_section_id, es.course_id
      FROM enrolled_subject es
      WHERE es.id = ?
      LIMIT 1
      `,
      [id],
    );
    const enrolledMeta = enrolledMetaRows?.[0];

    const sql = "DELETE FROM enrolled_subject WHERE id = ?";
    const [result] = await db3.query(sql, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Enrolled course not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertCourseTaggingAuditLog({
      req,
      action: "COURSE_TAGGING_UNENROLL",
      message: `${roleLabel} (${actorId}) unenrolled ${enrolledBefore?.courseLabel || `enrolled_subject ${id}`} from Student (${enrolledBefore?.studentNumber || "unknown"}).`,
    });

    if (enrolledMeta?.student_number && enrolledMeta?.active_school_year_id) {
      const remainingCourses = await getRemainingEnrolledCourseLabels(
        enrolledMeta.student_number,
        enrolledMeta.active_school_year_id,
      );

      await logCourseTaggingStudentHistory({
        req,
        action: "unenroll_course",
        studentNumber: enrolledMeta.student_number,
        courseId: enrolledMeta.course_id,
        departmentSectionId: enrolledMeta.department_section_id,
        activeSchoolYearId: enrolledMeta.active_school_year_id,
        remainingCourses,
      });
    }

    res.json({
      message: "Course and related evaluations removed successfully",
    });
  } catch (err) {
    console.error("Error deleting subject:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

// Delete all courses for user
router.delete("/courses/user/:userId", async (req, res) => {
  const { userId } = req.params;
  const { activeSchoolYearId } = req.query;

  try {
    let effectiveActiveSchoolYearId = activeSchoolYearId;

    if (!effectiveActiveSchoolYearId) {
      const activeYearSql = `SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1`;
      const [yearResult] = await db3.query(activeYearSql);

      if (yearResult.length === 0) {
        return res.status(404).json({ error: "No active school year found" });
      }

      effectiveActiveSchoolYearId = yearResult[0].id;
    }

    const [enrolledBefore] = await db3.query(
  `SELECT es.id, es.department_section_id, c.course_code, c.course_description
   FROM enrolled_subject es
   LEFT JOIN course_table c ON c.course_id = es.course_id
   WHERE es.student_number = ? AND es.active_school_year_id = ?`,
  [userId, effectiveActiveSchoolYearId],
);

    const sql =
      "DELETE FROM enrolled_subject WHERE student_number = ? AND active_school_year_id = ?";
    const [result] = await db3.query(sql, [
      userId,
      effectiveActiveSchoolYearId,
    ]);

    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      const sampleCourses = enrolledBefore
        .slice(0, 5)
        .map(
          (row) =>
            `${row.course_code || "N/A"} - ${row.course_description || "Unknown Course"}`,
        )
        .join(", ");
      const extraCount =
        enrolledBefore.length > 5
          ? ` and ${enrolledBefore.length - 5} more`
          : "";

      await insertCourseTaggingAuditLog({
        req,
        action: "COURSE_TAGGING_UNENROLL_ALL",
        message: `${roleLabel} (${actorId}) unenrolled ${result.affectedRows} course(s) from Student (${userId}). Course(s): ${sampleCourses || "N/A"}${extraCount}.`,
      });

      const unenrolledCourses = enrolledBefore.map(
        (row) =>
          `${row.course_code || "N/A"} (${row.course_description || "Unknown Course"})`,
      );

      const representativeSectionId = enrolledBefore.find((row) => row.department_section_id)?.department_section_id;

      await logCourseTaggingStudentHistory({
        req,
        action: "unenroll_all",
        studentNumber: userId,
        departmentSectionId: representativeSectionId,
        activeSchoolYearId: effectiveActiveSchoolYearId,
        courses: unenrolledCourses,
      });
    }

    res.json({ message: "All courses unenrolled successfully" });
  } catch (err) {
    return res.status(500).json(err);
  }
});

// SEARCH STUDENT (REGISTRAR)
router.post("/student-tagging", async (req, res) => {
  const { studentNumber, active_school_year_id } = req.body;
  if (!studentNumber) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const whereClause = active_school_year_id
      ? "WHERE sn.student_number = ? AND ss.active_school_year_id = ?"
      : "WHERE sn.student_number = ? AND (ss.active_school_year_id = 0 OR sy.astatus = 1)";
    const queryParams = active_school_year_id
      ? [studentNumber, active_school_year_id]
      : [studentNumber];

    const sql = `
      SELECT DISTINCT
        IFNULL(ss.id, "") AS student_status_id ,
        sn.student_number,
        ptbl.person_id,
        ptbl.first_name,
        ptbl.last_name,
        ptbl.middle_name,
        ptbl.age,
        ptbl.gender,
        ptbl.applyingAs,
        ptbl.emailAddress,
        ptbl.program,
        ptbl.profile_img,
        ptbl.extension,
        ss.active_curriculum,
        pt.program_id,
        pt.major,
        pt.program_description,
        pt.program_code,
        yt.year_id,
        yt.year_description,
        es.status AS enrolled_status,
        es.department_section_id,
        st.description AS section_description,
        dt.dprtmnt_id,
        dt.dprtmnt_name,
        ylt.year_level_id,
        ylt.year_level_description,
        ss.active_school_year_id,
        sy.semester_id
    FROM student_numbering_table AS sn
    LEFT JOIN student_status_table AS ss ON sn.student_number = ss.student_number
    LEFT JOIN person_table AS ptbl ON sn.person_id = ptbl.person_id
    LEFT JOIN curriculum_table AS c
      ON c.curriculum_id = COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program)
    LEFT JOIN program_table AS pt ON c.program_id = pt.program_id
    LEFT JOIN year_table AS yt ON c.year_id = yt.year_id
    LEFT JOIN enrolled_subject AS es
      ON ss.student_number = es.student_number
      AND es.active_school_year_id = ss.active_school_year_id
    LEFT JOIN dprtmnt_section_table AS dst ON es.department_section_id = dst.id
    LEFT JOIN section_table AS st ON dst.section_id = st.id
    LEFT JOIN dprtmnt_curriculum_table AS dct ON c.curriculum_id = dct.curriculum_id
    LEFT JOIN dprtmnt_table AS dt ON dct.dprtmnt_id = dt.dprtmnt_id
    LEFT JOIN year_level_table AS ylt ON ss.year_level_id = ylt.year_level_id
    LEFT JOIN active_school_year_table AS sy ON ss.active_school_year_id = sy.id
    ${whereClause} ORDER BY ss.active_school_year_id DESC, ss.id DESC
    `;

    const [results] = await db3.query(sql, queryParams);

    if (results.length === 0) {
      const message = await getStudentSearchFailure({
        studentNumber,
        activeSchoolYearId: active_school_year_id,
      });
      return res.status(404).json({ message });
    }

    const student = results[0];

    const effectiveProgram =
      student.active_curriculum && student.active_curriculum !== 0
        ? student.active_curriculum
        : student.program;

    const feeSql = `
      SELECT
        COALESCE(SUM(lec_fee), 0) AS total_lec_fee,
        COALESCE(SUM(lab_fee), 0) AS total_lab_fee,
        COALESCE(SUM(total_nstp), 0) AS total_nstp,
        COALESCE(SUM(total_computer_lab), 0) AS total_computer_lab,
        COALESCE(SUM(total_laboratory), 0) AS total_laboratory
      FROM (
        SELECT
          course_id,
          MAX(lec_fee) AS lec_fee,
          MAX(lab_fee) AS lab_fee,
          MAX(is_nstp = 1) AS total_nstp,
          MAX(iscomputer_lab = 1) AS total_computer_lab,
          MAX(islaboratory_fee = 1) AS total_laboratory
        FROM program_tagging_table
        WHERE curriculum_id = ?
          AND year_level_id = ?
          AND semester_id = ?
        GROUP BY course_id
      ) fees;

    `;

    const [feeResult] = await db3.query(feeSql, [
      effectiveProgram,
      student.year_level_id,
      student.semester_id,
    ]);

    const totalLecFee = Number(feeResult[0]?.total_lec_fee || 0);
    const totalLabFee = Number(feeResult[0]?.total_lab_fee || 0);
    const totalFees = totalLecFee + totalLabFee;
    const totalNstpCount = Number(feeResult[0]?.total_nstp || 0);
    const totalComputerLab = Number(feeResult[0]?.total_computer_lab || 0);
    const totalLaboratory = Number(feeResult[0]?.total_laboratory || 0);
    const isEnrolled = student.enrolled_status === 1;

    const token2 = webtoken.sign(
      {
        id: student.student_status_id,
        person_id2: student.person_id,
        studentNumber: student.student_number,
        section: student.section_description,
        activeCurriculum: effectiveProgram,
        major: student.major,
        yearLevel: student.year_level_id,
        yearLevelDescription: student.year_level_description,
        courseCode: student.program_code,
        courseDescription: student.program_description,
        departmentName: student.dprtmnt_name,
        yearDesc: student.year_description,
        firstName: student.first_name,
        middleName: student.middle_name,
        lastName: student.last_name,
        age: student.age,
        gender: student.gender,
        applyingAs: student.applyingAs,
        email: student.emailAddress,
        program: student.program,
        profile_img: student.profile_img,
        extension: student.extension,
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
    );

    res.json({
      message: "Search successful",
      token2,
      isEnrolled,
      totalLecFee,
      totalLabFee,
      totalFees,
      totalComputerLab,
      totalLaboratory,
      totalNstpCount,
      studentNumber: student.student_number,
      student_number: student.student_number,
      person_id2: student.person_id,
      person_id: student.person_id,
      section: student.section_description,
      department_section_id: student.department_section_id,
      dprtmnt_id: student.dprtmnt_id,
      activeCurriculum: effectiveProgram,
      active_curriculum: effectiveProgram,
      active_school_year_id: student.active_school_year_id,
      program_id: student.program_id,
      major: student.major,
      yearLevel: student.year_level_id,
      year_level_id: student.year_level_id,
      yearLevelDescription: student.year_level_description,
      year_level_description: student.year_level_description,
      courseCode: student.program_code,
      courseDescription: student.program_description,
      departmentName: student.dprtmnt_name,
      dprtmnt_name: student.dprtmnt_name,
      yearDesc: student.year_description,
      year_description: student.year_description,
      firstName: student.first_name,
      first_name: student.first_name,
      middleName: student.middle_name,
      middle_name: student.middle_name,
      lastName: student.last_name,
      last_name: student.last_name,
      age: student.age,
      gender: student.gender,
      applyingAs: student.applyingAs,
      email: student.emailAddress,
      emailAddress: student.emailAddress,
      program: student.program,
      profile_img: student.profile_img,
      extension: student.extension,
    });
  } catch (err) {
    console.error("SQL error:", err);
    return res.status(500).json({ message: "Database error" });
  }
});

router.post("/registrar/resolve-student-scope", async (req, res) => {
  const { studentNumber, active_school_year_id, employee_id } = req.body;

  if (!studentNumber) {
    return res.status(400).json({ message: "Student number is required." });
  }

  const employeeId =
    employee_id ||
    req.headers["x-employee-id"] ||
    req.headers["x-audit-actor-id"] ||
    null;

  try {
    const result = await resolveStudentScopeForEmployee(
      employeeId,
      studentNumber,
      {
        activeSchoolYearId: active_school_year_id,
      },
    );

    if (result.error) {
      return res.status(404).json({ message: result.error });
    }

    return res.json(result);
  } catch (err) {
    console.error("Failed to resolve student scope:", err);
    return res
      .status(500)
      .json({ message: "Failed to resolve student scope." });
  }
});

// SEARCH STUDENT BY DEPARTMENT
router.post("/student-tagging/dprtmnt", async (req, res) => {
  const { studentNumber, dprtmntId, active_school_year_id } = req.body;

  if (!studentNumber || dprtmntId == null) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const whereClause = active_school_year_id
      ? "WHERE sn.student_number = ? AND dct.dprtmnt_id = ?"
      : "WHERE sn.student_number = ? AND dct.dprtmnt_id = ? AND (ss.active_school_year_id = 0 OR sy.astatus = 1)";
    const queryParams = active_school_year_id
      ? [studentNumber, dprtmntId]
      : [studentNumber, dprtmntId];

    const sql = `
      SELECT DISTINCT
        IFNULL(ss.id, "") AS student_status_id ,
        sn.student_number,
        ptbl.person_id,
        ptbl.first_name,
        ptbl.last_name,
        ptbl.middle_name,
        ptbl.age,
        ptbl.gender,
        ptbl.applyingAs,
        ptbl.emailAddress,
        ptbl.program,
        ptbl.profile_img,
        ptbl.extension,
        ss.active_curriculum,
        pt.program_id,
        pt.major,
        pt.program_description,
        pt.program_code,
        yt.year_id,
        yt.year_description,
        es.status AS enrolled_status,
        es.department_section_id,
        st.description AS section_description,
        dt.dprtmnt_id,
        dt.dprtmnt_name,
        ylt.year_level_id,
        ylt.year_level_description,
        ss.active_school_year_id,
        sy.semester_id
    FROM student_numbering_table AS sn
    LEFT JOIN student_status_table AS ss ON sn.student_number = ss.student_number
    LEFT JOIN person_table AS ptbl ON sn.person_id = ptbl.person_id
    LEFT JOIN curriculum_table AS c
      ON c.curriculum_id = COALESCE(NULLIF(ss.active_curriculum, 0), ptbl.program)
    LEFT JOIN program_table AS pt ON c.program_id = pt.program_id
    LEFT JOIN year_table AS yt ON c.year_id = yt.year_id
    LEFT JOIN enrolled_subject AS es ON ss.student_number = es.student_number
    LEFT JOIN dprtmnt_section_table AS dst ON es.department_section_id = dst.id
    LEFT JOIN section_table AS st ON dst.section_id = st.id
    LEFT JOIN dprtmnt_curriculum_table AS dct ON c.curriculum_id = dct.curriculum_id
    LEFT JOIN dprtmnt_table AS dt ON dct.dprtmnt_id = dt.dprtmnt_id
    LEFT JOIN year_level_table AS ylt ON ss.year_level_id = ylt.year_level_id
    LEFT JOIN active_school_year_table AS sy ON ss.active_school_year_id = sy.id
    ${whereClause};
    `;

    const [results] = await db3.query(sql, queryParams);

    if (results.length === 0) {
      const message = await getStudentSearchFailure({
        studentNumber,
        dprtmntId,
        activeSchoolYearId: active_school_year_id,
      });
      return res.status(404).json({ message });
    }

    const student = results[0];

    const feeSql = `
      SELECT
        COALESCE(SUM(lec_fee), 0) AS total_lec_fee,
        COALESCE(SUM(lab_fee), 0) AS total_lab_fee,
        COALESCE(SUM(total_nstp), 0) AS total_nstp,
        COALESCE(SUM(total_computer_lab), 0) AS total_computer_lab,
        COALESCE(SUM(total_laboratory), 0) AS total_laboratory
      FROM (
        SELECT
          course_id,
          MAX(lec_fee) AS lec_fee,
          MAX(lab_fee) AS lab_fee,
          MAX(is_nstp = 1) AS total_nstp,
          MAX(iscomputer_lab = 1) AS total_computer_lab,
          MAX(islaboratory_fee = 1) AS total_laboratory
        FROM program_tagging_table
        WHERE curriculum_id = ?
          AND year_level_id = ?
          AND semester_id = ?
        GROUP BY course_id
      ) fees;
    `;
    const [feeResult] = await db3.query(feeSql, [
      student.active_curriculum,
      student.year_level_id,
      student.semester_id,
    ]);

    const totalLecFee = Number(feeResult[0]?.total_lec_fee || 0);
    const totalLabFee = Number(feeResult[0]?.total_lab_fee || 0);
    const totalFees = totalLecFee + totalLabFee;
    const totalNstpCount = Number(feeResult[0]?.total_nstp || 0);
    const totalComputerLab = Number(feeResult[0]?.total_computer_lab || 0);
    const totalLaboratory = Number(feeResult[0]?.total_laboratory || 0);
    const isEnrolled = student.enrolled_status === 1;
    const savedScholarship = await getSavedScholarshipDetails(
      student.student_number,
      student.active_school_year_id || active_school_year_id || null,
    );

    const effectiveProgram =
      student.active_curriculum && student.active_curriculum !== 0
        ? student.active_curriculum
        : student.program;

    const token2 = webtoken.sign(
      {
        id: student.student_status_id,
        person_id2: student.person_id,
        studentNumber: student.student_number,
        section: student.section_description,
        activeCurriculum: effectiveProgram,
        major: student.major,
        yearLevel: student.year_level_id,
        yearLevelDescription: student.year_level_description,
        courseCode: student.program_code,
        courseDescription: student.program_description,
        departmentName: student.dprtmnt_name,
        yearDesc: student.year_description,
        firstName: student.first_name,
        middleName: student.middle_name,
        lastName: student.last_name,
        age: student.age,
        gender: student.gender,
        email: student.emailAddress,
        program: student.program,
        profile_img: student.profile_img,
        extension: student.extension,
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
    );

    const corData = {
      student_number: student.student_number,
      person_id: student.person_id,
      profile_img: student.profile_img,
      lrnNumber: student.lrnNumber,
      cellphoneNumber: student.cellphoneNumber,
      last_name: student.last_name,
      middle_name: student.middle_name,
      campus: student.campus,
      first_name: student.first_name,
      extension: student.extension,
      gender: student.gender,
      age: student.age,
      email: student.emailAddress,
      curriculum: student.active_curriculum,
      yearlevel: student.year_level_id,
      program: student.program_description,
      program_code: student.program_code,
      college: student.dprtmnt_name,
      active_school_year_id: student.active_school_year_id,
      scholarship_id: savedScholarship?.scholarship_id ?? null,
      scholarship_code: savedScholarship?.scholarship_code || "",
      scholarship_name: savedScholarship?.scholarship_name || "",
      scholarship_source: savedScholarship?.scholarship_source || "",
    };

    res.json({
      message: "Search successful",
      token2,
      isEnrolled,
      totalLecFee,
      totalLabFee,
      totalFees,
      totalComputerLab,
      totalLaboratory,
      totalNstpCount,
      studentNumber: student.student_number,
      person_id2: student.person_id,
      section: student.section_description,
      department_section_id: student.department_section_id,
      dprtmnt_id: student.dprtmnt_id,
      activeCurriculum: effectiveProgram,
      program_id: student.program_id,
      major: student.major,
      yearLevel: student.year_level_id,
      yearLevelDescription: student.year_level_description,
      courseCode: student.program_code,
      courseDescription: student.program_description,
      departmentName: student.dprtmnt_name,
      yearDesc: student.year_description,
      firstName: student.first_name,
      middleName: student.middle_name,
      lastName: student.last_name,
      age: student.age,
      gender: student.gender,
      applyingAs: student.applyingAs,
      email: student.emailAddress,
      program: student.program,
      profile_img: student.profile_img,
      extension: student.extension,
      corData,
    });
  } catch (err) {
    console.error("SQL error:", err);
    return res.status(500).json({ message: "Database error" });
  }
});

// ENROLLED COURSES
router.get("/enrolled_courses/:userId/:currId", async (req, res) => {
  const { userId, currId } = req.params;
  const { activeSchoolYearId, includeOtherCurricula } = req.query;
  const includeOther =
    includeOtherCurricula === "1" ||
    String(includeOtherCurricula).toLowerCase() === "true";

  try {
    let effectiveActiveSchoolYearId = activeSchoolYearId;

    if (!effectiveActiveSchoolYearId) {
      const activeYearSql = `SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1`;
      const [yearResult] = await db3.query(activeYearSql);

      if (yearResult.length === 0) {
        return res.status(404).json({ error: "No active school year found" });
      }

      effectiveActiveSchoolYearId = yearResult[0].id;
    }

    const sql = `
      SELECT
        es.id,
        es.course_id,
        es.curriculum_id,
        c.course_code,
        c.course_description,
        st.description,
        c.course_unit,
        c.lab_unit,
        c.lec_unit,
        ds.id AS department_section_id,
        IFNULL(COALESCE(pt_es.program_code, pt_sec.program_code), 'TBA') AS program_code,
        IFNULL(COALESCE(pt_es.program_description, pt_sec.program_description), 'TBA') AS program_description,
        IFNULL(st.description, 'TBA') AS section,
        IFNULL(rd.description, 'TBA') AS day_description,
        IFNULL(tt.school_time_start, 'TBA') AS school_time_start,
        IFNULL(tt.school_time_end, 'TBA') AS school_time_end,
        IFNULL(rtbl.room_description, 'TBA') AS room_description,
        IFNULL(prof_table.lname, 'TBA') AS lname,
        IFNULL(prof_table.fname, 'TBA') AS fname,
        COALESCE(es_count.number_of_enrolled, 0) AS number_of_enrolled

      FROM enrolled_subject AS es
      INNER JOIN course_table AS c
        ON c.course_id = es.course_id
      LEFT JOIN dprtmnt_section_table AS ds
        ON ds.id = es.department_section_id
      LEFT JOIN section_table AS st
        ON st.id = ds.section_id
      LEFT JOIN curriculum_table AS cr_es
        ON cr_es.curriculum_id = es.curriculum_id
      LEFT JOIN program_table AS pt_es
        ON pt_es.program_id = cr_es.program_id
      LEFT JOIN curriculum_table AS cr_sec
        ON cr_sec.curriculum_id = ds.curriculum_id
      LEFT JOIN program_table AS pt_sec
        ON pt_sec.program_id = cr_sec.program_id
      LEFT JOIN time_table AS tt
        ON tt.school_year_id = es.active_school_year_id
        AND tt.department_section_id = es.department_section_id
        AND tt.course_id = es.course_id
      LEFT JOIN room_day_table AS rd
        ON rd.id = tt.room_day
      LEFT JOIN dprtmnt_room_table as dr
        ON dr.dprtmnt_room_id = tt.department_room_id
      LEFT JOIN room_table as rtbl
        ON rtbl.room_id = dr.room_id
      LEFT JOIN prof_table
        ON prof_table.prof_id = tt.professor_id
      LEFT JOIN (
        SELECT
          active_school_year_id,
          department_section_id,
          course_id,
          COUNT(*) AS number_of_enrolled
        FROM enrolled_subject
        GROUP BY active_school_year_id, department_section_id, course_id
      ) AS es_count
        ON es_count.active_school_year_id = es.active_school_year_id
        AND es_count.department_section_id = es.department_section_id
        AND es_count.course_id = es.course_id
      WHERE es.student_number = ?
        AND es.active_school_year_id = ?
        ${includeOther ? "" : "AND es.curriculum_id = ?"}
        AND COALESCE(NULLIF(TRIM(c.course_code), ''), NULLIF(TRIM(c.course_description), '')) IS NOT NULL
      ORDER BY
        CASE WHEN es.curriculum_id = ? THEN 0 ELSE 1 END,
        c.course_id ASC;
    `;

    const params = includeOther
      ? [userId, effectiveActiveSchoolYearId, currId]
      : [userId, effectiveActiveSchoolYearId, currId, currId];

    const [result] = await db3.query(sql, params);
    res.json(result);
  } catch (err) {
    console.error("Error in /enrolled_courses:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/student-tagging-batch", async (req, res) => {
  const { studentNumbers, selectedYearLevel, activeSchoolYearId } = req.body;

  if (
    !studentNumbers ||
    !Array.isArray(studentNumbers) ||
    studentNumbers.length === 0
  ) {
    return res.status(400).json({ message: "Student numbers are required" });
  }

  try {
    // SQL: WHERE sn.student_number IN (?, ?, ?)
    const placeholders = studentNumbers.map(() => "?").join(",");

    const sql = `
      SELECT DISTINCT
        IFNULL(ss.id, "") AS student_status_id,
        sn.student_number,
        ptbl.person_id,
        ptbl.first_name,
        ptbl.last_name,
        ptbl.middle_name,
        ptbl.campus,
        ptbl.lrnNumber,
        ptbl.cellphoneNumber,
        ptbl.age,
        ptbl.gender,
        ptbl.emailAddress,
        ptbl.program,
        ptbl.profile_img,
        ptbl.extension,
        ss.active_curriculum,
        pt.program_id,
        pt.major,
        pt.program_description,
        pt.program_code,
        yt.year_id,
        yt.year_description,
        es.status AS enrolled_status,
        es.department_section_id,
        st.description AS section_description,
        dt.dprtmnt_name,
        ylt.year_level_id,
        ylt.year_level_description,
        ss.active_school_year_id,
        sy.semester_id
      FROM student_numbering_table AS sn
      INNER JOIN student_status_table AS ss ON sn.student_number = ss.student_number
      INNER JOIN person_table AS ptbl ON sn.person_id = ptbl.person_id
      INNER JOIN curriculum_table AS c ON ss.active_curriculum = c.curriculum_id
      INNER JOIN program_table AS pt ON c.program_id = pt.program_id
      INNER JOIN year_table AS yt ON c.year_id = yt.year_id
      LEFT JOIN enrolled_subject AS es
        ON ss.student_number = es.student_number
       AND es.active_school_year_id = ss.active_school_year_id
      LEFT JOIN dprtmnt_section_table AS dst ON es.department_section_id = dst.id
      LEFT JOIN section_table AS st ON dst.section_id = st.id
      LEFT JOIN dprtmnt_curriculum_table AS dct ON c.curriculum_id = dct.curriculum_id
      LEFT JOIN dprtmnt_table AS dt ON dct.dprtmnt_id = dt.dprtmnt_id
      INNER JOIN year_level_table AS ylt ON ss.year_level_id = ylt.year_level_id
      INNER JOIN active_school_year_table AS sy ON ss.active_school_year_id = sy.id
      WHERE sn.student_number IN (${placeholders})
        AND ss.year_level_id = ?
        ${activeSchoolYearId ? "AND ss.active_school_year_id = ?" : ""}
    `;

    const queryParams = activeSchoolYearId
      ? [...studentNumbers, selectedYearLevel, activeSchoolYearId]
      : [...studentNumbers, selectedYearLevel];

    const [results] = await db3.query(sql, queryParams);

    if (!results.length) {
      return res
        .status(400)
        .json({ message: "No valid student numbers found" });
    }

    const studentsWithFees = await Promise.all(
      results.map(async (student) => {
        const feeSql = `
          SELECT
            COALESCE(SUM(lec_fee), 0) AS total_lec_fee,
            COALESCE(SUM(lab_fee), 0) AS total_lab_fee,
            COALESCE(SUM(total_nstp), 0) AS total_nstp,
            COALESCE(SUM(total_computer_lab), 0) AS total_computer_lab,
            COALESCE(SUM(total_laboratory), 0) AS total_laboratory
          FROM (
            SELECT
              course_id,
              MAX(lec_fee) AS lec_fee,
              MAX(lab_fee) AS lab_fee,
              MAX(is_nstp = 1) AS total_nstp,
              MAX(iscomputer_lab = 1) AS total_computer_lab,
              MAX(islaboratory_fee = 1) AS total_laboratory
            FROM program_tagging_table
            WHERE curriculum_id = ?
              AND year_level_id = ?
              AND semester_id = ?
            GROUP BY course_id
          ) fees;
        `;
        const [feeResult] = await db3.query(feeSql, [
          student.active_curriculum,
          student.year_level_id,
          student.semester_id,
        ]);

        const totalLecFee = Number(feeResult[0]?.total_lec_fee || 0);
        const totalLabFee = Number(feeResult[0]?.total_lab_fee || 0);
        const totalNstpCount = Number(feeResult[0]?.total_nstp || 0);
        const totalComputerLab = Number(feeResult[0]?.total_computer_lab || 0);
        const totalLaboratory = Number(feeResult[0]?.total_laboratory || 0);
        const savedScholarship = await getSavedScholarshipDetails(
          student.student_number,
          student.active_school_year_id || active_school_year_id || null,
        );

        const corData = {
          student_number: student.student_number,
          person_id: student.person_id,
          profile_img: student.profile_img,
          lrnNumber: student.lrnNumber,
          cellphoneNumber: student.cellphoneNumber,
          last_name: student.last_name,
          middle_name: student.middle_name,
          campus: student.campus,
          first_name: student.first_name,
          extension: student.extension,
          gender: student.gender,
          age: student.age,
          email: student.emailAddress,
          curriculum: student.active_curriculum,
          yearlevel: student.year_level_id,
          program: student.program_description,
          program_code: student.program_code,
          college: student.dprtmnt_name,
          active_school_year_id: student.active_school_year_id,
          scholarship_id: savedScholarship?.scholarship_id ?? null,
          scholarship_code: savedScholarship?.scholarship_code || "",
          scholarship_name: savedScholarship?.scholarship_name || "",
          scholarship_source: savedScholarship?.scholarship_source || "",
        };

        console.log("Data: ", corData);
        const token2 = webtoken.sign(
          {
            id: student.student_status_id,
            person_id2: student.person_id,
            studentNumber: student.student_number,
            firstName: student.first_name,
            middleName: student.middle_name,
            lastName: student.last_name,
          },
          process.env.JWT_SECRET,
          { expiresIn: "24h" },
        );

        return {
          ...student,
          totalLecFee,
          totalLabFee,
          totalNstpCount,
          totalComputerLab,
          totalLaboratory,
          corData,
          token2,
        };
      }),
    );

    res.json({
      message: "Search successful",
      students: studentsWithFees,
    });
  } catch (err) {
    console.error("SQL error:", err);
    return res.status(500).json({ message: "Database error" });
  }
});

// DEPARTMENT SECTIONS
router.get("/department-sections", async (req, res) => {
  const { departmentId } = req.query;

  const query = `
    SELECT
      dt.dprtmnt_id,
      dt.dprtmnt_name,
      dt.dprtmnt_code,
      c.year_id,
      c.program_id,
      c.curriculum_id,
      ds.id as department_and_program_section_id,
      ds.section_id,
      ds.year_level_id,
      ds.dsstat,
      pt.program_description,
      pt.program_code,
      pt.major,
      st.description
      FROM dprtmnt_table as dt
        INNER JOIN dprtmnt_curriculum_table as dc ON dc.dprtmnt_id  = dt.dprtmnt_id
        INNER JOIN curriculum_table as c ON c.curriculum_id = dc.curriculum_id
        INNER JOIN dprtmnt_section_table as ds ON ds.curriculum_id = c.curriculum_id
        INNER JOIN program_table as pt ON c.program_id = pt.program_id
        INNER JOIN section_table as st ON st.id = ds.section_id
      WHERE dt.dprtmnt_id = ?
        AND c.lock_status = 1
        AND ds.dsstat = 1
    ORDER BY ds.id
  `;

  try {
    const [results] = await db3.query(query, [departmentId]);
    res.status(200).json(results);
  } catch (err) {
    console.error("Error fetching department sections:", err);
    return res
      .status(500)
      .json({ error: "Database error", details: err.message });
  }
});

// UPDATE ACTIVE CURRICULUM (and remap enrolled subjects to the new section)
router.put("/update-active-curriculum", async (req, res) => {
  const { studentId, departmentSectionId, active_school_year_id } = req.body;

  if (!studentId || !departmentSectionId) {
    return res
      .status(400)
      .json({ error: "studentId and departmentSectionId are required" });
  }

  try {
    const [curriculumResult] = await db3.query(
      `
      SELECT curriculum_id
      FROM dprtmnt_section_table
      WHERE id = ?
      `,
      [departmentSectionId],
    );

    if (curriculumResult.length === 0) {
      return res.status(404).json({ error: "Section not found" });
    }

    const curriculumId = curriculumResult[0].curriculum_id;

    let activeSchoolYearId = active_school_year_id;
    if (!activeSchoolYearId) {
      const [yearResult] = await db3.query(
        `SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1`,
      );
      if (yearResult.length === 0) {
        return res.status(404).json({ error: "No active school year found" });
      }
      activeSchoolYearId = yearResult[0].id;
    }

    const [[statusRow]] = await db3.query(
      `
      SELECT active_curriculum
      FROM student_status_table
      WHERE student_number = ?
      ORDER BY id DESC
      LIMIT 1
      `,
      [studentId],
    );
    // Keep student_status.active_curriculum unchanged (home section is not a curriculum shift).
    const studentCurriculumId = statusRow?.active_curriculum ?? null;

    // Fill section only on enrolled subjects that still have no section.
    // Subjects already tagged to a section (including other-section enrollments) stay put.
    const curriculumIds = [
      ...new Set(
        [studentCurriculumId, curriculumId].filter(
          (id) => id != null && String(id).trim() !== "",
        ),
      ),
    ];

    let remappedEnrolledSubjects = 0;
    const connection = await db3.getConnection();

    try {
      await connection.beginTransaction();

      const curriculumFilter = curriculumIds.length
        ? `AND curriculum_id IN (${curriculumIds.map(() => "?").join(", ")})`
        : "";
      const [subjectsToRemap] = await connection.query(
        `
        SELECT id, course_id
        FROM enrolled_subject
        WHERE student_number = ?
          AND active_school_year_id = ?
          ${curriculumFilter}
          AND (department_section_id IS NULL OR department_section_id = 0)
        ORDER BY course_id, id
        FOR UPDATE
        `,
        [studentId, activeSchoolYearId, ...curriculumIds],
      );

      for (const enrolledSubject of subjectsToRemap) {
        await assertSectionCapacity({
          connection,
          sectionId: departmentSectionId,
          courseId: enrolledSubject.course_id,
          activeSchoolYearId,
        });

        const [remapResult] = await connection.query(
          `UPDATE enrolled_subject SET department_section_id = ? WHERE id = ?`,
          [departmentSectionId, enrolledSubject.id],
        );
        remappedEnrolledSubjects += remapResult.affectedRows || 0;
      }

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    res.status(200).json({
      message: "Home section updated successfully",
      curriculumId: studentCurriculumId,
      sectionCurriculumId: curriculumId,
      activeCurriculumChanged: false,
      remappedEnrolledSubjects,
    });
  } catch (err) {
    console.error("Error updating active curriculum:", err);
    return sendCourseTaggingError(res, err);
  }
});

// Update section for a single enrolled subject (no unenroll required)
router.put("/enrolled-courses/:id/section", async (req, res) => {
  const { id } = req.params;
  const { department_section_id } = req.body;

  if (
    department_section_id === undefined ||
    department_section_id === null ||
    department_section_id === ""
  ) {
    return res.status(400).json({ error: "department_section_id is required" });
  }

  try {
    const [[sectionRow]] = await db3.query(
      `SELECT id FROM dprtmnt_section_table WHERE id = ? LIMIT 1`,
      [department_section_id],
    );
    if (!sectionRow) {
      return res.status(404).json({ error: "Section not found" });
    }

    const [[before]] = await db3.query(
      `
      SELECT es.id, es.student_number, es.course_id, es.department_section_id,
             es.active_school_year_id, c.course_code
      FROM enrolled_subject es
      LEFT JOIN course_table c ON c.course_id = es.course_id
      WHERE es.id = ?
      LIMIT 1
      `,
      [id],
    );

    if (!before) {
      return res.status(404).json({ error: "Enrolled course not found" });
    }

    if (
      String(before.department_section_id || "") ===
      String(department_section_id)
    ) {
      return res.json({
        message: "Enrolled subject is already assigned to this section",
        id: Number(id),
        department_section_id: Number(department_section_id),
      });
    }

    const [result] = await runWithSectionCapacity({
      sectionId: department_section_id,
      courseId: before.course_id,
      activeSchoolYearId: before.active_school_year_id,
      mutation: (connection) =>
        connection.query(
          `UPDATE enrolled_subject SET department_section_id = ? WHERE id = ?`,
          [department_section_id, id],
        ),
    });

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Enrolled course not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertCourseTaggingAuditLog({
      req,
      action: "COURSE_TAGGING_SECTION_CHANGE",
      message: `${roleLabel} (${actorId}) changed section of ${before.course_code || `course ${before.course_id}`} for Student (${before.student_number}) from section ${before.department_section_id || "none"} to ${department_section_id}.`,
    });

    res.json({
      message: "Enrolled subject section updated successfully",
      id: Number(id),
      department_section_id: Number(department_section_id),
    });
  } catch (err) {
    console.error("Error updating enrolled subject section:", err);
    return sendCourseTaggingError(res, err);
  }
});

// SEARCH STUDENT BY SECTION
router.get("/search-student/:sectionId", async (req, res) => {
  const { sectionId } = req.params;

  try {
    const [programResult] = await db3.query(
      `
      SELECT
        dst.curriculum_id,
        pt.program_description,
        pt.program_code
      FROM dprtmnt_section_table dst
      INNER JOIN curriculum_table ct ON dst.curriculum_id = ct.curriculum_id
      INNER JOIN program_table pt ON ct.program_id = pt.program_id
      WHERE dst.id = ?
      `,
      [sectionId],
    );

    if (!programResult.length) {
      return res.status(404).json({ message: "Section not found" });
    }

    const { curriculum_id } = programResult[0];

      const [courses] = await db3.query(
      `
  SELECT
    c.course_id,
    c.course_code,
    c.course_description,
    c.course_unit,
    c.lab_unit,
    c.prereq,
    c.corequisite,
    c.subject_type_id,
    st.subject_type_name,
    c.category_type_id,
    cat.category_type_name
  FROM curriculum_table ct
  INNER JOIN program_tagging_table ptt ON ct.curriculum_id = ptt.curriculum_id
  INNER JOIN program_table pt ON ct.program_id = pt.program_id
  INNER JOIN course_table c ON ptt.course_id = c.course_id
  LEFT JOIN subject_type_table st ON st.subject_type_id = c.subject_type_id
  LEFT JOIN category_type_table cat ON cat.category_type_id = c.category_type_id
  WHERE ct.curriculum_id = ?
  ORDER BY c.course_code
  `,
      [curriculum_id],
    );

    const formattedCourses = courses.map((c) => ({
      ...c,
      prereq_list: c.prereq ? c.prereq.split(",").map((p) => p.trim()) : [],
    }));

    res.status(200).json({
      ...programResult[0],
      courses: formattedCourses,
    });
  } catch (err) {
    console.error("Error fetching course tagging data:", err);
    res.status(500).json({
      error: "Database error",
      details: err.message,
    });
  }
});

// SUBJECT ENROLLMENT COUNT
router.get("/subject-enrollment-count", async (req, res) => {
  const { sectionId, activeSchoolYearId } = req.query;

  try {
    let effectiveActiveSchoolYearId = activeSchoolYearId;

    if (!effectiveActiveSchoolYearId) {
      const activeYearSql = `SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1`;
      const [yearResult] = await db3.query(activeYearSql);

      if (yearResult.length === 0) {
        return res.status(404).json({ error: "No active school year found" });
      }

      effectiveActiveSchoolYearId = yearResult[0].id;
    }

    const sql = `
      SELECT
        es.course_id,
        COUNT(DISTINCT es.student_number) AS enrolled_count
      FROM enrolled_subject AS es
      WHERE es.active_school_year_id = ?
        AND es.department_section_id = ?
      GROUP BY es.course_id
    `;

    const [result] = await db3.query(sql, [
      effectiveActiveSchoolYearId,
      sectionId,
    ]);
    res.json(result);
  } catch (err) {
    console.error("Error fetching enrolled counts:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ADMIN DATA (DEPARTMENT BY EMAIL)
router.get("/admin_data/:email", async (req, res) => {
  const { email } = req.params;

  try {
    const {
      buildEmployeeScopePayload,
      ensureRegistrarScopeTable,
    } = require("../../utils/registrarScopeService");

    await ensureRegistrarScopeTable();

    const [[userAccount]] = await db3.query(
      `SELECT ua.employee_id, ua.dprtmnt_id
       FROM user_accounts AS ua
       WHERE ua.email = ?
       LIMIT 1`,
      [email],
    );

    if (!userAccount) {
      return res.status(404).json({ error: "User not found" });
    }

    const scopePayload = await buildEmployeeScopePayload(
      userAccount.employee_id,
      userAccount,
    );

    const { ensureDepartmentIsAllowedColumn } = require("./dprmntRoute");
    await ensureDepartmentIsAllowedColumn();

    const departmentId =
      scopePayload.dprtmnt_id ?? userAccount.dprtmnt_id ?? null;
    let is_allowed = 1;

    if (departmentId) {
      const [[departmentRow]] = await db3.query(
        `SELECT COALESCE(is_allowed, 1) AS is_allowed
         FROM dprtmnt_table
         WHERE dprtmnt_id = ?
         LIMIT 1`,
        [departmentId],
      );
      is_allowed = Number(departmentRow?.is_allowed ?? 1);
    }

    res.json({
      dprtmnt_id: departmentId,
      dprtmnt_ids: scopePayload.dprtmnt_ids,
      scopes: scopePayload.scopes,
      allowed_curriculum_ids: scopePayload.allowed_curriculum_ids,
      curriculum_id: scopePayload.curriculum_id ?? null,
      is_allowed,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch department" });
  }
});

// CHECK PREREQUISITE BEFORE ENROLLMENT
router.post("/check-student-balance", async (req, res) => {
  try {
    const { student_number, active_school_year_id } = req.body;

    if (!student_number) {
      return res.status(400).json({
        hasBalance: false,
        balance: 0,
        message: "student_number is required.",
      });
    }

    let activeSchoolYearId = active_school_year_id;

    if (!activeSchoolYearId) {
      const [activeYearRows] = await db3.query(
        "SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1",
      );

      activeSchoolYearId = activeYearRows[0]?.id || null;
    }

    const [unifastRows] = await db3.query(
      `SELECT id
       FROM unifast
       WHERE student_number = ?
         AND status = 1
         AND (? IS NULL OR active_school_year_id = ?)
       ORDER BY active_school_year_id DESC, id DESC
       LIMIT 1`,
      [student_number, activeSchoolYearId, activeSchoolYearId],
    );

    if (unifastRows.length > 0) {
      return res.json({
        hasBalance: false,
        balance: 0,
        payment_type: "unifast",
        unifast_id: unifastRows[0].id,
        active_school_year_id: activeSchoolYearId,
        message:
          "Student is under UNIFAST. Matriculation balance rule does not apply.",
      });
    }

    const [rows] = await db3.query(
      `SELECT
          id,
          student_number,
          COALESCE(NULLIF(balance, ''), '0') AS balance_status,
          COALESCE(NULLIF(total_tosf, ''), '0') AS total_tosf,
          COALESCE(NULLIF(payment, ''), '0') AS payment
       FROM matriculation
       WHERE student_number = ?
         AND (? IS NULL OR active_school_year_id = ?)
       ORDER BY active_school_year_id DESC, id DESC
       LIMIT 1`,
      [student_number, activeSchoolYearId, activeSchoolYearId],
    );

    const matriculation = rows[0] || null;
    const [[balanceRow]] = await db3.query(
      `SELECT COALESCE(NULLIF(mpl.balance, ''), '0') AS balance
       FROM matriculation_payment_lines mpl
       INNER JOIN matriculation m ON m.id = mpl.matriculation_id
       WHERE m.student_number = ?
         AND (? IS NULL OR m.active_school_year_id = ?)
       ORDER BY mpl.id DESC
       LIMIT 1`,
      [student_number, activeSchoolYearId, activeSchoolYearId],
    );

    const legacyBalance = Number(
      String(matriculation?.balance_status ?? "0").replace(/,/g, ""),
    );
    const balance = Number(
      String(balanceRow?.balance ?? (legacyBalance > 1 ? legacyBalance : "0")).replace(/,/g, ""),
    );
    const safeBalance = Number.isFinite(balance) && balance > 0 ? balance : 0;
    const hasBalance = Number(matriculation?.balance_status || 0) === 1 || safeBalance > 0;

    return res.json({
      hasBalance,
      balance: safeBalance,
      payment_type: matriculation ? "matriculation" : null,
      matriculation_id: matriculation?.id || null,
      active_school_year_id: activeSchoolYearId,
      message:
        hasBalance
          ? "Student still has a remaining matriculation balance."
          : "Student has no remaining matriculation balance.",
    });
  } catch (err) {
    console.error("Error in /check-student-balance:", err);
    return res.status(500).json({
      hasBalance: false,
      balance: 0,
      message: "Error checking student balance.",
    });
  }
});

const loadStudentPrerequisiteGradeMap = async (
  studentNumber,
  courseIds = [],
) => {
  const uniqueCourseIds = [...new Set(courseIds.filter(Boolean))];
  if (!uniqueCourseIds.length) {
    return new Map();
  }

  const placeholders = uniqueCourseIds.map(() => "?").join(", ");
  const [rows] = await db3.query(
    `
    SELECT
      course_id,
      MAX(CASE WHEN en_remarks = 1 THEN 1 ELSE 0 END) AS has_pass,
      MAX(CASE WHEN en_remarks = 2 THEN 1 ELSE 0 END) AS has_fail
    FROM enrolled_subject
    WHERE student_number = ? AND course_id IN (${placeholders})
    GROUP BY course_id
    `,
    [studentNumber, ...uniqueCourseIds],
  );

  return new Map(rows.map((row) => [row.course_id, row]));
};

const evaluatePrerequisiteForCourse = ({
  courseMeta,
  semesterId,
  curriculumId,
  gradeMap,
  tagSemesterMap,
  prereqByCode,
}) => {
  const { course_code: courseCode, prereq } = courseMeta;

  if (!prereq || String(prereq).trim() === "") {
    return {
      allowed: true,
      status: "NO_PREREQ",
      message: `Course ${courseCode} has no prerequisite.`,
      failedPrereq: [],
      missingPrereq: [],
    };
  }

  const prereqCodes = String(prereq)
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);

  if (prereqCodes.length === 0) {
    return {
      allowed: true,
      status: "NO_PREREQ",
      message: `Course ${courseCode} has no prerequisite (empty prereq field).`,
      failedPrereq: [],
      missingPrereq: [],
    };
  }

  const prereqCourses = prereqCodes
    .map((code) => prereqByCode.get(code))
    .filter(Boolean);

  if (!prereqCourses.length) {
    return {
      allowed: true,
      status: "PREREQ_NOT_FOUND",
      message:
        "Prerequisite course codes do not exist in course_table. Enrollment is allowed but please verify your curriculum data.",
      failedPrereq: [],
      missingPrereq: [],
    };
  }

  let applicablePrereqCourses = prereqCourses;

  if (semesterId && curriculumId) {
    applicablePrereqCourses = prereqCourses.filter((prereqCourse) => {
      const prereqSemesterId = tagSemesterMap.get(prereqCourse.course_id);
      if (!prereqSemesterId) return true;
      return Number(prereqSemesterId) < Number(semesterId);
    });

    if (applicablePrereqCourses.length === 0) {
      return {
        allowed: true,
        status: "NO_APPLICABLE_PREREQ",
        message: "Prerequisites are not applicable for the selected semester.",
        failedPrereq: [],
        missingPrereq: [],
      };
    }
  }

  const failedPrereq = [];
  const missingPrereq = [];

  for (const prereqCourse of applicablePrereqCourses) {
    const grade = gradeMap.get(prereqCourse.course_id) || {};
    const hasPass = Number(grade.has_pass) === 1;
    const hasFail = Number(grade.has_fail) === 1;

    if (!hasPass && hasFail) {
      failedPrereq.push(prereqCourse.course_code);
    } else if (!hasPass && !hasFail) {
      missingPrereq.push(prereqCourse.course_code);
    }
  }

  if (failedPrereq.length > 0) {
    return {
      allowed: false,
      status: "FAILED_PREREQ",
      failedPrereq,
      missingPrereq,
      message: `Student has FAILED prerequisite(s): ${failedPrereq.join(
        ", ",
      )}. They must PASS these before enrolling in ${courseCode}.`,
    };
  }

  if (missingPrereq.length > 0) {
    return {
      allowed: false,
      status: "MISSING_PREREQ",
      failedPrereq,
      missingPrereq,
      message: `Student must FIRST ENROLL and PASS prerequisite(s): ${missingPrereq.join(
        ", ",
      )} before taking ${courseCode}.`,
    };
  }

  return {
    allowed: true,
    status: "OK",
    failedPrereq: [],
    missingPrereq: [],
    message: `All prerequisites satisfied for ${courseCode}.`,
  };
};

router.post("/check-prerequisites-batch", async (req, res) => {
  try {
    const { student_number, curriculum_id, courses } = req.body;

    if (!student_number || !Array.isArray(courses) || courses.length === 0) {
      return res.status(400).json({
        message: "student_number and courses are required.",
      });
    }

    const courseIds = courses
      .map((course) => course?.course_id)
      .filter(
        (courseId) =>
          courseId !== null && courseId !== undefined && courseId !== "",
      );

    if (!courseIds.length) {
      return res.status(400).json({
        message: "At least one valid course_id is required.",
      });
    }

    const coursePlaceholders = courseIds.map(() => "?").join(", ");
    const [courseRows] = await db3.query(
      `SELECT course_id, course_code, prereq FROM course_table WHERE course_id IN (${coursePlaceholders})`,
      courseIds,
    );
    const courseMetaMap = new Map(
      courseRows.map((row) => [String(row.course_id), row]),
    );

    const prereqCodes = new Set();
    for (const row of courseRows) {
      if (!row.prereq || String(row.prereq).trim() === "") continue;
      String(row.prereq)
        .split(",")
        .map((code) => code.trim())
        .filter(Boolean)
        .forEach((code) => prereqCodes.add(code));
    }

    let prereqCourseRows = [];
    if (prereqCodes.size > 0) {
      const codePlaceholders = [...prereqCodes].map(() => "?").join(", ");
      [prereqCourseRows] = await db3.query(
        `SELECT course_id, course_code FROM course_table WHERE course_code IN (${codePlaceholders})`,
        [...prereqCodes],
      );
    }

    const prereqByCode = new Map(
      prereqCourseRows.map((row) => [row.course_code, row]),
    );

    let tagSemesterMap = new Map();
    if (curriculum_id && prereqCourseRows.length > 0) {
      const prereqCourseIds = prereqCourseRows.map((row) => row.course_id);
      const tagPlaceholders = prereqCourseIds.map(() => "?").join(", ");
      const [tagRows] = await db3.query(
        `
        SELECT course_id, semester_id
        FROM program_tagging_table
        WHERE curriculum_id = ? AND course_id IN (${tagPlaceholders})
        `,
        [curriculum_id, ...prereqCourseIds],
      );
      tagSemesterMap = new Map(
        tagRows.map((row) => [row.course_id, row.semester_id]),
      );
    }

    const gradeMap = await loadStudentPrerequisiteGradeMap(
      student_number,
      prereqCourseRows.map((row) => row.course_id),
    );

    const results = {};
    for (const course of courses) {
      const courseId = String(course.course_id);
      const courseMeta = courseMetaMap.get(courseId);

      if (!courseMeta) {
        results[courseId] = {
          allowed: false,
          status: "COURSE_NOT_FOUND",
          message: "Course not found in course_table.",
          failedPrereq: [],
          missingPrereq: [],
          hasPrereq: false,
        };
        continue;
      }

      const evaluation = evaluatePrerequisiteForCourse({
        courseMeta,
        semesterId: course.semester_id,
        curriculumId: curriculum_id,
        gradeMap,
        tagSemesterMap,
        prereqByCode,
      });

      results[courseId] = {
        ...evaluation,
        hasPrereq: ![
          "NO_PREREQ",
          "PREREQ_NOT_FOUND",
          "NO_APPLICABLE_PREREQ",
        ].includes(evaluation.status),
      };
    }

    return res.json({ results });
  } catch (err) {
    console.error("Error in /check-prerequisites-batch:", err);
    return res.status(500).json({
      message: err.message,
    });
  }
});

router.post("/check-prerequisite", async (req, res) => {
  try {
    const { student_number, course_id, semester_id, curriculum_id } = req.body;

    if (!student_number || !course_id) {
      return res.status(400).json({
        allowed: false,
        status: "INVALID_REQUEST",
        message: "student_number and course_id are required.",
      });
    }

    const [courseRows] = await db3.query(
      "SELECT prereq, course_code FROM course_table WHERE course_id = ? LIMIT 1",
      [course_id],
    );

    if (!courseRows.length) {
      return res.status(404).json({
        allowed: false,
        status: "COURSE_NOT_FOUND",
        message: "Course not found in course_table.",
      });
    }

    const { prereq, course_code } = courseRows[0];

    if (!prereq || String(prereq).trim() === "") {
      return res.json({
        allowed: true,
        status: "NO_PREREQ",
        message: `Course ${course_code} has no prerequisite.`,
      });
    }

    const prereqCodes = String(prereq)
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    if (prereqCodes.length === 0) {
      return res.json({
        allowed: true,
        status: "NO_PREREQ",
        message: `Course ${course_code} has no prerequisite (empty prereq field).`,
      });
    }

    const placeholders = prereqCodes.map(() => "?").join(", ");

    const [prereqCourses] = await db3.query(
      `
      SELECT course_id, course_code
      FROM course_table
      WHERE course_code IN (${placeholders})
      `,
      prereqCodes,
    );

    if (!prereqCourses.length) {
      return res.json({
        allowed: true,
        status: "PREREQ_NOT_FOUND",
        message:
          "Prerequisite course codes do not exist in course_table. Enrollment is allowed but please verify your curriculum data.",
      });
    }

    let applicablePrereqCourses = prereqCourses;

    if (semester_id && curriculum_id) {
      const prereqCourseIds = prereqCourses.map((p) => p.course_id);
      const placeholders2 = prereqCourseIds.map(() => "?").join(", ");

      const [tagRows] = await db3.query(
        `
        SELECT course_id, semester_id
        FROM program_tagging_table
        WHERE curriculum_id = ? AND course_id IN (${placeholders2})
        `,
        [curriculum_id, ...prereqCourseIds],
      );

      const prereqSemesterMap = new Map(
        tagRows.map((row) => [row.course_id, row.semester_id]),
      );

      applicablePrereqCourses = prereqCourses.filter((p) => {
        const prereqSemesterId = prereqSemesterMap.get(p.course_id);
        if (!prereqSemesterId) return true;
        return Number(prereqSemesterId) < Number(semester_id);
      });

      if (applicablePrereqCourses.length === 0) {
        return res.json({
          allowed: true,
          status: "NO_APPLICABLE_PREREQ",
          message:
            "Prerequisites are not applicable for the selected semester.",
        });
      }
    }

    const failedPrereq = [];
    const missingPrereq = [];

    for (const prereqCourse of applicablePrereqCourses) {
      const prereqCourseId = prereqCourse.course_id;
      const prereqCourseCode = prereqCourse.course_code;

      const [gradeRows] = await db3.query(
        `
        SELECT
          MAX(CASE WHEN en_remarks = 1 THEN 1 ELSE 0 END) AS has_pass,
          MAX(CASE WHEN en_remarks = 2 THEN 1 ELSE 0 END) AS has_fail
        FROM enrolled_subject
        WHERE student_number = ? AND course_id = ?
        `,
        [student_number, prereqCourseId],
      );

      const { has_pass, has_fail } = gradeRows[0];

      if (!has_pass && has_fail) {
        failedPrereq.push(prereqCourseCode);
      } else if (!has_pass && !has_fail) {
        missingPrereq.push(prereqCourseCode);
      }
    }

    if (failedPrereq.length > 0) {
      return res.json({
        allowed: false,
        status: "FAILED_PREREQ",
        failedPrereq,
        missingPrereq,
        message: `Student has FAILED prerequisite(s): ${failedPrereq.join(
          ", ",
        )}. They must PASS these before enrolling in ${course_code}.`,
      });
    }

    if (missingPrereq.length > 0) {
      return res.json({
        allowed: false,
        status: "MISSING_PREREQ",
        failedPrereq,
        missingPrereq,
        message: `Student must FIRST ENROLL and PASS prerequisite(s): ${missingPrereq.join(
          ", ",
        )} before taking ${course_code}.`,
      });
    }

    return res.json({
      allowed: true,
      status: "OK",
      failedPrereq: [],
      missingPrereq: [],
      message: `All prerequisites satisfied for ${course_code}.`,
    });
  } catch (err) {
    console.error("Error in /check-prerequisite:", err);
    return res.status(500).json({
      allowed: false,
      status: "SERVER_ERROR",
      message: err.message,
    });
  }
});

router.post("/add-all-to-enrolled-courses-summer", async (req, res) => {
  const {
    subject_id,
    user_id,
    curriculumID,
    departmentSectionID,
    year_level,
    active_school_year_id,
    active_semester_id,
  } = req.body;

  try {
    let activeSchoolYearId = active_school_year_id;
    let activeSemesterId = active_semester_id;

    if (activeSchoolYearId && !activeSemesterId) {
      const [schoolYearRows] = await db3.query(
        `SELECT semester_id FROM active_school_year_table WHERE id = ? LIMIT 1`,
        [activeSchoolYearId],
      );
      activeSemesterId = schoolYearRows[0]?.semester_id || null;
    }

    if (!activeSchoolYearId || !activeSemesterId) {
      const activeYearSql = `SELECT id, semester_id FROM active_school_year_table WHERE astatus = 1 LIMIT 1`;
      const [yearResult] = await db3.query(activeYearSql);

      if (yearResult.length === 0) {
        return res.status(404).json({ error: "No active school year found" });
      }

      activeSchoolYearId = activeSchoolYearId || yearResult[0].id;
      activeSemesterId = activeSemesterId || yearResult[0].semester_id;
    }

    const checkSql = `
      SELECT year_level_id, semester_id, curriculum_id
      FROM program_tagging_table
      WHERE course_id = ? AND curriculum_id = ?
      LIMIT 1
    `;

    const [checkResult] = await db3.query(checkSql, [subject_id, curriculumID]);

    if (!checkResult.length) {
      console.warn(`Subject ${subject_id} not found in tagging table`);
      return res.status(404).json({ message: "Subject not found" });
    }

    const { year_level_id, semester_id, curriculum_id } = checkResult[0];

    if (
      Number(year_level_id) !== Number(year_level) ||
      Number(curriculum_id) !== Number(curriculumID)
    ) {
      return res.status(200).json({
        message: "Skipped - Wrong Year Level / Wrong Curriculum",
        enrolled: false,
        skipped: true,
      });
    }

    const checkDuplicateSql = `
      SELECT * FROM enrolled_subject
      WHERE course_id = ? AND student_number = ? AND active_school_year_id = ?
    `;

    const [dupResult] = await db3.query(checkDuplicateSql, [
      subject_id,
      user_id,
      activeSchoolYearId,
    ]);

    if (dupResult.length > 0) {
      return res.status(200).json({
        message: "Skipped - Already Enrolled",
        enrolled: false,
        skipped: true,
      });
    }

    const insertSql = `
      INSERT INTO enrolled_subject (course_id, student_number, active_school_year_id, curriculum_id, department_section_id, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    const [insertResult] = await db3.query(insertSql, [
      subject_id,
      user_id,
      activeSchoolYearId,
      curriculumID,
      departmentSectionID,
      1,
    ]);

    await autoTagNstpComponent({
      connection: db3,
      enrolledSubjectId: insertResult.insertId,
      studentNumber: user_id,
      courseId: subject_id,
      activeSchoolYearId,
    });

    const updateStatusSql = `
      UPDATE student_status_table
      SET enrolled_status = 1, active_curriculum = ?, year_level_id = ?, active_school_year_id = ?
      WHERE student_number = ?
    `;

    await db3.query(updateStatusSql, [
      curriculumID,
      year_level,
      activeSchoolYearId,
      user_id,
    ]);

    const [getStudentNUmber] = await db3.query(
      `
      SELECT id, person_id FROM student_numbering_table WHERE student_number = ?
    `,
      [user_id],
    );

    if (getStudentNUmber.length === 0) {
      console.log("Student number not found");
    }

    const student_numbering_id = getStudentNUmber[0].id;
    const person_id = getStudentNUmber[0].person_id;

    const [getDepartmentID] = await db3.query(
      `
      SELECT dprtmnt_id FROM dprtmnt_curriculum_table WHERE curriculum_id = ?
    `,
      [curriculumID],
    );

    if (getDepartmentID.length === 0) {
      console.log("Department ID not found");
    }

    const department_id = getDepartmentID[0].dprtmnt_id;

    const [checkExistingCurriculum] = await db3.query(
      `
      SELECT * FROM student_curriculum_table
      WHERE student_numbering_id = ? AND curriculum_id = ?
      `,
      [student_numbering_id, curriculum_id],
    );

    await db3.query(
      `
        UPDATE user_accounts SET dprtmnt_id = ? WHERE person_id = ?
      `,
      [department_id, person_id],
    );

    if (checkExistingCurriculum.length === 0) {
      await db3.query(
        `
        INSERT INTO student_curriculum_table (student_numbering_id, curriculum_id)
        VALUES (?, ?)
        `,
        [student_numbering_id, curriculum_id],
      );
    } else {
      console.log(
        `⚠️ Curriculum ${curriculum_id} already exists for student ${user_id}`,
      );
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const courseLabel = await getCourseLabel(subject_id);
    await insertCourseTaggingAuditLog({
      req,
      action: "COURSE_TAGGING_SUMMER_BULK_ENROLL",
      message: `${roleLabel} (${actorId}) enrolled ${courseLabel} to Student (${user_id}) via summer bulk course tagging.`,
    });

    await logCourseTaggingStudentHistory({
      req,
      action: "bulk_enroll",
      studentNumber: user_id,
      courseId: subject_id,
      departmentSectionId: departmentSectionID,
      activeSchoolYearId,
    });

    res.status(200).json({
      message: "Course enrolled successfully",
      enrolled: true,
      skipped: false,
    });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
