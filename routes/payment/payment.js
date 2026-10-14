const express = require("express");
const {
  db,
  db3,
  ensureUnifastUnitColumns,
  ensureMatriculationUnitColumns,
} = require("../database/database");
const {
  logStudentHistoryFromRequest,
} = require("../../utils/studentHistoryLogger");
const { createUnifastPaymentLine } = require("../../utils/unifastPaymentLines");
const {
  upsertMatriculationAssessmentPaymentLine,
} = require("../../utils/matriculationPaymentLines");

const router = express.Router();

void ensureUnifastUnitColumns().catch((error) => {
  console.error("Error ensuring UNIFAST unit columns:", error);
});
void ensureMatriculationUnitColumns().catch((error) => {
  console.error("Error ensuring MATRICULATION unit columns:", error);
});

const normalizeFeeLines = (feeLines = []) =>
  Array.isArray(feeLines)
    ? feeLines
        .map((line) => ({
          fee_rate_id: Number(line?.fee_rate_id),
          amount: Number(line?.amount) || 0,
        }))
        .filter(
          (line) => Number.isFinite(line.fee_rate_id) && line.fee_rate_id > 0,
        )
    : [];

const round2 = (value) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const parseBranchList = (rawBranches) => {
  if (!rawBranches) return [];
  if (Array.isArray(rawBranches)) return rawBranches;
  try {
    const parsed = JSON.parse(rawBranches);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
};

const resolveBranchLabel = (branches, rawValue) => {
  const fallback = String(rawValue || "").trim();
  if (!fallback) return "";

  // If the client already sent a readable branch label, keep it as-is.
  if (Number.isNaN(Number(fallback))) {
    return fallback;
  }

  const numericId = Number(fallback);
  if (!Number.isFinite(numericId)) {
    return fallback;
  }

  const matched = branches.find(
    (branch) =>
      String(branch?.id) === String(numericId) ||
      String(branch?.branch_id) === String(numericId),
  );

  return String(
    matched?.branch || matched?.branch_name || matched?.name || fallback,
  ).trim();
};

const getCampusLabelByStudentNumber = async (connection, studentNumber) => {
  if (!studentNumber || !String(studentNumber).trim()) return "";

  const [campusRows] = await connection.query(
    `SELECT pt.campus
     FROM student_numbering_table sn
     INNER JOIN person_table pt ON pt.person_id = sn.person_id
     WHERE sn.student_number = ?
     LIMIT 1`,
    [studentNumber],
  );

  const campusId = campusRows?.[0]?.campus;
  if (campusId === null || campusId === undefined || campusId === "") {
    return "";
  }

  const [settingsRows] = await db.query(
    "SELECT branches FROM company_settings WHERE id = 1 LIMIT 1",
  );
  const branches = parseBranchList(settingsRows?.[0]?.branches);
  return resolveBranchLabel(branches, campusId);
};

const normalizeYearLevelId = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.trunc(numeric);
  const parsed = Number.parseInt(String(value).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const getActiveSchoolYearScope = async (connection, activeSchoolYearId) => {
  if (!activeSchoolYearId) return null;

  const [rows] = await connection.query(
    `SELECT id, year_id, semester_id
     FROM active_school_year_table
     WHERE id = ?
     LIMIT 1`,
    [activeSchoolYearId],
  );

  return rows[0] || null;
};

const getScholarshipType = async (connection, scholarshipId) => {
  if (!scholarshipId) return null;

  const [rows] = await connection.query(
    `SELECT id, scholarship_name
     FROM scholarship_type
     WHERE id = ? AND scholarship_status = 1
     LIMIT 1`,
    [scholarshipId],
  );

  return rows[0] || null;
};

const getScholarshipFeeRules = async (
  connection,
  { scholarshipId, schoolYearId, semesterId, yearLevelId },
) => {
  if (!scholarshipId || !schoolYearId || !semesterId) return [];

  const normalizedYearLevelId = normalizeYearLevelId(yearLevelId) || 0;
  const [rows] = await connection.query(
    `SELECT
       sf.id,
       sf.fee_rate_id,
       sf.discount_type,
       sf.discount_value,
       sf.year_level_id
     FROM scholarship_fees sf
     LEFT JOIN fee_rate fr ON fr.fee_rate_id = sf.fee_rate_id
     WHERE sf.scholarship_id = ?
       AND sf.school_year_id = ?
       AND sf.semester_id = ?
       AND sf.status = 1
       AND (sf.fee_rate_id = 0 OR fr.is_active = 1)
       AND (sf.year_level_id = 0 OR sf.year_level_id IS NULL OR sf.year_level_id = ?)
     ORDER BY
       CASE
         WHEN sf.year_level_id = ? THEN 0
         WHEN sf.year_level_id = 0 OR sf.year_level_id IS NULL THEN 1
         ELSE 2
       END,
       sf.id DESC`,
    [
      scholarshipId,
      schoolYearId,
      semesterId,
      normalizedYearLevelId,
      normalizedYearLevelId,
    ],
  );

  return rows;
};

const getFeeRateMetaByIds = async (connection, feeRateIds = []) => {
  const uniqueIds = [
    ...new Set(
      feeRateIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  ];
  if (!uniqueIds.length) return new Map();

  const placeholders = uniqueIds.map(() => "?").join(",");
  const [rows] = await connection.query(
    `SELECT
       fr.fee_rate_id,
       fc.fee_category,
       fc.fee_code,
       fc.fee_name
     FROM fee_rate fr
     INNER JOIN fee_catalog fc ON fc.fee_id = fr.fee_id
     WHERE fr.fee_rate_id IN (${placeholders})`,
    uniqueIds,
  );

  return new Map(rows.map((row) => [String(row.fee_rate_id), row]));
};

const applyDiscountToAmount = (amount, rule) => {
  const baseAmount = round2(amount);
  if (!rule) return baseAmount;

  const discountType = Number(rule.discount_type);
  const discountValue = Number(rule.discount_value || 0);

  let nextAmount = baseAmount;
  if (discountType === 0) {
    nextAmount = 0;
  } else if (discountType === 1) {
    nextAmount = baseAmount - baseAmount * (discountValue / 100);
  } else if (discountType === 2) {
    nextAmount = baseAmount - discountValue;
  }

  return round2(Math.max(nextAmount, 0));
};

const getScholarshipRuleForFeeRate = (scholarshipRules, feeRateId) =>
  (Array.isArray(scholarshipRules) ? scholarshipRules : []).find(
    (rule) => String(rule.fee_rate_id) === String(feeRateId),
  ) || null;

const isTuitionMeta = (meta) => Number(meta?.fee_category) === 2;
const isNstpMeta = (meta) =>
  String(meta?.fee_code || "")
    .toUpperCase()
    .includes("NSTP");

const applyScholarshipRulesToFeeLines = (
  feeLines,
  feeMetaMap,
  scholarshipRules,
) => {
  const ruleByFeeRate = new Map();
  for (const rule of scholarshipRules) {
    const key = String(rule.fee_rate_id);
    if (!ruleByFeeRate.has(key)) {
      ruleByFeeRate.set(key, rule);
    }
  }

  const adjustedLines = [];
  let tuitionFees = 0;
  let totalMisc = 0;
  let totalNstp = 0;

  for (const line of normalizeFeeLines(feeLines)) {
    const meta = feeMetaMap.get(String(line.fee_rate_id));
    const rule = ruleByFeeRate.get(String(line.fee_rate_id));
    const adjustedAmount = applyDiscountToAmount(line.amount, rule);
    const adjustedLine = {
      fee_rate_id: line.fee_rate_id,
      amount: adjustedAmount,
    };

    adjustedLines.push(adjustedLine);

    if (isNstpMeta(meta)) {
      totalNstp += adjustedAmount;
    } else if (isTuitionMeta(meta)) {
      tuitionFees += adjustedAmount;
    } else {
      totalMisc += adjustedAmount;
    }
  }

  const totalTosf = round2(tuitionFees + totalNstp + totalMisc);

  return {
    adjustedLines,
    tuitionFees: round2(tuitionFees),
    totalMisc: round2(totalMisc),
    totalNstp: round2(totalNstp),
    totalTosf,
    matchedRules: ruleByFeeRate.size,
  };
};

const insertFeeLines = async (
  connection,
  tableName,
  idColumn,
  ownerId,
  feeLines,
  { requireFeeLines = false, label = "payment" } = {},
) => {
  const lines = normalizeFeeLines(feeLines);
  if (!lines.length) {
    if (requireFeeLines) {
      const error = new Error(
        `${label} fee lines were not generated. Save cancelled.`,
      );
      error.statusCode = 400;
      throw error;
    }
    return 0;
  }

  await connection.query(
    `INSERT INTO ${tableName} (${idColumn}, fee_rate_id, amount) VALUES ?`,
    [lines.map((line) => [ownerId, line.fee_rate_id, line.amount])],
  );

  return lines.length;
};

router.get("/payment-status/:studentNumber", async (req, res) => {
  const { studentNumber } = req.params;
  const requestedSchoolYearId = req.query.active_school_year_id;

  try {
    let activeSchoolYearId = requestedSchoolYearId;

    if (!activeSchoolYearId) {
      const [activeRows] = await db3.query(
        "SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1",
      );
      activeSchoolYearId = activeRows[0]?.id;
    }

    if (!activeSchoolYearId) {
      return res.json({
        success: true,
        saved_unifast: false,
        saved_matriculation: false,
      });
    }

    const [unifastRows] = await db3.query(
      "SELECT status FROM unifast WHERE student_number = ? AND status = 1 AND active_school_year_id = ? LIMIT 1",
      [studentNumber, activeSchoolYearId],
    );
    const [matricRows] = await db3.query(
      "SELECT status FROM matriculation WHERE student_number = ? AND status = 1 AND active_school_year_id = ? LIMIT 1",
      [studentNumber, activeSchoolYearId],
    );

    res.json({
      success: true,
      saved_unifast: unifastRows.length > 0,
      saved_matriculation: matricRows.length > 0,
      active_school_year_id: activeSchoolYearId,
    });
  } catch (error) {
    console.error("Error fetching payment status:", error);
    res.status(500).json({ message: "Server error while fetching status" });
  }
});

router.post("/save_to_unifast", async (req, res) => {
  const {
    campus_name,
    branch_name,
    branch,
    student_number,
    learner_reference_number,
    last_name,
    given_name,
    middle_initial,
    degree_program,
    year_level,
    sex,
    email_address,
    phone_number,
    tuition_fees,
    total_tosf,
    remark,
    laboratory_units,
    computer_units,
    academic_units_enrolled,
    academic_units_nstp_enrolled,
    active_school_year_id,
    status,
    fee_lines,
    require_fee_lines,
  } = req.body;

  try {
    if (!student_number || !String(student_number).trim()) {
      return res.status(400).json({
        message: "Student number is required before saving to UNIFAST.",
      });
    }

    const statusValue = Number.isFinite(Number(status)) ? Number(status) : 1;
    const strictFeeLines =
      Number(require_fee_lines) === 1 || require_fee_lines === true;
    const [unifastScholarships] = await db3.query(
      `SELECT id
       FROM scholarship_type
       WHERE UPPER(TRIM(scholarship_name)) LIKE '%UNIFAST%'
         AND scholarship_status = 1
       ORDER BY id ASC
       LIMIT 1`,
    );

    const unifastScholarshipId = unifastScholarships?.[0]?.id ?? null;
    if (!unifastScholarshipId) {
      return res.status(400).json({
        message:
          "Cannot save to UNIFAST because no active scholarship type containing 'UNIFAST' was found.",
      });
    }

    const connection = await db3.getConnection();
    let unifast_id;

    try {
      await connection.beginTransaction();

      const [settingsRows] = await db.query(
        "SELECT branches FROM company_settings WHERE id = 1 LIMIT 1",
      );
      const branches = parseBranchList(settingsRows?.[0]?.branches);
      const resolvedCampusName =
        (await getCampusLabelByStudentNumber(connection, student_number)) ||
        resolveBranchLabel(branches, branch_name || branch || campus_name);

      const query = `
        INSERT INTO unifast (
          campus_name, student_number, learner_reference_number, last_name, given_name, middle_initial,
          degree_program, year_level, sex, email_address, phone_number, scholarship_id,
          laboratory_units, computer_units, academic_units_enrolled, academic_units_nstp_enrolled,
          total_tosf, remark, active_school_year_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        resolvedCampusName,
        student_number,
        learner_reference_number || "No LRN Number",
        last_name,
        given_name,
        middle_initial || "",
        degree_program,
        year_level,
        sex,
        email_address || null,
        phone_number || null,
        unifastScholarshipId,
        Number(laboratory_units) || 0,
        Number(computer_units) || 0,
        Number(academic_units_enrolled) || 0,
        Number(academic_units_nstp_enrolled) || 0,
        total_tosf,
        remark || "UNIFAST",
        active_school_year_id,
        statusValue,
      ];

      const [result] = await connection.query(query, values);
      unifast_id = result.insertId;

      await insertFeeLines(
        connection,
        "unifast_fee_lines",
        "unifast_id",
        unifast_id,
        fee_lines,
        { requireFeeLines: strictFeeLines, label: "UNIFAST" },
      );
      await createUnifastPaymentLine(connection, {
        unifastId: unifast_id,
        tuitionFees: tuition_fees,
        totalTosf: total_tosf,
      });

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const studentName = [last_name, given_name, middle_initial]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" ");

    await logStudentHistoryFromRequest({
      req,
      studentNumber: student_number,
      action: "save_unifast",
      details: {
        student_name: studentName || "Unknown Student",
        payment_target: remark || "UNIFAST",
      },
    });

    res.json({
      success: true,
      unifast_id,
      message: "Data successfully saved to UNIFAST",
    });
  } catch (error) {
    console.error("Error saving to UNIFAST:", error);
    res.status(500).json({ message: "Server error while saving data" });
  }
});

router.post("/save_to_matriculation", async (req, res) => {
  const {
    campus_name,
    branch_name,
    branch,
    student_number,
    learner_reference_number,
    last_name,
    given_name,
    middle_initial,
    degree_program,
    year_level,
    sex,
    email_address,
    phone_number,
    tuition_fees,
    total_tosf,
    total_misc,
    scholarship_id,
    remark,
    matriculation_remark,
    laboratory_units,
    computer_units,
    academic_units_enrolled,
    academic_units_nstp_enrolled,
    active_school_year_id,
    status,
    fee_lines,
    require_fee_lines,
    year_level_id,
  } = req.body;

  try {
    if (!student_number || !String(student_number).trim()) {
      return res.status(400).json({
        message: "Student number is required before saving to MATRICULATION.",
      });
    }

    const statusValue = Number.isFinite(Number(status)) ? Number(status) : 1;
    const strictFeeLines =
      Number(require_fee_lines) === 1 || require_fee_lines === true;
    const normalizedScholarshipId = Number(scholarship_id);
    if (
      !Number.isFinite(normalizedScholarshipId) ||
      normalizedScholarshipId <= 0
    ) {
      return res.status(400).json({
        message: "scholarship_id is required before saving to MATRICULATION.",
      });
    }

    const connection = await db3.getConnection();
    let matriculation_id;
    let savedFees = null;
    let scholarshipRemark = "";

    try {
      const activeScope = await getActiveSchoolYearScope(
        connection,
        active_school_year_id,
      );
      if (!activeScope) {
        throw Object.assign(new Error("Active school year scope not found."), {
          statusCode: 400,
        });
      }

      const scholarship = await getScholarshipType(
        connection,
        normalizedScholarshipId,
      );
      if (!scholarship) {
        throw Object.assign(
          new Error("Selected scholarship type not found or inactive."),
          { statusCode: 400 },
        );
      }

      const [settingsRows] = await db.query(
        "SELECT branches FROM company_settings WHERE id = 1 LIMIT 1",
      );
      const branches = parseBranchList(settingsRows?.[0]?.branches);
      const resolvedCampusName =
        (await getCampusLabelByStudentNumber(connection, student_number)) ||
        resolveBranchLabel(branches, branch_name || branch || campus_name);

      const normalizedFeeLines = normalizeFeeLines(fee_lines);
      if (strictFeeLines && !normalizedFeeLines.length) {
        throw Object.assign(
          new Error(
            "Matriculation fee lines were not generated. Save cancelled.",
          ),
          { statusCode: 400 },
        );
      }

      const hasInputFeeLines = normalizedFeeLines.length > 0;
      const resolvedFees = hasInputFeeLines
        ? (() => {
            const feeMetaMapPromise = getFeeRateMetaByIds(
              connection,
              normalizedFeeLines.map((line) => line.fee_rate_id),
            );
            return feeMetaMapPromise.then(async (feeMetaMap) => {
              const scholarshipRules = await getScholarshipFeeRules(
                connection,
                {
                  scholarshipId: normalizedScholarshipId,
                  schoolYearId: activeScope.year_id,
                  semesterId: activeScope.semester_id,
                  yearLevelId: year_level_id || year_level,
                },
              );

              const applied = applyScholarshipRulesToFeeLines(
                normalizedFeeLines,
                feeMetaMap,
                scholarshipRules,
              );

              if (strictFeeLines && !applied.adjustedLines.length) {
                throw Object.assign(
                  new Error(
                    "Matriculation fee lines were not generated. Save cancelled.",
                  ),
                  { statusCode: 400 },
                );
              }

              return {
                ...applied,
                scholarshipRules,
              };
            });
          })()
        : Promise.resolve({
            adjustedLines: [],
            tuitionFees: round2(tuition_fees || 0),
            totalMisc: round2(total_misc || 0),
            totalNstp: 0,
            totalTosf: round2(total_tosf || 0),
            matchedRules: 0,
          });

      savedFees = await resolvedFees;
      const catalogTuitionFees = round2(savedFees?.tuitionFees || 0);
      const tuitionRule = hasInputFeeLines
        ? getScholarshipRuleForFeeRate(savedFees?.scholarshipRules, 0)
        : null;
      const resolvedTuitionFees = hasInputFeeLines
        ? applyDiscountToAmount(tuition_fees || 0, tuitionRule)
        : round2(tuition_fees || 0);
      savedFees = {
        ...savedFees,
        catalogTuitionFees,
        tuitionFees: resolvedTuitionFees,
        totalTosf: round2(
          resolvedTuitionFees +
            catalogTuitionFees +
            (savedFees?.totalMisc || 0) +
            (savedFees?.totalNstp || 0),
        ),
      };

      scholarshipRemark =
        matriculation_remark ||
        scholarship.scholarship_name ||
        remark ||
        "Matriculation";

      await connection.beginTransaction();

      const query = `
        INSERT INTO matriculation (
          campus_name, student_number, learner_reference_number, last_name, given_name, middle_initial,
          degree_program, year_level, sex, email_address, phone_number, scholarship_id,
          laboratory_units, computer_units, academic_units_enrolled, academic_units_nstp_enrolled,
          total_misc, total_tosf, remark, matriculation_remark, active_school_year_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        resolvedCampusName,
        student_number,
        learner_reference_number || "No LRN Number",
        last_name,
        given_name,
        middle_initial || "",
        degree_program,
        year_level,
        sex,
        email_address || null,
        phone_number || null,
        normalizedScholarshipId,
        Number(laboratory_units) || 0,
        Number(computer_units) || 0,
        Number(academic_units_enrolled) || 0,
        Number(academic_units_nstp_enrolled) || 0,
        savedFees.totalMisc,
        savedFees.totalTosf,
        remark || "Matriculation",
        scholarshipRemark,
        activeScope.id,
        statusValue,
      ];

      const [result] = await connection.query(query, values);
      matriculation_id = result.insertId;

      await connection.query(
        `INSERT INTO matriculation_fee_lines
         (matriculation_id, fee_rate_id, amount, is_paid, paid_amount)
         VALUES (?, 0, ?, 0, 0)`,
        [matriculation_id, round2(savedFees.tuitionFees || 0)],
      );

      await insertFeeLines(
        connection,
        "matriculation_fee_lines",
        "matriculation_id",
        matriculation_id,
        savedFees.adjustedLines,
        { requireFeeLines: strictFeeLines, label: "MATRICULATION" },
      );
      await upsertMatriculationAssessmentPaymentLine(connection, {
        matriculationId: matriculation_id,
        tuitionFees: savedFees.tuitionFees,
        totalTosf: savedFees.totalTosf,
      });

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const studentName = [last_name, given_name, middle_initial]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" ");

    await logStudentHistoryFromRequest({
      req,
      studentNumber: student_number,
      action: "save_matriculation",
      details: {
        student_name: studentName || "Unknown Student",
        payment_target: matriculation_remark || remark || "Matriculation",
      },
    });

    res.json({
      success: true,
      matriculation_id,
      total_misc: savedFees?.totalMisc ?? 0,
      total_tosf: savedFees?.totalTosf ?? 0,
      tuition_fees: savedFees?.tuitionFees ?? 0,
      message: "Data successfully saved to MATRICULATION",
    });
  } catch (error) {
    console.error("Error saving to MATRICULATION:", error);
    const statusCode = Number(error?.statusCode) || 500;
    res.status(statusCode).json({
      message: error?.message || "Server error while saving data",
    });
  }
});

module.exports = router;
