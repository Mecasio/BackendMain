const express = require("express");
const multer = require("multer");
const { db, db3 } = require("../database/database");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");

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

const getProgramTaggingLabel = async (programTaggingId) => {
  const [rows] = await db3.query(
    `
    SELECT
      pt.program_tagging_id,
      p.program_code,
      p.program_description,
      p.major,
      co.course_code,
      co.course_description,
      yl.year_level_description,
      s.semester_description,
      y.year_description
    FROM program_tagging_table pt
    JOIN curriculum_table c ON pt.curriculum_id = c.curriculum_id
    JOIN year_table y ON c.year_id = y.year_id
    JOIN program_table p ON c.program_id = p.program_id
    JOIN course_table co ON pt.course_id = co.course_id
    JOIN year_level_table yl ON pt.year_level_id = yl.year_level_id
    JOIN semester_table s ON pt.semester_id = s.semester_id
    WHERE pt.program_tagging_id = ?
    LIMIT 1
    `,
    [programTaggingId],
  );

  const tag = rows?.[0];
  if (!tag) return `Program Tag ${programTaggingId}`;

  const major = tag.major ? ` (${tag.major})` : "";
  return `${tag.year_description} - (${tag.program_code}) ${tag.program_description}${major}, ${tag.year_level_description}, ${tag.semester_description}, ${tag.course_code} - ${tag.course_description}`;
};

const getProgramTaggingFilterLabel = async ({
  curriculum_id,
  year_level_id,
  semester_id,
}) => {
  const [rows] = await db3.query(
    `
    SELECT
      y.year_description,
      p.program_code,
      p.program_description,
      p.major,
      yl.year_level_description,
      s.semester_description
    FROM curriculum_table c
    JOIN year_table y ON c.year_id = y.year_id
    JOIN program_table p ON c.program_id = p.program_id
    LEFT JOIN year_level_table yl ON yl.year_level_id = ?
    LEFT JOIN semester_table s ON s.semester_id = ?
    WHERE c.curriculum_id = ?
    LIMIT 1
    `,
    [year_level_id, semester_id, curriculum_id],
  );

  const filter = rows?.[0];
  if (!filter) {
    return `Curriculum ${curriculum_id}, Year Level ${year_level_id}, Semester ${semester_id}`;
  }

  const major = filter.major ? ` (${filter.major})` : "";
  return `${filter.year_description} - (${filter.program_code}) ${filter.program_description}${major}, ${filter.year_level_description || `Year Level ${year_level_id}`}, ${filter.semester_description || `Semester ${semester_id}`}`;
};

const insertProgramTaggingAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

router.get("/program_tagging_list", async (req, res) => {
  const readQuery = `
SELECT 
  pt.program_tagging_id,
  pt.curriculum_id,
  c.program_id,
  dc.dprtmnt_id,
  pt.course_id,
  pt.year_level_id,
  pt.semester_id,
  pt.lec_fee,
  pt.lab_fee,
  pt.iscomputer_lab,
  pt.islaboratory_fee,
  pt.is_nstp,

  CONCAT(y.year_description, ' - ', p.program_description) AS curriculum_description,
  p.program_code,
  p.major, 

  co.course_code,
  co.course_description,
  co.course_unit,
  co.lab_unit,
  co.lec_unit,
  co.prereq,
  yl.year_level_description,
  s.semester_description
FROM program_tagging_table pt
JOIN curriculum_table c ON pt.curriculum_id = c.curriculum_id
LEFT JOIN dprtmnt_curriculum_table dc ON dc.curriculum_id = c.curriculum_id
JOIN year_table y ON c.year_id = y.year_id
JOIN program_table p ON c.program_id = p.program_id
JOIN course_table co ON pt.course_id = co.course_id
JOIN year_level_table yl ON pt.year_level_id = yl.year_level_id
JOIN semester_table s ON pt.semester_id = s.semester_id;

`;


  try {
    const [result] = await db3.query(readQuery);
    res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching tagged programs:", error);
    res.status(500).json({ error: "Error fetching program tagging list" });
  }
});

async function getLatestTosf() {
  const [rows] = await db3.query(
    `SELECT *
     FROM tosf
     ORDER BY tosf_id DESC
     LIMIT 1`
  );

  if (!rows.length) {
    throw new Error("TOSF is empty");
  }

  return rows[0];
}

router.post("/program_tagging", CanCreate, async (req, res) => {
  const {
    curriculum_id,
    year_level_id,
    semester_id,
    course_id,
    lec_fee,
    lab_fee,
    iscomputer_lab,
    islaboratory_fee,
    is_nstp,
  } = req.body;

  try {
    const [existing] = await db3.query(
      `SELECT program_tagging_id
       FROM program_tagging_table
       WHERE curriculum_id = ?
         AND year_level_id = ?
         AND semester_id = ?
         AND course_id = ?`,
      [curriculum_id, year_level_id, semester_id, course_id],
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: "Program tag already exists" });
    }


    const tosf = await getLatestTosf();

    let amount = 0;
    if (Number(iscomputer_lab) === 1) amount = Number(tosf.computer_fees);
    else if (Number(islaboratory_fee) === 1) amount = Number(tosf.laboratory_fees);
    else if (Number(is_nstp) === 1) amount = Number(tosf.nstp_fees);

    const [result] = await db3.query(
      `INSERT INTO program_tagging_table (
        curriculum_id,
        year_level_id,
        semester_id,
        course_id,
        lec_fee,
        lab_fee,
        iscomputer_lab,
        islaboratory_fee,
        is_nstp,
        amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        curriculum_id,
        year_level_id,
        semester_id,
        course_id,
        Number(lec_fee) || 0,
        Number(lab_fee) || 0,
        Number(iscomputer_lab) || 0,
        Number(islaboratory_fee) || 0,
        Number(is_nstp) || 0,
        amount
      ]
    );


    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const tagLabel = await getProgramTaggingLabel(result.insertId);

    await insertProgramTaggingAuditLog({
      req,
      action: "PROGRAM_TAGGING_CREATE",
      message: `${roleLabel} (${actorId}) tagged course ${tagLabel}.`,
    });

    res.status(201).json({
      insertId: result.insertId,
      amount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.put("/program_tagging/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const {
    curriculum_id,
    year_level_id,
    semester_id,
    course_id,
    lec_fee,
    lab_fee,
    iscomputer_lab,
    islaboratory_fee,
    is_nstp,
  } = req.body;

  try {
    const tagBefore = await getProgramTaggingLabel(id);

    const tosf = await getLatestTosf();

    let amount = 0;
    if (Number(iscomputer_lab) === 1) amount = Number(tosf.computer_fees);
    else if (Number(islaboratory_fee) === 1) amount = Number(tosf.laboratory_fees);
    else if (Number(is_nstp) === 1) amount = Number(tosf.nstp_fees);

    const [result] = await db3.query(
      `UPDATE program_tagging_table
       SET curriculum_id = ?,
           year_level_id = ?,
           semester_id = ?,
           course_id = ?,
           lec_fee = ?,
           lab_fee = ?,
           iscomputer_lab = ?,
           islaboratory_fee = ?,
           is_nstp = ?,
           amount = ?
       WHERE program_tagging_id = ?`,
      [
        curriculum_id,
        year_level_id,
        semester_id,
        course_id,
        Number(lec_fee) || 0,
        Number(lab_fee) || 0,
        Number(iscomputer_lab) || 0,
        Number(islaboratory_fee) || 0,
        Number(is_nstp) || 0,
        amount,
        id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Program tag not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const tagAfter = await getProgramTaggingLabel(id);

    await insertProgramTaggingAuditLog({
      req,
      action: "PROGRAM_TAGGING_UPDATE",
      message: `${roleLabel} (${actorId}) updated tagged course from ${tagBefore} to ${tagAfter}.`,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/program_tagging/:id(\\d+)", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const tagBefore = await getProgramTaggingLabel(id);
    const query =
      "DELETE FROM program_tagging_table WHERE program_tagging_id = ?";
    const [result] = await db3.query(query, [id]);

    if (result.affectedRows === 0)
      return res.status(404).json({ error: "Program tag not found" });

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);

    await insertProgramTaggingAuditLog({
      req,
      action: "PROGRAM_TAGGING_DELETE",
      message: `${roleLabel} (${actorId}) deleted tagged course ${tagBefore}.`,
    });

    res.status(200).json({ message: "Program tag deleted successfully" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to delete program tag", details: err.message });
  }
});

router.delete("/program_tagging/delete_all", CanDelete, async (req, res) => {
  const { curriculum_id, year_level_id, semester_id } = req.body;

  if (!curriculum_id || !year_level_id || !semester_id) {
    return res.status(400).json({
      error: "curriculum_id, year_level_id, and semester_id are required",
    });
  }

  try {
    const filterLabel = await getProgramTaggingFilterLabel({
      curriculum_id,
      year_level_id,
      semester_id,
    });

    const [result] = await db3.query(
      `
      DELETE FROM program_tagging_table
      WHERE curriculum_id = ?
        AND year_level_id = ?
        AND semester_id = ?
      `,
      [curriculum_id, year_level_id, semester_id],
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);

    if (result.affectedRows > 0) {
      await insertProgramTaggingAuditLog({
        req,
        action: "PROGRAM_TAGGING_DELETE_ALL",
        message: `${roleLabel} (${actorId}) deleted ${result.affectedRows} tagged course(s) under ${filterLabel}.`,
      });
    }

    res.status(200).json({
      message: "Matching program tags deleted successfully",
      deletedCount: result.affectedRows,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to delete matching program tags",
      details: err.message,
    });
  }
});

module.exports = router;