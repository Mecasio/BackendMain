const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { db, db3 } = require("../database/database");
const { insertAuditLogAdmission } = require("../../utils/auditLogger");

const uploadDir = path.join(
  __dirname,
  "..",
  "..",
  "uploads",
  "ApplicantOnlineDocuments"
);

const getRequirementUploadAuditInfo = async (uploadId) => {
  const [rows] = await db.query(
    `
    SELECT
      ru.upload_id,
      ru.person_id,
      ru.status,
      ru.document_status,
      rt.description,
      ant.applicant_number,
      pt.first_name,
      pt.middle_name,
      pt.last_name,
      pt.emailAddress
    FROM requirement_uploads ru
    LEFT JOIN requirements_table rt ON rt.id = ru.requirements_id
    LEFT JOIN person_table pt ON pt.person_id = ru.person_id
    LEFT JOIN applicant_numbering_table ant ON ant.person_id = ru.person_id
    WHERE ru.upload_id = ?
    LIMIT 1
    `,
    [uploadId],
  );

  return rows?.[0] || null;
};

const requirementStatusLabel = (status) => {
  if (Number(status) === 1) return "Verified";
  if (Number(status) === 2) return "Rejected";
  return "Pending";
};


// Ito
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024 // ✅ 4MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/jpg",
      "application/pdf"
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Only JPG, JPEG, PNG, PDF allowed"));
    }

    cb(null, true);
  }
});

router.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      error: "File exceeds 4MB limit"
    });
  }

  if (err.message === "Only JPG, JPEG, PNG, PDF allowed") {
    return res.status(400).json({
      error: err.message
    });
  }

  next(err);
});

const applicantAuditLabel = (applicant) => {
  const applicantName = [
    applicant?.last_name,
    applicant?.first_name,
    applicant?.middle_name,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    applicant?.applicant_number ||
    applicantName ||
    applicant?.emailAddress ||
    `person_id ${applicant?.person_id || "unknown"}`
  );
};


const insertRequirementAuditLog = async ({
  actorId,
  actorRole,
  message,
  severity = "INFO",
}) => {
  await insertAuditLogAdmission({
    actorId: actorId || "unknown",
    role: actorRole || "registrar",
    action: "APPLICANT_REQUIREMENTS",
    severity,
    message,
  });
};

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};


const getApplicantDocumentStatusInfo = async (applicantNumber) => {
  const [rows] = await db.query(
    `
    SELECT
      ant.applicant_number,
      pt.person_id,
      pt.first_name,
      pt.middle_name,
      pt.last_name,
      pt.emailAddress,
      ru.document_status
    FROM applicant_numbering_table ant
    INNER JOIN person_table pt ON pt.person_id = ant.person_id
    LEFT JOIN requirement_uploads ru ON ru.person_id = pt.person_id
    WHERE ant.applicant_number = ?
    ORDER BY ru.upload_id DESC
    LIMIT 1
    `,
    [applicantNumber],
  );

  return rows?.[0] || null;
};


const getShortLabel = async (desc) => {
  try {
    const [rows] = await db.query(
      "SELECT short_label FROM requirements_table WHERE LOWER(description) LIKE CONCAT('%', LOWER(?), '%') LIMIT 1",
      [desc],
    );

    if (rows.length > 0) {
      return rows[0].short_label; //  return short_label directly from DB
    } else {
      return "Unknown"; // no match found
    }
  } catch (error) {
    console.error("Error fetching short_label:", error);
    return "Unknown";
  }
};


router.get("/person_with_applicant/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [[person]] = await db.query(
      `
      SELECT
        pt.*,
        ant.applicant_number,
        ps.qualifying_result AS qualifying_exam_score,
        ps.interview_result AS qualifying_interview_score,
        ps.exam_result AS exam_score
      FROM person_table pt
      LEFT JOIN applicant_numbering_table ant ON pt.person_id = ant.person_id
      LEFT JOIN person_status_table ps ON ps.person_id = pt.person_id
      WHERE pt.person_id = ? OR ant.applicant_number = ?
      LIMIT 1
    `,
      [id, id],
    );

    if (!person) {
      return res.status(404).json({ message: "Person not found" });
    }

    // get latest document status + evaluator
    const [rows] = await db.query(
      `
      SELECT
        ru.document_status    AS upload_document_status,
        rt.id                 AS requirement_id,
        ua.email              AS evaluator_email,
        ua.role               AS evaluator_role,
        ua.first_name              AS evaluator_fname,
        ua.middle_name              AS evaluator_mname,
        ua.last_name              AS evaluator_lname,
        ru.created_at,
        ru.last_updated_by
      FROM requirement_uploads AS ru
      LEFT JOIN requirements_table AS rt ON ru.requirements_id = rt.id
      LEFT JOIN enrollment.user_accounts ua ON ru.last_updated_by = ua.person_id
      WHERE ru.person_id = ?
      ORDER BY ru.created_at DESC
    `,
      [person.person_id],
    );

    if (rows.length > 0) {
      person.document_status = rows[0].upload_document_status || "On process";
      person.evaluator = rows[0];
    } else {
      person.document_status = "On process";
      person.evaluator = null;
    }

    res.json(person);
  } catch (err) {
    console.error(" Error fetching person_with_applicant:", err);
    res.status(500).json({ error: "Failed to fetch person" });
  }
});

router.get("/uploads/by-applicant/:applicant_number", async (req, res) => {
  const applicant_number = req.params.applicant_number;

  try {
    const [personResult] = await db.query(
      "SELECT person_id FROM applicant_numbering_table WHERE applicant_number = ?",
      [applicant_number],
    );

    if (personResult.length === 0) {
      return res.status(404).json({ message: "Applicant not found" });
    }

    const person_id = personResult[0].person_id;

    const [uploads] = await db.query(
      `
      SELECT
        ru.upload_id,
        ru.requirements_id,
        ru.person_id,
        ru.file_path,
        ru.original_name,
        ru.remarks,
        ru.status,

        CASE
          WHEN ru.status = 1 THEN 'Approved'
          WHEN ru.status = 2 THEN 'Rejected'
          ELSE 'Pending'
        END AS status_label,

        ru.document_status,
        ru.registrar_status,
        ru.created_at,
        rt.description,


        ua.email AS evaluator_email,
        ua.role  AS evaluator_role,
        ua.last_name AS evaluator_lname,
        ua.first_name AS evaluator_fname,
        ua.middle_name AS evaluator_mname

      FROM requirement_uploads ru
      JOIN requirements_table rt
        ON ru.requirements_id = rt.id
      LEFT JOIN enrollment.user_accounts ua
        ON ru.last_updated_by = ua.person_id
      WHERE ru.person_id = ?
      `,
      [person_id],
    );

    res.status(200).json(uploads);
  } catch (err) {
    console.error("Error fetching uploads by applicant number:", err);
    res.status(500).json({ message: "Internal Server Error", error: err });
  }
});

router.get("/document_status/:applicant_number", async (req, res) => {
  const { applicant_number } = req.params;

  try {
    const [rows] = await db.query(
      `
      SELECT
        COALESCE(ru.document_status, 'On process') AS document_status,
        ua.email AS evaluator_email,
        ua.last_name AS evaluator_lname,
        ua.first_name AS evaluator_fname,
        ua.middle_name AS evaluator_mname,
        ru.created_at
      FROM applicant_numbering_table ant
      INNER JOIN person_table pt ON pt.person_id = ant.person_id
      LEFT JOIN requirement_uploads ru ON ru.person_id = pt.person_id
      LEFT JOIN enrollment.user_accounts ua ON ua.person_id = ru.last_updated_by
      WHERE ant.applicant_number = ?
      ORDER BY ru.upload_id DESC
      LIMIT 1
      `,
      [applicant_number],
    );

    const row = rows?.[0] || {};
    res.json({
      document_status: row.document_status || "On process",
      evaluator: row.evaluator_email
        ? {
          evaluator_email: row.evaluator_email,
          evaluator_lname: row.evaluator_lname,
          evaluator_fname: row.evaluator_fname,
          evaluator_mname: row.evaluator_mname,
          created_at: row.created_at,
        }
        : null,
    });
  } catch (err) {
    console.error("Error fetching document status:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

router.put("/document_status/:applicant_number", async (req, res) => {
  const { applicant_number } = req.params;
  const {
    document_status,
    user_id,
    audit_actor_id,
    audit_actor_role,
  } = req.body;

  if (!document_status || !user_id) {
    return res.status(400).json({
      message: "document_status and user_id are required",
    });
  }

  try {
    const applicantBefore = await getApplicantDocumentStatusInfo(applicant_number);

    if (!applicantBefore) {
      return res.status(404).json({ message: "Applicant not found" });
    }

    let statusSyncSql = "";
    const updateParams = [document_status, user_id];

    if (document_status === "Documents Verified & ECAT") {
      statusSyncSql = ", ru.status = ?, ru.verified_at = NOW()";
      updateParams.push(1);
    } else if (document_status === "Disapproved / Program Closed") {
      statusSyncSql = ", ru.status = ?, ru.verified_at = NULL";
      updateParams.push(2);
    } else {
      statusSyncSql = ", ru.verified_at = NULL";
    }

    updateParams.push(applicant_number);

    const [result] = await db.query(
      `
      UPDATE requirement_uploads ru
      INNER JOIN applicant_numbering_table ant ON ant.person_id = ru.person_id
      SET ru.document_status = ?, ru.last_updated_by = ?${statusSyncSql}
      WHERE ant.applicant_number = ?
      `,
      updateParams,
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Applicant uploads not found" });
    }

    if (
      String(applicantBefore.document_status || "On process") !==
      String(document_status || "On process")
    ) {
      const safeActor = audit_actor_id || user_id || "unknown";
      const roleLabel = formatAuditActorRole(audit_actor_role || "registrar");

      await insertRequirementAuditLog({
        actorId: safeActor,
        actorRole: audit_actor_role || "registrar",
        message: `${roleLabel} (${safeActor}) changed overall document status of Applicant (${applicantAuditLabel(applicantBefore)}) from ${applicantBefore.document_status || "On process"} to ${document_status}.`,
      });
    }

    res.json({
      success: true,
      document_status,
      message: "Document status updated successfully",
    });
  } catch (err) {
    console.error("Error updating document status:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

//  Get uploads with evaluator info

// Add to server.js
// “ GET persons and their applicant numbers for AdminRequirementsPanel.jsx
router.get("/upload_documents", async (req, res) => {
  try {
    const [persons] = await db.query(`
      SELECT
        pt.person_id,
        pt.first_name,
        pt.middle_name,
        pt.last_name,
        pt.profile_img,
        pt.height,
        pt.generalAverage1,
        pt.emailAddress,
        ant.applicant_number,
        pt.applyingAs
      FROM person_table pt
      LEFT JOIN applicant_numbering_table ant ON pt.person_id = ant.person_id
    `);

    res.status(200).json(persons);
  } catch (error) {
    console.error(" Error fetching upload documents:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

//  Update status only
router.put("/uploads/status/:upload_id", async (req, res) => {
  const { upload_id } = req.params;
  const { status, user_id, audit_actor_id, audit_actor_role } = req.body;

  try {
    const uploadBefore = await getRequirementUploadAuditInfo(upload_id);
    if (!uploadBefore) {
      return res.status(404).json({ message: "Upload not found" });
    }

    // 1. Update single row status
    await db.query(
      `UPDATE requirement_uploads
       SET status = ?, last_updated_by = ?, verified_at = CASE WHEN ? = 1 OR ? = '1' THEN NOW() ELSE NULL END
       WHERE upload_id = ?`,
      [status, user_id, status, status, upload_id]
    );

    const person_id = uploadBefore.person_id;

    // 3. Get all verifiable documents of this applicant
    const [docs] = await db.query(
      `SELECT status
       FROM requirement_uploads ru
       JOIN requirements_table rt ON ru.requirements_id = rt.id
       WHERE ru.person_id = ?
       AND rt.is_verifiable = 1`,
      [person_id]
    );

    // 4. Check if ALL are verified (status = 1)
    const allVerified = docs.length > 0 && docs.every(d => d.status === 1);

    if (allVerified) {
      // 🔥 5. AUTO UPDATE document_status
      await db.query(
        `UPDATE requirement_uploads
         SET document_status = 'Documents Verified & ECAT',
             verified_at = COALESCE(verified_at, NOW())
         WHERE person_id = ?`,
        [person_id]
      );

      // 🔥 6. OPTIONAL: ensure ALL status = 1 (safety sync)
      await db.query(
        `UPDATE requirement_uploads
         SET status = 1
         WHERE person_id = ?`,
        [person_id]
      );
    }

    if (String(uploadBefore.status ?? "0") !== String(status ?? "0")) {
      const safeActor = audit_actor_id || user_id || "unknown";
      const roleLabel = formatAuditActorRole(audit_actor_role || "registrar");
      await insertRequirementAuditLog({
        actorId: safeActor,
        actorRole: audit_actor_role || "registrar",
        message: `${roleLabel} (${safeActor}) changed document status of Applicant (${applicantAuditLabel(uploadBefore)}) for ${uploadBefore.description || "document"} from ${requirementStatusLabel(uploadBefore.status)} to ${requirementStatusLabel(status)}.`,
      });
    }

    res.json({ message: "Status updated and auto-sync checked." });

  } catch (err) {
    console.error("Error updating status:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

router.delete("/admin/uploads/:uploadId", async (req, res) => {
  const { uploadId } = req.params;

  try {
    // 1¸ Get upload row (file + person_id)
    const [uploadRows] = await db.query(
      "SELECT person_id, file_path FROM requirement_uploads WHERE upload_id = ?",
      [uploadId],
    );
    if (!uploadRows.length) {
      return res.status(404).json({ error: "Upload not found." });
    }

    const { person_id: personId, file_path: filePath } = uploadRows[0];

    // 2¸ Applicant info
    const [[appInfo]] = await db.query(
      `
      SELECT ant.applicant_number, pt.last_name, pt.first_name, pt.middle_name
      FROM applicant_numbering_table ant
      JOIN person_table pt ON ant.person_id = pt.person_id
      WHERE ant.person_id = ?
    `,
      [personId],
    );

    const applicant_number = appInfo?.applicant_number || "Unknown";
    const fullName = `${appInfo?.last_name || ""}, ${appInfo?.first_name || ""} ${appInfo?.middle_name?.charAt(0) || ""}.`;

    // 3¸ Actor (admin performing the action)
    const user_person_id = req.headers["x-person-id"];

    // 4¸ Delete physical file
    if (filePath) {
      const fullPath = path.join(uploadDir, filePath);

      try {
        await fs.promises.unlink(fullPath);
        console.log("—‘¸ File deleted:", fullPath);
      } catch (err) {
        if (err.code === "ENOENT") {
          console.warn(" ¸ File already missing:", fullPath);
        } else {
          console.error("File delete error:", err);
        }
      }
    }

    // 5¸ Delete DB record
    await db.query("DELETE FROM requirement_uploads WHERE upload_id = ?", [
      uploadId,
    ]);

    // Deleted upload record and file.
   

    res.status(200).json({ message: " Upload deleted successfully." });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Failed to delete the upload." });
  }
});

router.get("/uploads/preview/:uploadId", async (req, res) => {
  const { uploadId } = req.params;

  try {
    const [[row]] = await db.query(
      "SELECT file_path FROM requirement_uploads WHERE upload_id = ?",
      [uploadId]
    );

    if (!row || !row.file_path) {
      return res.status(404).json({ error: "File record not found" });
    }

    const dir = uploadDir;
    let fullPath = path.join(dir, row.file_path);

    if (!fs.existsSync(fullPath)) {
      // Fallback: DB extension is stale — find the actual file on disk
      // that shares the same base name regardless of extension.
      const baseName = path.basename(row.file_path, path.extname(row.file_path));
      const filesInDir = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const match = filesInDir.find(
        (f) => path.basename(f, path.extname(f)) === baseName
      );

      if (!match) {
        return res.status(404).json({ error: "File not found on server" });
      }
      fullPath = path.join(dir, match);
    }

    res.sendFile(fullPath);
  } catch (err) {
    console.error("Applicant preview error:", err);
    res.status(500).json({ error: "Failed to load file" });
  }
});

router.get("/uploads/:personId", async (req, res) => {
  const personId = req.params.personId;
  if (!personId) return res.status(400).json({ error: "Missing person ID" });

  try {
    const [results] = await db.query(
      `
      SELECT
        ru.upload_id,
        ru.requirements_id,
        ru.person_id,
        ru.file_path,
        ru.original_name,
        ru.remarks,
        ru.status,
        rt.description,
        rt.short_label
      FROM requirement_uploads ru
      LEFT JOIN requirements_table rt ON ru.requirements_id = rt.id
      WHERE ru.person_id = ?
      ORDER BY ru.upload_id DESC
    `,
      [personId],
    );

    res.json(results);
  } catch (err) {
    console.error("Fetch uploads failed:", err);
    res.status(500).json({ error: "Failed to fetch uploads" });
  }
});

//  UPDATE Remarks ONLY (no socket emit, no evaluator lookup)
//  Update remarks only
router.put("/uploads/remarks/:upload_id", async (req, res) => {
  const { upload_id } = req.params;
  const { remarks, user_id } = req.body;

  try {
    await db.query(
      `UPDATE requirement_uploads
       SET remarks = ?, last_updated_by = ?
       WHERE upload_id = ?`,
      [remarks || null, user_id, upload_id],
    );

    res.json({ message: "Remarks updated successfully." });
  } catch (err) {
    console.error("Error updating remarks:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Update submitted_documents by upload_id (apply to ALL docs of that applicant)
router.put("/submitted-documents/:upload_id", async (req, res) => {
  const { upload_id } = req.params;
  const { submitted_documents, user_person_id } = req.body;

  try {
    // 1. Find person_id
    const [[row]] = await db.query(
      "SELECT person_id FROM admission.requirement_uploads WHERE upload_id = ?",
      [upload_id]
    );

    if (!row) {
      return res.status(404).json({ error: "Upload not found" });
    }

    const person_id = row.person_id;

    // 2. Applicant info
    const [[appInfo]] = await db.query(
      `
      SELECT ant.applicant_number, pt.last_name, pt.first_name, pt.middle_name
      FROM applicant_numbering_table ant
      JOIN person_table pt ON ant.person_id = pt.person_id
      WHERE ant.person_id = ?
      `,
      [person_id]
    );

    const applicant_number = appInfo?.applicant_number || "Unknown";

    const fullName = `${appInfo?.last_name || ""}, ${appInfo?.first_name || ""
      } ${appInfo?.middle_name?.charAt(0) || ""}.`;

    // 3. Actor info
    let actorEmail = "earistmis@gmail.com";
    let actorName = "SYSTEM";

    if (user_person_id) {
      const [actorRows] = await db3.query(
        `
        SELECT email, role, employee_id, last_name, first_name, middle_name
        FROM user_accounts
        WHERE person_id = ?
        LIMIT 1
        `,
        [user_person_id]
      );

      if (actorRows.length > 0) {
        const u = actorRows[0];

        const role = u.role?.toUpperCase() || "UNKNOWN";
        const empId = u.employee_id || "";
        const lname = u.last_name || "";
        const fname = u.first_name || "";
        const mname = u.middle_name || "";
        const email = u.email || "";

        actorEmail = email;
        actorName = `${role} (${empId}) - ${lname}, ${fname} ${mname}`.trim();
      }
    }

    // 4. Toggle + message
    let type, message;

    if (submitted_documents === 1) {
      await db.query(
        `
        UPDATE admission.requirement_uploads
        SET submitted_documents = 1,
            registrar_status = 1,
            missing_documents = '[]'
        WHERE person_id = ?
        `,
        [person_id]
      );

      type = "submit";
      message = `Requirements submitted by Applicant #${applicant_number} - ${fullName}`;
    } else {
      await db.query(
        `
        UPDATE admission.requirement_uploads
        SET submitted_documents = 0,
            registrar_status = 0,
            missing_documents = NULL
        WHERE person_id = ?
        `,
        [person_id]
      );

      type = "unsubmit";
      message = `Requirements unsubmitted for Applicant #${applicant_number} - ${fullName}`;
    }

    const actorId = req.body?.user_person_id || req.headers["x-audit-actor-id"] || "unknown";
    const actorRole = req.headers["x-audit-actor-role"] || "registrar";
    const roleLabel = formatAuditActorRole(actorRole);
    await insertAuditLogAdmission({
      actorId,
      role: actorRole,
      action:
        submitted_documents === 1
          ? "APPLICATION_ORIGINAL_DOCUMENTS_SUBMIT"
          : "APPLICATION_ORIGINAL_DOCUMENTS_UNSUBMIT",
      severity: "INFO",
      message: `${roleLabel} (${actorId}) marked original documents of Applicant (${applicant_number}) as ${submitted_documents === 1 ? "submitted" : "unsubmitted"}.`,
    });

    res.json({
      success: true,
      message,
    });
  } catch (err) {
    console.error("Error toggling submitted documents:", err);

    res.status(500).json({
      error: "Failed to toggle submitted documents",
    });
  }
});

router.get("/all-applicants", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT DISTINCT
        snt.student_number,
        p.person_id,
        p.applyingAs,
        p.last_name,
        p.first_name,
        p.middle_name,
        p.extension,
        p.program,
        pgt.program_code,
        p.emailAddress,
        p.generalAverage,
        p.generalAverage1,
        p.campus,
        p.created_at,
        p.birthOfDate,
        p.gender,
        p.strand,
        a.applicant_number,
        SUBSTRING(a.applicant_number, 5, 1) AS middle_code,
        app_sem.semester_id AS applicant_semester_id,
        app_sem.semester_code AS applicant_semester_code,
        ea.schedule_id,
        ees.day_description AS exam_day,
        ees.room_description AS exam_room,
        ees.start_time AS exam_start_time,
        ees.end_time AS exam_end_time,
        ea.email_sent,

        /* latest prioritized upload id for this person */
        ruprio.upload_id AS upload_id,
        ruprio.submitted_medical,

        /*  allow NULL values to pass through */
        ruprio.submitted_documents,
        ruprio.registrar_status,

        /* collect missing_documents across uploads if you still want to show aggregated missing docs */
        ruagg.all_missing_docs,

        ruprio.document_status,
        ruprio.created_at AS last_updated,
        ps.exam_status,
        COALESCE(rtot.total_required_docs, 0) AS total_required_docs,

        /*  NEW: how many required docs are verified */
        COALESCE(vdocs.verified_count, 0) AS required_docs_verified

      FROM admission.person_table AS p
      LEFT JOIN enrollment.user_accounts AS ua
        ON ua.person_id = p.person_id
      LEFT JOIN admission.applicant_numbering_table AS a
        ON p.person_id = a.person_id
      LEFT JOIN enrollment.semester_table AS app_sem
        ON app_sem.semester_code = SUBSTRING(a.applicant_number, 5, 1)
      LEFT JOIN admission.exam_applicants AS ea
        ON a.applicant_number = ea.applicant_id
      LEFT JOIN admission.entrance_exam_schedule AS ees
        ON ea.schedule_id = ees.schedule_id
       LEFT JOIN enrollment.program_table AS pgt ON p.program = pgt.program_id
      LEFT JOIN enrollment.student_numbering_table AS snt
        ON p.person_id = snt.person_id

      /* get aggregated missing_documents for display only */
      LEFT JOIN (
        SELECT
          person_id,
          GROUP_CONCAT(missing_documents SEPARATOR '||') AS all_missing_docs
        FROM admission.requirement_uploads
        GROUP BY person_id
      ) AS ruagg ON ruagg.person_id = p.person_id

      /*  get the prioritized row per applicant */
      LEFT JOIN admission.requirement_uploads AS ruprio
        ON ruprio.upload_id = (
          SELECT ru2.upload_id
          FROM admission.requirement_uploads ru2
          WHERE ru2.person_id = p.person_id
          ORDER BY
            CASE
              WHEN ru2.document_status = 'Disapproved' THEN 1
              WHEN ru2.document_status = 'Program Closed' THEN 2
              WHEN ru2.document_status = 'Documents Verified & ECAT' THEN 3
              WHEN ru2.document_status = 'On process' THEN 4
              ELSE 5
            END ASC,
            ru2.upload_id DESC
          LIMIT 1
        )

      LEFT JOIN admission.person_status_table AS ps
        ON p.person_id = ps.person_id
      LEFT JOIN admission.user_accounts AS aua
        ON p.person_id = aua.person_id

      LEFT JOIN (
        SELECT
          p2.person_id,
          COUNT(rt.id) AS total_required_docs
        FROM admission.person_table p2
        LEFT JOIN admission.requirements_table rt
          ON rt.applicant_type COLLATE utf8mb4_unicode_ci =
             p2.applyingAs COLLATE utf8mb4_unicode_ci
         AND rt.category = 'Main'
         AND rt.is_verifiable = 1
        GROUP BY p2.person_id
      ) AS rtot ON rtot.person_id = p.person_id

      /*  subquery: count verified docs for this applicant */
      LEFT JOIN (
        SELECT
          ru.person_id,
          COUNT(DISTINCT ru.requirements_id) AS verified_count
        FROM admission.requirement_uploads ru
        INNER JOIN admission.requirements_table rt
          ON ru.requirements_id = rt.id
        INNER JOIN admission.person_table p3
          ON rt.applicant_type COLLATE utf8mb4_unicode_ci =
             p3.applyingAs COLLATE utf8mb4_unicode_ci
         AND p3.person_id = ru.person_id
        WHERE ru.document_status = 'Documents Verified & ECAT'
          AND rt.category = 'Main'
          AND rt.is_verifiable = 1
        GROUP BY ru.person_id
      ) AS vdocs ON vdocs.person_id = p.person_id

      WHERE COALESCE(aua.is_archived, 0) = 0

      ORDER BY p.last_name ASC, p.first_name ASC
    `);

    // Parse aggregated missing_documents into array (if present)
    const merged = rows.map((r) => {
      let mergedDocs = [];
      if (r.all_missing_docs) {
        const parts = r.all_missing_docs.split("||");
        const all = parts.flatMap((item) => {
          try {
            if (!item || item === "null") return [];
            return JSON.parse(item);
          } catch {
            return [];
          }
        });
        mergedDocs = [...new Set(all)];
      }
      return {
        ...r,
        missing_documents: mergedDocs,
      };
    });

    res.json(merged);
  } catch (err) {
    console.error(" Error fetching all applicants:", err);
    res.status(500).send("Server error");
  }
});

router.get("/search-person", async (req, res) => {
  const { query } = req.query;
  if (!query) {
    return res.status(400).json({ error: "Missing search query" });
  }

  try {
    const [rows] = await db.query(
      `
      SELECT
        p.*,
        a.applicant_number
      FROM person_table p
      LEFT JOIN applicant_numbering_table a ON p.person_id = a.person_id
      WHERE a.applicant_number LIKE ?
         OR p.first_name LIKE ?
         OR p.last_name LIKE ?
         OR p.emailAddress LIKE ?
      LIMIT 1
    `,
      [`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "No matching applicant found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Error searching person:", error);
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/missing-documents/:person_id", async (req, res) => {
  const { person_id } = req.params;
  let { missing_documents, user_id } = req.body;

  try {
    if (!Array.isArray(missing_documents)) {
      missing_documents = [];
    }

    const jsonDocs = JSON.stringify(missing_documents);

    await db.query(
      `UPDATE admission.requirement_uploads
       SET missing_documents = ?, last_updated_by = ?
       WHERE person_id = ?`,
      [jsonDocs, user_id || null, person_id],
    );

    res.json({ success: true, message: "Missing documents updated" });
  } catch (err) {
    console.error(" Error updating missing_documents:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to update missing_documents" });
  }
});

router.get("/submitted-status/:person_id", async (req, res) => {
  const { person_id } = req.params;

  try {
    const [[row]] = await db.query(
      `
      SELECT COALESCE(MAX(submitted_documents), 0) AS submitted_documents
      FROM requirement_uploads
      WHERE person_id = ?
      `,
      [person_id]
    );

    res.json({ submitted_documents: row.submitted_documents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch submitted status" });
  }
});

module.exports = router;
