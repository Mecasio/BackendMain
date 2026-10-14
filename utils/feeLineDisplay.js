const { isNstpCatalogFee } = require("./feeNormalization");
const { computeGlobalBalance } = require("./matriculationPayment");

const amountOf = (line) => Number(line?.amount || 0);

const isNstpLine = (line) =>
  Boolean(line?.is_nstp_fee) || isNstpCatalogFee(line);

const findLineAmount = (feeLines, matcher) => {
  const line = feeLines.find((item) => matcher(item));
  return amountOf(line);
};

const sumFeeLineAmounts = (feeLines = []) =>
  feeLines.reduce((sum, line) => sum + amountOf(line), 0);

const deriveFeeBreakdownFromLines = (feeLines = []) => {
  const nstp_fees = feeLines
    .filter(isNstpLine)
    .reduce((sum, line) => sum + amountOf(line), 0);

  const total_misc = feeLines
    .filter((line) => {
      const category = Number(line.fee_category);
      return (category === 3 || category === 5) && !isNstpLine(line);
    })
    .reduce((sum, line) => sum + amountOf(line), 0);

  return {
    nstp_fees,
    total_misc,
    athletic_fees: findLineAmount(feeLines, (item) =>
      String(item.fee_code || "").toUpperCase().includes("ATHLETIC")
    ),
    computer_fees: findLineAmount(feeLines, (item) =>
      String(item.fee_code || "").toUpperCase().includes("COMPUTER")
    ),
    cultural_fees: findLineAmount(feeLines, (item) =>
      String(item.fee_code || "").toUpperCase().includes("CULTURAL")
    ),
    development_fees: findLineAmount(feeLines, (item) =>
      String(item.fee_code || "").toUpperCase().includes("DEVELOPMENT")
    ),
    guidance_fees: findLineAmount(feeLines, (item) =>
      String(item.fee_code || "").toUpperCase().includes("GUIDANCE")
    ),
    laboratory_fees: findLineAmount(feeLines, (item) =>
      String(item.fee_code || "").toUpperCase().includes("LAB")
    ),
    library_fees: findLineAmount(feeLines, (item) =>
      String(item.fee_code || "").toUpperCase().includes("LIBRARY")
    ),
    medical_and_dental_fees: findLineAmount(feeLines, (item) =>
      String(item.fee_code || "").toUpperCase().includes("MEDICAL")
    ),
    registration_fees: findLineAmount(feeLines, (item) =>
      String(item.fee_code || "").toUpperCase().includes("REGISTRATION")
    ),
    school_id_fees: findLineAmount(feeLines, (item) =>
      String(item.fee_code || "").toUpperCase().includes("SCHOOL")
    ),
  };
};

const enrichAssessmentRow = (row, fee_lines, paymentLine = null) => {
  const breakdown = deriveFeeBreakdownFromLines(fee_lines);
  const tuition_fees = Number(paymentLine?.tuition_fees || 0);
  const tuition_is_paid = Number(paymentLine?.tuition_is_paid) === 1;
  const tuition_paid_amount = Number(paymentLine?.tuition_paid_amount || 0);
  const total_tosf =
    Number(paymentLine?.total_tosf || 0) ||
    tuition_fees + sumFeeLineAmounts(fee_lines);
  const balance = computeGlobalBalance(
    fee_lines,
    tuition_fees,
    tuition_is_paid,
    tuition_paid_amount
  );
  const payment = Math.max(total_tosf - balance, 0);

  return {
    ...row,
    fee_lines,
    payment_line: paymentLine,
    tuition_fees,
    tuition_is_paid,
    tuition_paid_amount,
    total_tosf,
    payment,
    balance,
    ...breakdown,
    payment_status: balance <= 0 ? 1 : 0,
  };
};

module.exports = {
  deriveFeeBreakdownFromLines,
  enrichAssessmentRow,
  sumFeeLineAmounts,
  isNstpLine,
};