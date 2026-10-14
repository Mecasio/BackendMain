const webtoken = require("jsonwebtoken");
const { db3 } = require("../routes/database/database");

const MAX_MESSAGE_LENGTH = 255;

const getBearerPayload = (req) => {
  const authHeader = req?.headers?.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) return null;

  try {
    return webtoken.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
};

const formatPersonFullName = (person) => {
  const parts = [person?.first_name, person?.middle_name, person?.last_name]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return parts.join(" ") || "Unknown";
};

const truncateMessage = (message) => {
  const safeMessage = String(message || "").trim();
  if (safeMessage.length <= MAX_MESSAGE_LENGTH) return safeMessage;
  return `${safeMessage.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
};

const getAuditLookupId = (req) => {
  const tokenPayload = getBearerPayload(req) || {};
  const lookupId =
    req?.body?.actor_person_id ||
    tokenPayload.person_id ||
    req?.headers?.["x-audit-actor-person-id"] ||
    req?.body?.actor_employee_id ||
    tokenPayload.employee_id ||
    req?.headers?.["x-audit-actor-id"] ||
    req?.headers?.["x-employee-id"] ||
    req?.body?.audit_actor_id ||
    "unknown";
  const lookupEmail =
    tokenPayload.email || req?.headers?.["x-audit-actor-email"] || "";

  return { lookupId, lookupEmail };
};

const getEmployeeActorFromRequest = async (req) => {
  const { lookupId, lookupEmail } = getAuditLookupId(req);

  try {
    const [rows] = await db3.query(
      `
      SELECT
        ua.person_id,
        ua.employee_id,
        ua.email,
        ua.first_name,
        ua.middle_name,
        ua.last_name
      FROM user_accounts ua
      WHERE ua.person_id = ? OR ua.employee_id = ? OR ua.email = ?
      LIMIT 1
      `,
      [lookupId, lookupId, lookupEmail || lookupId],
    );

    if (rows?.[0]) {
      const actor = rows[0];
      return {
        personId: Number(actor.person_id) || 0,
        employeeId: String(actor.employee_id || lookupId || "unknown"),
        email: actor.email || lookupEmail || "unknown",
        name: formatPersonFullName(actor),
      };
    }
  } catch (error) {
    console.error("Student history actor lookup failed:", error);
  }

  return {
    personId: 0,
    employeeId: String(lookupId || "unknown"),
    email: lookupEmail || "unknown",
    name: lookupEmail || String(lookupId || "Unknown User"),
  };
};

const getEmployeeActorFromIds = async ({ actorId, actorEmail }) => {
  const lookupId = String(actorId || "").trim() || "unknown";
  const lookupEmail = String(actorEmail || "").trim();

  try {
    const [rows] = await db3.query(
      `
      SELECT
        ua.person_id,
        ua.employee_id,
        ua.email,
        ua.first_name,
        ua.middle_name,
        ua.last_name
      FROM user_accounts ua
      WHERE ua.person_id = ? OR ua.employee_id = ? OR ua.email = ?
      LIMIT 1
      `,
      [lookupId, lookupId, lookupEmail || lookupId],
    );

    if (rows?.[0]) {
      const actor = rows[0];
      return {
        personId: Number(actor.person_id) || 0,
        employeeId: String(actor.employee_id || lookupId),
        email: actor.email || lookupEmail || "unknown",
        name: formatPersonFullName(actor),
      };
    }
  } catch (error) {
    console.error("Student history actor lookup failed:", error);
  }

  return {
    personId: 0,
    employeeId: lookupId,
    email: lookupEmail || "unknown",
    name: lookupEmail || lookupId,
  };
};

const buildActorLabel = (actor) =>
  `${actor?.name || "Unknown User"} (${actor?.employeeId || "unknown"})`;

const getStudentNameByNumber = async (studentNumber) => {
  const safeStudentNumber = String(studentNumber || "").trim();
  if (!safeStudentNumber) return "Unknown Student";

  try {
    const [rows] = await db3.query(
      `
      SELECT pt.first_name, pt.middle_name, pt.last_name
      FROM student_numbering_table sn
      LEFT JOIN person_table pt ON pt.person_id = sn.person_id
      WHERE sn.student_number = ?
      LIMIT 1
      `,
      [safeStudentNumber],
    );

    if (rows?.[0]) return formatPersonFullName(rows[0]);
  } catch (error) {
    console.error("Student history student lookup failed:", error);
  }

  return "Unknown Student";
};

const getDepartmentSectionLabel = async (departmentSectionId) => {
  if (!departmentSectionId) return "Unknown Section";

  try {
    const [rows] = await db3.query(
      `
      SELECT pt.program_description, pt.major, st.description, dt.dprtmnt_name
      FROM dprtmnt_section_table ds
      LEFT JOIN curriculum_table c ON c.curriculum_id = ds.curriculum_id
      LEFT JOIN program_table pt ON c.program_id = pt.program_id
      LEFT JOIN section_table st ON st.id = ds.section_id
      LEFT JOIN dprtmnt_curriculum_table dc ON dc.curriculum_id = ds.curriculum_id
      LEFT JOIN dprtmnt_table dt ON dt.dprtmnt_id = dc.dprtmnt_id
      WHERE ds.id = ?
      LIMIT 1
      `,
      [departmentSectionId],
    );

    const section = rows?.[0];
    if (!section) return "Unknown Section";

    return [
      section.dprtmnt_name,
      section.program_description,
      section.major,
      section.description,
    ]
      .filter(Boolean)
      .join(" ");
  } catch (error) {
    return "Unknown Section";
  }
};

const getSchoolYearLabel = async (activeSchoolYearId) => {
  if (!activeSchoolYearId) return "current academic year";

  try {
    const [rows] = await db3.query(
      `
      SELECT yt.year_description, s.semester_description
      FROM active_school_year_table sy
      JOIN year_table yt ON sy.year_id = yt.year_id
      JOIN semester_table s ON sy.semester_id = s.semester_id
      WHERE sy.id = ?
      LIMIT 1
      `,
      [activeSchoolYearId],
    );

    if (rows?.[0]) {
      return `${rows[0].year_description}-${parseInt(rows[0].year_description) + 1}, ${rows[0].semester_description}`;
    }
  } catch (error) {
    console.error("Student history school year lookup failed:", error);
  }

  return "current academic year";
};

const getCourseLabel = async (courseId) => {
  try {
    const [rows] = await db3.query(
      "SELECT course_code, course_description FROM course_table WHERE course_id = ? LIMIT 1",
      [courseId],
    );
    const course = rows?.[0];
    if (!course) return `Course ${courseId}`;
    return `${course.course_code || "N/A"} (${course.course_description || "Unknown Course"})`;
  } catch (error) {
    return `Course ${courseId}`;
  }
};
const getExpectedTaggedCourseCount = async (curriculumId, yearLevelId, semesterId) => {
  const [rows] = await db3.query(
    `SELECT COUNT(DISTINCT course_id) AS total
     FROM program_tagging_table
     WHERE curriculum_id = ? AND year_level_id = ? AND semester_id = ?`,
    [curriculumId, yearLevelId, semesterId],
  );
  return Number(rows?.[0]?.total || 0);
};

const buildStudentHistoryMessage = ({ actor, body }) => {
  const actorLabel = buildActorLabel(actor);
  const studentNumber = String(body?.student_number || body?.studentNumber || "").trim();
  const studentName = String(body?.student_name || body?.studentName || "Unknown Student").trim();
  const sectionLabel = String(body?.section_label || body?.sectionLabel || "Unknown Section").trim();
  const schoolYearLabel = String(
    body?.school_year_label || body?.schoolYearLabel || "current academic year",
  ).trim();
  const generatedNumber = String(body?.generated_number || body?.generatedNumber || "").trim();
  const courseLabel = String(body?.course_label || body?.courseLabel || "").trim();
  const paymentTarget = String(body?.payment_target || body?.paymentTarget || "").trim();
  const grade = body?.grade ?? body?.final_grade;
  const courseCount = Array.isArray(body?.courses) ? body.courses.length : 0;

  switch (body?.action) {
    case "assign_student_number":
      return truncateMessage(
        `${actorLabel} generated student number ${generatedNumber} and assigned it to ${studentName}`,
      );
    case "bulk_enroll":
      return truncateMessage(
        `${actorLabel} enrolled ${courseCount} ${courseCount === 1 ? "subject" : "subjects"} for Student (${studentNumber}) ${studentName} in ${sectionLabel} for Academic Year ${schoolYearLabel}.`
      );
    case "enroll_course":
      return truncateMessage(
        `${actorLabel} Enrolled Student (${studentNumber}) ${studentName} to ${sectionLabel} for ${schoolYearLabel}. ${courseLabel}`,
      );
    case "unenroll_course":
      return truncateMessage(
        `${actorLabel} unenrolled ${courseLabel} from Student (${studentNumber}) ${studentName}. ${formatCourseList(body?.remaining_courses || body?.remainingCourses, "Remaining courses")}`,
      );
    case "unenroll_all":
      return truncateMessage(
        `${actorLabel} unenrolled ${courseCount} ${courseCount === 1 ? "subject" : "subjects"} for Student (${studentNumber}) ${studentName} in ${sectionLabel} for Academic Year ${schoolYearLabel}.`
      );
    case "save_matriculation":
      return truncateMessage(
        `${actorLabel} saved matriculation for Student (${studentNumber}) ${studentName}${paymentTarget ? ` (${paymentTarget})` : ""}`,
      );
    case "save_unifast":
      return truncateMessage(
        `${actorLabel} saved UNIFAST for Student (${studentNumber}) ${studentName}${paymentTarget ? ` (${paymentTarget})` : ""}`,
      );
    case "grade_update":
      return truncateMessage(
        `${actorLabel} updated grade to ${grade} for Student (${studentNumber}) ${studentName} in ${courseLabel}`,
      );
    case "program_evaluation_grade":
      return truncateMessage(
        `${actorLabel} submitted program evaluation grade ${grade} for Student (${studentNumber}) ${studentName} in ${courseLabel}`,
      );
    default:
      return truncateMessage(String(body?.message || "").trim());
  }
};

const formatCourseList = (courses, prefix = "Courses") => {
  const labels = (Array.isArray(courses) ? courses : [])
    .map((course) => String(course || "").trim())
    .filter(Boolean);

  if (!labels.length) return "";
  return `${prefix}: ${labels.join(", ")}`;
};

const insertStudentHistoryLog = async ({ studentNumber, message, employeeId }) => {
  const safeStudentNumber = String(studentNumber || "").trim();
  const safeMessage = truncateMessage(message);
  const safeEmployeeId = Number(employeeId) || 0;

  if (!safeStudentNumber || !safeMessage) return false;

  try {
    await db3.query(
      `INSERT INTO student_history_logs (student_number, message, employee_id) VALUES (?, ?, ?)`,
      [safeStudentNumber, safeMessage, safeEmployeeId],
    );
    return true;
  } catch (error) {
    console.error("Student history log insert failed:", error);
    return false;
  }
};

const logStudentHistoryFromRequest = async ({ req, studentNumber, action, details = {}, message }) => {
  const actor = await getEmployeeActorFromRequest(req);
  const finalMessage =
    message ||
    buildStudentHistoryMessage({
      actor,
      body: { action, student_number: studentNumber, ...details },
    });

  if (!finalMessage) return false;

  return insertStudentHistoryLog({
    studentNumber,
    message: finalMessage,
    employeeId: actor.personId,
  });
};

const logStudentHistoryFromActor = async ({
  actorId,
  actorRole,
  studentNumber,
  action,
  details = {},
  message,
}) => {
  const actor = await getEmployeeActorFromIds({ actorId, actorEmail: "" });
  const finalMessage =
    message ||
    buildStudentHistoryMessage({
      actor,
      body: { action, student_number: studentNumber, ...details },
    });

  if (!finalMessage) return false;

  return insertStudentHistoryLog({
    studentNumber,
    message: finalMessage,
    employeeId: actor.personId,
  });
};

module.exports = {
  MAX_MESSAGE_LENGTH,
  buildActorLabel,
  buildStudentHistoryMessage,
  formatCourseList,
  getCourseLabel,
  getDepartmentSectionLabel,
  getEmployeeActorFromIds,
  getEmployeeActorFromRequest,
  getSchoolYearLabel,
  getExpectedTaggedCourseCount,
  getStudentNameByNumber,
  insertStudentHistoryLog,
  logStudentHistoryFromActor,
  logStudentHistoryFromRequest,
  truncateMessage,
};
