const express = require("express");
const { db3 } = require("../database/database");
const { insertAuditLogEnrollment } = require("../../utils/auditLogger");
const {
  getCourseLabel,
  getStudentNameByNumber,
  logStudentHistoryFromRequest,
} = require("../../utils/studentHistoryLogger");

const router = express.Router();

const formatEnrollmentAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";
  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getEnrollmentAuditActor = (req) => ({
  actorId:
    req.body?.audit_actor_id ||
    req.headers["x-audit-actor-id"] ||
    req.headers["x-employee-id"] ||
    "unknown",
  actorRole:
    req.body?.audit_actor_role ||
    req.headers["x-audit-actor-role"] ||
    "registrar",
});

const getGradeUpdateCourseLabel = async (courseId) => {
  try {
    const [rows] = await db3.query(
      "SELECT course_code, course_description FROM course_table WHERE course_id = ? LIMIT 1",
      [courseId],
    );
    const course = rows?.[0];
    if (!course) return `course_id ${courseId}`;
    return `${course.course_code || "N/A"} - ${course.course_description || "Untitled Course"}`;
  } catch (err) {
    console.error("Grade audit course lookup failed:", err);
    return `course_id ${courseId}`;
  }
};

// NEW API
router.post("/update-grade", async (req, res) => {
  const { course_id, student_number, final_grade } = req.body;
  console.log("Enrolled ID", course_id);
  console.log("Student Number", student_number);
  console.log("Final Grade", final_grade);

  if (!course_id || !student_number || final_grade === undefined) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const [result] = await db3.execute(
      `UPDATE enrolled_subject
             SET final_grade = ?
             WHERE student_number = ? AND course_id = ?`,
      [final_grade, student_number, course_id],
    );

    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getEnrollmentAuditActor(req);
      const roleLabel = formatEnrollmentAuditActorRole(actorRole);
      const courseLabel = await getGradeUpdateCourseLabel(course_id);
      await insertAuditLogEnrollment({
        actorId,
        role: actorRole,
        action: "REGISTRAR_GRADE_UPDATE",
        severity: "INFO",
        message: `${roleLabel} (${actorId}) updated grade of Student (${student_number}) in ${courseLabel} to ${final_grade}.`,
      });

      const [studentName, courseHistoryLabel] = await Promise.all([
        getStudentNameByNumber(student_number),
        getCourseLabel(course_id),
      ]);

      await logStudentHistoryFromRequest({
        req,
        studentNumber: student_number,
        action: "program_evaluation_grade",
        details: {
          student_name: studentName,
          course_label: courseHistoryLabel,
          grade: final_grade,
        },
      });
    }

    res.json({ success: true, message: "Grade updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update grade" });
  }
});

module.exports = router;
