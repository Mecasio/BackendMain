const FEE_LINE_SELECT = `
  SELECT
    ufl.id,
    ufl.unifast_id,
    ufl.fee_rate_id,
    ufl.amount,
    fr.fee_id,
    fc.fee_code,
    fc.fee_name,
    fc.fee_category,
    fc.sort_order,
    fc.fee_group,
    fc.account_type
  FROM unifast_fee_lines ufl
  INNER JOIN fee_rate fr ON fr.fee_rate_id = ufl.fee_rate_id
  INNER JOIN fee_catalog fc ON fc.fee_id = fr.fee_id
`;

const getUnifastFeeLines = async (db, unifastId) => {
  const [rows] = await db.query(
    `${FEE_LINE_SELECT}
     WHERE ufl.unifast_id = ?
     ORDER BY fc.sort_order ASC, fc.fee_name ASC`,
    [unifastId]
  );
  return rows;
};

module.exports = {
  FEE_LINE_SELECT,
  getUnifastFeeLines,
};