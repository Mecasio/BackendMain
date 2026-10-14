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

const nstpLabel = (component) => {
  if (Number(component) === 1) return "CWTS";
  if (Number(component) === 2) return "LTS";
  if (Number(component) === 3) return "MTS";
  return `Component ${component}`;
};

const insertNstpAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

class NstpSectionCapacityError extends Error {
  constructor({ courseCode, enrolledCount, incomingCount, maxSlots }) {
    super(
      maxSlots <= 0
        ? `${courseCode} enrollment is closed in the selected target section.`
        : `${courseCode} has only ${Math.max(maxSlots - enrolledCount, 0)} slot(s) remaining, but ${incomingCount} student(s) were selected.`,
    );
    this.code = "SECTION_FULL";
    this.courseCode = courseCode;
    this.enrolledCount = enrolledCount;
    this.incomingCount = incomingCount;
    this.maxSlots = maxSlots;
  }
}

const assertNstpTransferCapacity = async ({
  connection,
  sourceSectionId,
  targetSectionId,
  activeSchoolYearId,
  studentNumbers,
  yearLevelId,
}) => {
  if (String(sourceSectionId) === String(targetSectionId)) return;

  const studentPlaceholders = studentNumbers.map(() => "?").join(", ");
  const yearLevelFilter = yearLevelId
    ? `AND EXISTS (
        SELECT 1
        FROM student_status_table status_row
        WHERE status_row.student_number = es.student_number
          AND status_row.active_school_year_id = es.active_school_year_id
          AND status_row.year_level_id = ?
      )`
    : "";
  const candidateParams = [
    sourceSectionId,
    activeSchoolYearId,
    ...studentNumbers,
  ];
  if (yearLevelId) candidateParams.push(yearLevelId);

  const [candidateCourses] = await connection.query(
    `SELECT
       es.course_id,
       c.course_code,
       COUNT(DISTINCT es.student_number) AS incoming_count
     FROM enrolled_subject es
     INNER JOIN course_table c ON c.course_id = es.course_id
     WHERE es.department_section_id = ?
       AND es.active_school_year_id = ?
       AND es.student_number IN (${studentPlaceholders})
       AND c.course_code IN ('NSTPROG1', 'NSTPROG2')
       ${yearLevelFilter}
     GROUP BY es.course_id, c.course_code`,
    candidateParams,
  );

  for (const course of candidateCourses) {
    const [slotRows] = await connection.query(
      `SELECT COALESCE(max_slots, 0) AS max_slots
       FROM section_subject_table
       WHERE department_section_id = ?
         AND course_id = ?
         AND active_school_year_id = ?
         AND is_active = 1
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [targetSectionId, course.course_id, activeSchoolYearId],
    );

    const maxSlots = Number(slotRows[0]?.max_slots) || 0;
    const [[countRow]] = await connection.query(
      `SELECT COUNT(DISTINCT student_number) AS enrolled_count
       FROM enrolled_subject
       WHERE department_section_id = ?
         AND course_id = ?
         AND active_school_year_id = ?`,
      [targetSectionId, course.course_id, activeSchoolYearId],
    );
    const enrolledCount = Number(countRow?.enrolled_count) || 0;
    const incomingCount = Number(course.incoming_count) || 0;

    if (maxSlots <= 0 || enrolledCount + incomingCount > maxSlots) {
      throw new NstpSectionCapacityError({
        courseCode: course.course_code,
        enrolledCount,
        incomingCount,
        maxSlots,
      });
    }
  }
};

router.get("/nstp-section-capacities", async (req, res) => {
  const { active_school_year_id } = req.query;

  if (!active_school_year_id) {
    return res.status(400).json({ error: "School year is required." });
  }

  try {
    const [rows] = await db3.query(
      `SELECT
         dst.id AS department_section_id,
         COUNT(sst.id) AS configured_nstp_subjects,
         COALESCE(SUM(GREATEST(COALESCE(sst.max_slots, 0) - COALESCE(ec.enrolled_count, 0), 0)), 0) AS available_slots
       FROM dprtmnt_section_table dst
       LEFT JOIN section_subject_table sst
         ON sst.department_section_id = dst.id
         AND sst.active_school_year_id = ?
         AND sst.is_active = 1
         AND sst.course_id IN (
           SELECT course_id
           FROM course_table
           WHERE course_code IN ('NSTPROG1', 'NSTPROG2')
         )
       LEFT JOIN (
         SELECT department_section_id, course_id, COUNT(DISTINCT student_number) AS enrolled_count
         FROM enrolled_subject
         WHERE active_school_year_id = ?
         GROUP BY department_section_id, course_id
       ) ec
         ON ec.department_section_id = sst.department_section_id
         AND ec.course_id = sst.course_id
       WHERE dst.dsstat = 1
       GROUP BY dst.id`,
      [active_school_year_id, active_school_year_id],
    );

    res.json(rows);
  } catch (err) {
    console.error("Failed to fetch NSTP section capacities:", err);
    res.status(500).json({ error: "Failed to fetch NSTP section capacities." });
  }
});

router.get("/get_student_per_section", async (req, res) => {
  const { department_section_id, active_school_year_id, year_level_id } = req.query;
  console.log(
    "Received params - Department Section ID:",
    department_section_id,
    "Active School Year ID:",
    active_school_year_id,
  );
  try {
    const [rows] = await db3.query(
      `
      SELECT 
      es.student_number, p.first_name, p.last_name,
      pgt.program_code, pgt.program_id, pgt.program_description,
      s.student_number,
      sst.year_level_id,
      ylt.year_level_description
      FROM enrolled_subject es
      JOIN student_numbering_table s ON es.student_number = s.student_number
      JOIN person_table p ON s.person_id = p.person_id
      JOIN student_status_table sst ON es.student_number = sst.student_number 
      AND es.active_school_year_id = sst.active_school_year_id
      JOIN curriculum_table ct ON es.curriculum_id = ct.curriculum_id
      JOIN program_table pgt ON ct.program_id = pgt.program_id
      LEFT JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id
      WHERE es.department_section_id = ? AND es.active_school_year_id = ? AND course_id IN (
        SELECT course_id FROM course_table WHERE course_code IN ('NSTPROG1', 'NSTPROG2')
      )
      ${year_level_id ? "AND sst.year_level_id = ?" : ""}
      `,
      year_level_id
        ? [department_section_id, active_school_year_id, year_level_id]
        : [department_section_id, active_school_year_id],
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch student data" });
  }
});

router.get("/get_nstp_tagged_student", async (req, res) => {
  const { department_section_id, active_school_year_id, year_level_id } = req.query;
  console.log(
    "Received params - Department Section ID:",
    department_section_id,
    "Active School Year ID:",
    active_school_year_id,
  );
  try {
    const [rows] = await db3.query(
      `SELECT 
        es.student_number,
        p.first_name,
        p.last_name,
        pgt.program_code,
        pgt.program_id,
        pgt.program_description,
        s.student_number,
        sst.year_level_id,
        ylt.year_level_description,
        es.component
      FROM enrolled_subject es
      JOIN student_numbering_table s ON es.student_number = s.student_number
      JOIN person_table p ON s.person_id = p.person_id
      JOIN curriculum_table ct ON es.curriculum_id = ct.curriculum_id
      JOIN program_table pgt ON ct.program_id = pgt.program_id
      JOIN student_status_table sst ON es.student_number = sst.student_number 
      AND es.active_school_year_id = sst.active_school_year_id
      LEFT JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id
      WHERE es.department_section_id = ?
        AND es.active_school_year_id = ?
        AND es.component IS NOT NULL
        AND es.component != 0
        ${year_level_id ? "AND sst.year_level_id = ?" : ""}
        AND es.course_id IN (
          SELECT course_id 
          FROM course_table 
          WHERE course_code IN ('NSTPROG1', 'NSTPROG2')
        );
      `,
      year_level_id
        ? [department_section_id, active_school_year_id, year_level_id]
        : [department_section_id, active_school_year_id],
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch NSTP tagged students" });
  }
});

router.put("/enroll_nstp_component", async (req, res) => {
  const {
    department_section_id,
    active_school_year_id,
    curriculum_id,
    year_level_id,
    nstp_type,
    target_department_section_id,
    student_numbers,
  } = req.body;

  const selectedStudentNumbers = Array.isArray(student_numbers)
    ? [...new Set(student_numbers.map((value) => String(value).trim()).filter(Boolean))]
    : [];
  const resolvedTargetSectionId =
    target_department_section_id || department_section_id;
  let connection;

  try {
    if (
      !department_section_id ||
      !active_school_year_id ||
      !nstp_type ||
      !resolvedTargetSectionId ||
      selectedStudentNumbers.length === 0
    ) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const yearLevelFilter = year_level_id
      ? `AND student_number IN (
          SELECT student_number
          FROM student_status_table
          WHERE active_school_year_id = ? AND year_level_id = ?
        )`
      : "";
    const studentPlaceholders = selectedStudentNumbers.map(() => "?").join(", ");

    connection = await db3.getConnection();
    await connection.beginTransaction();
    await assertNstpTransferCapacity({
      connection,
      sourceSectionId: department_section_id,
      targetSectionId: resolvedTargetSectionId,
      activeSchoolYearId: active_school_year_id,
      studentNumbers: selectedStudentNumbers,
      yearLevelId: year_level_id,
    });

    const sql = `
      UPDATE enrolled_subject
      SET component = ?, department_section_id = ?
      WHERE student_number IN (
        SELECT student_number FROM enrolled_subject
        WHERE department_section_id = ? AND active_school_year_id = ?
        AND student_number IN (${studentPlaceholders})
        ${yearLevelFilter}
      ) AND course_id IN (
        SELECT course_id FROM course_table WHERE course_code IN ('NSTPROG1', 'NSTPROG2')
      )
      AND active_school_year_id = ?
    `;

    const params = [
      nstp_type,
      resolvedTargetSectionId,
      department_section_id,
      active_school_year_id,
      ...selectedStudentNumbers,
    ];

    if (year_level_id) {
      params.push(active_school_year_id, year_level_id);
    }

    params.push(active_school_year_id);

    const [result] = await connection.execute(sql, params);
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(409).json({
        error: "No matching NSTP subject records were updated for the checked students.",
      });
    }

    await connection.commit();

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertNstpAuditLog({
      req,
      action: "NSTP_TAGGING_ENROLL_ALL",
      message: `${roleLabel} (${actorId}) enrolled ${selectedStudentNumbers.length} checked student(s) in ${nstpLabel(nstp_type)} and assigned their NSTP subjects to department section ${resolvedTargetSectionId}.`,
    });
    res.json({
      message: "NSTP components updated successfully for the section",
      updated_rows: result.affectedRows,
    });
  } catch (err) {
    if (connection) await connection.rollback();
    if (err?.code === "SECTION_FULL") {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        course_code: err.courseCode,
        enrolled_count: err.enrolledCount,
        incoming_count: err.incomingCount,
        max_slots: err.maxSlots,
      });
    }
    console.error("Error updating NSTP components:", err);
    res.status(500).json({ error: "Failed to update NSTP components" });
  } finally {
    connection?.release();
  }
});

router.put("/enroll_nstp_component/:student_number", async (req, res) => {
  const { student_number } = req.params;
  const {
    department_section_id,
    active_school_year_id,
    curriculum_id,
    year_level_id,
    nstp_type,
    target_department_section_id,
  } = req.body;
  const resolvedTargetSectionId =
    target_department_section_id || department_section_id;
  let connection;
  console.log(
    "Received params - Student Number:",
    student_number,
    "Department Section ID:",
    department_section_id,
    "Active School Year ID:",
    active_school_year_id,
    "Curriculum ID:",
    curriculum_id,
    "NSTP Type:",
    nstp_type,
  );
  try {
    if (
      !student_number ||
      !department_section_id ||
      !active_school_year_id ||
      !nstp_type ||
      !resolvedTargetSectionId
    ) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    connection = await db3.getConnection();
    await connection.beginTransaction();
    await assertNstpTransferCapacity({
      connection,
      sourceSectionId: department_section_id,
      targetSectionId: resolvedTargetSectionId,
      activeSchoolYearId: active_school_year_id,
      studentNumbers: [student_number],
      yearLevelId: year_level_id,
    });

    const sql = `
      UPDATE enrolled_subject
      SET component = ?, department_section_id = ?
      WHERE student_number = ? AND department_section_id = ? AND active_school_year_id = ? AND course_id IN (
        SELECT course_id FROM course_table WHERE course_code IN ('NSTPROG1', 'NSTPROG2')
      )
    `;

    const [result] = await connection.execute(sql, [
      nstp_type,
      resolvedTargetSectionId,
      student_number,
      department_section_id,
      active_school_year_id,
    ]);
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({
        error: "No matching NSTP subject record was found for this student.",
      });
    }

    await connection.commit();

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertNstpAuditLog({
      req,
      action: "NSTP_TAGGING_ENROLL",
      message: `${roleLabel} (${actorId}) enrolled Student (${student_number}) in ${nstpLabel(nstp_type)} and assigned the NSTP subject to department section ${resolvedTargetSectionId}.`,
    });
    res.json({
      message: "NSTP component updated successfully for the student",
      updated_rows: result.affectedRows,
    });
  } catch (err) {
    if (connection) await connection.rollback();
    if (err?.code === "SECTION_FULL") {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        course_code: err.courseCode,
        enrolled_count: err.enrolledCount,
        incoming_count: err.incomingCount,
        max_slots: err.maxSlots,
      });
    }
    console.error("Error updating NSTP component for student:", err);
    res
      .status(500)
      .json({ error: "Failed to update NSTP component for the student" });
  } finally {
    connection?.release();
  }
});

router.put("/unenroll_nstp_component", async (req, res) => {
  const { department_section_id, active_school_year_id, curriculum_id, year_level_id } =
    req.body;

  try {
    if (!department_section_id || !active_school_year_id) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const yearLevelFilter = year_level_id
      ? `AND student_number IN (
          SELECT student_number
          FROM student_status_table
          WHERE active_school_year_id = ? AND year_level_id = ?
        )`
      : "";

    const sql = `
      UPDATE enrolled_subject
      SET component = 0
      WHERE department_section_id = ? AND active_school_year_id = ?
      ${yearLevelFilter}
      AND course_id IN (
        SELECT course_id FROM course_table WHERE course_code IN ('NSTPROG1', 'NSTPROG2')
      )
    `;

    const params = [
      department_section_id,
      active_school_year_id,
    ];

    if (year_level_id) {
      params.push(active_school_year_id, year_level_id);
    }

    const [result] = await db3.execute(sql, params);
    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      await insertNstpAuditLog({
        req,
        action: "NSTP_TAGGING_UNENROLL_ALL",
        message: `${roleLabel} (${actorId}) unenrolled ${result.affectedRows} student(s) from NSTP for department section ${department_section_id}.`,
      });
    }
    res.json({
      message: "NSTP components unenrolled successfully for the section",
    });
  } catch (err) {
    console.error("Error unenrolling NSTP components:", err);
    res.status(500).json({ error: "Failed to unenroll NSTP components" });
  }
});

router.put("/unenroll_nstp_component/:student_number", async (req, res) => {
  const { student_number } = req.params;
  const { department_section_id, active_school_year_id, curriculum_id } =
    req.body;

  try {
    if (
      !student_number ||
      !department_section_id ||
      !active_school_year_id
    ) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const sql = `
      UPDATE enrolled_subject
      SET component = 0
      WHERE student_number = ? AND department_section_id = ? AND active_school_year_id = ? AND course_id IN (
        SELECT course_id FROM course_table WHERE course_code IN ('NSTPROG1', 'NSTPROG2')
      )
    `;

    const [result] = await db3.execute(sql, [
      student_number,
      department_section_id,
      active_school_year_id,
    ]);
    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      await insertNstpAuditLog({
        req,
        action: "NSTP_TAGGING_UNENROLL",
        message: `${roleLabel} (${actorId}) unenrolled Student (${student_number}) from NSTP.`,
      });
    }
    res.json({
      message: "NSTP component unenrolled successfully for the student",
    });
  } catch (err) {
    console.error("Error unenrolling NSTP component for student:", err);
    res
      .status(500)
      .json({ error: "Failed to unenroll NSTP component for the student" });
  }
});

module.exports = router;
