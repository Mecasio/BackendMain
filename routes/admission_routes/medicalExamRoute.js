const express = require("express");
const { db, db3 } = require("../database/database");
const { insertAuditLogEnrollment } = require("../../utils/auditLogger");

const router = express.Router();

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getMedicalAuditActor = (req) => ({
  actorId:
    req.headers["x-audit-actor-id"] ||
    req.body?.audit_actor_id ||
    req.body?.user_id ||
    "unknown",
  actorRole:
    req.headers["x-audit-actor-role"] ||
    req.body?.audit_actor_role ||
    "registrar",
});

const getStudentAuditLabel = async (studentNumber) => {
  try {
    const [rows] = await db3.query(
      `
      SELECT
        s.student_number,
        p.last_name,
        p.first_name,
        p.middle_name
      FROM student_numbering_table s
      LEFT JOIN person_table p ON p.person_id = s.person_id
      WHERE s.student_number = ?
      LIMIT 1
      `,
      [studentNumber],
    );

    const student = rows?.[0];
    if (!student) return studentNumber;

    const fullName = [student.last_name, student.first_name, student.middle_name]
      .filter(Boolean)
      .join(", ");

    return fullName ? `${student.student_number} - ${fullName}` : student.student_number;
  } catch (err) {
    console.error("Medical audit student lookup failed:", err);
    return studentNumber;
  }
};

const insertMedicalAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getMedicalAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

const stripAuditFields = (data) => {
  delete data.audit_actor_id;
  delete data.audit_actor_role;
  delete data.user_id;
  return data;
};


// ✅ Search by student number or name in enrollment db3
router.get("/search-person-student", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "Missing search query" });

  try {
    const [rows] = await db3.query(
      `
      SELECT
        p.*,
        s.student_number,
        p.program AS original_program,
        COALESCE(NULLIF(sst.active_curriculum, 0), p.program) AS current_program,
        asy.id AS active_school_year_id
      FROM student_numbering_table s
      JOIN person_table p ON s.person_id = p.person_id
      LEFT JOIN active_school_year_table asy ON asy.astatus = 1
      LEFT JOIN student_status_table sst
        ON sst.student_number = s.student_number
       AND sst.active_school_year_id = asy.id
      WHERE s.student_number LIKE ?
         OR p.last_name LIKE ?
         OR p.first_name LIKE ?
         OR p.emailAddress LIKE ?
      ORDER BY sst.id DESC
      LIMIT 1
    `,
      [`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`],
    );

    if (!rows.length)
      return res.status(404).json({ message: "No matching student found" });

    const person = rows[0];
    person.program = person.current_program ?? person.original_program ?? person.program;
    res.json(person);
  } catch (err) {
    console.error("❌ Error searching person (db3):", err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});


// ✅ Fetch ALL medical records
router.get("/medical-requirements", async (req, res) => {
  try {
    const [rows] = await db3.query(
      "SELECT * FROM medical_requirements ORDER BY id DESC",
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching medical requirements:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Fetch ONE record by student_number (smart version using person_id fallback)
router.get("/medical-requirements/:student_number", async (req, res) => {
  const { student_number } = req.params;

  try {
    // Step 1: Try direct match in medical_requirements
    const [directMatch] = await db3.query(
      "SELECT * FROM medical_requirements WHERE student_number = ?",
      [student_number],
    );

    if (directMatch.length > 0) {
      return res.json(directMatch[0]); // found directly
    }

    // Step 2: If not found, check if that number belongs to a person in student_numbering_table
    const [studentMatch] = await db3.query(
      "SELECT person_id FROM student_numbering_table WHERE student_number = ?",
      [student_number],
    );

    if (studentMatch.length === 0) {
      return res
        .status(404)
        .json({ message: "No record found for this student number." });
    }

    const person_id = studentMatch[0].person_id;

    // Step 3: Find a medical record using the same person_id
    const [viaPerson] = await db3.query(
      "SELECT * FROM medical_requirements WHERE person_id = ?",
      [person_id],
    );

    if (viaPerson.length === 0) {
      return res
        .status(404)
        .json({ message: "No medical record linked to this person yet." });
    }

    res.json(viaPerson[0]);
  } catch (err) {
    console.error("Error fetching record:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create or update medical record
router.put("/medical-requirements", async (req, res) => {
  const { student_number, ...data } = req.body;
  stripAuditFields(data);

  if (!student_number) {
    return res.status(400).json({ message: "Student number is required." });
  }

  try {
    const [existing] = await db3.query(
      "SELECT id FROM medical_requirements WHERE student_number = ?",
      [student_number],
    );

    const isUpdate = existing.length > 0;

    if (isUpdate) {
      await db3.query(
        "UPDATE medical_requirements SET ? WHERE student_number = ?",
        [data, student_number],
      );
    } else {
      await db3.query("INSERT INTO medical_requirements SET ?", [
        { student_number, ...data },
      ]);
    }

    const { actorId, actorRole } = getMedicalAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const studentLabel = await getStudentAuditLabel(student_number);
    await insertMedicalAuditLog({
      req,
      action: isUpdate
        ? "MEDICAL_REQUIREMENTS_UPDATE"
        : "MEDICAL_REQUIREMENTS_CREATE",
      message: `${roleLabel} (${actorId}) ${isUpdate ? "updated" : "created"} medical history record for Student (${studentLabel}).`,
    });

    res.json({
      success: true,
      message: isUpdate ? "Record updated" : "Record created",
    });
  } catch (err) {
    console.error("Error saving medical record:", err);
    res.status(500).json({ error: err.message });
  }
});



// ✅ Fetch Dental Assessment Record (Smart version)
router.get("/dental-assessment/:student_number", async (req, res) => {
  const { student_number } = req.params;

  try {
    // Step 1: Try direct match in medical_requirements
    const [directRows] = await db3.query(
      "SELECT * FROM medical_requirements WHERE student_number = ?",
      [student_number],
    );

    let record = directRows[0];

    // Step 2: If not found, find same person via student_numbering_table
    if (!record) {
      const [studentMatch] = await db3.query(
        "SELECT person_id FROM student_numbering_table WHERE student_number = ?",
        [student_number],
      );

      if (studentMatch.length > 0) {
        const person_id = studentMatch[0].person_id;

        const [viaPerson] = await db3.query(
          "SELECT * FROM medical_requirements WHERE person_id = ?",
          [person_id],
        );

        if (viaPerson.length > 0) {
          record = viaPerson[0];
        }
      }
    }

    // Step 3: If still not found, create blank record
    if (!record) {
      await db3.query(
        "INSERT INTO medical_requirements (student_number) VALUES (?)",
        [student_number],
      );
      const [newRows] = await db3.query(
        "SELECT * FROM medical_requirements WHERE student_number = ?",
        [student_number],
      );
      record = newRows[0];
    }

    // Step 4: Parse JSON fields safely
    const jsonFields = [
      "dental_upper_right",
      "dental_upper_left",
      "dental_lower_right",
      "dental_lower_left",
    ];

    jsonFields.forEach((key) => {
      if (!record[key]) record[key] = Array(8).fill("");
      else if (typeof record[key] === "string") {
        try {
          record[key] = JSON.parse(record[key]);
        } catch {
          record[key] = Array(8).fill("");
        }
      }
    });

    res.json(record);
  } catch (err) {
    console.error("❌ Error fetching dental data:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create or Update Dental Assessment
router.put("/dental-assessment", async (req, res) => {
  const { student_number, ...data } = req.body;
  stripAuditFields(data);

  if (!student_number) {
    return res.status(400).json({ message: "Student number is required." });
  }

  try {
    // Stringify JSON fields before saving
    const jsonFields = [
      "dental_upper_right",
      "dental_upper_left",
      "dental_lower_right",
      "dental_lower_left",
    ];

    jsonFields.forEach((key) => {
      if (data[key] && typeof data[key] !== "string") {
        data[key] = JSON.stringify(data[key]);
      }
    });

    // Check if record exists by student_number
    const [existing] = await db3.query(
      "SELECT id FROM medical_requirements WHERE student_number = ?",
      [student_number],
    );

    const isUpdate = existing.length > 0;

    if (isUpdate) {
      await db3.query(
        "UPDATE medical_requirements SET ? WHERE student_number = ?",
        [data, student_number],
      );
    } else {
      // Optionally fetch person_id from student_numbering_table
      const [studentRow] = await db3.query(
        "SELECT person_id FROM student_numbering_table WHERE student_number = ?",
        [student_number],
      );
      const person_id = studentRow.length > 0 ? studentRow[0].person_id : null;

      await db3.query("INSERT INTO medical_requirements SET ?", [
        { student_number, person_id, ...data },
      ]);
    }

    const { actorId, actorRole } = getMedicalAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const studentLabel = await getStudentAuditLabel(student_number);
    await insertMedicalAuditLog({
      req,
      action: isUpdate
        ? "DENTAL_ASSESSMENT_UPDATE"
        : "DENTAL_ASSESSMENT_CREATE",
      message: `${roleLabel} (${actorId}) ${isUpdate ? "updated" : "created"} dental assessment record for Student (${studentLabel}).`,
    });

    res.json({
      success: true,
      message: isUpdate ? "Dental record updated" : "Dental record created",
    });
  } catch (err) {
    console.error("❌ Error saving dental data:", err);
    res.status(500).json({ error: err.message });
  }
});



// ✅ PHYSICAL & NEUROLOGICAL EXAMINATION API
router.get("/physical-neuro/:student_number", async (req, res) => {
  const { student_number } = req.params;
  try {
    const [rows] = await db3.query(
      "SELECT * FROM medical_requirements WHERE student_number = ?",
      [student_number],
    );

    if (rows.length === 0) {
      // Create a blank record if none exists
      await db3.query(
        "INSERT INTO medical_requirements (student_number) VALUES (?)",
        [student_number],
      );
      const [newRows] = await db3.query(
        "SELECT * FROM medical_requirements WHERE student_number = ?",
        [student_number],
      );
      return res.json(newRows[0]);
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching physical/neuro data:", err);
    res.status(500).json({ error: err.message });
  }
});

router.put("/physical-neuro", async (req, res) => {
  const { student_number, ...data } = req.body;
  stripAuditFields(data);
  if (!student_number)
    return res.status(400).json({ message: "Student number is required." });

  try {
    const [existing] = await db3.query(
      "SELECT id FROM medical_requirements WHERE student_number = ?",
      [student_number],
    );

    const isUpdate = existing.length > 0;

    if (isUpdate) {
      await db3.query(
        "UPDATE medical_requirements SET ? WHERE student_number = ?",
        [data, student_number],
      );
    } else {
      await db3.query("INSERT INTO medical_requirements SET ?", [
        { student_number, ...data },
      ]);
    }

    const { actorId, actorRole } = getMedicalAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const studentLabel = await getStudentAuditLabel(student_number);
    await insertMedicalAuditLog({
      req,
      action: isUpdate
        ? "PHYSICAL_NEURO_UPDATE"
        : "PHYSICAL_NEURO_CREATE",
      message: `${roleLabel} (${actorId}) ${isUpdate ? "updated" : "created"} physical and neurological examination record for Student (${studentLabel}).`,
    });

    res.json({
      success: true,
      message: isUpdate
        ? "Physical/Neuro record updated"
        : "Physical/Neuro record created",
    });
  } catch (err) {
    console.error("Error saving physical/neuro data:", err);
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
