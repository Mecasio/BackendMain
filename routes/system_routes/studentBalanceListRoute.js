const express = require("express");
const { db3 } = require("../database/database");
const { getMatriculationPaymentLine } = require("../../utils/matriculationPaymentLines");
const { getMatriculationFeeLines } = require("../../utils/matriculationFeeLines");

const router = express.Router();

router.get("/student-balance-terms", async (req, res) => {
  try {
    const [[currentTerm]] = await db3.query(
      `SELECT MAX(yt.year_description) AS current_year
       FROM active_school_year_table sy
       INNER JOIN year_table yt ON yt.year_id = sy.year_id
       WHERE sy.astatus = 1`,
    );

    const currentYear = Number(currentTerm?.current_year);
    if (!Number.isFinite(currentYear)) {
      return res.status(404).json({ message: "Current active school year not found." });
    }

    const [terms] = await db3.query(
      `SELECT
         sy.id,
         sy.id AS school_year_id,
         sy.year_id,
         sy.semester_id,
         sy.astatus,
         yt.year_description,
         yt.year_description + 1 AS next_year,
         st.semester_description
       FROM active_school_year_table sy
       INNER JOIN year_table yt ON yt.year_id = sy.year_id
       INNER JOIN semester_table st ON st.semester_id = sy.semester_id
       WHERE yt.year_description BETWEEN ? AND ?
       ORDER BY yt.year_description DESC, sy.semester_id ASC`,
      [currentYear - 10, currentYear],
    );

    return res.json(terms);
  } catch (error) {
    console.error("Error fetching student balance terms:", error);
    return res.status(500).json({ message: "Failed to fetch academic school years." });
  }
});

router.get("/student-balance-list", async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(25, Number.parseInt(req.query.limit, 10) || 100));
  const offset = (page - 1) * limit;
  const search = String(req.query.search || "").trim();
  const activeSchoolYearId = Number(req.query.active_school_year_id);

  if (!Number.isFinite(activeSchoolYearId) || activeSchoolYearId <= 0) {
    return res.status(400).json({ message: "active_school_year_id is required." });
  }

  const where = [
    "m.status = 1",
    "sst.enrolled_status = 1",
    "m.active_school_year_id = ?",
  ];
  const params = [activeSchoolYearId];

  if (search) {
    where.push(`(
      snt.student_number LIKE ? OR
      pt.first_name LIKE ? OR
      pt.middle_name LIKE ? OR
      pt.last_name LIKE ? OR
      CONCAT_WS(' ', pt.first_name, pt.middle_name, pt.last_name) LIKE ? OR
      pgt.program_code LIKE ? OR
      pgt.program_description LIKE ?
    )`);
    const value = `%${search}%`;
    params.push(value, value, value, value, value, value, value);
  }

  const fromSql = `
    FROM matriculation m
    INNER JOIN student_status_table sst
      ON sst.student_number = m.student_number
     AND sst.active_school_year_id = m.active_school_year_id
    INNER JOIN student_numbering_table snt
      ON snt.student_number = m.student_number
    INNER JOIN person_table pt ON pt.person_id = snt.person_id
    LEFT JOIN curriculum_table ct ON ct.curriculum_id = sst.active_curriculum
    LEFT JOIN program_table pgt ON pgt.program_id = ct.program_id
    LEFT JOIN year_level_table ylt ON ylt.year_level_id = sst.year_level_id
  `;
  const whereSql = `WHERE ${where.join(" AND ")}`;

  try {
    const [[countRow]] = await db3.query(
      `SELECT COUNT(DISTINCT m.id) AS total ${fromSql} ${whereSql}`,
      params,
    );

    const [rows] = await db3.query(
      `SELECT DISTINCT
        m.id AS matriculation_id,
        m.student_number,
        m.active_school_year_id,
        pt.first_name,
        pt.middle_name,
        pt.last_name,
        CONCAT_WS(' ', pt.first_name, pt.middle_name, pt.last_name) AS student_full_name,
        ct.curriculum_id,
        CONCAT_WS(' - ', pgt.program_code, pgt.program_description) AS curriculum,
        ylt.year_level_description AS year_level,
        COALESCE(m.total_tosf, 0) AS stored_total_fee,
        COALESCE(mpl.total_tosf, m.total_tosf, 0) AS total_fee,
        COALESCE(mpl.balance, 0) AS stored_balance
      ${fromSql}
      LEFT JOIN matriculation_payment_lines mpl ON mpl.matriculation_id = m.id
      ${whereSql}
      ORDER BY pt.last_name ASC, pt.first_name ASC, m.student_number ASC
      LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const data = await Promise.all(rows.map(async (row, index) => {
      const paymentLine = await getMatriculationPaymentLine(db3, row.matriculation_id);
      const feeLines = await getMatriculationFeeLines(db3, row.matriculation_id);
      const [[paymentRow]] = await db3.query(
        `SELECT
           COALESCE(SUM(tt.payment), 0) AS total_payment,
           COALESCE((SELECT tt2.payment
             FROM transaction_table tt2
             WHERE tt2.student_number = tt.student_number
               AND tt2.active_school_year_id = tt.active_school_year_id
               AND COALESCE(tt2.payment_status, 'PAID') <> 'VOID'
               AND COALESCE(tt2.receipt_status, 'PAID_NOT_PRINTED') <> 'VOID'
             ORDER BY tt2.created_at DESC, tt2.transaction_no DESC LIMIT 1), 0) AS last_payment
         FROM transaction_table tt
         WHERE tt.student_number = ?
           AND tt.active_school_year_id = ?
           AND COALESCE(tt.payment_status, 'PAID') <> 'VOID'
           AND COALESCE(tt.receipt_status, 'PAID_NOT_PRINTED') <> 'VOID'`,
        [row.student_number, row.active_school_year_id],
      );

      const totalFee = Number(paymentLine?.total_tosf ?? row.total_fee ?? 0);
      const totalPayment = Number(paymentRow?.total_payment || paymentLine?.payment || 0);
      const balance = Math.max(
        Number.isFinite(Number(paymentLine?.balance)) && Number(paymentLine?.balance) > 0
          ? Number(paymentLine.balance)
          : totalFee - totalPayment,
        0,
      );

      // Only return fees that still have an outstanding amount. The frontend
      // uses this list for the privilege-order payment breakdown.
      const feeBreakdown = feeLines
        .map((line, lineIndex) => {
          const feeAmount = Number(line.amount || 0);
          const paidAmount = Number(line.paid_amount || 0);
          const remainingAmount = Number(line.is_paid) === 1
            ? 0
            : Math.max(feeAmount - paidAmount, 0);

          return {
            priority: Number(line.is_tuition) === 1
              ? 0
              : Number.isFinite(Number(line.sort_order))
                ? Number(line.sort_order)
                : lineIndex,
            fee: line.fee_name || "Unnamed Fee",
            account_type_id: line.account_type ?? null,
            account_type_label: line.account_type_description || "Any",
            fee_amount: remainingAmount,
          };
        })
        .filter((line) => line.fee_amount > 0)
        .sort((a, b) => a.priority - b.priority);

      return {
        ...row,
        index: offset + index + 1,
        total_fee: totalFee,
        last_payment: Number(paymentRow?.last_payment || 0),
        balance,
        can_pay: balance > 0,
        fee_breakdown: feeBreakdown,
      };
    }));

    const total = Number(countRow?.total || 0);
    return res.json({
      data,
      total,
      page,
      limit,
      hasMore: offset + data.length < total,
      nextPage: offset + data.length < total ? page + 1 : null,
    });
  } catch (error) {
    console.error("Error fetching student balance list:", error);
    return res.status(500).json({ message: "Failed to fetch student balances." });
  }
});

module.exports = router;
