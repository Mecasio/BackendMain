const express = require("express");
const webtoken = require("jsonwebtoken");
const { db3 } = require("../database/database");
const {
  insertAuditLogAdmission,
  insertAuditLogEnrollment,
} = require("../../utils/auditLogger");
const { resolveUserMacAddress } = require("../../utils/macAddress");

const router = express.Router();

const getBearerPayload = (req) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return null;
  try {
    return webtoken.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
};

const formatPersonFullName = (person, fallback = "Unknown person") => {
  const fullName = [
    person?.first_name || person?.fname,
    person?.middle_name || person?.mname,
    person?.last_name || person?.lname,
    person?.extension,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  return fullName || fallback;
};

const getAuditEventActorFromRequest = async (req) => {
  const tokenPayload = getBearerPayload(req) || {};
  const lookupId =
    req.body?.actor_person_id ||
    tokenPayload.person_id ||
    req.headers["x-audit-actor-person-id"] ||
    req.headers["x-audit-actor-id"] ||
    tokenPayload.employee_id ||
    req.body?.actor_employee_id ||
    "unknown";
  const lookupEmail = tokenPayload.email || req.headers["x-audit-actor-email"] || "";

  try {
    const [rows] = await db3.query(
      `
      SELECT
        ua.employee_id,
        ua.email,
        ua.first_name,
        ua.middle_name,
        ua.last_name,
        at.access_description
      FROM user_accounts ua
      LEFT JOIN access_table at ON at.access_id = ua.access_level
      WHERE ua.person_id = ? OR ua.employee_id = ? OR ua.email = ?
      LIMIT 1
      `,
      [lookupId, lookupId, lookupEmail || lookupId],
    );

    if (rows?.[0]) {
      const actor = rows[0];
      return {
        id: actor.employee_id || lookupId,
        email: actor.email || lookupEmail || "unknown",
        name: formatPersonFullName(actor, actor.email || lookupId),
        accessDescription: actor.access_description || "",
      };
    }
  } catch (error) {
    console.error("Audit actor lookup failed:", error);
  }

  return {
    id: req.body?.actor_employee_id || lookupId,
    email: lookupEmail || "unknown",
    name: req.headers["x-audit-actor-name"] || lookupEmail || lookupId,
    accessDescription: req.headers["x-audit-actor-role"] || "",
  };
};

const getFacultyAuditActor = async (profId) => {
  try {
    const [rows] = await db3.query(
      "SELECT prof_id, employee_id, email, fname, mname, lname FROM prof_table WHERE prof_id = ? LIMIT 1",
      [profId],
    );

    if (rows?.[0]) {
      const professor = rows[0];
      return {
        id: professor.employee_id || professor.prof_id,
        auditId: professor.prof_id,
        email: professor.email || "unknown",
        name: `${professor.lname || ""}, ${professor.fname || ""} ${professor.mname || ""}`.trim(),
      };
    }
  } catch (error) {
    console.error("Faculty audit actor lookup failed:", error);
  }

  return {
    id: profId || "unknown",
    auditId: profId || "unknown",
    email: "unknown",
    name: profId || "unknown",
  };
};

const buildAuditEventMessage = async (req) => {
  const eventType = String(req.body?.event_type || "").trim();
  const details = req.body?.details || {};
  const actor = eventType.startsWith("faculty_")
    ? await getFacultyAuditActor(details.prof_id)
    : await getAuditEventActorFromRequest(req);
  const employeePrefix = `${actor.accessDescription || "Employee ID"} #${actor.id} - ${actor.email || actor.name}`;
  const userPrefix = `User #${actor.id} - ${actor.name}`;

  const gradeEntry = `${details.min_score}-${details.max_score} = ${details.equivalent_grade}`;
  const gradingSheetProfessor = details.professor_name || `Prof. ${actor.name || "Unknown Faculty"}`;
  const gradingSheetEmployeeId = details.employee_id || actor.id || "N/A";
  const gradingSheetStudent = details.student_name || "Unknown Student";
  const gradingSheetStudentNumber = details.student_number || "N/A";
  const gradingSheetSubject = details.subject_name || details.course_description || "N/A";
  const gradingSheetSubjectCode = details.subject_code ? ` (${details.subject_code})` : "";
  const gradingSheetSection = details.section_name
    ? ` - ${details.program_code ? `${details.program_code}-` : ""}${details.section_name}`
    : "";
  const gradingSheetFile = details.file_name || "N/A";
  const gradingSheetStudentCount = details.student_count
    ? ` (${details.student_count} student/s)`
    : "";
  const gradingSheetImportCount = details.imported_count
    ? ` Imported: ${details.imported_count}.`
    : "";
  const gradingSheetError = details.error_message ? ` Reason: ${details.error_message}` : "";
  const gradingSheetMidterm = details.midterm_equivalent_grade || details.midterm_grade || "N/A";
  const gradingSheetFinalterm = details.finalterm_equivalent_grade || details.finalterm_grade || "N/A";
  const gradingSheetFinalGrade = details.final_equivalent_grade || details.final_grade || "N/A";
  const schedulePage = details.page_name === "College Schedule Checker"
    ? "College Schedule Checker"
    : "Schedule Checker";
  const scheduleType = details.schedule_type === "honorarium" ? "honorarium" : "regular";
  const actorRoleLabel = actor.accessDescription || req.headers["x-audit-actor-role"] || "Registrar";
  const actorDisplayName = actor.name || actor.email || "Unknown User";
  const actorNameWithId = `${actorRoleLabel} ${actorDisplayName} (${actor.id || "N/A"})`;
  const preparedByName = details.prepared_by_name || "Unknown User";
  const preparedByEmployeeId = details.prepared_by_employee_id || "N/A";
  const applicantName = details.applicant_name || "Unknown Applicant";
  const applicantNumber = details.applicant_number || "N/A";
  const searchedStudentName = details.student_name || "Unknown Student";
  const searchedStudentNumber = details.student_number || "N/A";

  const events = {
    grade_conversion_saved: {
      type: details.is_update ? "update" : "insert",
      message: `${employeePrefix} successfully ${details.is_update ? "updated" : "created"} grade conversion entry (${gradeEntry})`,
    },
    grade_conversion_deleted: {
      type: "delete",
      message: `${employeePrefix} successfully deleted grade conversion entry (${gradeEntry})`,
    },
    honors_rule_saved: {
      type: details.is_update ? "update" : "insert",
      message: `${employeePrefix} successfully ${details.is_update ? "updated" : "created"} honors rule (${details.title || "Untitled"})`,
    },
    honors_rule_deleted: {
      type: "delete",
      message: `${employeePrefix} successfully deleted honors rule (${details.title || "Untitled"})`,
    },
    grading_period_activated: {
      type: "update",
      message: `${employeePrefix} successfully activated grading period (${details.description || details.id || "N/A"})`,
    },
    enrolled_subjects_imported: {
      type: "import",
      message: `${employeePrefix} successfully imported enrolled subjects from XLSX${details.imported_count ? ` (${details.imported_count} record/s)` : ""}${details.skipped_count ? ` with ${details.skipped_count} skipped row/s` : ""}`,
    },
    payment_saved: {
      type: "insert",
      message: `${employeePrefix} successfully saved student #${details.student_number || "N/A"} payment to ${details.payment_target || "N/A"}`,
    },
    payment_transferred: {
      type: "insert",
      message: `${employeePrefix} successfully transferred student #${details.student_number || "N/A"} payment to ${details.payment_target || "N/A"}`,
    },
    schedule_inserted: {
      type: "insert",
      message: `${employeePrefix} successfully inserted ${scheduleType} schedule in ${schedulePage}`,
    },
    schedule_designation_inserted: {
      type: "insert",
      message: `${employeePrefix} successfully inserted designation schedule in ${schedulePage}`,
    },
    schedule_deleted: {
      type: "delete",
      message: `${employeePrefix} successfully deleted schedule in ${schedulePage}`,
    },
    program_evaluation_grade_submitted: {
      type: "submit",
      message: `${userPrefix} successfully submitted student grades in Program Evaluation`,
    },
    faculty_grading_sheet_grade_submitted: {
      type: "submit",
      message: `${gradingSheetProfessor} (${gradingSheetEmployeeId}) graded the student ${gradingSheetStudent} (${gradingSheetStudentNumber}) in ${gradingSheetSubject}${gradingSheetSubjectCode}.\nMidterm Grade: ${gradingSheetMidterm}\nFinalterm Grade: ${gradingSheetFinalterm}\nFinal Grade: ${gradingSheetFinalGrade}`,
    },
    faculty_grading_sheet_exported: {
      type: "export",
      message: `${gradingSheetProfessor} (${gradingSheetEmployeeId}) exported the Grading Sheet for ${gradingSheetSubject}${gradingSheetSubjectCode}${gradingSheetSection}${gradingSheetStudentCount}. File: ${gradingSheetFile}`,
    },
    faculty_grading_sheet_upload_succeeded: {
      type: "upload",
      message: `${gradingSheetProfessor} (${gradingSheetEmployeeId}) successfully imported grades in Grading Sheet for ${gradingSheetSubject}${gradingSheetSubjectCode}${gradingSheetSection}. File: ${gradingSheetFile}.${gradingSheetImportCount}`,
    },
    faculty_grading_sheet_upload_tried: {
      type: "upload",
      message: `${gradingSheetProfessor} (${gradingSheetEmployeeId}) tried to import grades in Grading Sheet for ${gradingSheetSubject}${gradingSheetSubjectCode}${gradingSheetSection}. File: ${gradingSheetFile}.${gradingSheetError}`,
    },
    faculty_grading_sheet_upload_failed: {
      type: "upload",
      message: `${gradingSheetProfessor} (${gradingSheetEmployeeId}) failed to import grades in Grading Sheet for ${gradingSheetSubject}${gradingSheetSubjectCode}${gradingSheetSection}. File: ${gradingSheetFile}.${gradingSheetError}`,
    },
    faculty_grading_sheet_save_all: {
      type: "submit",
      message: `${userPrefix} executed Save All in Grading Sheet. Success: ${Number(details.success_count || 0)}, Failed: ${Number(details.fail_count || 0)}`,
    },
    faculty_grading_sheet_grades_posted: {
      type: "submit",
      message: `${gradingSheetProfessor} (${gradingSheetEmployeeId}) posted student grades in Grading Sheet for ${gradingSheetSubject}${gradingSheetSubjectCode}${gradingSheetSection}. Posted: ${Number(details.posted_count || 0)} student/s.`,
    },
    faculty_evaluation_printed: {
      type: "Printing",
      message: `${userPrefix} printed Faculty Evaluation Report`,
    },
    examination_profile_prepared_by_set: {
      type: "update",
      message: `${actorNameWithId} set ${preparedByName} (${preparedByEmployeeId}) as a campus administrator in examination profile of ${applicantName} (${applicantNumber})`,
    },
    student_cor_searched: {
      type: "search",
      message: `${actorNameWithId} searched the certificate of registration of student ${searchedStudentName} (${searchedStudentNumber})`,
    },
    student_basic_info_searched: {
      type: "search",
      message: `${actorNameWithId} searched the basic information of student ${searchedStudentName} (${searchedStudentNumber}).`,
    },
    PRINTING_APPLICANT_DOCS: {
      type: "Printing",
      message: details.failed
        ? `${actorNameWithId} failed to print ${details.document_label || "applicant document"} for applicant ${applicantName} (${applicantNumber}).`
        : `${actorNameWithId} printed ${details.document_label || "applicant document"} for applicant ${applicantName} (${applicantNumber}).`,
    },
    PRINTING_STUDENT_DOCS: {
      type: "Printing",
      message: details.failed
        ? `${actorNameWithId} failed to print ${details.document_label || "student document"} for student ${searchedStudentName} (${searchedStudentNumber}).`
        : `${actorNameWithId} printed ${details.document_label || "student document"} for student ${searchedStudentName} (${searchedStudentNumber}).`,
    },
    DOWNLOAD_EXAM_PDF: {
      type: "Download",
      message: details.failed
        ? `${actorNameWithId} failed to download ${details.document_label || "exam document"} PDF for applicant ${applicantName} (${applicantNumber}).`
        : `${actorNameWithId} downloaded ${details.document_label || "exam document"} PDF for applicant ${applicantName} (${applicantNumber}).`,
    },
  };

  const event = events[eventType];
  if (!event) return null;

  return {
    ...event,
    eventType,
    actor,
    auditId: actor.auditId || actor.id,
  };
};

router.post("/audit/event", async (req, res) => {
  try {
    const auditEvent = await buildAuditEventMessage(req);
    if (!auditEvent) {
      return res.status(400).json({ message: "Unsupported audit event" });
    }

    const insertFn =
      auditEvent.eventType === "PRINTING_APPLICANT_DOCS" ||
        auditEvent.eventType === "DOWNLOAD_EXAM_PDF"
        ? insertAuditLogAdmission
        : insertAuditLogEnrollment;

    const userMacAddress = await resolveUserMacAddress(req);

    await insertFn({
      actorId: auditEvent.actor.id,
      role: req.headers["x-audit-actor-role"] || req.body?.audit_actor_role || "faculty",
      action: auditEvent.eventType,
      severity:
        (auditEvent.eventType === "PRINTING_APPLICANT_DOCS" ||
          auditEvent.eventType === "PRINTING_STUDENT_DOCS" ||
          auditEvent.eventType === "DOWNLOAD_EXAM_PDF") &&
          req.body?.details?.failed
          ? "WARNING"
          : "INFO",
      message: auditEvent.message,
      userMacAddress,
    });

    res.json({ success: true, message: "Log inserted" });
  } catch (error) {
    console.error("Error inserting audit event:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
