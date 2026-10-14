const express = require('express');
const multer = require("multer");
const { db, db3, ensureScholarshipTypeCodeColumn } = require('../database/database');
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");

const router = express.Router();

ensureScholarshipTypeCodeColumn().catch((err) => {
  console.error("Failed to ensure scholarship_type.scholarship_code column:", err);
});

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const insertTosfAuditLog = async ({ req, action, message }) => {
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

const FEE_CATEGORY = {
  TUITION: 2,
  MISCELLANEOUS: 3,
  OTHER: 5,
};

const normalizeAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : 0;
};

const normalizeTinyInt = (value, defaultValue) => {
  const n = Number(value);
  return Number.isInteger(n) ? n : defaultValue;
};

const normalizeNullableInt = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};

const normalizeFeeCatalogPayload = (body) => ({
  feeCode: String(body.fee_code || "").trim().toUpperCase(),
  feeName: String(body.fee_name || "").trim(),
  feeCategory: normalizeTinyInt(body.fee_category, FEE_CATEGORY.OTHER),
  isActive: normalizeTinyInt(body.is_active, 1) === 1 ? 1 : 0,
  sortOrder: Math.max(1, normalizeTinyInt(body.sort_order, 1)),
  feeGroup: normalizeNullableInt(body.fee_group),
  accountType: normalizeNullableInt(body.account_type),
});

const normalizeFeeRatePayload = (body) => {
  const appliesToAll = normalizeTinyInt(body.applies_to_all, 1) === 1 ? 1 : 0;
  const rawCurriculumIds = Array.isArray(body.dprtmnt_curriculum_ids)
    ? body.dprtmnt_curriculum_ids
    : (() => {
        if (Array.isArray(body.dprtmnt_curriculum_id)) return body.dprtmnt_curriculum_id;
        if (typeof body.dprtmnt_curriculum_id === "string") {
          try {
            const parsed = JSON.parse(body.dprtmnt_curriculum_id);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            // Keep legacy scalar curriculum IDs supported.
          }
        }
        return [body.dprtmnt_curriculum_id];
      })();
  const curriculumIds = rawCurriculumIds
    .map((value) => normalizeNullableInt(value))
    .filter((value, index, values) => value !== null && values.indexOf(value) === index);

  return {
    feeId: normalizeNullableInt(body.fee_id),
    dprtmntCurriculumId: appliesToAll ? null : JSON.stringify(curriculumIds),
    branchId: normalizeNullableInt(body.branch_id),
    amount: normalizeAmount(body.amount),
    appliedTo: normalizeNullableInt(body.applied_to) ?? 0,
    appliesToAll,
    isActive: normalizeTinyInt(body.is_active, 1) === 1 ? 1 : 0,
  };
};

const normalizeScholarshipFeePayload = (body) => {
  const rawDiscountType = normalizeTinyInt(body.discount_type, 0);
  const discountType = [0, 1, 2].includes(rawDiscountType) ? rawDiscountType : 0;

  return {
    scholarshipId: normalizeNullableInt(body.scholarship_id),
    feeRateId: normalizeNullableInt(body.fee_rate_id),
    discountType,
    discountValue: discountType === 0 ? null : normalizeNullableInt(body.discount_value),
    yearLevelId: normalizeNullableInt(body.year_level_id) ?? 0,
    schoolYearId: normalizeNullableInt(body.school_year_id),
    semesterId: normalizeNullableInt(body.semester_id),
    status: normalizeTinyInt(body.status, 1) === 1 ? 1 : 0,
  };
};

const findDuplicateFeeRate = async (conn, payload, excludeFeeRateId = null) => {
  const params = [
    payload.feeId,
    payload.appliedTo,
    payload.appliesToAll,
    payload.branchId,
  ];

  let sql = `
    SELECT fee_rate_id, dprtmnt_curriculum_id
    FROM fee_rate
    WHERE fee_id = ?
      AND applied_to = ?
      AND applies_to_all = ?
      AND (branch_id <=> ?)
  `;

  if (excludeFeeRateId) {
    sql += " AND fee_rate_id <> ?";
    params.push(excludeFeeRateId);
  }

  sql += " LIMIT 1";

  const [rows] = await conn.query(sql, params);
  const normalizeScope = (value) => {
    if (value == null || value === "") return null;
    try {
      const parsed = JSON.parse(String(value));
      return JSON.stringify((Array.isArray(parsed) ? parsed : [parsed]).map(Number).sort((a, b) => a - b));
    } catch {
      return JSON.stringify([Number(value)]);
    }
  };
  const expectedScope = payload.appliesToAll ? null : normalizeScope(payload.dprtmntCurriculumId);
  return rows.find((row) =>
    normalizeScope(row.dprtmnt_curriculum_id) === expectedScope &&
    (!excludeFeeRateId || Number(row.fee_rate_id) !== Number(excludeFeeRateId)),
  ) || null;
};

router.get("/scholarship_types", async (req, res) => {
  try {
    const [rows] = await db3.query(
      "SELECT id, scholarship_code, scholarship_name, rfd, tfd, mfd, nfd, afd, scholarship_status, created_at FROM scholarship_type ORDER BY id DESC"
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching scholarship types" });
  }
});

// Legacy flat TOSF row used by Certificate of Registration screens (expects an array; UI reads tosf[0]).
router.get("/tosf", async (req, res) => {
  try {
    const [rows] = await db3.query(`SELECT * FROM tosf LIMIT 1`);
    res.json(Array.isArray(rows) ? rows : []);
  } catch (error) {
    console.error("Error fetching tosf:", error);
    res.status(500).json({ message: "Server error while fetching TOSF" });
  }
});

router.post("/insert_scholarship_type", CanCreate, async (req, res) => {
  const { scholarship_code, scholarship_name, scholarship_status, created_at } = req.body;

  if (!scholarship_name || !String(scholarship_name).trim()) {
    return res.status(400).json({ message: "scholarship_name is required" });
  }

  try {
    const [maxRow] = await db3.query(
      "SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM scholarship_type"
    );
    const nextId = maxRow?.[0]?.next_id || 1;

    await db3.query(
      `INSERT INTO scholarship_type (
        id,
        scholarship_code,
        scholarship_name,
        scholarship_status,
        created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        nextId,
        scholarship_code == null ? "" : String(scholarship_code).trim(),
        String(scholarship_name).trim(),
        scholarship_status ?? 1,
        created_at ?? Math.floor(Date.now() / 1000),
      ]
    );

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "SCHOLARSHIP_TYPE_CREATE",
      message: `${roleLabel} (${actorId}) created scholarship type ${String(scholarship_name).trim()}.`,
    });

    res.json({ success: true, message: "Scholarship type inserted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while inserting scholarship type" });
  }
});

router.put("/update_scholarship_type/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { scholarship_code, scholarship_name, scholarship_status } = req.body;

  if (!scholarship_name || !String(scholarship_name).trim()) {
    return res.status(400).json({ message: "scholarship_name is required" });
  }

  try {
    const [result] = await db3.query(
      `UPDATE scholarship_type
       SET scholarship_code = ?, scholarship_name = ?, scholarship_status = ?
       WHERE id = ?`,
      [
        scholarship_code == null ? "" : String(scholarship_code).trim(),
        String(scholarship_name).trim(),
        scholarship_status ?? 1,
        id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Scholarship type not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "SCHOLARSHIP_TYPE_UPDATE",
      message: `${roleLabel} (${actorId}) updated scholarship type ${String(scholarship_name).trim()}.`,
    });

    res.json({ success: true, message: "Scholarship type updated successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while updating scholarship type" });
  }
});

router.delete("/delete_scholarship_type/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[scholarshipType]] = await db3.query(
      "SELECT scholarship_name FROM scholarship_type WHERE id = ? LIMIT 1",
      [id]
    );

    const [result] = await db3.query(
      "DELETE FROM scholarship_type WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Scholarship type not found" });
    }

    const scholarshipLabel = scholarshipType?.scholarship_name || `scholarship type ID ${id}`;
    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "SCHOLARSHIP_TYPE_DELETE",
      message: `${roleLabel} (${actorId}) deleted scholarship type ${scholarshipLabel}.`,
    });

    res.json({ success: true, message: "Scholarship type deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while deleting scholarship type" });
  }
});

// ================== SCHOLARSHIP FEES ==================

router.get("/tosf/scholarship-fee-options", async (req, res) => {
  try {
    const [yearLevels] = await db3.query(`
      SELECT year_level_id, year_level_description, level_type
      FROM year_level_table
      WHERE COALESCE(LOWER(level_type), 'year') <> 'special'
      ORDER BY year_level_id ASC
    `);

    const [schoolYears] = await db3.query(`
      SELECT DISTINCT
        year_id,
        year_description,
        year_description AS current_year,
        year_description + 1 AS next_year
      FROM year_table
      ORDER BY current_year ASC
    `);

    const [activeSchoolYears] = await db3.query(`
      SELECT
        asyt.id AS active_school_year_id,
        asyt.year_id,
        asyt.semester_id,
        asyt.astatus,
        yt.year_description,
        yt.year_description AS current_year,
        yt.year_description + 1 AS next_year,
        sem.semester_description
      FROM active_school_year_table AS asyt
      INNER JOIN year_table AS yt ON yt.year_id = asyt.year_id
      INNER JOIN semester_table AS sem ON sem.semester_id = asyt.semester_id
      WHERE asyt.astatus = 1
      ORDER BY asyt.id DESC
      LIMIT 1
    `);

    const [years] = await db3.query(`
      SELECT year_id, year_description
      FROM year_table
      ORDER BY year_id DESC
    `);

    const [semesters] = await db3.query(`
      SELECT semester_id, semester_description
      FROM semester_table
      ORDER BY semester_id ASC
    `);

    res.json({ yearLevels, schoolYears, activeSchoolYear: activeSchoolYears[0] || null, years, semesters });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching scholarship fee options" });
  }
});

router.get("/tosf/scholarship-fees", async (req, res) => {
  try {
    const scholarshipId = req.query?.scholarship_id;
    if (!scholarshipId) {
      return res.status(400).json({ message: "scholarship_id is required" });
    }

    const [rows] = await db3.query(
      `SELECT
        sf.*,
        st.scholarship_name,
        CASE WHEN sf.fee_rate_id = 0 THEN 'TUITION' ELSE fc.fee_code END AS fee_code,
        CASE WHEN sf.fee_rate_id = 0 THEN 'Computed Tuition' ELSE fc.fee_name END AS fee_name,
        CASE WHEN sf.fee_rate_id = 0 THEN 0 ELSE fr.amount END AS amount,
        ylt.year_level_description,
        sf.school_year_id AS year_id,
        yt.year_description,
        yt.year_description AS current_year,
        yt.year_description + 1 AS next_year,
        sem.semester_description
       FROM scholarship_fees sf
       INNER JOIN scholarship_type st ON st.id = sf.scholarship_id
       LEFT JOIN fee_rate fr ON fr.fee_rate_id = sf.fee_rate_id
       LEFT JOIN fee_catalog fc ON fc.fee_id = fr.fee_id
       LEFT JOIN year_level_table ylt ON ylt.year_level_id = sf.year_level_id
       LEFT JOIN year_table yt ON yt.year_id = sf.school_year_id
       LEFT JOIN semester_table sem ON sem.semester_id = sf.semester_id
       WHERE sf.scholarship_id = ?
       ORDER BY sf.id DESC`,
      [scholarshipId]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching scholarship fees" });
  }
});

router.post("/tosf/scholarship-fees", CanCreate, async (req, res) => {
  const payload = normalizeScholarshipFeePayload(req.body || {});

  if (!payload.scholarshipId) {
    return res.status(400).json({ message: "scholarship_id is required" });
  }
  if (payload.feeRateId === null || payload.feeRateId === undefined) {
    return res.status(400).json({ message: "fee_rate_id is required" });
  }
  if (!payload.schoolYearId) {
    return res.status(400).json({ message: "school_year_id is required" });
  }
  if (!payload.semesterId) {
    return res.status(400).json({ message: "semester_id is required" });
  }

  try {
    const [result] = await db3.query(
      `INSERT INTO scholarship_fees
       (scholarship_id, fee_rate_id, discount_type, discount_value, year_level_id, school_year_id, semester_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.scholarshipId,
        payload.feeRateId,
        payload.discountType,
        payload.discountValue,
        payload.yearLevelId,
        payload.schoolYearId,
        payload.semesterId,
        payload.status,
      ]
    );

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "SCHOLARSHIP_FEE_CREATE",
      message: `${roleLabel} (${actorId}) created scholarship fee ${result.insertId} for scholarship_id ${payload.scholarshipId}.`,
    });

    res.json({ success: true, id: result.insertId, message: "Scholarship fee created successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while creating scholarship fee" });
  }
});

router.put("/tosf/scholarship-fees/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const payload = normalizeScholarshipFeePayload(req.body || {});

  if (!payload.scholarshipId) {
    return res.status(400).json({ message: "scholarship_id is required" });
  }
  if (payload.feeRateId === null || payload.feeRateId === undefined) {
    return res.status(400).json({ message: "fee_rate_id is required" });
  }
  if (!payload.schoolYearId) {
    return res.status(400).json({ message: "school_year_id is required" });
  }
  if (!payload.semesterId) {
    return res.status(400).json({ message: "semester_id is required" });
  }

  try {
    const [result] = await db3.query(
      `UPDATE scholarship_fees
       SET scholarship_id = ?,
           fee_rate_id = ?,
           discount_type = ?,
           discount_value = ?,
           year_level_id = ?,
           school_year_id = ?,
           semester_id = ?,
           status = ?
       WHERE id = ?`,
      [
        payload.scholarshipId,
        payload.feeRateId,
        payload.discountType,
        payload.discountValue,
        payload.yearLevelId,
        payload.schoolYearId,
        payload.semesterId,
        payload.status,
        Number(id),
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Scholarship fee not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "SCHOLARSHIP_FEE_UPDATE",
      message: `${roleLabel} (${actorId}) updated scholarship fee ${id}.`,
    });

    res.json({ success: true, message: "Scholarship fee updated successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while updating scholarship fee" });
  }
});

router.delete("/tosf/scholarship-fees/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[scholarshipFee]] = await db3.query(
      `SELECT id, scholarship_id FROM scholarship_fees WHERE id = ? LIMIT 1`,
      [id]
    );

    const [result] = await db3.query(
      `DELETE FROM scholarship_fees WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Scholarship fee not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "SCHOLARSHIP_FEE_DELETE",
      message: `${roleLabel} (${actorId}) deleted scholarship fee ${id} (scholarship_id ${scholarshipFee?.scholarship_id ?? "unknown"}).`,
    });

    res.json({ success: true, message: "Scholarship fee deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while deleting scholarship fee" });
  }
});

router.get("/tosf/fee-options", async (req, res) => {
  try {
    const [curricula] = await db3.query(`
      SELECT
        dc.dprtmnt_curriculum_id,
        dc.dprtmnt_id,
        d.dprtmnt_name,
        dc.curriculum_id,
        c.lock_status,
        c.year_id,
        y.year_description,
        p.program_id,
        p.program_code,
        p.program_description,
        p.major
      FROM dprtmnt_curriculum_table dc
      INNER JOIN dprtmnt_table d ON d.dprtmnt_id = dc.dprtmnt_id
      INNER JOIN curriculum_table c
        ON c.curriculum_id = dc.curriculum_id
       AND c.lock_status = 1
      INNER JOIN year_table y ON y.year_id = c.year_id
      INNER JOIN program_table p ON p.program_id = c.program_id
      ORDER BY d.dprtmnt_name, p.program_code, y.year_description
    `);

    const [yearLevels] = await db3.query(`
      SELECT year_level_id, year_level_description, level_type
      FROM year_level_table
      WHERE COALESCE(LOWER(level_type), 'year') <> 'special'
      ORDER BY year_level_id ASC
    `);

    res.json({
      categories: FEE_CATEGORY,
      yearLevels,
      curricula,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching fee options" });
  }
});

router.get("/tosf/fee-catalog", async (req, res) => {
  try {
    const [rows] = await db3.query(
      `SELECT
        fc.*,
        COALESCE(rate_counts.rate_count, 0) AS rate_count,
        fg.description AS fee_group_description,
        at.description AS account_type_description
       FROM fee_catalog fc
       LEFT JOIN fee_group fg ON fg.id = fc.fee_group
       LEFT JOIN account_type at ON at.id = fc.account_type
       LEFT JOIN (
        SELECT fee_id, COUNT(*) AS rate_count
        FROM fee_rate
        GROUP BY fee_id
       ) rate_counts ON rate_counts.fee_id = fc.fee_id
       ORDER BY fc.sort_order ASC, fc.fee_name ASC`
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching fee catalog" });
  }
});

router.post("/tosf/fee-catalog", CanCreate, async (req, res) => {
  const payload = normalizeFeeCatalogPayload(req.body);

  if (!payload.feeCode || !payload.feeName) {
    return res.status(400).json({ message: "fee_code and fee_name are required" });
  }
  if (payload.sortOrder < 1) {
    return res.status(400).json({ message: "sort_order must be 1 or greater" });
  }

  try {
    const [result] = await db3.query(
      `INSERT INTO fee_catalog
       (fee_code, fee_name, fee_category, is_active, sort_order, fee_group, account_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.feeCode,
        payload.feeName,
        payload.feeCategory,
        payload.isActive,
        payload.sortOrder,
        payload.feeGroup,
        payload.accountType,
      ]
    );

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "FEE_CATALOG_CREATE",
      message: `${roleLabel} (${actorId}) created fee ${payload.feeName} (${payload.feeCode}).`,
    });

    res.json({ success: true, fee_id: result.insertId, message: "Fee created successfully" });
  } catch (error) {
    console.error(error);
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Fee code already exists" });
    }
    res.status(500).json({ message: "Server error while creating fee" });
  }
});

router.put("/tosf/fee-catalog/:fee_id", CanEdit, async (req, res) => {
  const { fee_id } = req.params;
  const payload = normalizeFeeCatalogPayload(req.body);

  if (!payload.feeCode || !payload.feeName) {
    return res.status(400).json({ message: "fee_code and fee_name are required" });
  }
  if (payload.sortOrder < 1) {
    return res.status(400).json({ message: "sort_order must be 1 or greater" });
  }

  try {
    const [result] = await db3.query(
      `UPDATE fee_catalog
       SET fee_code = ?, fee_name = ?, fee_category = ?, is_active = ?, sort_order = ?, fee_group = ?, account_type = ?
       WHERE fee_id = ?`,
      [
        payload.feeCode,
        payload.feeName,
        payload.feeCategory,
        payload.isActive,
        payload.sortOrder,
        payload.feeGroup,
        payload.accountType,
        fee_id,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Fee not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "FEE_CATALOG_UPDATE",
      message: `${roleLabel} (${actorId}) updated fee ${payload.feeName} (${payload.feeCode}).`,
    });

    res.json({ success: true, message: "Fee updated successfully" });
  } catch (error) {
    console.error(error);
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Fee code already exists" });
    }
    res.status(500).json({ message: "Server error while updating fee" });
  }
});

router.delete("/tosf/fee-catalog/:fee_id", CanDelete, async (req, res) => {
  const { fee_id } = req.params;
  let conn;

  try {
    conn = await db3.getConnection();
    await conn.beginTransaction();

    const [[fee]] = await conn.query(
      "SELECT fee_code, fee_name FROM fee_catalog WHERE fee_id = ? LIMIT 1",
      [fee_id]
    );

    if (!fee) {
      await conn.rollback();
      return res.status(404).json({ message: "Fee not found" });
    }

    await conn.query("DELETE FROM fee_rate WHERE fee_id = ?", [fee_id]);
    await conn.query("DELETE FROM fee_catalog WHERE fee_id = ?", [fee_id]);
    await conn.commit();

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "FEE_CATALOG_DELETE",
      message: `${roleLabel} (${actorId}) deleted fee ${fee.fee_name} (${fee.fee_code}) and its rates.`,
    });

    res.json({ success: true, message: "Fee deleted successfully" });
  } catch (error) {
    if (conn) await conn.rollback();
    console.error(error);
    res.status(500).json({ message: "Server error while deleting fee" });
  } finally {
    if (conn) conn.release();
  }
});

router.get("/tosf/fee-rates", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT
        fr.*,
        fc.fee_code,
        fc.fee_name,
        fc.fee_category,
        fc.sort_order,
        d.dprtmnt_name,
        p.program_code,
        p.program_description,
        p.major,
        y.year_description
      FROM fee_rate fr
      INNER JOIN fee_catalog fc ON fc.fee_id = fr.fee_id
      LEFT JOIN dprtmnt_curriculum_table dc ON dc.dprtmnt_curriculum_id = fr.dprtmnt_curriculum_id
      LEFT JOIN dprtmnt_table d ON d.dprtmnt_id = dc.dprtmnt_id
      LEFT JOIN curriculum_table c ON c.curriculum_id = dc.curriculum_id
      LEFT JOIN year_table y ON y.year_id = c.year_id
      LEFT JOIN program_table p ON p.program_id = c.program_id
      ORDER BY fc.sort_order ASC, fc.fee_name ASC, fr.fee_rate_id DESC
    `);

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching fee rates" });
  }
});

router.post("/tosf/fee-rates", CanCreate, async (req, res) => {
  const payload = normalizeFeeRatePayload(req.body);

  if (!payload.feeId) {
    return res.status(400).json({ message: "fee_id is required" });
  }

  if (!payload.appliesToAll && payload.dprtmntCurriculumId === "[]") {
    return res.status(400).json({ message: "dprtmnt_curriculum_id is required unless applies_to_all is enabled" });
  }

  try {
    const duplicate = await findDuplicateFeeRate(db3, payload);
    if (duplicate) {
      return res.status(409).json({
        message: "A fee rate with the same fee, curriculum scope, branch, and year level already exists.",
      });
    }

    const [result] = await db3.query(
      `INSERT INTO fee_rate
       (fee_id, dprtmnt_curriculum_id, branch_id, amount, applied_to, applies_to_all, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.feeId,
        payload.dprtmntCurriculumId,
        payload.branchId,
        payload.amount,
        payload.appliedTo,
        payload.appliesToAll,
        payload.isActive,
      ],
    );

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "FEE_RATE_CREATE",
      message: `${roleLabel} (${actorId}) created fee rate ${result.insertId}.`,
    });

    res.json({ success: true, fee_rate_id: result.insertId, message: "Fee rate created successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while creating fee rate" });
  }
});

router.put("/tosf/fee-rates/:fee_rate_id", CanEdit, async (req, res) => {
  const { fee_rate_id } = req.params;
  const payload = normalizeFeeRatePayload(req.body);

  if (!payload.feeId) {
    return res.status(400).json({ message: "fee_id is required" });
  }

  if (!payload.appliesToAll && payload.dprtmntCurriculumId === "[]") {
    return res.status(400).json({ message: "dprtmnt_curriculum_id is required unless applies_to_all is enabled" });
  }

  try {
    const duplicate = await findDuplicateFeeRate(db3, payload, Number(fee_rate_id));
    if (duplicate) {
      return res.status(409).json({
        message: "A fee rate with the same fee, curriculum scope, branch, and year level already exists.",
      });
    }

    const [result] = await db3.query(
      `UPDATE fee_rate
       SET fee_id = ?, dprtmnt_curriculum_id = ?, branch_id = ?, amount = ?,
           applied_to = ?, applies_to_all = ?, is_active = ?
       WHERE fee_rate_id = ?`,
      [
        payload.feeId,
        payload.dprtmntCurriculumId,
        payload.branchId,
        payload.amount,
        payload.appliedTo,
        payload.appliesToAll,
        payload.isActive,
        fee_rate_id,
      ],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Fee rate not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "FEE_RATE_UPDATE",
      message: `${roleLabel} (${actorId}) updated fee rate ${fee_rate_id}.`,
    });

    res.json({ success: true, message: "Fee rate updated successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while updating fee rate" });
  }
});

router.delete("/tosf/fee-rates/:fee_rate_id", CanDelete, async (req, res) => {
  const { fee_rate_id } = req.params;

  try {
    const [result] = await db3.query(
      "DELETE FROM fee_rate WHERE fee_rate_id = ?",
      [fee_rate_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Fee rate not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "FEE_RATE_DELETE",
      message: `${roleLabel} (${actorId}) deleted fee rate ${fee_rate_id}.`,
    });

    res.json({ success: true, message: "Fee rate deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while deleting fee rate" });
  }
});

const normalizeDescription = (value) => String(value || "").trim().slice(0, 60);

router.get("/tosf/fee-groups", async (req, res) => {
  try {
    const [rows] = await db3.query(
      "SELECT id, description FROM fee_group ORDER BY description ASC"
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching fee groups" });
  }
});

router.post("/tosf/fee-groups", CanCreate, async (req, res) => {
  const description = normalizeDescription(req.body.description);

  if (!description) {
    return res.status(400).json({ message: "description is required" });
  }

  try {
    const [result] = await db3.query(
      "INSERT INTO fee_group (description) VALUES (?)",
      [description]
    );

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "FEE_GROUP_CREATE",
      message: `${roleLabel} (${actorId}) created fee group ${description}.`,
    });

    res.json({ success: true, id: result.insertId, message: "Fee group created successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while creating fee group" });
  }
});

router.put("/tosf/fee-groups/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const description = normalizeDescription(req.body.description);

  if (!description) {
    return res.status(400).json({ message: "description is required" });
  }

  try {
    const [result] = await db3.query(
      "UPDATE fee_group SET description = ? WHERE id = ?",
      [description, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Fee group not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "FEE_GROUP_UPDATE",
      message: `${roleLabel} (${actorId}) updated fee group ${description}.`,
    });

    res.json({ success: true, message: "Fee group updated successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while updating fee group" });
  }
});

router.delete("/tosf/fee-groups/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[feeGroup]] = await db3.query(
      "SELECT description FROM fee_group WHERE id = ? LIMIT 1",
      [id]
    );

    const [result] = await db3.query("DELETE FROM fee_group WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Fee group not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "FEE_GROUP_DELETE",
      message: `${roleLabel} (${actorId}) deleted fee group ${feeGroup?.description || id}.`,
    });

    res.json({ success: true, message: "Fee group deleted successfully" });
  } catch (error) {
    console.error(error);
    if (error.code === "ER_ROW_IS_REFERENCED_2") {
      return res.status(409).json({ message: "Cannot delete fee group because it is in use" });
    }
    res.status(500).json({ message: "Server error while deleting fee group" });
  }
});

router.get("/tosf/account-types", async (req, res) => {
  try {
    const [rows] = await db3.query(
      "SELECT id, description FROM account_type ORDER BY description ASC"
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching account types" });
  }
});

router.post("/tosf/account-types", CanCreate, async (req, res) => {
  const description = normalizeDescription(req.body.description);

  if (!description) {
    return res.status(400).json({ message: "description is required" });
  }

  try {
    const [result] = await db3.query(
      "INSERT INTO account_type (description) VALUES (?)",
      [description]
    );

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "ACCOUNT_TYPE_CREATE",
      message: `${roleLabel} (${actorId}) created account type ${description}.`,
    });

    res.json({ success: true, id: result.insertId, message: "Account type created successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while creating account type" });
  }
});

router.put("/tosf/account-types/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const description = normalizeDescription(req.body.description);

  if (!description) {
    return res.status(400).json({ message: "description is required" });
  }

  try {
    const [result] = await db3.query(
      "UPDATE account_type SET description = ? WHERE id = ?",
      [description, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Account type not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "ACCOUNT_TYPE_UPDATE",
      message: `${roleLabel} (${actorId}) updated account type ${description}.`,
    });

    res.json({ success: true, message: "Account type updated successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while updating account type" });
  }
});

router.delete("/tosf/account-types/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[accountType]] = await db3.query(
      "SELECT description FROM account_type WHERE id = ? LIMIT 1",
      [id]
    );

    const [result] = await db3.query("DELETE FROM account_type WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Account type not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertTosfAuditLog({
      req,
      action: "ACCOUNT_TYPE_DELETE",
      message: `${roleLabel} (${actorId}) deleted account type ${accountType?.description || id}.`,
    });

    res.json({ success: true, message: "Account type deleted successfully" });
  } catch (error) {
    console.error(error);
    if (error.code === "ER_ROW_IS_REFERENCED_2") {
      return res.status(409).json({ message: "Cannot delete account type because it is in use" });
    }
    res.status(500).json({ message: "Server error while deleting account type" });
  }
});

router.post("/tosf/resolve-fees", async (req, res) => {
  const { resolveFees } = require("../../utils/resolveFees");

  try {
    let dprtmntCurriculumId = req.body.dprtmnt_curriculum_id;
    if (
      (dprtmntCurriculumId == null || dprtmntCurriculumId === "") &&
      req.body.curriculum_id
    ) {
      const [curriculumRows] = await db3.query(
        `SELECT dprtmnt_curriculum_id
         FROM dprtmnt_curriculum_table
         WHERE curriculum_id = ?
         LIMIT 1`,
        [req.body.curriculum_id]
      );
      dprtmntCurriculumId = curriculumRows[0]?.dprtmnt_curriculum_id ?? null;
    }

    const context = {
      branch_id: req.body.branch_id,
      dprtmnt_curriculum_id: dprtmntCurriculumId,
      curriculum_id: req.body.curriculum_id,
      year_level_id: req.body.year_level_id,
      tuition_amount: req.body.tuition_amount,
      has_nstp: req.body.has_nstp,
      nstp_count: req.body.nstp_count,
      has_computer: req.body.has_computer,
      has_laboratory: req.body.has_laboratory,
      is_first_year_first_sem: req.body.is_first_year_first_sem,
    };

    const result = await resolveFees({ db: db3, context });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while resolving fees" });
  }
});

router.get("/tosf/matriculation/:matriculation_id/fee-lines", async (req, res) => {
  const {
    getMatriculationFeeLines,
    getMatriculationFeeLineTotals,
  } = require("../../utils/matriculationFeeLines");

  try {
    const { matriculation_id } = req.params;
    const feeLines = await getMatriculationFeeLines(db3, matriculation_id);
    const totals = getMatriculationFeeLineTotals(feeLines);

    res.json({
      fee_lines: feeLines,
      totals,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching matriculation fee lines" });
  }
});

module.exports = router;
