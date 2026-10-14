const express = require('express');
const { db, db3 } = require('../database/database');
const router = express.Router();

router.get("/applicant_number/:person_id", async (req, res) => {
  const { person_id } = req.params;

  try {
    const [rows] = await db.query("SELECT applicant_number FROM applicant_numbering_table WHERE person_id = ?", [person_id]);

    if (!rows.length) {
      return res.status(404).json({ message: "Applicant number not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching applicant number:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/verification-status/:applicant_number", async (req, res) => {
  const { applicant_number } = req.params;

  try {
    // ✅ Step 1: Get person_id from applicant_number
    const [personRows] = await db.query(
      `
      SELECT pt.person_id, pt.applyingAs
      FROM applicant_numbering_table ant
      INNER JOIN person_table pt
        ON ant.person_id = pt.person_id
      WHERE ant.applicant_number = ?
      `,
      [applicant_number]
    );
    if (personRows.length === 0) {
      return res.json({ verified: false, reason: "Applicant not found" });
    }

    const { person_id: personId, applyingAs } = personRows[0];

    // ✅ Step 2: Count how many verifiable requirements exist
    const [requirements] = await db.query(
      `
      SELECT COUNT(*) AS total_required
      FROM requirements_table
      WHERE is_verifiable = 1
        AND applicant_type = ?
      `,
      [applyingAs]
    );
    const totalRequired = requirements[0]?.total_required || 0;

    // ✅ Step 3: Count how many of those requirements were submitted & verified
    const [verifiedUploads] = await db.query(
      `
      SELECT COUNT(DISTINCT requirements_id) AS total_verified
      FROM requirement_uploads
      WHERE person_id = ?
      AND document_status = 'Documents Verified & ECAT'
      `,
      [personId]
    );
    const totalVerified = verifiedUploads[0]?.total_verified || 0;

    // ✅ Step 4: Check if applicant has an exam schedule
    const [schedule] = await db.query(
      `
      SELECT ees.*
      FROM exam_applicants ea
      JOIN entrance_exam_schedule ees ON ea.schedule_id = ees.schedule_id
      WHERE ea.applicant_id = ?
      `,
      [applicant_number]
    );
    const hasSchedule = schedule.length > 0;

    // ✅ Step 5: Determine if verified
    const fullyVerified = totalVerified >= totalRequired && hasSchedule;

    res.json({
      verified: fullyVerified,
      totalRequired,
      totalVerified,
      hasSchedule,
    });
  } catch (error) {
    console.error("Error checking applicant verification:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/verified-exam-applicants", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT 
          ea.id AS exam_applicant_id,
          ea.applicant_id,
          ant.person_id,
          p.last_name,
          p.first_name,
          p.middle_name,
          p.emailAddress,
          p.program,
          ea.schedule_id
      FROM exam_applicants ea
      JOIN applicant_numbering_table ant 
          ON ea.applicant_id = ant.applicant_number
      JOIN person_table p 
          ON ant.person_id = p.person_id
      WHERE ant.person_id IN (
          SELECT ru.person_id
          FROM requirement_uploads ru
          INNER JOIN requirements_table rt
            ON ru.requirements_id = rt.id
          WHERE ru.document_status = 'Documents Verified & ECAT'
            AND rt.category = 'Main'
            AND rt.is_verifiable = 1
          GROUP BY ru.person_id
          HAVING COUNT(DISTINCT ru.requirements_id) >= (
            SELECT COUNT(*)
            FROM requirements_table rt2
            INNER JOIN person_table p2
              ON rt2.applicant_type = p2.applyingAs
            WHERE rt2.category = 'Main'
              AND rt2.is_verifiable = 1
              AND p2.person_id = ru.person_id
          )
      )
      ORDER BY p.last_name ASC, p.first_name ASC
      `
    );

    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching verified exam applicants:", err);
    res.status(500).json({ error: "Failed to fetch verified exam applicants" });
  }
});

const fetchApplicantExamSchedule = async (applicant_number) => {
  const [rows] = await db.query(`
    SELECT
      s.day_description AS date_of_exam,
      s.start_time,
      s.end_time,
      s.building_description,
      s.room_description,
      rt.floor,
      s.proctor,
      s.created_at AS schedule_created_at
    FROM exam_applicants ea
    JOIN entrance_exam_schedule s
      ON ea.schedule_id = s.schedule_id
    LEFT JOIN enrollment.room_table rt
      ON rt.room_description = s.room_description
      AND rt.building_description = s.building_description
    WHERE ea.applicant_id = ?
      AND COALESCE(ea.email_sent, 0) = 1
    LIMIT 1
  `, [applicant_number]);

  return rows;
};

const sendApplicantExamSchedule = async (req, res) => {
    const { applicant_number } = req.params;

    try {
      const rows = await fetchApplicantExamSchedule(applicant_number);

      if (rows.length === 0) {
        return res.status(404).json({ message: "No exam schedule found" });
      }

      res.json(rows[0]);
    } catch (err) {
      console.error("Error fetching exam schedule:", err);
      res.status(500).json({ error: "Database error" });
    }
};

router.get("/exam-schedule/:applicant_number", sendApplicantExamSchedule);
router.get("/applicant-schedule/:applicant_number", sendApplicantExamSchedule);

router.get("/scheduled-by/:role", async (req, res) => {
  const { role } = req.params;

  try {
    const [rows] = await db3.query(
      `
      SELECT first_name, middle_name, last_name 
      FROM user_accounts 
      WHERE role = ? 
      LIMIT 1
      `,
      [role]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "No user found for that role" });
    }

    const { first_name, middle_name, last_name } = rows[0];
    const fullName = `${first_name || ""} ${middle_name ? middle_name + " " : ""}${last_name || ""}`.trim();

    res.json({ fullName });
  } catch (err) {
    console.error("❌ Error fetching user by role:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
