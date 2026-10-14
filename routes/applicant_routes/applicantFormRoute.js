const express = require('express');
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const {
  db,
  db3,
  ensureApplicantProgramAssignmentColumn,
} = require('../database/database');
const bcrypt = require("bcrypt");
const router = express.Router();
const QRCode = require("qrcode");
const {
  insertAuditLogAdmission,
} = require("../../utils/auditLogger");
const upload = multer({ storage: multer.memoryStorage() });

const uploadProfile = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024, // ✅ 2MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/jpg"];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Only JPG, JPEG, PNG allowed"));
    }
    cb(null, true);
  },
});


const allowedFields = new Set([
  "profile_img", "campus", "academicProgram", "classifiedAs", "applyingAs",
  "program", "program2", "program3", "yearLevel", "last_name", "first_name",
  "middle_name", "extension", "nickname", "height", "weight", "lrnNumber",
  "nolrnNumber", "gender", "pwdMember", "pwdType", "pwdId", "birthOfDate",
  "age", "birthPlace", "languageDialectSpoken", "citizenship", "religion",
  "civilStatus", "spouse", "facebook_account",  "tribeEthnicGroup", "cellphoneNumber", "emailAddress",
  "presentStreet", "presentBarangay", "presentZipCode", "presentRegion",
  "presentProvince", "presentMunicipality", "presentDswdHouseholdNumber",
  "sameAsPresentAddress", "permanentStreet", "permanentBarangay",
  "permanentZipCode", "permanentRegion", "permanentProvince",
  "permanentMunicipality", "permanentDswdHouseholdNumber", "solo_parent",
  "father_deceased", "father_family_name", "father_given_name",
  "father_middle_name", "father_ext", "father_nickname", "father_education",
  "father_education_level", "father_last_school", "father_course",
  "father_year_graduated", "father_school_address", "father_contact",
  "father_occupation", "father_employer", "father_income", "father_email",
  "mother_deceased", "mother_family_name", "mother_given_name",
  "mother_middle_name", "mother_ext", "mother_nickname", "mother_education",
  "mother_education_level", "mother_last_school", "mother_course",
  "mother_year_graduated", "mother_school_address", "mother_contact",
  "mother_occupation", "mother_employer", "mother_income", "mother_email",
  "guardian", "guardian_family_name", "guardian_given_name",
  "guardian_middle_name", "guardian_ext", "guardian_nickname",
  "guardian_address", "guardian_contact", "guardian_email", "annual_income", "has_no_siblings", "siblings",
  "schoolLevel", "schoolLastAttended", "schoolAddress", "courseProgram",
  "honor", "generalAverage", "yearGraduated", "schoolLevel1",
  "schoolLastAttended1", "schoolAddress1", "courseProgram1", "honor1",
  "generalAverage1", "yearGraduated1", "strand", "cough", "colds", "fever",
  "asthma", "faintingSpells", "heartDisease", "tuberculosis",
  "frequentHeadaches", "hernia", "chronicCough", "headNeckInjury", "hiv",
  "highBloodPressure", "diabetesMellitus", "allergies", "cancer",
  "smokingCigarette", "alcoholDrinking", "hospitalized",
  "hospitalizationDetails", "medications", "hadCovid", "covidDate",
  "vaccine1Brand", "vaccine1Date", "vaccine2Brand", "vaccine2Date",
  "booster1Brand", "booster1Date", "booster2Brand", "booster2Date",
  "chestXray", "cbc", "urinalysis", "otherworkups", "symptomsToday",
  "remarks", "termsOfAgreement", "current_step"
]);

const courseFields = ["program", "program2", "program3"];

const formatActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getCurriculumLabel = async (curriculumId) => {
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

const insertApplicantCourseChangeAuditLog = async ({
  actorId,
  actorRole,
  applicant,
  changes,
}) => {
  if (!changes.length) return;

  const safeActor = actorId || "unknown";
  const roleLabel = formatActorRole(actorRole);
  const applicantName = [
    applicant?.last_name,
    applicant?.first_name,
    applicant?.middle_name,
  ]
    .filter(Boolean)
    .join(", ");
  const applicantLabel =
    applicant?.applicant_number ||
    applicantName ||
    applicant?.emailAddress ||
    `person_id ${applicant?.person_id || "unknown"}`;
  const changeText = changes
    .map((change) => `${change.label} from ${change.fromLabel} to ${change.toLabel}`)
    .join("; ");

  await insertAuditLogAdmission({
    actorId: safeActor,
    role: actorRole || "registrar",
    action: "APPLICANT_COURSE_CHANGE",
    severity: "INFO",
    message: `${roleLabel} (${safeActor}) changed course of Applicant (${applicantLabel}) ${changeText}.`,
  });
};

router.get("/person/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await ensureApplicantProgramAssignmentColumn();
    const [rows] = await db.execute(`
      SELECT pt.*, ant.applicant_number 
      FROM applicant_numbering_table AS ant
      LEFT JOIN person_table AS pt ON ant.person_id = pt.person_id
      WHERE pt.person_id = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Person not found" });
    }

    const person = rows[0];

    // ✅ normalize siblings to always be an array
    if (typeof person.siblings === "string") {
      try {
        person.siblings = JSON.parse(person.siblings);
      } catch {
        person.siblings = [];
      }
    } else if (!person.siblings) {
      person.siblings = [];
    }

    res.json(person);
  } catch (error) {
    console.error("❌ Error fetching person:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.put("/person/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await ensureApplicantProgramAssignmentColumn();
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "No fields provided for update" });
    }

    // 🧼 Clean + FILTER only allowed columns
    const cleanedEntries = Object.entries(req.body)
      .filter(([key, value]) => allowedFields.has(key))
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => {
        // ✅ NEW — siblings is a JSON column, must be stored as a JSON string
        if (key === "siblings") {
          if (value == null) return [key, null];
          try {
            return [key, JSON.stringify(value)];
          } catch {
            return [key, null];
          }
        }
        return [key, value === "" ? null : value];
      });

    if (cleanedEntries.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    // 🗑️ Delete the old Applicant1by1 photo file if profile_img is being
    // cleared or replaced, so removed/changed photos don't orphan on disk.
    const profileImgEntry = cleanedEntries.find(([key]) => key === "profile_img");

    if (profileImgEntry) {
      const nextValue = profileImgEntry[1];
      const [[personBeforePhoto]] = await db.query(
        "SELECT profile_img FROM person_table WHERE person_id = ? LIMIT 1",
        [id],
      );
      const oldProfileImg = personBeforePhoto?.profile_img;

      if (oldProfileImg && oldProfileImg !== nextValue) {
        const oldPhotoPath = path.join(
          __dirname,
          "../../uploads/Applicant1by1",
          oldProfileImg,
        );

        try {
          await fs.promises.unlink(oldPhotoPath);
          console.log("✅ Old applicant photo deleted:", oldPhotoPath);
        } catch (err) {
          if (err.code === "ENOENT") {
            console.warn("⚠️ Old applicant photo already missing:", oldPhotoPath);
          } else {
            console.error("❌ Failed to delete old applicant photo:", err);
          }
        }
      }
    }

    const emailEntry = cleanedEntries.find(([key]) => key === "emailAddress");
    const nextEmailRaw = emailEntry?.[1] ?? null;
    const nextEmail =
      nextEmailRaw == null
        ? null
        : String(nextEmailRaw).trim().toLowerCase();

    const courseUpdateFields = cleanedEntries
      .filter(([key]) => courseFields.includes(key))
      .map(([key]) => key);
    let applicantBefore = null;

    if (courseUpdateFields.length > 0) {
      const [beforeRows] = await db.query(
        `
        SELECT pt.*, ant.applicant_number
        FROM person_table pt
        LEFT JOIN applicant_numbering_table ant ON ant.person_id = pt.person_id
        WHERE pt.person_id = ?
        LIMIT 1
        `,
        [id],
      );
      applicantBefore = beforeRows?.[0] || null;
    }

    if (courseUpdateFields.includes("program")) {
      const cleanedData = Object.fromEntries(cleanedEntries);
      const nextProgram = cleanedData.program;
      const nextCampus = cleanedData.campus ?? applicantBefore?.campus;
      const nextAcademicProgram =
        cleanedData.academicProgram ?? applicantBefore?.academicProgram;

      const programActuallyChanged =
        String(nextProgram || "") !== String(applicantBefore?.program || "");
      if (req.user?.role === "applicant" && programActuallyChanged) {
        return res.status(403).json({
          error: "Only authorized personnel can assign or change an applicant's course.",
        });
      }

      if (nextProgram) {
        const [curriculumRows] = await db3.query(
          `SELECT ct.curriculum_id
           FROM curriculum_table ct
           INNER JOIN program_table pt ON pt.program_id = ct.program_id
           WHERE ct.curriculum_id = ?
             AND pt.components = ?
             AND pt.academic_program = ?
             AND ct.lock_status = 1
           LIMIT 1`,
          [nextProgram, nextCampus, nextAcademicProgram],
        );
        if (curriculumRows.length === 0) {
          return res.status(400).json({
            error: "The assigned course must be active and match the applicant's branch and academic program.",
          });
        }
      }

      cleanedEntries.push([
        "program_assignment_pending",
        nextProgram ? 0 : 1,
      ]);
    }

    const setClause = cleanedEntries.map(([key]) => `${key}=?`).join(", ");
    const values = cleanedEntries.map(([_, val]) => val);
    values.push(id);

    const sql = `UPDATE person_table SET ${setClause} WHERE person_id=?`;
    const [result] = await db.execute(sql, values);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Person not found or no changes made" });
    }

    
    // Keep user_accounts email in sync when applicant email changes.
    // We only update applicant role accounts to avoid touching staff emails.
    if (emailEntry) {
      if (!nextEmail) {
        return res.status(400).json({ error: "emailAddress cannot be empty." });
      }

      const [conflictRows] = await db.query(
        `SELECT person_id
         FROM user_accounts
         WHERE LOWER(TRIM(email)) = ?
           AND person_id <> ?
         LIMIT 1`,
        [nextEmail, id],
      );
      if (conflictRows.length > 0) {
        return res.status(409).json({ error: "Email is already used by another account." });
      }

      await db.query(
        `UPDATE user_accounts
         SET email = ?
         WHERE person_id = ? AND role = 'applicant'`,
        [nextEmail, id],
      );
    }

    if (applicantBefore && courseUpdateFields.length > 0) {
      const cleanedData = Object.fromEntries(cleanedEntries);
      const changes = [];

      for (const field of courseUpdateFields) {
        const oldValue = applicantBefore[field] ?? null;
        const newValue = cleanedData[field] ?? null;

        if (String(oldValue || "") !== String(newValue || "")) {
          const [fromLabel, toLabel] = await Promise.all([
            getCurriculumLabel(oldValue),
            getCurriculumLabel(newValue),
          ]);

          changes.push({
            label: field === "program" ? "course applied" : field,
            fromLabel,
            toLabel,
          });
        }
      }

      await insertApplicantCourseChangeAuditLog({
        actorId:
          req.body.audit_actor_id ||
          req.body.actor_id ||
          req.body.employee_id ||
          "unknown",
        actorRole: req.body.audit_actor_role || req.body.role || "registrar",
        applicant: applicantBefore,
        changes,
      });
    }
    res.json({ message: "✅ Person updated successfully" });
  } catch (error) {
    console.error("❌ Error updating person:", error);
    res.status(500).json({
      error: "Database error during update",
      details: error.message
    });
  }
});


router.post("/upload-profile-picture", uploadProfile.single("profile_picture"), async (req, res) => {
  const { person_id } = req.body;
  if (!person_id || !req.file) {
    return res.status(400).send("Missing person_id or file.");
  }

  try {
    // ✅ Get applicant_number from person_id
    const [rows] = await db.query(
      "SELECT applicant_number FROM applicant_numbering_table WHERE person_id = ?",
      [person_id]
    );
    if (!rows.length) {
      return res.status(404).json({ message: "Applicant number not found for person_id " + person_id });
    }

    const applicant_number = rows[0].applicant_number;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const year = new Date().getFullYear();
    const filename = `${applicant_number}_1by1_${year}${ext}`;
    const uploadDir = path.join(__dirname, "../../uploads/Applicant1by1");
    const finalPath = path.join(uploadDir, filename);

    const files = await fs.promises.readdir(uploadDir);
    for (const file of files) {
      if (file.startsWith(`${applicant_number}_1by1_`)) {
        await fs.promises.unlink(path.join(uploadDir, file));
      }
    }

    await fs.promises.writeFile(finalPath, req.file.buffer);

    await db.query("UPDATE person_table SET profile_img = ? WHERE person_id = ?", [filename, person_id]);

    res.status(200).json({ message: "Uploaded successfully", filename });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Failed to upload image.");
  }
});

router.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      error: "Profile picture must be 2MB or less.",
    });
  }

  if (err.message === "Only JPG, JPEG, PNG allowed") {
    return res.status(400).json({
      error: err.message,
    });
  }

  next(err);
});

router.post("/add-applicant", async (req, res) => {
  const {
    email,
    password,
    campus,
    first_name,
    middle_name,
    last_name,
    birthOfDate,
    academicProgram,
    applyingAs,
    program,
    active_school_year_id, // optional override, same as /register
  } = req.body;

  const normalizedEmail = email?.trim().toLowerCase();
  let person_id = null;

  try {
    await ensureApplicantProgramAssignmentColumn();
    // ---- 1. Required fields ----
    if (
      !normalizedEmail ||
      !password ||
      !campus ||
      !first_name ||
      !last_name ||
      !birthOfDate ||
      !academicProgram ||
      !applyingAs ||
      !program
    ) {
      await insertRegistrationAuditLog({
        actorId: normalizedEmail || "unknown",
        outcome: "FAILED",
        event: "failed to add applicant",
        reason: "Missing required fields",
      });
      return res.status(400).json({
        success: false,
        message: "Please fill up all required fields",
      });
    }

    // ---- 2. Email domain reachability ----
    const domainOk = await isDomainReachable(normalizedEmail);
    if (!domainOk) {
      await insertRegistrationAuditLog({
        actorId: normalizedEmail,
        outcome: "FAILED",
        event: "failed to add applicant",
        reason: "Email domain has no valid mail records",
      });
      return res.status(400).json({
        success: false,
        message: "This email domain doesn't appear to exist or can't receive mail.",
      });
    }

    // ---- 3. Email uniqueness ----
    const [existingEmail] = await db.query(
      "SELECT 1 FROM user_accounts WHERE email = ?",
      [normalizedEmail]
    );
    if (existingEmail.length > 0) {
      return res.status(400).json({ success: false, message: "Email is already registered" });
    }

    const [[company]] = await db.query(
      "SELECT short_term, company_name FROM company_settings WHERE id = 1"
    );
    const issuer = company?.short_term || "School";
    const companyName = company?.company_name || "Main Campus";

    // ---- 4. Duplicate enrollment person check ----
    const duplicateEnrollmentPerson = await checkEnrollmentPersonDuplicate({
      email: normalizedEmail,
      firstName: first_name,
      lastName: last_name,
      birthday: birthOfDate,
    });
    if (duplicateEnrollmentPerson.duplicate) {
      await insertRegistrationAuditLog({
        actorId: normalizedEmail,
        outcome: "FAILED",
        event: "failed to add applicant",
        reason: duplicateEnrollmentPerson.message,
      });
      return res.status(400).json({
        success: false,
        message: duplicateEnrollmentPerson.message,
      });
    }

    // ---- 5. Exact person match -> already took the exam? ----
    const [personMatch] = await db.query(
      `SELECT person_id
       FROM person_table
       WHERE first_name = ?
         AND last_name = ?
         AND birthOfDate = ?
         AND LOWER(TRIM(emailAddress)) = ?
       LIMIT 1`,
      [first_name.trim(), last_name.trim(), birthOfDate, normalizedEmail]
    );
    if (personMatch.length > 0) {
      const matchedPersonId = personMatch[0].person_id;
      const [applicant] = await db.query(
        `SELECT applicant_number FROM applicant_numbering_table WHERE person_id = ? LIMIT 1`,
        [matchedPersonId]
      );
      if (applicant.length > 0) {
        const [exam] = await db.query(
          `SELECT email_sent FROM exam_applicants WHERE applicant_id = ? LIMIT 1`,
          [applicant[0].applicant_number]
        );
        if (exam.length > 0 && exam[0].email_sent === 1) {
          return res.status(400).json({
            success: false,
            message: `We are sorry to inform you that this applicant is no longer allowed to take the ${issuer} College Admission Test (ECAT). Based on our records, they have already taken the examination.`,
          });
        }
      }
    }

    // ---- 6. Partial match (same name, different email context) ----
    const [partialMatch] = await db.query(
      `SELECT person_id
       FROM person_table
       WHERE last_name = ?
         AND middle_name = ?
         AND first_name = ?
       LIMIT 1`,
      [last_name.trim(), middle_name?.trim() || null, first_name.trim()]
    );
    if (partialMatch.length > 0) {
      const matchedPersonId = partialMatch[0].person_id;
      const [applicant] = await db.query(
        `SELECT applicant_number FROM applicant_numbering_table WHERE person_id = ? LIMIT 1`,
        [matchedPersonId]
      );
      if (applicant.length > 0) {
        const [exam] = await db.query(
          `SELECT email_sent FROM exam_applicants WHERE applicant_id = ? LIMIT 1`,
          [applicant[0].applicant_number]
        );
        if (exam.length > 0 && exam[0].email_sent === 1) {
          return res.status(400).json({
            success: false,
            message: "A similar applicant already received an email. Cannot add this applicant.",
          });
        }
      }
    }

    // ---- 7. Branch / campus + registration window validation ----
    const [[row]] = await db.query(
      "SELECT branches FROM company_settings WHERE id = 1"
    );
    const branches = JSON.parse(row.branches || "[]");
    const branch = branches.find((b) => b.id == campus);
    if (!branch) {
      return res.status(400).json({ success: false, message: "Invalid branch selected" });
    }
    const nowDate = new Date();
    let isOpen = branch.registration_open;
    if (branch.start_date && branch.end_date) {
      isOpen =
        nowDate >= new Date(branch.start_date) &&
        nowDate <= new Date(branch.end_date);
    }
    if (!isOpen) {
      return res.status(400).json({
        success: false,
        message: "Registration is closed for this branch",
      });
    }

    const selectedAcademicProgram = (branch.academicPrograms || []).find(
      (item) => String(item.id) === String(academicProgram),
    );
    if (!selectedAcademicProgram) {
      return res.status(400).json({
        success: false,
        message: "Invalid academic program selected",
      });
    }
    const allProgramsEnabled =
      Number(selectedAcademicProgram.all_programs) === 1;

    // ---- 8. Curriculum / program validation ----
    if (!allProgramsEnabled) {
      const [selectedCurriculumRows] = await db3.query(
        `SELECT ct.curriculum_id
         FROM curriculum_table AS ct
         INNER JOIN program_table AS pt ON pt.program_id = ct.program_id
         WHERE ct.curriculum_id = ?
           AND pt.components = ?
           AND pt.academic_program = ?
           AND ct.lock_status = 1
         LIMIT 1`,
        [program, campus, academicProgram]
      );
      if (selectedCurriculumRows.length === 0) {
        return res.status(400).json({ success: false, message: "Invalid curriculum selected" });
      }
    }

    // NOTE: No OTP/TOTP check here — this endpoint is for a registrar/admin
    // creating an applicant record directly, not self-service registration,
    // so there's no QR/authenticator step to verify.

    const hashedPassword = await bcrypt.hash(password, 10);

    // ---- Race-condition guard right before insert ----
    const [existingUser] = await db.query(
      "SELECT * FROM user_accounts WHERE email = ?",
      [normalizedEmail]
    );
    if (existingUser.length > 0) {
      await insertRegistrationAuditLog({
        actorId: normalizedEmail,
        outcome: "FAILED",
        event: "failed to add applicant",
        reason: "Email already registered (race condition)",
      });
      return res.status(400).json({ success: false, message: "Email is already registered" });
    }

    const age = calculateAge(birthOfDate);

    const [personResult] = await db.query(
      `INSERT INTO person_table
       (campus, emailAddress, first_name, middle_name, last_name, birthOfDate, age,
        academicProgram, applyingAs, program, program_assignment_pending,
        termsOfAgreement, current_step)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        campus,
        normalizedEmail,
        first_name.trim(),
        middle_name?.trim() || null,
        last_name.trim(),
        birthOfDate,
        age,
        academicProgram,
        applyingAs,
        allProgramsEnabled ? null : program,
        allProgramsEnabled ? 1 : 0,
        0,
        1,
      ]
    );

    person_id = personResult.insertId;

    let schoolYearId = Number(active_school_year_id);
    if (!Number.isInteger(schoolYearId) || schoolYearId <= 0) {
      const [[activeSchoolYear]] = await db3.query(
        "SELECT id AS school_year_id FROM active_school_year_table WHERE astatus = 1 LIMIT 1"
      );
      schoolYearId = activeSchoolYear?.school_year_id || null;
    }

    await db.query(
      `INSERT INTO user_accounts (person_id, email, password, role, status, school_year_id)
       VALUES (?, ?, ?, 'applicant', ?, ?)`,
      [person_id, normalizedEmail, hashedPassword, 1, schoolYearId]
    );

    // Admin-created accounts must change their password on first login
    await db.query(
      `UPDATE user_accounts SET force_password_change = 1 WHERE person_id = ? AND role = 'applicant'`,
      [person_id]
    );

    const [activeYearResult] = await db3.query(`
      SELECT yt.year_description, st.semester_code
      FROM active_school_year_table sy
      JOIN year_table yt ON yt.year_id = sy.year_id
      JOIN semester_table st ON st.semester_id = sy.semester_id
      WHERE sy.astatus = 1
      LIMIT 1
    `);
    if (activeYearResult.length === 0) {
      throw new Error("No active school year/semester found.");
    }

    const year = String(activeYearResult[0].year_description).split("-")[0];
    const semCode = activeYearResult[0].semester_code;

    // Use the shared counter table (avoids the COUNT(*) race condition
    // the old add-applicant had when two requests land at once)
    const [countRes] = await db.query(
      "SELECT counter, query FROM applicant_counter WHERE id = 1"
    );
    const padded = String(countRes[0].query).padStart(5, "0");
    const applicant_number = `${year}${semCode}${padded}`;

    await db.query(
      "INSERT INTO applicant_numbering_table (applicant_number, person_id) VALUES (?, ?)",
      [applicant_number, person_id]
    );

    const qrData = `${process.env.DB_HOST_LOCAL}:5173/applicant_profile/${applicant_number}`;
    const qrFilename = `${applicant_number}_qrcode.png`;
    const qrPath = path.join(__dirname, "../../uploads/QrCodeGenerated", qrFilename);


    await QRCode.toFile(qrPath, qrData, {
      color: { dark: "#000", light: "#FFF" },
      width: 300,
    });
   
    await db.query(
      "UPDATE applicant_numbering_table SET qr_code = ? WHERE applicant_number = ?",
      [qrFilename, applicant_number]
    );

    await db.query(
      `INSERT INTO person_status_table
       (person_id, applicant_id, exam_status, requirements, residency,
        student_registration_status, exam_result, hs_ave, qualifying_result, interview_result)
       VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
      [person_id, applicant_number]
    );

    await db.query(
      `INSERT INTO interview_applicants
       (schedule_id, applicant_id, email_sent, status, qualifying_status, interview_status)
       VALUES (?, ?, 0, 0, null, null)`,
      [null, applicant_number]
    );

    const nextQuery = countRes[0].query + 1;
    await db.query(
      "UPDATE applicant_counter SET counter = ?, query = ? WHERE id = 1",
      [countRes[0].query, nextQuery]
    );

    res.status(201).json({
      success: true,
      message: "Applicant created successfully",
      person_id,
      applicant_number,
      campus,
    });

    await insertRegistrationAuditLog({
      actorId: normalizedEmail,
      outcome: "SUCCESS",
      event: "successfully added applicant",
    });
  } catch (error) {
    if (person_id) {
      await db.query("DELETE FROM person_table WHERE person_id = ?", [person_id]);
    }
    console.error(error);
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to add applicant",
      reason: "Internal server error",
    });
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
});



module.exports = router;
