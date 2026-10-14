const express = require("express");
const path = require("path");
const fs = require("fs");
const webtoken = require("jsonwebtoken");
const { db3 } = require("../database/database");
const { insertAuditLogEnrollment } = require("../../utils/auditLogger");
const {
  getStudentNameByNumber,
  logStudentHistoryFromRequest,
} = require("../../utils/studentHistoryLogger");
const { upload, profileUpload } = require("../../utils/uploadMiddleware");

const router = express.Router();

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";
  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

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

const getAuditActorFromRequest = async (req) => {
  const tokenPayload = getBearerPayload(req) || {};
  const actorId =
    tokenPayload.employee_id ||
    req.headers["x-audit-actor-id"] ||
    req.body?.audit_actor_id ||
    tokenPayload.person_id ||
    req.headers["x-employee-id"] ||
    "unknown";
  const actorRole =
    tokenPayload.role ||
    req.headers["x-audit-actor-role"] ||
    req.body?.audit_actor_role ||
    "registrar";

  let actorName = tokenPayload.email || req.headers["x-audit-actor-name"] || actorId;

  try {
    const [rows] = await db3.query(
      `
      SELECT
        ua.email,
        ua.employee_id,
        ua.person_id,
        ua.role,
        COALESCE(pt.first_name, pr.fname) AS first_name,
        COALESCE(pt.middle_name, pr.mname) AS middle_name,
        COALESCE(pt.last_name, pr.lname) AS last_name
      FROM user_accounts ua
      LEFT JOIN person_table pt ON pt.person_id = ua.person_id
      LEFT JOIN prof_table pr ON pr.person_id = ua.person_id OR pr.employee_id = ua.employee_id
      WHERE ua.employee_id = ? OR ua.person_id = ? OR ua.email = ?
      LIMIT 1
      `,
      [actorId, tokenPayload.person_id || actorId, tokenPayload.email || actorId],
    );

    if (rows?.[0]) {
      actorName = formatPersonFullName(rows[0], rows[0].email || actorName);
    }
  } catch (error) {
    console.error("Audit actor lookup failed:", error);
  }

  return {
    actorId,
    actorRole,
    actorName,
  };
};

const auditSectionLabels = {
  personal_information: "personal information",
  family_information: "family information",
  educational_attainment: "educational attainment data",
  health_information: "health information",
};

const getAuditChangeSection = (req) => {
  const section = String(req.headers["x-audit-change-section"] || "").trim();
  return auditSectionLabels[section] ? section : "";
};

const insertProfileChangeAuditLog = async ({
  req,
  target,
  targetType,
  targetNumber,
  auditLogger,
}) => {
  const section = getAuditChangeSection(req);
  if (!section) return;

  const { actorId, actorRole, actorName } = await getAuditActorFromRequest(req);
  const sectionLabel = auditSectionLabels[section];
  const targetLabel = targetType === "student" ? "student" : "applicant";
  const targetName = formatPersonFullName(target, `Unknown ${targetLabel}`);
  const safeNumber = targetNumber || "N/A";

  await auditLogger({
    actorId,
    role: actorRole,
    action: "PROFILE_UPDATE",
    severity: "INFO",
    message: `${actorName} (${actorId}) changed the ${sectionLabel} of the ${targetLabel} ${targetName} (${safeNumber})`,
  });
};

const getApplicantCurriculumLabel = async (curriculumId) => {
  if (!curriculumId) return "None";

  try {
    const [rows] = await db3.query(
      `
      SELECT
        pt.program_code,
        pt.program_description,
        pt.major,
        yt.year_description,
        yt2.year_description AS next_year
      FROM curriculum_table ct
      LEFT JOIN program_table pt ON ct.program_id = pt.program_id
      LEFT JOIN year_table yt ON ct.year_id = yt.year_id
      LEFT JOIN year_table yt2 ON yt2.year_id = yt.year_id + 1
      WHERE ct.curriculum_id = ?
      LIMIT 1
      `,
      [curriculumId],
    );

    const curriculum = rows?.[0];
    if (!curriculum) return `Curriculum ${curriculumId}`;

    const programCode = curriculum.program_code || "N/A";
    const description = curriculum.program_description || "Unknown Program";
    const major = curriculum.major ? ` (${curriculum.major})` : "";
    const year = curriculum.year_description
      ? ` ${curriculum.year_description}${curriculum.next_year ? `-${curriculum.next_year}` : ""}`
      : "";

    return `(${programCode}) ${description}${major}${year}`;
  } catch (error) {
    console.error("Curriculum label lookup failed:", error);
    return `Curriculum ${curriculumId}`;
  }
};


const updateActiveStudentCurriculumForCurrentSchoolYear = async ({
  req,
  personId,
  previousCurriculumId,
  nextCurriculumId,
  fallbackCurriculumId,
}) => {
  const nextId = Number(nextCurriculumId || 0);

  if (!nextId) {
    return {
      changed: false,
      reason: "No curriculum change detected",
    };
  }

  const [[studentRow]] = await db3.query(
    `
    SELECT student_number
    FROM student_numbering_table
    WHERE person_id = ?
    LIMIT 1
    `,
    [personId],
  );

  if (!studentRow?.student_number) {
    return {
      changed: false,
      reason: "Student number not found",
    };
  }

  const [[activeSchoolYear]] = await db3.query(
    `
    SELECT id
    FROM active_school_year_table
    WHERE astatus = 1
    LIMIT 1
    `,
  );

  if (!activeSchoolYear?.id) {
    return {
      changed: false,
      reason: "Active school year not found",
    };
  }

  const studentNumber = studentRow.student_number;
  const activeSchoolYearId = activeSchoolYear.id;

  const [[statusRow]] = await db3.query(
    `
    SELECT id, active_curriculum, year_level_id, enrolled_status, control_status
    FROM student_status_table
    WHERE student_number = ?
      AND active_school_year_id = ?
    ORDER BY id DESC
    LIMIT 1
    `,
    [studentNumber, activeSchoolYearId],
  );

  const previousId = Number(
    previousCurriculumId ??
    statusRow?.active_curriculum ??
    fallbackCurriculumId ??
    0,
  );

  if (previousId === nextId) {
    return {
      changed: false,
      reason: "No curriculum change detected",
    };
  }

  let updatedStatusRows = 0;

  if (statusRow?.id) {
    const [statusResult] = await db3.query(
      `
      UPDATE student_status_table
      SET active_curriculum = ?
      WHERE student_number = ?
        AND active_school_year_id = ?
      `,
      [nextId, studentNumber, activeSchoolYearId],
    );
    updatedStatusRows = statusResult.affectedRows || 0;
  } else {
    const [[anyStatus]] = await db3.query(
      `
      SELECT year_level_id, enrolled_status, control_status
      FROM student_status_table
      WHERE student_number = ?
      ORDER BY id DESC
      LIMIT 1
      `,
      [studentNumber],
    );

    const [insertResult] = await db3.query(
      `
      INSERT INTO student_status_table
        (student_number, active_curriculum, enrolled_status, year_level_id, active_school_year_id, control_status)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        studentNumber,
        nextId,
        anyStatus?.enrolled_status ?? 0,
        anyStatus?.year_level_id ?? 0,
        activeSchoolYearId,
        anyStatus?.control_status ?? 0,
      ],
    );
    updatedStatusRows = insertResult.affectedRows || 0;
  }

  const [fromLabel, toLabel, studentName] = await Promise.all([
    previousId
      ? getApplicantCurriculumLabel(previousId)
      : Promise.resolve("N/A"),
    getApplicantCurriculumLabel(nextId),
    getStudentNameByNumber(studentNumber),
  ]);

  await logStudentHistoryFromRequest({
    req,
    studentNumber,
    message: `Student (${studentNumber}) ${studentName} shifted curriculum from ${fromLabel} to ${toLabel}.`,
  });

  const { actorId, actorRole } = await getAuditActorFromRequest(req);
  const roleLabel = formatAuditActorRole(actorRole);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole || "registrar",
    action: "STUDENT_PROGRAM_CHANGE",
    severity: "INFO",
    message: `${roleLabel} (${actorId}) changed the program of Student ${studentName} (${studentNumber}) from ${fromLabel} to ${toLabel}.`,
  });

  return {
    changed: true,
    studentNumber,
    activeSchoolYearId,
    updatedStatusRows,
    fromLabel,
    toLabel,
  };
};

//  Fetch full record
router.get("/person/enrollment_data/:person_id", async (req, res) => {
  const { person_id } = req.params;
  const [rows] = await db3.query(
    `
    SELECT p.*, s.student_number
    FROM person_table p
    LEFT JOIN student_numbering_table s ON p.person_id = s.person_id
    WHERE p.person_id = ?
  `,
    [person_id],
  );
  if (!rows.length)
    return res.status(404).json({ message: "Person not found" });
  res.json(rows[0]);
});

//  Update person in ENROLLMENT DB (db3)
router.put("/enrollment/person/:person_id", async (req, res) => {
  const { person_id } = req.params;
  const updatedData = req.body;

  // program is the current-term curriculum: update student_status_table only.
  // person_table.program stays as the student's original course.
  const requestedProgram = Object.prototype.hasOwnProperty.call(
    updatedData,
    "program",
  )
    ? updatedData.program
    : undefined;

  const excludedFields = [
    "document_status",
    "evaluator",
    "program",
    "original_program",
    "current_program",
    "active_curriculum",
    "active_school_year_id",
    "student_number",
  ];
  const sanitizedData = Object.fromEntries(
    Object.entries(updatedData).filter(([key]) => !excludedFields.includes(key))
  );

  // ✅ FIX — mysql2's `SET ?` escaping mangles arrays/objects (e.g. `siblings`,
  // which can arrive as a parsed JS array from the frontend instead of a
  // JSON string). Left as-is, an array value like [{name:"A"},{name:"B"}]
  // gets serialized as `siblings` = '[object Object]', '[object Object]'
  // — a comma inside a single SET assignment — which breaks the whole
  // UPDATE statement with a SQL syntax error. Stringify any non-null
  // object/array value here so every field becomes a single scalar before
  // it reaches the query builder, regardless of what shape the caller sent.
  for (const key of Object.keys(sanitizedData)) {
    const value = sanitizedData[key];
    if (value !== null && typeof value === "object") {
      sanitizedData[key] = JSON.stringify(value);
    }
  }

  if (typeof sanitizedData.emailAddress === "string") {
    sanitizedData.emailAddress = sanitizedData.emailAddress.trim().toLowerCase();
  }

  try {
    const [[personBefore]] = await db3.query(
      `
      SELECT person_id, program, profile_img
      FROM person_table
      WHERE person_id = ?
      LIMIT 1
      `,
      [person_id],
    );

    if (!personBefore) {
      return res
        .status(404)
        .json({ message: "Person not found in ENROLLMENT" });
    }

    // 🗑️ Delete the old Student1by1 photo file if profile_img is being
    // cleared or replaced, so removed/changed photos don't orphan on disk.
    if (Object.prototype.hasOwnProperty.call(sanitizedData, "profile_img")) {
      const nextValue = sanitizedData.profile_img;
      const oldProfileImg = personBefore.profile_img;

      if (oldProfileImg && oldProfileImg !== nextValue) {
        const oldPhotoPath = path.join(
          __dirname,
          "../../uploads",
          "Student1by1",
          oldProfileImg,
        );

        try {
          await fs.promises.unlink(oldPhotoPath);
          console.log("✅ Old student photo deleted:", oldPhotoPath);
        } catch (err) {
          if (err.code === "ENOENT") {
            console.warn("⚠️ Old student photo already missing:", oldPhotoPath);
          } else {
            console.error("❌ Failed to delete old student photo:", err);
          }
        }
      }
    }

    if (sanitizedData.emailAddress) {
      const [duplicateEmail] = await db3.query(
        `SELECT id
         FROM user_accounts
         WHERE LOWER(email) = ?
           AND person_id <> ?
           AND role = 'student'
         LIMIT 1`,
        [sanitizedData.emailAddress, person_id],
      );

      if (duplicateEmail.length > 0) {
        return res.status(400).json({ error: "Email already exists" });
      }
    }

    let result = { affectedRows: 1 };
    if (Object.keys(sanitizedData).length > 0) {
      [result] = await db3.query(
        "UPDATE person_table SET ? WHERE person_id = ?",
        [sanitizedData, person_id],
      );

      if (result.affectedRows === 0)
        return res
          .status(404)
          .json({ message: "Person not found in ENROLLMENT" });
    }

    let curriculumShift = {
      changed: false,
      reason: "Program field was not updated",
    };

    if (
      requestedProgram !== undefined &&
      requestedProgram !== null &&
      requestedProgram !== ""
    ) {
      curriculumShift = await updateActiveStudentCurriculumForCurrentSchoolYear({
        req,
        personId: person_id,
        nextCurriculumId: requestedProgram,
        fallbackCurriculumId: personBefore.program,
      });
    }

    if (sanitizedData.emailAddress) {
      await db3.query(
        `UPDATE user_accounts
         SET email = ?
         WHERE person_id = ?
           AND role = 'student'`,
        [sanitizedData.emailAddress, person_id],
      );
    }

    if (getAuditChangeSection(req)) {
      const [targetRows] = await db3.query(
        `
        SELECT p.*, s.student_number
        FROM person_table p
        LEFT JOIN student_numbering_table s ON s.person_id = p.person_id
        WHERE p.person_id = ?
        LIMIT 1
        `,
        [person_id],
      );

      await insertProfileChangeAuditLog({
        req,
        target: targetRows?.[0],
        targetType: "student",
        targetNumber: targetRows?.[0]?.student_number,
        auditLogger: insertAuditLogEnrollment,
      });
    }

    res.json({
      success: true,
      message: "Person updated successfully in ENROLLMENT DB3",
      curriculumShift,
    });
  } catch (err) {
    console.error(" Error updating person in ENROLLMENT DB:", err);
    res.status(500).json({ error: "Failed to update person in ENROLLMENT DB" });
  }
});

router.post(
  "/update_student/:user_id",
  profileUpload.single("profile_picture"),
  async (req, res) => {
    const { user_id } = req.params;
    const data = req.body;
    const file = req.file;

    try {
      const [existing] = await db3.query(
        "SELECT * FROM user_accounts WHERE id = ?",
        [user_id],
      );
      if (existing.length === 0)
        return res.status(404).json({ message: "User not found" });
      const student_person_id = existing[0].person_id;

      const [student] = await db3.query(
        "SELECT * FROM student_numbering_table WHERE person_id = ?",
        [student_person_id],
      );

      if (student.length === 0)
        return res.status(404).json({ message: "Student not found" });
      const student_number = student[0].student_number;

      const [datas] = await db3.query(
        "SELECT * FROM person_table WHERE person_id = ?",
        [student_person_id],
      );
      const current = datas[0];

      let finalFilename = current.profile_img;

      if (file) {
        const s_id = student_number || "unknown";
        const philTime = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" });
        const year = new Date(philTime).getFullYear();
        const ext = path.extname(file.originalname).toLowerCase();
        finalFilename = `${s_id}_1by1_${year}${ext}`; // ✅ matches _1by1_ convention now

        const tempUploadDir = path.join(__dirname, "../../uploads");
        const studentPhotoDir = path.join(__dirname, "../../uploads", "Student1by1");

        if (!fs.existsSync(studentPhotoDir)) {
          fs.mkdirSync(studentPhotoDir, { recursive: true });
        }

        const tempPath = path.join(tempUploadDir, file.filename);
        const newPath = path.join(studentPhotoDir, finalFilename);

        if (current.profile_img) {
          const oldPath = path.join(studentPhotoDir, current.profile_img);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        fs.renameSync(tempPath, newPath);
      }

      const sql = `UPDATE person_table SET profile_img = ? WHERE person_id = ?`;
      const [updated] = await db3.query(sql, [finalFilename, student_person_id]);

      res.json({
        success: true,
        message: "Student updated successfully!",
        updated,
      });
    } catch (error) {
      console.error(" Error updating student:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

router.post(
  "/enrollment/upload-profile-picture",
  upload.single("profile_picture"),
  async (req, res) => {
    const { person_id } = req.body;

    if (!person_id || !req.file) {
      return res.status(400).json({ message: "Missing person_id or file." });
    }

    try {
      const [rows] = await db3.query(
        "SELECT student_number FROM student_numbering_table WHERE person_id = ?",
        [person_id],
      );
      if (!rows.length) {
        return res.status(404).json({ message: "Student number not found for person_id " + person_id });
      }
      const student_number = rows[0].student_number;

      const [[current]] = await db3.query(
        "SELECT profile_img FROM person_table WHERE person_id = ?",
        [person_id],
      );

      const ext = path.extname(req.file.originalname).toLowerCase();
      const year = new Date().getFullYear();
      const filename = `${student_number}_1by1_${year}${ext}`;

      const uploadDir = path.join(__dirname, "../../uploads/Student1by1");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

      // ✅ delete by DB value instead of:
      // const files = await fs.promises.readdir(uploadDir);
      // for (const file of files) { if (file.startsWith(`${student_number}_1by1_`)) ... }
      if (current?.profile_img) {
        const oldPath = path.join(uploadDir, current.profile_img);
        try {
          await fs.promises.unlink(oldPath);
        } catch (err) {
          if (err.code !== "ENOENT") console.error("Old photo delete failed:", err);
        }
      }

      await fs.promises.writeFile(path.join(uploadDir, filename), req.file.buffer);

      await db3.query(
        "UPDATE person_table SET profile_img = ? WHERE person_id = ?",
        [filename, person_id],
      );

      res.status(200).json({ message: "Uploaded successfully", filename });
    } catch (err) {
      console.error("Upload error:", err);
      res.status(500).json({ message: "Failed to upload image.", error: err.message });
    }
  },
);

module.exports = router;
