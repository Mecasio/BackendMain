const express = require("express");
const { db } = require("../database/database");
const { insertAuditLogAdmission, resolveAuditActor } = require("../../utils/auditLogger");

const router = express.Router();

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const insertSubjectAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogAdmission({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

//////////////////////////////////////////////////////////////
// GET ALL SUBJECTS
//////////////////////////////////////////////////////////////
router.get("/subjects/all", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT *
      FROM subjects
      ORDER BY id ASC
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch subjects" });
  }
});

router.get("/subjects", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT *
      FROM subjects
      ORDER BY id ASC
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch subjects" });
  }
});

//////////////////////////////////////////////////////////////
// GET ACTIVE SUBJECTS ONLY
//////////////////////////////////////////////////////////////
router.get("/subjects/active", async (req, res) => {
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
    res.status(500).json({ error: "Failed to fetch active subjects" });
  }
});

//////////////////////////////////////////////////////////////
// CREATE SUBJECT
//////////////////////////////////////////////////////////////
router.post("/subjects", async (req, res) => {
  try {
    const { name, max_score, is_active } = req.body;

    if (!name || !max_score) {
      return res.status(400).json({
        error: "Name and max_score are required"
      });
    }

    const [result] = await db.query(`
      INSERT INTO subjects (name, max_score, is_active, created_at)
      VALUES (?, ?, ?, NOW())
    `, [name, max_score, Number(is_active) === 0 ? 0 : 1]);

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertSubjectAuditLog({
      req,
      action: "APPLICANT_EXAM_SUBJECT_CREATE",
      message: `${roleLabel} (${actorId}) created applicant exam subject ${name}. Max score: ${max_score}.`,
    });

    res.json({
      success: true,
      id: result.insertId
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create subject" });
  }
});

//////////////////////////////////////////////////////////////
// UPDATE SUBJECT
//////////////////////////////////////////////////////////////
router.put("/subjects/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, max_score, is_active } = req.body;

    const [[subjectBefore]] = await db.query(
      "SELECT * FROM subjects WHERE id = ? LIMIT 1",
      [id],
    );

    if (!subjectBefore) {
      return res.status(404).json({ error: "Subject not found" });
    }

    await db.query(`
      UPDATE subjects
      SET
        name = ?,
        max_score = ?,
        is_active = ?
      WHERE id = ?
    `, [name, max_score, is_active, id]);

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const previousStatus = Number(subjectBefore.is_active) === 1 ? "Active" : "Inactive";
    const nextStatus = Number(is_active) === 1 ? "Active" : "Inactive";
    const nameChanged = String(subjectBefore.name || "") !== String(name || "");
    const maxScoreChanged = Number(subjectBefore.max_score || 0) !== Number(max_score || 0);
    const statusChanged = Number(subjectBefore.is_active) !== Number(is_active);
    const onlyStatusChanged = statusChanged && !nameChanged && !maxScoreChanged;

    const auditAction = onlyStatusChanged
      ? Number(is_active) === 1
        ? "APPLICANT_EXAM_SUBJECT_ACTIVATE"
        : "APPLICANT_EXAM_SUBJECT_DEACTIVATE"
      : "APPLICANT_EXAM_SUBJECT_UPDATE";

    const auditMessage = onlyStatusChanged
      ? `${roleLabel} (${actorId}) set applicant exam subject ${subjectBefore.name} to ${nextStatus}.`
      : `${roleLabel} (${actorId}) updated applicant exam subject ${subjectBefore.name} to ${name}. Max score: ${subjectBefore.max_score} to ${max_score}. Status: ${previousStatus} to ${nextStatus}.`;

    await insertSubjectAuditLog({
      req,
      action: auditAction,
      message: auditMessage,
    });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update subject" });
  }
});

//////////////////////////////////////////////////////////////
// DELETE SUBJECT
//////////////////////////////////////////////////////////////
router.delete("/subjects/:id", async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;

    await connection.beginTransaction();

    const [[subjectBefore]] = await connection.query(
      "SELECT * FROM subjects WHERE id = ? LIMIT 1",
      [id],
    );

    if (!subjectBefore) {
      await connection.rollback();
      return res.status(404).json({ error: "Subject not found" });
    }

    await connection.query(`
      DELETE FROM exam_result_details
      WHERE subject_id = ?
    `, [id]);

    await connection.query(`
      DELETE FROM subjects
      WHERE id = ?
    `, [id]);

    await connection.commit();

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertSubjectAuditLog({
      req,
      action: "APPLICANT_EXAM_SUBJECT_DELETE",
      message: `${roleLabel} (${actorId}) deleted applicant exam subject ${subjectBefore.name}.`,
    });

    res.json({ success: true });

  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: "Failed to delete subject" });
  } finally {
    connection.release();
  }
});

router.post("/exam/submit", async (req, res) => {
  try {
    const { applicant_id, answers } = req.body;

    for (const subject_id in answers) {
      await db.query(`
        INSERT INTO exam_results (applicant_id, subject_id, score)
        VALUES (?, ?, ?)
      `, [applicant_id, subject_id, answers[subject_id]]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit exam" });
  }
});

module.exports = router;
