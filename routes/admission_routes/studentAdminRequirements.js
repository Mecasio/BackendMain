const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { db, db3 } = require("../database/database");
const { insertAuditLogAdmission } = require("../../utils/auditLogger");

const studentDocsDir = path.join(__dirname, "..", "..", "uploads", "StudentOnlineDocuments");


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

// ============================================================
//  STUDENT REQUIREMENTS UPLOADER — BACKEND ROUTES
//  Uses: db3, student_numbering_table (instead of applicant_numbering_table)
//  Profile image path: /Student1by1
//  Documents path:     /StudentOnlineRequirements
// ============================================================

// ---------------------
//  POST /student/upload
// ---------------------
router.post("/student/upload", upload.single("file"), async (req, res) => {
  const { requirements_id, person_id, remarks } = req.body;

  if (!req.file || !person_id || !requirements_id) {
    return res
      .status(400)
      .json({ message: "Missing file, person_id, or requirements_id" });
  }

  try {
    // Fetch description & short_label
    const [rows] = await db3.query(
      "SELECT description, short_label FROM requirements_table WHERE id = ?",
      [requirements_id],
    );

    if (!rows.length)
      return res.status(404).json({ message: "Requirement not found" });

    const shortLabel = await getShortLabel(rows[0].description);

    const year = new Date().getFullYear();
    const ext = path.extname(req.file.originalname).toLowerCase();

    // Fetch student number from student_numbering_table
    const [stuRows] = await db3.query(
      "SELECT student_number FROM student_numbering_table WHERE person_id = ?",
      [person_id],
    );

    if (!stuRows.length) {
      return res.status(404).json({
        message: `Student number not found for person_id ${person_id}`,
      });
    }

    const student_number = stuRows[0].student_number;

    // Construct filename using student_number
    const filename = `${student_number}_${shortLabel}_${year}${ext}`;
    const finalPath = path.join(studentDocsDir, filename);

    // Remove existing file if exists
    const [existingFiles] = await db3.query(
      `SELECT upload_id, file_path FROM requirement_uploads
       WHERE person_id = ? AND requirements_id = ? AND file_path LIKE ?`,
      [person_id, requirements_id, `%${shortLabel}_${year}%`],
    );

    for (const file of existingFiles) {
      const fullFilePath = path.join(studentDocsDir, file.file_path);
      try {
        await fs.promises.unlink(fullFilePath);
      } catch (err) {
        console.warn("File delete warning:", err.message);
      }
      await db3.query("DELETE FROM requirement_uploads WHERE upload_id = ?", [
        file.upload_id,
      ]);
    }

    await fs.promises.mkdir(studentDocsDir, { recursive: true });

    // Write file to disk
    await fs.promises.writeFile(finalPath, req.file.buffer);

    const filePath = `${filename}`;
    const originalName = req.file.originalname;

    await db3.query(
      `INSERT INTO requirement_uploads
        (requirements_id, person_id, file_path, original_name, status, remarks)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [requirements_id, person_id, filePath, originalName, remarks || null],
    );

    res.status(201).json({ message: "Upload successful", filename });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ message: "Upload failed", error: err.message });
  }
});

// -----------------------------------
//  PUT /student/uploads/status/:upload_id
// -----------------------------------
router.put("/student/uploads/status/:upload_id", async (req, res) => {
  const { upload_id } = req.params;
  const { status, user_id, audit_actor_id, audit_actor_role } = req.body;

  try {
    const uploadBefore = await getRequirementUploadAuditInfo(upload_id);
    if (!uploadBefore) {
      return res.status(404).json({ message: "Upload not found" });
    }

    // Update single row status
    await db3.query(
      `UPDATE requirement_uploads
       SET status = ?, last_updated_by = ?
       WHERE upload_id = ?`,
      [status, user_id, upload_id],
    );

    const person_id = uploadBefore.person_id;

    // Get all verifiable documents of this student
    const [docs] = await db3.query(
      `SELECT status
       FROM requirement_uploads ru
       JOIN requirements_table rt ON ru.requirements_id = rt.id
       WHERE ru.person_id = ?
       AND rt.is_verifiable = 1`,
      [person_id],
    );

    // Check if ALL are verified (status = 1)
    const allVerified = docs.length > 0 && docs.every((d) => d.status === 1);

    if (allVerified) {
      await db3.query(
        `UPDATE requirement_uploads
         SET document_status = 'Documents Verified & ECAT'
         WHERE person_id = ?`,
        [person_id],
      );

      await db3.query(
        `UPDATE requirement_uploads
         SET status = 1
         WHERE person_id = ?`,
        [person_id],
      );
    }

    if (String(uploadBefore.status ?? "0") !== String(status ?? "0")) {
      const safeActor = audit_actor_id || user_id || "unknown";
      const roleLabel = formatAuditActorRole(audit_actor_role || "registrar");
      await insertRequirementAuditLog({
        actorId: safeActor,
        actorRole: audit_actor_role || "registrar",
        message: `${roleLabel} (${safeActor}) changed document status of Student (${studentAuditLabel(uploadBefore)}) for ${uploadBefore.description || "document"} from ${requirementStatusLabel(uploadBefore.status)} to ${requirementStatusLabel(status)}.`,
      });
    }

    res.json({ message: "Status updated and auto-sync checked." });
  } catch (err) {
    console.error("Error updating status:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// ---------------------------------------------------
//  GET /student/document_status/:student_number
// ---------------------------------------------------
router.get("/student/document_status/:student_number", async (req, res) => {
  const { student_number } = req.params;

  try {
    const [rows] = await db3.query(
      `
      SELECT
        COALESCE(ru.document_status, 'On process') AS document_status,
        ua.email AS evaluator_email,
        pr.lname AS evaluator_lname,
        pr.fname AS evaluator_fname,
        pr.mname AS evaluator_mname,
        ru.created_at
      FROM student_numbering_table snt
      INNER JOIN person_table pt ON pt.person_id = snt.person_id
      LEFT JOIN requirement_uploads ru ON ru.person_id = pt.person_id
      LEFT JOIN enrollment.user_accounts ua ON ua.person_id = ru.last_updated_by
      LEFT JOIN enrollment.prof_table pr ON pr.person_id = ua.person_id
      WHERE snt.student_number = ?
      ORDER BY ru.upload_id DESC
      LIMIT 1
      `,
      [student_number],
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

// ---------------------------------------------------
//  PUT /student/document_status/:student_number
// ---------------------------------------------------
router.put("/student/document_status/:student_number", async (req, res) => {
  const { student_number } = req.params;
  const { document_status, user_id, audit_actor_id, audit_actor_role } =
    req.body;

  if (!document_status || !user_id) {
    return res.status(400).json({
      message: "document_status and user_id are required",
    });
  }

  try {
    const studentBefore = await getStudentDocumentStatusInfo(student_number);

    if (!studentBefore) {
      return res.status(404).json({ message: "Student not found" });
    }

    let statusSyncSql = "";
    const updateParams = [document_status, user_id];

    if (document_status === "Documents Verified & ECAT") {
      statusSyncSql = ", ru.status = ?";
      updateParams.push(1);
    } else if (document_status === "Disapproved / Program Closed") {
      statusSyncSql = ", ru.status = ?";
      updateParams.push(2);
    }

    updateParams.push(student_number);

    const [result] = await db3.query(
      `
      UPDATE requirement_uploads ru
      INNER JOIN student_numbering_table snt ON snt.person_id = ru.person_id
      SET ru.document_status = ?, ru.last_updated_by = ?${statusSyncSql}
      WHERE snt.student_number = ?
      `,
      updateParams,
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Student uploads not found" });
    }

    if (
      String(studentBefore.document_status || "On process") !==
      String(document_status || "On process")
    ) {
      const safeActor = audit_actor_id || user_id || "unknown";
      const roleLabel = formatAuditActorRole(audit_actor_role || "registrar");

      await insertRequirementAuditLog({
        actorId: safeActor,
        actorRole: audit_actor_role || "registrar",
        message: `${roleLabel} (${safeActor}) changed overall document status of Student (${studentAuditLabel(studentBefore)}) from ${studentBefore.document_status || "On process"} to ${document_status}.`,
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

// ---------------------------------------------------
//  GET /student_with_number/:id
// ---------------------------------------------------
router.get("/student_with_number/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [[person]] = await db3.query(
      `
      SELECT
        pt.*,
        snt.student_number
      FROM person_table pt
      JOIN student_numbering_table snt ON pt.person_id = snt.person_id
      WHERE pt.person_id = ? OR snt.student_number = ?
      LIMIT 1
      `,
      [id, id],
    );

    if (!person) {
      return res.status(404).json({ message: "Person not found" });
    }

    // Get latest document status + evaluator
    const [rows] = await db3.query(
      `
      SELECT
        ru.document_status    AS upload_document_status,
        rt.id                 AS requirement_id,
        ua.email              AS evaluator_email,
        ua.role               AS evaluator_role,
        ua.first_name         AS evaluator_fname,
        ua.middle_name        AS evaluator_mname,
        ua.last_name          AS evaluator_lname,
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
    console.error("Error fetching student_with_number:", err);
    res.status(500).json({ error: "Failed to fetch person" });
  }
});

// ---------------------------------------------------
//  GET /student/uploads/by-student/:student_number
// ---------------------------------------------------
router.get("/student/uploads/by-student/:student_number", async (req, res) => {
  const student_number = req.params.student_number;

  try {
    const [personResult] = await db3.query(
      "SELECT person_id FROM student_numbering_table WHERE student_number = ?",
      [student_number],
    );

    if (personResult.length === 0) {
      return res.status(404).json({ message: "Student not found" });
    }

    const person_id = personResult[0].person_id;

    const [uploads] = await db3.query(
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
        pr.lname AS evaluator_lname,
        pr.fname AS evaluator_fname,
        pr.mname AS evaluator_mname

      FROM requirement_uploads ru
      JOIN requirements_table rt
        ON ru.requirements_id = rt.id
      LEFT JOIN enrollment.user_accounts ua
        ON ru.last_updated_by = ua.person_id
      LEFT JOIN enrollment.prof_table pr
        ON ua.person_id = pr.person_id
      WHERE ru.person_id = ?
      `,
      [person_id],
    );

    res.status(200).json(uploads);
  } catch (err) {
    console.error("Error fetching uploads by student number:", err);
    res.status(500).json({ message: "Internal Server Error", error: err });
  }
});

// ---------------------------------------------------
//  GET /student_upload_documents_superadmin
// ---------------------------------------------------
router.get("/student_upload_documents_superadmin", async (req, res) => {
  try {
    const [persons] = await db3.query(`
      SELECT
        pt.person_id,
        pt.first_name,
        pt.middle_name,
        pt.last_name,
        pt.profile_img,
        pt.height,
        pt.generalAverage1,
        pt.emailAddress,
        snt.student_number,
        pt.applyingAs
      FROM person_table pt
      LEFT JOIN student_numbering_table snt ON pt.person_id = snt.person_id;
    `);

    res.status(200).json(persons);
  } catch (error) {
    console.error("Error fetching student upload documents:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

router.delete("/student/uploads/:uploadId", async (req, res) => {
  const { uploadId } = req.params;

  // Point to the same directory used during upload
  const studentDocsDir = path.join(__dirname, "..", "..", "uploads", "StudentOnlineDocuments");

  try {
    // 1. Get upload row (file + person_id)
    const [uploadRows] = await db3.query(
      "SELECT person_id, file_path FROM requirement_uploads WHERE upload_id = ?",
      [uploadId],
    );

    if (!uploadRows.length) {
      return res.status(404).json({ error: "Upload not found." });
    }

    const { person_id: personId, file_path: filePath } = uploadRows[0];

    // 2. Student info
    const [[stuInfo]] = await db3.query(
      `
      SELECT snt.student_number, pt.last_name, pt.first_name, pt.middle_name
      FROM student_numbering_table snt
      JOIN person_table pt ON snt.person_id = pt.person_id
      WHERE snt.person_id = ?
      `,
      [personId],
    );

    const student_number = stuInfo?.student_number || "Unknown";
    const fullName = `${stuInfo?.last_name || ""}, ${stuInfo?.first_name || ""} ${stuInfo?.middle_name?.charAt(0) || ""}.`;

    // 3. Delete physical file
    if (filePath) {
      const fullPath = path.join(studentDocsDir, filePath);
      try {
        await fs.promises.unlink(fullPath);
        console.log("✅ File deleted:", fullPath);
      } catch (err) {
        if (err.code === "ENOENT") {
          console.warn("⚠️ File already missing:", fullPath);
        } else {
          console.error("File delete error:", err);
        }
      }
    }

    // 4. Delete DB record
    await db3.query("DELETE FROM requirement_uploads WHERE upload_id = ?", [
      uploadId,
    ]);

    console.log(`🗑️ Deleted document (Student #${student_number} - ${fullName})`);

    res.status(200).json({ message: "Upload deleted successfully." });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Failed to delete the upload." });
  }
});

module.exports = router;  
