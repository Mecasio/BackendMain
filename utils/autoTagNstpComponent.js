const autoTagNstpComponent = async ({
  connection,
  enrolledSubjectId,
  studentNumber,
  courseId,
  activeSchoolYearId,
}) => {
  const [[currentCourse]] = await connection.query(
    `SELECT course_code
     FROM course_table
     WHERE course_id = ?
     LIMIT 1`,
    [courseId],
  );

  if (String(currentCourse?.course_code || "").trim().toUpperCase() !== "NSTPROG2") {
    return { tagged: false, reason: "NOT_NSTPROG2" };
  }

  const [[currentTerm]] = await connection.query(
    `SELECT year_id, semester_id
     FROM active_school_year_table
     WHERE id = ?
     LIMIT 1`,
    [activeSchoolYearId],
  );

  if (!currentTerm) return { tagged: false, reason: "CURRENT_TERM_NOT_FOUND" };

  const [[previousNstp]] = await connection.query(
    `SELECT es.component
     FROM enrolled_subject es
     INNER JOIN course_table c ON c.course_id = es.course_id
     INNER JOIN active_school_year_table sy ON sy.id = es.active_school_year_id
     WHERE es.student_number = ?
       AND es.component IN (1, 2, 3)
       AND c.course_code IN ('NSTPROG1', 'NSTPROG2')
       AND (
         sy.year_id < ?
         OR (sy.year_id = ? AND sy.semester_id < ?)
       )
     ORDER BY sy.year_id DESC, sy.semester_id DESC, es.id DESC
     LIMIT 1`,
    [
      studentNumber,
      currentTerm.year_id,
      currentTerm.year_id,
      currentTerm.semester_id,
    ],
  );

  const component = Number(previousNstp?.component);
  if (![1, 2, 3].includes(component)) {
    return { tagged: false, reason: "NO_PREVIOUS_COMPONENT" };
  }

  const [result] = await connection.query(
    `UPDATE enrolled_subject
     SET component = ?
     WHERE id = ?
       AND (component IS NULL OR component = 0)`,
    [component, enrolledSubjectId],
  );

  return {
    tagged: result.affectedRows > 0,
    component,
    reason: result.affectedRows > 0 ? "PREVIOUS_COMPONENT_COPIED" : "ALREADY_TAGGED",
  };
};

module.exports = { autoTagNstpComponent };
