const express = require("express");
const { db3 } = require("../database/database");
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

const insertDepartmentSectionTaggingAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    message,
    severity: "INFO",
  });
};

const getDepartmentSectionLabel = async (departmentSectionId) => {
  const [[section]] = await db3.query(
    `
    SELECT
      pt.program_code,
      st.description AS section_description
    FROM dprtmnt_section_table dst
    INNER JOIN curriculum_table ct ON dst.curriculum_id = ct.curriculum_id
    INNER JOIN program_table pt ON ct.program_id = pt.program_id
    INNER JOIN section_table st ON dst.section_id = st.id
    WHERE dst.id = ?
    LIMIT 1
    `,
    [departmentSectionId]
  );

  if (!section) return `department section ${departmentSectionId}`;

  const programCode = String(section.program_code || "").trim();
  const sectionDescription = String(section.section_description || "").trim();

  if (programCode && sectionDescription) return `${programCode}-${sectionDescription}`;
  return programCode || sectionDescription || `department section ${departmentSectionId}`;
};

const getYearLevelLabel = async (yearLevelId) => {
  if (!yearLevelId) return "";

  const [[yearLevel]] = await db3.query(
    "SELECT year_level_description FROM year_level_table WHERE year_level_id = ? LIMIT 1",
    [yearLevelId]
  );

  return String(yearLevel?.year_level_description || "").trim().toLowerCase();
};

const formatStudentCountLabel = (count, yearLevelLabel) => {
  const safeCount = Number(count) || 0;
  const yearPhrase = yearLevelLabel ? `${yearLevelLabel} ` : "";
  return `${safeCount} ${yearPhrase}student`;
};

const currentStudentStatusJoin = `
  LEFT JOIN (
    SELECT
      current_status.student_number,
      current_status.active_curriculum,
      current_status.active_school_year_id,
      current_status.year_level_id
    FROM student_status_table AS current_status
    INNER JOIN (
      SELECT
        student_number,
        active_curriculum,
        active_school_year_id,
        MAX(id) AS latest_status_id
      FROM student_status_table
      GROUP BY student_number, active_curriculum, active_school_year_id
    ) AS latest_status
      ON latest_status.latest_status_id = current_status.id
  ) AS sst
    ON sst.student_number = es.student_number
   AND sst.active_curriculum = es.curriculum_id
   AND sst.active_school_year_id = es.active_school_year_id
`;

// ── GET: All students under curriculum not yet tagged ────────────────────────
router.get('/get_student_per_curriculum', async (req, res) => {
  const { curriculum_id, active_school_year_id, year_level_id } = req.query;
  console.log("Received params - Curriculum ID:", curriculum_id, "Active School Year ID:", active_school_year_id, "Year Level ID:", year_level_id);
  try {
    const params = [curriculum_id, active_school_year_id];
    const yearLevelClause = year_level_id ? "AND sst.year_level_id = ?" : "";
    if (year_level_id) params.push(year_level_id);

    const [rows] = await db3.query(
      `
      SELECT DISTINCT
        es.student_number, p.first_name, p.last_name,
        pgt.program_code, pgt.program_id, pgt.program_description,
        es.department_section_id,
        sst.year_level_id,
        ylt.year_level_description,
        st.description AS section_description
      FROM (
        SELECT
          student_number,
          curriculum_id,
          active_school_year_id,
          MAX(NULLIF(department_section_id, 0)) AS department_section_id
        FROM enrolled_subject
        WHERE curriculum_id = ? AND active_school_year_id = ?
        GROUP BY student_number, curriculum_id, active_school_year_id
      ) AS es
      JOIN student_numbering_table s ON es.student_number = s.student_number
      JOIN person_table p ON s.person_id = p.person_id
      JOIN curriculum_table ct ON es.curriculum_id = ct.curriculum_id
      JOIN program_table pgt ON ct.program_id = pgt.program_id
      ${currentStudentStatusJoin}
      LEFT JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id
      LEFT JOIN dprtmnt_section_table dst ON dst.id = es.department_section_id
      LEFT JOIN section_table st ON dst.section_id = st.id
      WHERE 1 = 1
      ${yearLevelClause}
      `,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "No students found for the given curriculum and school year" });
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch student data" });
  }
});

// ── GET: Students already tagged to a section ────────────────────────────────
// FIX: added es.department_section_id to SELECT so the frontend can use it
//      when sending the untag request — without it, actualSectionId was undefined.
router.get('/get_student_already_tagged', async (req, res) => {
  const { curriculum_id, active_school_year_id, department_section_id, year_level_id } = req.query;
  console.log("Received params - Curriculum ID:", curriculum_id, "Active School Year ID:", active_school_year_id, "Department Section ID:", department_section_id, "Year Level ID:", year_level_id);
  try {
    const params = [curriculum_id, active_school_year_id];
    const sectionClause = department_section_id ? "AND es.department_section_id = ?" : "";
    const yearLevelClause = year_level_id ? "AND sst.year_level_id = ?" : "";
    if (department_section_id) params.push(department_section_id);
    if (year_level_id) params.push(year_level_id);

    const [rows] = await db3.query(
      `
      SELECT DISTINCT
        es.student_number,
        es.department_section_id,
        p.first_name, p.last_name,
        pgt.program_code, pgt.program_id, pgt.program_description,
        sst.year_level_id,
        ylt.year_level_description,
        st.description AS section_description
      FROM (
        SELECT
          student_number,
          curriculum_id,
          active_school_year_id,
          MAX(NULLIF(department_section_id, 0)) AS department_section_id
        FROM enrolled_subject
        WHERE curriculum_id = ? AND active_school_year_id = ?
        GROUP BY student_number, curriculum_id, active_school_year_id
      ) AS es
      JOIN student_numbering_table s ON es.student_number = s.student_number
      JOIN person_table p ON s.person_id = p.person_id
      JOIN curriculum_table ct ON es.curriculum_id = ct.curriculum_id
      JOIN program_table pgt ON ct.program_id = pgt.program_id
      ${currentStudentStatusJoin}
      LEFT JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id
      LEFT JOIN dprtmnt_section_table dst ON dst.id = es.department_section_id
      LEFT JOIN section_table st ON dst.section_id = st.id
      WHERE es.department_section_id IS NOT NULL
      ${sectionClause}
      ${yearLevelClause}
      `,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "No students found for the given curriculum and school year" });
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch student data" });
  }
});

// ── PUT: Bulk tag students into a section ────────────────────────────────────
router.put('/enrolled_student_in_section', async (req, res) => {
  const { curriculum_id, active_school_year_id, department_section_id, year_level_id, student_numbers } = req.body;

  if (!curriculum_id || !active_school_year_id || !department_section_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const filterParams = [curriculum_id, active_school_year_id];
    const yearLevelClause = year_level_id ? "AND sst.year_level_id = ?" : "";
    if (year_level_id) filterParams.push(year_level_id);

    const selectedStudentNumbers = Array.isArray(student_numbers)
      ? student_numbers.map((number) => String(number).trim()).filter(Boolean)
      : [];
    const selectedStudentClause = selectedStudentNumbers.length > 0
      ? `AND es.student_number IN (${selectedStudentNumbers.map(() => "?").join(", ")})`
      : "";
    filterParams.push(...selectedStudentNumbers);

    const [[eligibleStudentCount]] = await db3.query(
      `
      SELECT COUNT(DISTINCT es.student_number) AS student_count
      FROM enrolled_subject es
      ${currentStudentStatusJoin}
      WHERE es.curriculum_id = ? AND es.active_school_year_id = ?
        AND (es.department_section_id IS NULL OR es.department_section_id = 0)
      ${yearLevelClause}
      ${selectedStudentClause}
      `,
      filterParams
    );

    const params = [department_section_id, ...filterParams];

    const [result] = await db3.query(
      `
      UPDATE enrolled_subject es
      ${currentStudentStatusJoin}
      SET es.department_section_id = ?
      WHERE es.curriculum_id = ? AND es.active_school_year_id = ?
        AND (es.department_section_id IS NULL OR es.department_section_id = 0)
      ${yearLevelClause}
      ${selectedStudentClause}
      `,
      params
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const sectionLabel = await getDepartmentSectionLabel(department_section_id);
    const yearLevelLabel = await getYearLevelLabel(year_level_id);
    const studentCountLabel = formatStudentCountLabel(
      eligibleStudentCount?.student_count,
      yearLevelLabel
    );
    await insertDepartmentSectionTaggingAuditLog({
      req,
      action: selectedStudentNumbers.length > 0
        ? "DEPARTMENT_SECTION_STUDENT_ENROLL_SELECTED"
        : "DEPARTMENT_SECTION_STUDENT_ENROLL_ALL",
      message: `${roleLabel} (${actorId}) enrolled ${studentCountLabel} in ${sectionLabel}.`,
    });

    res.json({
      message: `The students was successfully enrolled in the section`,
      affectedRows: result.affectedRows,
      affectedStudents: eligibleStudentCount?.student_count || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to enroll students in section" });
  }
});

// ── PUT: Tag single student into a section ───────────────────────────────────
router.put('/enrolled_student_in_section/:student_number', async (req, res) => {
  const { student_number } = req.params;
  const { curriculum_id, department_section_id, active_school_year_id } = req.body;

  console.log("Received params - Student Number:", student_number, "Curriculum ID:", curriculum_id, "Department Section ID:", department_section_id, "Active School Year ID:", active_school_year_id);

  if (!curriculum_id || !department_section_id || !active_school_year_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  try {
    const [result] = await db3.query(
      `
      UPDATE enrolled_subject
      SET department_section_id = ?
      WHERE student_number = ? AND curriculum_id = ? AND active_school_year_id = ?
      `,
      [department_section_id, student_number, curriculum_id, active_school_year_id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Student not found or already enrolled in a section" });
    }
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const sectionLabel = await getDepartmentSectionLabel(department_section_id);
    const [[studentYearLevel]] = await db3.query(
      `
      SELECT ylt.year_level_description
      FROM student_status_table sst
      LEFT JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id
      WHERE sst.student_number = ?
        AND sst.active_curriculum = ?
        AND sst.active_school_year_id = ?
      ORDER BY sst.id DESC
      LIMIT 1
      `,
      [student_number, curriculum_id, active_school_year_id]
    );
    const studentCountLabel = formatStudentCountLabel(
      1,
      String(studentYearLevel?.year_level_description || "").trim().toLowerCase()
    );
    await insertDepartmentSectionTaggingAuditLog({
      req,
      action: "DEPARTMENT_SECTION_STUDENT_ENROLL",
      message: `${roleLabel} (${actorId}) enrolled ${studentCountLabel} ${student_number} in ${sectionLabel}.`,
    });
    res.json({ message: "Student enrolled in section successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to enroll student in section" });
  }
});

// ── PUT: Bulk untag all students from a section ──────────────────────────────
router.put('/unenrolled_student_in_section', async (req, res) => {
  const { curriculum_id, active_school_year_id, department_section_id, year_level_id } = req.body;
  if (!curriculum_id || !active_school_year_id || !department_section_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  try {
    const params = [curriculum_id, active_school_year_id, department_section_id];
    const yearLevelClause = year_level_id ? "AND sst.year_level_id = ?" : "";
    if (year_level_id) params.push(year_level_id);

    const [[eligibleStudentCount]] = await db3.query(
      `
      SELECT COUNT(DISTINCT es.student_number) AS student_count
      FROM enrolled_subject es
      ${currentStudentStatusJoin}
      WHERE es.curriculum_id = ? AND es.active_school_year_id = ? AND es.department_section_id = ?
      ${yearLevelClause}
      `,
      params
    );

    const [result] = await db3.query(
      `
      UPDATE enrolled_subject es
      ${currentStudentStatusJoin}
      SET es.department_section_id = NULL
      WHERE es.curriculum_id = ? AND es.active_school_year_id = ? AND es.department_section_id = ?
      ${yearLevelClause}
      `,
      params
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const sectionLabel = await getDepartmentSectionLabel(department_section_id);
    const yearLevelLabel = await getYearLevelLabel(year_level_id);
    const studentCountLabel = formatStudentCountLabel(
      eligibleStudentCount?.student_count,
      yearLevelLabel
    );
    await insertDepartmentSectionTaggingAuditLog({
      req,
      action: "DEPARTMENT_SECTION_STUDENT_UNENROLL_ALL",
      message: `${roleLabel} (${actorId}) unenrolled ${studentCountLabel} from ${sectionLabel}.`,
    });
    res.json({
      message: "Students unenrolled from section successfully",
      affectedRows: result.affectedRows,
      affectedStudents: eligibleStudentCount?.student_count || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to unenroll students from section" });
  }
});

// ── PUT: Untag single student ────────────────────────────────────────────────
// FIX: removed department_section_id from WHERE clause.
//      Previously the query matched on the section ID sent by the frontend,
//      but that value was undefined (not returned by get_student_already_tagged),
//      so affectedRows was always 0 → 404.
//      Now we match only on student_number + curriculum + school year, which is
//      always sufficient to identify the correct row.
router.put('/unenrolled_student_in_section/:student_number', async (req, res) => {
  const { student_number } = req.params;
  const { curriculum_id, active_school_year_id, department_section_id } = req.body;

  if (!curriculum_id || !active_school_year_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  try {
    // Resolve the actual section the student is in (use what the frontend sent
    // if available, otherwise look it up so the audit log is accurate).
    let resolvedSectionId = department_section_id;
    if (!resolvedSectionId) {
      const [[current]] = await db3.query(
        `SELECT department_section_id FROM enrolled_subject
         WHERE student_number = ? AND curriculum_id = ? AND active_school_year_id = ?
         AND department_section_id IS NOT NULL AND department_section_id != 0
         LIMIT 1`,
        [student_number, curriculum_id, active_school_year_id]
      );
      resolvedSectionId = current?.department_section_id;
    }

    const [result] = await db3.query(
      `
      UPDATE enrolled_subject
      SET department_section_id = NULL
      WHERE student_number = ? AND curriculum_id = ? AND active_school_year_id = ?
        AND (department_section_id IS NOT NULL AND department_section_id != 0)
      `,
      [student_number, curriculum_id, active_school_year_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Student not found or not tagged to any section" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const sectionLabel = resolvedSectionId
      ? await getDepartmentSectionLabel(resolvedSectionId)
      : "unknown section";

    const [[studentYearLevel]] = await db3.query(
      `
      SELECT ylt.year_level_description
      FROM student_status_table sst
      LEFT JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id
      WHERE sst.student_number = ?
        AND sst.active_curriculum = ?
        AND sst.active_school_year_id = ?
      ORDER BY sst.id DESC
      LIMIT 1
      `,
      [student_number, curriculum_id, active_school_year_id]
    );
    const studentCountLabel = formatStudentCountLabel(
      1,
      String(studentYearLevel?.year_level_description || "").trim().toLowerCase()
    );
    await insertDepartmentSectionTaggingAuditLog({
      req,
      action: "DEPARTMENT_SECTION_STUDENT_UNENROLL",
      message: `${roleLabel} (${actorId}) unenrolled ${studentCountLabel} ${student_number} from ${sectionLabel}.`,
    });

    res.json({ message: "Student untagged from section successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to untag student from section" });
  }
});

module.exports = router;
