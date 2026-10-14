const express = require("express");
const { db, db3 } = require("../database/database");
const { insertAuditLogAdmission } = require("../../utils/auditLogger");

const router = express.Router();

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const formatExamStatus = (status) => {
  if (status === null || status === undefined || status === "") return "N/A";
  if (Number(status) === 0) return "PASSED";
  if (Number(status) === 1) return "FAILED";
  return String(status);
};

const normalizeExamStatus = (status) => {
  if (status === null || status === undefined || status === "") return "";
  return String(Number(status));
};

const mapExamResultStatusToPersonExamStatus = (status) => {
  if (status === null || status === undefined || status === "") return null;
  const numericStatus = Number(status);
  if (Number.isNaN(numericStatus)) return null;
  // exam_results.status: 0 = PASSED, 1 = FAILED
  // person_status_table.exam_status: 1 = passed/finished, 0 = not passed
  if (numericStatus === 0) return 1;
  if (numericStatus === 1) return 0;
  return null;
};

const formatPersonExamStatus = (status) => {
  if (status === null || status === undefined || status === "") return "N/A";
  if (Number(status) === 1) return "PASSED";
  if (Number(status) === 0) return "NOT PASSED";
  return String(status);
};

const { authenticateToken } = require("../../middleware/auth");

function verifyToken(req, res, next) {
  if (req.user) return next();
  return authenticateToken(req, res, next);
}


//////////////////////////////////////////////////////////////
// GET ACTIVE SUBJECTS
//////////////////////////////////////////////////////////////
router.get("/active-subjects", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT *
      FROM subjects
      WHERE is_active = 1
      ORDER BY id ASC
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch subjects" });
  }
});


//////////////////////////////////////////////////////////////
// GET APPLICANT SCORING
//////////////////////////////////////////////////////////////
router.get("/api-applicant-scoring", async (req, res) => {
  try {

    // ✅ SUBJECTS (dynamic)
    const [subjects] = await db.query(`
      SELECT id, name, max_score
      FROM subjects
      WHERE is_active = 1
      ORDER BY id ASC
    `);

    const [rows] = await db.query(`
      SELECT DISTINCT
        p.person_id,
        p.campus,
        p.first_name,
        p.middle_name,
        p.last_name,
        p.extension,
        a.applicant_number,
        SUBSTRING(a.applicant_number, 5, 1) AS middle_code,
        p.program,
        p.generalAverage1,
        p.created_at,

        er.id AS exam_result_id,
        er.total_score,
        er.percentage,
        er.final_rating,
        er.status,
        er.active_school_year_id,

        COALESCE(ps.exam_result, 0) AS total_ave,
        COALESCE(ps.qualifying_result, 0) AS qualifying_exam_score,
        COALESCE(ps.interview_result, 0) AS qualifying_interview_score,

        COALESCE(CAST(ia.status AS UNSIGNED), 0) AS college_approval_status

      FROM person_table p
      INNER JOIN applicant_numbering_table a
        ON p.person_id = a.person_id

      LEFT JOIN exam_results er
        ON p.person_id = er.person_id

      LEFT JOIN person_status_table ps
        ON p.person_id = ps.person_id

      LEFT JOIN interview_applicants ia
        ON ia.applicant_id = a.applicant_number

      LEFT JOIN exam_applicants ea
        ON a.applicant_number = ea.applicant_id

      WHERE ea.email_sent = 1
      ORDER BY p.person_id ASC
    `);

    // ✅ DETAILS (scores per subject)
    const [details] = await db.query(`
      SELECT exam_result_id, subject_id, score
      FROM exam_result_details
    `);

    // ✅ FORMAT RESULT
    const formatted = rows.map(row => {

      const scores = {};

      // initialize all subjects = 0
      subjects.forEach(sub => {
        scores[sub.id] = 0;
      });

      // fill actual scores
      details
        .filter(d => d.exam_result_id === row.exam_result_id)
        .forEach(d => {
          scores[d.subject_id] = Number(d.score);
        });

      // compute total dynamically
      const total = Object.values(scores)
        .reduce((sum, val) => sum + val, 0);

      const maxTotal = subjects.reduce(
        (sum, sub) => sum + Number(sub.max_score || 0),
        0
      );

      // ✅ Guidance Office Formula
      const percentage =
        maxTotal > 0
          ? ((total / maxTotal) * 50) + 50
          : 0;

      // Final rating same as percentage
      const final_rating =
        subjects.length > 0
          ? total / subjects.length
          : 0;
          
      return {
        ...row,
        scores,
        total,
        percentage,
        final_rating
      };
    });

    // ✅ SEND EVERYTHING
    res.json({
      subjects,
      data: formatted
    });

  } catch (err) {
    console.error("Error fetching applicant scoring:", err);

    res.status(500).send("Server error");
  }
});

//////////////////////////////////////////////////////////////
// SAVE EXAM
//////////////////////////////////////////////////////////////
router.post("/exam/save", verifyToken, async (req, res) => {
  try {
    const {
      applicant_number,
      scores,
      status,
      audit_actor_id,
      audit_actor_role,
    } = req.body;

    if (!applicant_number) {
      return res.status(400).json({
        error: "Applicant number required"
      });
    }

    if (!Array.isArray(scores)) {
      return res.status(400).json({
        error: "Scores must be array"
      });
    }

    //--------------------------------------
    // GET USER
    //--------------------------------------
    let actor = {
      actorId: audit_actor_id || "unknown",
      role: audit_actor_role || "registrar"
    };

    if (req.user?.email) {
      const [userRows] = await db3.query(
        `SELECT email, role, employee_id
         FROM user_accounts
         WHERE email = ?
         LIMIT 1`,
        [req.user.email]
      );

      if (userRows.length) {
        actor = {
          actorId: audit_actor_id || userRows[0].employee_id || userRows[0].email,
          role: audit_actor_role || userRows[0].role || "registrar",
        };
      }
    }

    if (audit_actor_id || audit_actor_role) {
      actor = {
        actorId: audit_actor_id || actor.actorId || "unknown",
        role: audit_actor_role || actor.role || "registrar",
      };
    }

    //--------------------------------------
    // GET CURRENTLY-ACTIVE SCHOOL YEAR/SEMESTER
    //--------------------------------------
    // db3 already connects straight to the enrollment database (see
    // user_accounts lookup above with no schema prefix), so no cross-db
    // qualifier is needed here. Requires:
    //   ALTER TABLE exam_results ADD COLUMN active_school_year_id INT NULL;
    let activeSchoolYearId = null;
    try {
      const [[activeYear]] = await db3.query(
        `SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1`
      );
      activeSchoolYearId = activeYear?.id ?? null;
    } catch (asyErr) {
      console.error("Error resolving active school year for exam save:", asyErr);
    }

    //--------------------------------------
    // GET PERSON
    //--------------------------------------
    const [personRows] = await db.query(
      `SELECT
         ant.person_id,
         pt.first_name,
         pt.middle_name,
         pt.last_name
       FROM applicant_numbering_table ant
       LEFT JOIN person_table pt ON pt.person_id = ant.person_id
       WHERE ant.applicant_number = ?
       LIMIT 1`,
      [applicant_number]
    );

    if (!personRows.length) {
      return res.status(404).json({
        error: "Applicant not found"
      });
    }

    const personId = personRows[0].person_id;
    const applicantName = [
      personRows[0].last_name,
      personRows[0].first_name,
      personRows[0].middle_name,
    ]
      .filter(Boolean)
      .join(", ");

    //--------------------------------------
    // COMPUTE TOTAL
    //--------------------------------------
    let totalScore = 0;

    scores.forEach(item => {
      totalScore += Number(item.score || 0);
    });

    //--------------------------------------
    // GET MAX TOTAL
    //--------------------------------------
    const [maxRows] = await db.query(`
      SELECT SUM(max_score) AS max_total
      FROM subjects
      WHERE is_active = 1
    `);

    const maxTotal = Number(maxRows[0].max_total || 0);

    // Guidance Office Formula
    const percentage =
      maxTotal > 0
        ? ((totalScore / maxTotal) * 50) + 50
        : 0;

    // Final rating same as percentage
    const finalRating =
      scores.length > 0
        ? totalScore / scores.length
        : 0;

    //--------------------------------------
    // CHECK EXISTING EXAM RESULT
    //--------------------------------------
    const [existingRows] = await db.query(
      `SELECT id, status
       FROM exam_results
       WHERE person_id = ?
       LIMIT 1`,
      [personId]
    );

    let examResultId;
    let previousScoreMap = {};
    let previousStatus = "";

    if (existingRows.length) {
      examResultId = existingRows[0].id;
      previousStatus = existingRows[0].status;

      const [previousScoreRows] = await db.query(
        `SELECT subject_id, score
         FROM exam_result_details
         WHERE exam_result_id = ?`,
        [examResultId]
      );

      previousScoreMap = previousScoreRows.reduce((acc, row) => {
        acc[row.subject_id] = Number(row.score || 0);
        return acc;
      }, {});

      await db.query(`
        UPDATE exam_results
        SET
          total_score = ?,
          percentage = ?,
          final_rating = ?,
          status = ?,
          active_school_year_id = ?,
          date_created = NOW()
        WHERE id = ?
      `, [
        totalScore,
        percentage,
        finalRating,
        status,
        activeSchoolYearId,
        examResultId
      ]);

      await db.query(`
        DELETE FROM exam_result_details
        WHERE exam_result_id = ?
      `, [examResultId]);

    } else {
      const [insertResult] = await db.query(`
        INSERT INTO exam_results
        (
          person_id,
          total_score,
          percentage,
          final_rating,
          status,
          active_school_year_id,
          date_created
        )
        VALUES (?, ?, ?, ?, ?, ?, NOW())
      `, [
        personId,
        totalScore,
        percentage,
        finalRating,
        status,
        activeSchoolYearId
      ]);

      examResultId = insertResult.insertId;
    }

    //--------------------------------------
    // INSERT SUBJECT SCORES
    //--------------------------------------
    const scoreSubjectIds = scores.map((item) => item.subject_id).filter(Boolean);
    const [subjectRows] = scoreSubjectIds.length
      ? await db.query(
        `SELECT id, name, max_score FROM subjects WHERE id IN (?)`,
        [scoreSubjectIds]
      )
      : [[]];
    const subjectMap = subjectRows.reduce((acc, subject) => {
      acc[subject.id] = subject;
      return acc;
    }, {});

    for (const item of scores) {
      await db.query(`
        INSERT INTO exam_result_details
        (
          exam_result_id,
          subject_id,
          score
        )
        VALUES (?, ?, ?)
      `, [
        examResultId,
        item.subject_id,
        item.score
      ]);
    }

    const personExamStatus = mapExamResultStatusToPersonExamStatus(status);
    let previousPersonExamStatus = null;

    if (personExamStatus !== null) {
      const [personStatusRows] = await db.query(
        `SELECT exam_status
         FROM person_status_table
         WHERE person_id = ?
         LIMIT 1`,
        [personId]
      );

      previousPersonExamStatus = personStatusRows[0]?.exam_status ?? null;

      await db.query(
        `INSERT INTO person_status_table (person_id, applicant_id, exam_status)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE exam_status = VALUES(exam_status)`,
        [personId, applicant_number, personExamStatus]
      );
    }

    //--------------------------------------
    // AUDIT LOG
    //--------------------------------------
    const roleLabel = formatAuditActorRole(actor.role);

    await insertAuditLogAdmission({
      actorId: actor.actorId,
      role: actor.role,
      action: "SAVE_EXAM",
      message: `${roleLabel} (${actor.actorId}) saved entrance examination result for Applicant (${applicant_number}${applicantName ? ` - ${applicantName}` : ""}). Total score: ${totalScore}. Status: ${formatExamStatus(status)}.`,
      severity: "INFO"
    });

    if (normalizeExamStatus(previousStatus) !== normalizeExamStatus(status)) {
      await insertAuditLogAdmission({
        actorId: actor.actorId,
        role: actor.role,
        action: "UPDATE_EXAM_STATUS",
        message: `${roleLabel} (${actor.actorId}) changed ECAT status of Applicant (${applicant_number}${applicantName ? ` - ${applicantName}` : ""}): ${formatExamStatus(previousStatus)} -> ${formatExamStatus(status)}.`,
        severity: "INFO"
      });
    }

    if (
      personExamStatus !== null &&
      String(previousPersonExamStatus ?? "") !== String(personExamStatus)
    ) {
      await insertAuditLogAdmission({
        actorId: actor.actorId,
        role: actor.role,
        action: "UPDATE_PERSON_EXAM_STATUS",
        message: `${roleLabel} (${actor.actorId}) changed applicant exam_status for (${applicant_number}${applicantName ? ` - ${applicantName}` : ""}): ${formatPersonExamStatus(previousPersonExamStatus)} -> ${formatPersonExamStatus(personExamStatus)}.`,
        severity: "INFO"
      });
    }

    for (const item of scores) {
      const previousScore = previousScoreMap[item.subject_id] ?? 0;
      const nextScore = Number(item.score || 0);

      if (Number(previousScore) === Number(nextScore)) continue;

      const subject = subjectMap[item.subject_id];
      const subjectLabel = subject
        ? `${subject.name}${subject.max_score ? ` (max ${subject.max_score})` : ""}`
        : `Subject ${item.subject_id}`;

      await insertAuditLogAdmission({
        actorId: actor.actorId,
        role: actor.role,
        action: "SAVE_EXAM_SUBJECT_SCORE",
        message: `${roleLabel} (${actor.actorId}) changed ECAT score of Applicant (${applicant_number}${applicantName ? ` - ${applicantName}` : ""}) for ${subjectLabel}: ${previousScore} -> ${nextScore}.`,
        severity: "INFO"
      });
    }

    res.json({
      success: true,
      message: "Exam saved successfully"
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed saving exam"
    });
  }
});


module.exports = router;