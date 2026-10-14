const PAYMENT_LINE_SELECT = `
  SELECT
    upl.id,
    upl.unifast_id,
    upl.transaction_id,
    upl.tuition_fees,
    upl.total_tosf,
    upl.payment,
    upl.balance,
    upl.created_at,
    upl.updated_at
  FROM unifast_payment_lines upl
`;

const getUnifastPaymentLine = async (db, unifastId) => {
  const [rows] = await db.query(
    `${PAYMENT_LINE_SELECT}
     WHERE upl.unifast_id = ?
     ORDER BY upl.id ASC
     LIMIT 1`,
    [unifastId]
  );
  return rows[0] || null;
};

const createUnifastPaymentLine = async (
  db,
  { unifastId, tuitionFees, totalTosf }
) => {
  const tuition = Number(tuitionFees) || 0;
  const total = Number(totalTosf) || 0;

  const [result] = await db.query(
    `INSERT INTO unifast_payment_lines
     (unifast_id, transaction_id, tuition_fees, total_tosf, payment, balance)
     VALUES (?, NULL, ?, ?, ?, 0)`,
    [unifastId, tuition, total, total]
  );

  const [rows] = await db.query(
    `${PAYMENT_LINE_SELECT} WHERE upl.id = ?`,
    [result.insertId]
  );
  return rows[0] || null;
};

module.exports = {
  PAYMENT_LINE_SELECT,
  getUnifastPaymentLine,
  createUnifastPaymentLine,
};