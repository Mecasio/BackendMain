const { computeGlobalBalance } = require("./matriculationPayment");

const PAYMENT_LINE_SELECT = `
  SELECT
    mpl.id,
    mpl.matriculation_id,
    mpl.transaction_id,
    mpl.tuition_fees,
    mpl.total_tosf,
    mpl.payment,
    mpl.balance,
    COALESCE(mpl.tuition_is_paid, 0) AS tuition_is_paid,
    COALESCE(mpl.tuition_paid_amount, 0) AS tuition_paid_amount,
    mpl.created_at,
    mpl.updated_at
  FROM matriculation_payment_lines mpl
`;

let paymentLineColumnsReady = false;

const ensurePaymentLineColumns = async (db) => {
  if (paymentLineColumnsReady) return;

  await db.query(`
    ALTER TABLE matriculation_payment_lines
      ADD COLUMN IF NOT EXISTS tuition_is_paid tinyint(1) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tuition_paid_amount decimal(10,2) NOT NULL DEFAULT 0
  `);

  paymentLineColumnsReady = true;
};

const getMatriculationPaymentLine = async (db, matriculationId) => {
  await ensurePaymentLineColumns(db);
  const [rows] = await db.query(
    `${PAYMENT_LINE_SELECT}
     WHERE mpl.matriculation_id = ?
     ORDER BY mpl.id ASC
     LIMIT 1`,
    [matriculationId]
  );
  return rows[0] || null;
};

const upsertMatriculationAssessmentPaymentLine = async (
  db,
  { matriculationId, tuitionFees, totalTosf }
) => {
  await ensurePaymentLineColumns(db);
  const tuition = Number(tuitionFees) || 0;
  const total = Number(totalTosf) || 0;
  const existing = await getMatriculationPaymentLine(db, matriculationId);

  if (existing) {
    await db.query(
      `UPDATE matriculation_payment_lines
       SET tuition_fees = ?, total_tosf = ?, balance = ?, payment = 0,
           transaction_id = NULL, tuition_is_paid = 0, tuition_paid_amount = 0
       WHERE id = ?`,
      [tuition, total, total, existing.id]
    );
    return getMatriculationPaymentLine(db, matriculationId);
  }

  const [result] = await db.query(
    `INSERT INTO matriculation_payment_lines
     (matriculation_id, transaction_id, tuition_fees, total_tosf, payment, balance, tuition_is_paid)
     VALUES (?, NULL, ?, ?, 0, ?, 0)`,
    [matriculationId, tuition, total, total]
  );

  const [rows] = await db.query(
    `${PAYMENT_LINE_SELECT} WHERE mpl.id = ?`,
    [result.insertId]
  );
  return rows[0] || null;
};

const recomputeMatriculationPaymentSummary = async (
  db,
  { matriculationId, feeLines = [] }
) => {
  const paymentLine = await getMatriculationPaymentLine(db, matriculationId);
  if (!paymentLine) {
    throw new Error("Matriculation payment summary not found.");
  }

  const tuitionIsPaid = Number(paymentLine.tuition_is_paid) === 1;
  const balance = computeGlobalBalance(
    feeLines,
    paymentLine.tuition_fees,
    tuitionIsPaid,
    paymentLine.tuition_paid_amount
  );
  const totalTosf = Number(paymentLine.total_tosf || 0);
  const payment = Math.max(totalTosf - balance, 0);

  await db.query(
    `UPDATE matriculation_payment_lines
     SET payment = ?, balance = ?
     WHERE id = ?`,
    [payment, balance, paymentLine.id]
  );

  return getMatriculationPaymentLine(db, matriculationId);
};

const applyMatriculationPayment = async (
  db,
  { matriculationId, transactionId, allocations = [], feeLines = [] }
) => {
  await ensurePaymentLineColumns(db);
  const paymentLine = await getMatriculationPaymentLine(db, matriculationId);
  if (!paymentLine) {
    throw new Error("Matriculation payment summary not found.");
  }

  const tuitionAllocation = (allocations || []).find((item) => item.is_tuition);
  const tuitionPaidNow = Number(tuitionAllocation?.paid_amount || 0);

  if (tuitionPaidNow > 0) {
    await db.query(
      `UPDATE matriculation_payment_lines
       SET tuition_paid_amount = COALESCE(tuition_paid_amount, 0) + ?,
           tuition_is_paid = CASE
             WHEN COALESCE(tuition_paid_amount, 0) + ? >= tuition_fees THEN 1
             ELSE 0
           END
       WHERE id = ?`,
      [tuitionPaidNow, tuitionPaidNow, paymentLine.id]
    );
  }

  const updatedPaymentLine = await recomputeMatriculationPaymentSummary(db, {
    matriculationId,
    feeLines,
  });

  if (transactionId != null) {
    await db.query(
      `UPDATE matriculation_payment_lines
       SET transaction_id = ?
       WHERE id = ?`,
      [transactionId, updatedPaymentLine.id]
    );
    return getMatriculationPaymentLine(db, matriculationId);
  }

  return updatedPaymentLine;
};

const hasMatriculationPayments = async (db, matriculationId) => {
  const paymentLine = await getMatriculationPaymentLine(db, matriculationId);
  return Number(paymentLine?.payment || 0) > 0;
};

const deleteMatriculationPaymentLine = async (db, matriculationId) => {
  await db.query(
    `DELETE FROM matriculation_payment_lines WHERE matriculation_id = ?`,
    [matriculationId]
  );
};

module.exports = {
  PAYMENT_LINE_SELECT,
  ensurePaymentLineColumns,
  getMatriculationPaymentLine,
  upsertMatriculationAssessmentPaymentLine,
  recomputeMatriculationPaymentSummary,
  applyMatriculationPayment,
  hasMatriculationPayments,
  deleteMatriculationPaymentLine,
};