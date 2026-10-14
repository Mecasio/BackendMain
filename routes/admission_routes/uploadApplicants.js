const express = require("express");
const { db3 } = require("../database/database");
const { resolveAuditActor } = require("../../utils/auditLogger");
const {
  isStudentNumberTaken,
  assignStudentNumberFromUploadedApplicant,
  assignTraditionalStudentNumberFromUploadedApplicant,
  changeStudentNumberFromUploadedApplicant,
} = require("../../services/studentNumberAssignmentService");

const router = express.Router();

const normalizeText = (value) => String(value ?? "").trim();

const getAuditActor = (req) => {
  const { actorId, actorRole } = resolveAuditActor(req);
  return {
    auditActorId:
      req.body?.audit_actor_id ||
      req.headers["x-audit-actor-id"] ||
      req.headers["x-actor-id"] ||
      req.headers["x-person-id"] ||
      actorId ||
      "unknown",
    auditActorRole:
      req.body?.audit_actor_role ||
      req.headers["x-audit-actor-role"] ||
      req.headers["x-actor-role"] ||
      actorRole ||
      "registrar",
  };
};

const getRequestedUploadedApplicantIds = (body) => {
  const rawIds = Array.isArray(body?.uploaded_applicant_ids)
    ? body.uploaded_applicant_ids
    : [body?.uploaded_applicant_id ?? body?.id].filter((value) => value !== undefined);

  return [
    ...new Set(
      rawIds
        .map((id) => Number.parseInt(id, 10))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
};

const fetchUploadedApplicantsByIds = async (uploadedApplicantIds) => {
  const [uploadedApplicants] = await db3.query(
    `SELECT
       id,
       applicant_number,
       last_name,
       first_name,
       middle_name,
       program,
       email_address,
       contact_num,
       address,
       date_applied,
       uploaded_at
     FROM uploaded_applicants_table
     WHERE id IN (?)`,
    [uploadedApplicantIds],
  );

  const uploadedApplicantOrder = new Map(
    uploadedApplicantIds.map((id, index) => [id, index]),
  );

  uploadedApplicants.sort(
    (left, right) =>
      uploadedApplicantOrder.get(Number(left.id)) -
      uploadedApplicantOrder.get(Number(right.id)),
  );

  return uploadedApplicants;
};

router.get("/uploaded-applicants/check-student-number", async (req, res) => {
  const connection = await db3.getConnection();

  try {
    const studentNumber = normalizeText(req.query.student_number);
    const excludeStudentNumber = normalizeText(req.query.exclude_student_number);

    if (!studentNumber) {
      return res.status(400).json({
        success: false,
        error: "student_number query parameter is required.",
      });
    }

    const exists = await isStudentNumberTaken(connection, studentNumber, {
      excludeStudentNumber,
    });

    res.json({
      success: true,
      exists,
      available: !exists,
    });
  } catch (error) {
    console.error("Uploaded applicant student-number check error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to check student number availability.",
    });
  } finally {
    connection.release();
  }
});

router.post("/uploaded-applicants/assign-student-number", async (req, res) => {
  try {
    const uploadedApplicantIds = getRequestedUploadedApplicantIds(req.body);
    const studentNumber = normalizeText(req.body?.student_number);

    if (!uploadedApplicantIds.length) {
      return res.status(400).json({
        success: false,
        error: "Please select at least one uploaded applicant.",
      });
    }

    if (!studentNumber) {
      return res.status(400).json({
        success: false,
        error: "Student number is required.",
      });
    }

    const uploadedApplicants = await fetchUploadedApplicantsByIds(uploadedApplicantIds);
    const foundUploadedIds = new Set(uploadedApplicants.map((row) => Number(row.id)));
    const { auditActorId, auditActorRole } = getAuditActor(req);
    const assigned = [];
    const skipped = uploadedApplicantIds
      .filter((id) => !foundUploadedIds.has(id))
      .map((id) => ({
        uploaded_applicant_id: id,
        reason: "Uploaded applicant was not found.",
      }));

    for (const uploadedApplicant of uploadedApplicants) {
      try {
        const result = await assignStudentNumberFromUploadedApplicant({
          uploadedApplicant,
          studentNumber,
          auditActorId,
          auditActorRole,
        });

        assigned.push({
          uploaded_applicant_id: uploadedApplicant.id,
          applicant_number: uploadedApplicant.applicant_number,
          ...result,
        });
      } catch (error) {
        skipped.push({
          uploaded_applicant_id: uploadedApplicant.id,
          applicant_number: uploadedApplicant.applicant_number,
          reason: error.message || "Failed to assign student number.",
        });
      }
    }

    const success = assigned.length > 0 && skipped.length === 0;
    const partial = assigned.length > 0 && skipped.length > 0;

    res.status(assigned.length > 0 ? 200 : 400).json({
      success,
      partial,
      assigned,
      skipped,
      assignedCount: assigned.length,
      skippedCount: skipped.length,
      message: partial
        ? `Assigned ${assigned.length} applicant(s), skipped ${skipped.length}.`
        : success
          ? `Assigned ${assigned.length} applicant(s).`
          : "No uploaded applicants were assigned.",
    });
  } catch (error) {
    console.error("Uploaded applicant student-number assignment error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to assign student number to uploaded applicant.",
    });
  }
});

router.post(
  "/uploaded-applicants/assign-student-number/traditional",
  async (req, res) => {
    try {
      const uploadedApplicantIds = getRequestedUploadedApplicantIds(req.body);

      if (!uploadedApplicantIds.length) {
        return res.status(400).json({
          success: false,
          error: "Please select at least one uploaded applicant.",
        });
      }

      const uploadedApplicants = await fetchUploadedApplicantsByIds(
        uploadedApplicantIds,
      );
      const foundUploadedIds = new Set(
        uploadedApplicants.map((row) => Number(row.id)),
      );
      const { auditActorId, auditActorRole } = getAuditActor(req);
      const assigned = [];
      const skipped = uploadedApplicantIds
        .filter((id) => !foundUploadedIds.has(id))
        .map((id) => ({
          uploaded_applicant_id: id,
          reason: "Uploaded applicant was not found.",
        }));

      for (const uploadedApplicant of uploadedApplicants) {
        try {
          const result = await assignTraditionalStudentNumberFromUploadedApplicant(
            {
              uploadedApplicant,
              auditActorId,
              auditActorRole,
            },
          );

          assigned.push({
            uploaded_applicant_id: uploadedApplicant.id,
            applicant_number: uploadedApplicant.applicant_number,
            ...result,
          });
        } catch (error) {
          skipped.push({
            uploaded_applicant_id: uploadedApplicant.id,
            applicant_number: uploadedApplicant.applicant_number,
            reason: error.message || "Failed to assign student number.",
          });
        }
      }

      const success = assigned.length > 0 && skipped.length === 0;
      const partial = assigned.length > 0 && skipped.length > 0;

      res.status(assigned.length > 0 ? 200 : 400).json({
        success,
        partial,
        assigned,
        skipped,
        assignedCount: assigned.length,
        skippedCount: skipped.length,
        message: partial
          ? `Assigned ${assigned.length} applicant(s), skipped ${skipped.length}.`
          : success
            ? `Assigned ${assigned.length} applicant(s).`
            : "No uploaded applicants were assigned.",
      });
    } catch (error) {
      console.error(
        "Uploaded applicant traditional student-number assignment error:",
        error,
      );
      res.status(500).json({
        success: false,
        error: "Failed to assign traditional student number to uploaded applicant.",
      });
    }
  },
);

router.put("/uploaded-applicants/change-student-number", async (req, res) => {
  try {
    const uploadedApplicantId = Number.parseInt(
      req.body?.uploaded_applicant_id ?? req.body?.id,
      10,
    );
    const studentNumber = normalizeText(req.body?.student_number);

    if (!Number.isInteger(uploadedApplicantId) || uploadedApplicantId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Valid uploaded_applicant_id is required.",
      });
    }

    if (!studentNumber) {
      return res.status(400).json({
        success: false,
        error: "Student number is required.",
      });
    }

    const uploadedApplicants = await fetchUploadedApplicantsByIds([uploadedApplicantId]);
    if (!uploadedApplicants.length) {
      return res.status(404).json({
        success: false,
        error: "Uploaded applicant was not found.",
      });
    }

    const { auditActorId, auditActorRole } = getAuditActor(req);
    const result = await changeStudentNumberFromUploadedApplicant({
      uploadedApplicant: uploadedApplicants[0],
      newStudentNumber: studentNumber,
      auditActorId,
      auditActorRole,
    });

    res.json(result);
  } catch (error) {
    console.error("Uploaded applicant student-number change error:", error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || "Failed to change student number.",
    });
  }
});

module.exports = router;
