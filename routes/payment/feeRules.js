const express = require("express");
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

const insertFeeRuleAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    message,
    severity: "INFO",
  });
};

const getActorLabel = (req) => {
  const { actorId, actorRole } = getAuditActor(req);
  return {
    actorId,
    roleLabel: formatAuditActorRole(actorRole),
  };
};

router.get("/course/:courseId/all-fees", async (req, res) => {
  try {
    const [fees] = await db3.query(`
      SELECT fee_code, description, amount
      FROM fee_rules
      WHERE applies_to_all = 1
        AND fee_code IN (
          'COURSE_WITH_LAB_FEE',
          'COMPUTER_LABORATORY_FEE',
          'NSTP_SPECIAL_FEE'
        )
      ORDER BY fee_rule_id
    `);

    const total = fees.reduce((sum, f) => sum + Number(f.amount || 0), 0);

    res.json({
      breakdown: fees,
      total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to compute fees" });
  }
});

router.get("/coursepanel/fee_rules", async (req, res) => {
  try {
    const [rows] = await db3.query(`
    SELECT
  fee_rule_id,
  fee_code,
  description,
  amount,
  semester_id,
  year_level_id,
  dprtmnt_id,
  program_id,
  CAST(applies_to_all AS UNSIGNED) AS applies_to_all
FROM fee_rules;
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch course panel fees" });
  }
});

router.get("/fee_rules", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT
        fee_rule_id,
        fee_code,
        description,
        amount,
        applies_to_all,
        iscomputer_lab,
        isnon_computer_lab,
        is_nstp,
        semester_id,
        year_level_id,
        dprtmnt_id,
        program_id
      FROM fee_rules
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch fee rules" });
  }
});

router.post("/insert_fee_rule", CanCreate, async (req, res) => {
  const {
    fee_code,
    description,
    amount,
    applies_to_all,
    semester_id,
    year_level_id,
    dprtmnt_id,
    program_id,
  } = req.body;

  try {
    const [result] = await db3.query(
      `
      INSERT INTO fee_rules (
        fee_code,
        description,
        amount,
        applies_to_all,
        semester_id,
        year_level_id,
        dprtmnt_id,
        program_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        fee_code,
        description,
        amount,

        applies_to_all ? 1 : 0,
        applies_to_all ? null : semester_id || null,
        applies_to_all ? null : year_level_id || null,
        applies_to_all ? null : dprtmnt_id || null,
        applies_to_all ? null : program_id || null,
      ],
    );

    const { actorId, roleLabel } = getActorLabel(req);
    await insertFeeRuleAuditLog({
      req,
      action: "FEE_RULE_CREATE",
      message: `${roleLabel} (${actorId}) created fee rule ${fee_code || result.insertId}.`,
    });

    res.status(201).json({ message: "Fee rule inserted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to insert fee rule" });
  }
});

// =================== UPDATE an existing fee rule ===================
router.put("/update_fee_rule/:fee_rule_id", CanEdit, async (req, res) => {
  const { fee_rule_id } = req.params;
  const {
    description,
    amount,

    applies_to_all,
    semester_id,
    year_level_id,
    dprtmnt_id,
    program_id,
  } = req.body;

  try {
    const [result] = await db3.query(
      `
      UPDATE fee_rules
      SET
        description = ?,
        amount = ?,
        applies_to_all = ?,
        semester_id = ?,
        year_level_id = ?,
        dprtmnt_id = ?,
        program_id = ?
      WHERE fee_rule_id = ?
      `,
      [
        description,
        amount,
        applies_to_all ? 1 : 0,
        applies_to_all ? null : semester_id || null,
        applies_to_all ? null : year_level_id || null,
        applies_to_all ? null : dprtmnt_id || null,
        applies_to_all ? null : program_id || null,
        fee_rule_id,
      ],
    );

    if (result.affectedRows > 0) {
      const { actorId, roleLabel } = getActorLabel(req);
      await insertFeeRuleAuditLog({
        req,
        action: "FEE_RULE_UPDATE",
        message: `${roleLabel} (${actorId}) updated fee rule ${fee_rule_id}.`,
      });
    }

    res.json({
      message: "Fee rule updated",
      affectedRows: result.affectedRows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Update failed" });
  }
});

// =================== DELETE a fee rule ===================
router.delete("/delete_fee_rule/:fee_code", CanDelete, async (req, res) => {
  const { fee_code } = req.params;

  try {
    const [[feeRule]] = await db3.query(
      "SELECT fee_code, description FROM fee_rules WHERE fee_code = ? LIMIT 1",
      [fee_code],
    );

    const [result] = await db3.query(
      `DELETE FROM fee_rules WHERE fee_code = ?`,
      [fee_code],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Fee rule not found" });
    }

    const feeRuleLabel = feeRule?.description
      ? `${feeRule.fee_code} (${feeRule.description})`
      : fee_code;
    const { actorId, roleLabel } = getActorLabel(req);
    await insertFeeRuleAuditLog({
      req,
      action: "FEE_RULE_DELETE",
      message: `${roleLabel} (${actorId}) deleted fee rule ${feeRuleLabel}.`,
    });

    res.json({ message: "Fee rule deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete fee rule" });
  }
});

router.get("/misc_fee", async (req, res) => {
  const { year_level_id, semester_id, program_id, dprtmnt_id } = req.query;

  try {
    const [rows] = await db3.query(
      `
      SELECT fee_code, description, amount
      FROM fee_rules
      WHERE fee_code LIKE 'MISC%'
        AND year_level_id = ?
        AND semester_id = ?
        AND (program_id = ? OR program_id IS NULL)
        AND (dprtmnt_id = ? OR dprtmnt_id IS NULL)
      ORDER BY program_id DESC, dprtmnt_id DESC
      LIMIT 1
      `,
      [year_level_id, semester_id, program_id, dprtmnt_id],
    );

    res.json(rows[0] || null);
  } catch (err) {
    console.error("MISC FETCH ERROR:", err);
    res.status(500).json({ message: "Failed to fetch misc fee" });
  }
});

router.put("/misc_fee", async (req, res) => {
  const { amount, year_level_id, semester_id, program_id, dprtmnt_id } =
    req.body;

  try {
    const [result] = await db3.query(
      `
      UPDATE fee_rules
      SET amount = ?
      WHERE fee_code LIKE 'MISC%'
        AND year_level_id = ?
        AND semester_id = ?
        AND (program_id = ? OR program_id IS NULL)
        AND (dprtmnt_id = ? OR dprtmnt_id IS NULL)
      ORDER BY program_id DESC, dprtmnt_id DESC
      LIMIT 1
      `,
      [amount, year_level_id, semester_id, program_id, dprtmnt_id],
    );

    // ðŸ” DEBUG GUARD
    if (result.affectedRows === 0) {
      console.warn("âš ï¸ No MISC row updated", {
        year_level_id,
        semester_id,
        program_id,
        dprtmnt_id,
      });
    }

    if (result.affectedRows > 0) {
      const { actorId, roleLabel } = getActorLabel(req);
      await insertFeeRuleAuditLog({
        req,
        action: "MISC_FEE_UPDATE",
        message: `${roleLabel} (${actorId}) updated miscellaneous fee for year level ${year_level_id}, semester ${semester_id}.`,
      });
    }

    res.json({ success: true, affectedRows: result.affectedRows });
  } catch (err) {
    console.error("MISC UPDATE ERROR:", err);
    res.status(500).json({ message: "Failed to update misc fee" });
  }
});

router.get("/extra_fees", async (req, res) => {
  const { year_level_id, semester_id, dprtmnt_id, program_id } = req.query;

  try {
    const [rows] = await db3.query(
      `
      SELECT fee_rule_id, fee_code, description, amount
      FROM fee_rules
      WHERE (fee_code LIKE 'MISC%' OR fee_code = 'ID_FEE')
        AND (year_level_id = ? OR year_level_id IS NULL)
        AND (semester_id = ? OR semester_id IS NULL)
        AND (program_id = ? OR program_id IS NULL)
        AND (dprtmnt_id = ? OR dprtmnt_id IS NULL)
      ORDER BY
        program_id DESC,
        dprtmnt_id DESC,
        year_level_id DESC,
        semester_id DESC
      `,
      [year_level_id, semester_id, program_id, dprtmnt_id],
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch extra fees" });
  }
});


module.exports = router
