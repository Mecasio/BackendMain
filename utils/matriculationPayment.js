const { normalizeAmount } = require("./resolveFees");

const isLinePaid = (line) => Number(line?.is_paid) === 1;

const getLineRemaining = (line) => {
  if (isLinePaid(line)) return 0;
  const amount = normalizeAmount(line.amount);
  const paidAmount = normalizeAmount(line.paid_amount);
  return Math.max(normalizeAmount(amount - paidAmount), 0);
};

const isLineEligibleForAccountType = (line, accountTypeId) => {
  if (accountTypeId == null) return true;
  if (line.account_type == null) return true;
  return Number(line.account_type) === Number(accountTypeId);
};

const isTuitionLine = (line) =>
  Boolean(line?.is_tuition) ||
  Number(line?.fee_rate_id) === 0 ||
  String(line?.fee_code || "").toUpperCase() === "TUITION";

const sortFeeLines = (lines) =>
  [...lines].sort(
    (a, b) =>
      Number(a.sort_order) - Number(b.sort_order) ||
      String(a.fee_name || "").localeCompare(String(b.fee_name || ""))
  );

const getTuitionRemaining = (
  tuitionFees = 0,
  tuitionIsPaid = false,
  tuitionPaidAmount = 0
) => {
  if (tuitionIsPaid) return 0;
  return Math.max(
    normalizeAmount(tuitionFees) - normalizeAmount(tuitionPaidAmount),
    0
  );
};

const buildVirtualTuitionLine = (
  tuitionFees,
  tuitionIsPaid = false,
  tuitionPaidAmount = 0
) => {
  const remaining = getTuitionRemaining(
    tuitionFees,
    tuitionIsPaid,
    tuitionPaidAmount
  );
  if (remaining <= 0) return null;

  return {
    id: "tuition",
    fee_code: "TUITION",
    fee_name: "Tuition Fees",
    sort_order: 0,
    account_type: null,
    account_type_description: null,
    amount: normalizeAmount(tuitionFees),
    paid_amount: normalizeAmount(tuitionPaidAmount),
    is_paid: 0,
    is_tuition: true,
  };
};

const resolveTuitionLine = (
  feeLines = [],
  tuitionFees = 0,
  tuitionIsPaid = false,
  tuitionPaidAmount = 0
) => {
  const existing = feeLines.find(isTuitionLine);
  if (!existing) {
    return buildVirtualTuitionLine(
      tuitionFees,
      tuitionIsPaid,
      tuitionPaidAmount
    );
  }

  return {
    ...existing,
    id: existing.id ?? "tuition",
    fee_code: "TUITION",
    fee_name: existing.fee_name || "Tuition Fees",
    sort_order: 0,
    account_type: existing.account_type ?? null,
    account_type_description: existing.account_type_description ?? null,
    amount: normalizeAmount(existing.amount ?? tuitionFees),
    paid_amount: normalizeAmount(existing.paid_amount ?? tuitionPaidAmount),
    is_paid: Number(existing?.is_paid) === 1 || tuitionIsPaid ? 1 : 0,
    is_tuition: true,
    fee_rate_id: Number(existing?.fee_rate_id ?? 0),
  };
};

const getUnpaidLinesForCashier = (
  feeLines = [],
  accountTypeId = null,
  tuitionFees = 0,
  tuitionIsPaid = false,
  tuitionPaidAmount = 0
) => {
  const tuitionLine = resolveTuitionLine(
    feeLines,
    tuitionFees,
    tuitionIsPaid,
    tuitionPaidAmount
  );
  const catalogLines = (feeLines || []).filter(
    (line) =>
      !isTuitionLine(line) &&
      getLineRemaining(line) > 0 &&
      isLineEligibleForAccountType(line, accountTypeId)
  );

  return tuitionLine
    ? [tuitionLine, ...sortFeeLines(catalogLines)]
    : sortFeeLines(catalogLines);
};

const computeGlobalBalance = (
  feeLines = [],
  tuitionFees = 0,
  tuitionIsPaid = false,
  tuitionPaidAmount = 0
) => {
  const tuitionLine = resolveTuitionLine(
    feeLines,
    tuitionFees,
    tuitionIsPaid,
    tuitionPaidAmount
  );

  let balance = tuitionLine
    ? getLineRemaining(tuitionLine)
    : getTuitionRemaining(tuitionFees, tuitionIsPaid, tuitionPaidAmount);

  for (const line of feeLines) {
    if (isTuitionLine(line)) continue;
    balance += getLineRemaining(line);
  }
  return normalizeAmount(balance);
};

const computeScopedBalance = (
  feeLines = [],
  accountTypeId = null,
  tuitionFees = 0,
  tuitionIsPaid = false,
  tuitionPaidAmount = 0
) => {
  const lines = getUnpaidLinesForCashier(
    feeLines,
    accountTypeId,
    tuitionFees,
    tuitionIsPaid,
    tuitionPaidAmount
  );
  return normalizeAmount(
    lines.reduce((sum, line) => sum + getLineRemaining(line), 0)
  );
};

const buildLineBalances = (feeLines, accountTypeId = null) => {
  const tuitionLines = (feeLines || []).filter(
    (line) => isTuitionLine(line) && getLineRemaining(line) > 0
  );
  const catalogLines = (feeLines || []).filter(
    (line) =>
      !isTuitionLine(line) &&
      getLineRemaining(line) > 0 &&
      isLineEligibleForAccountType(line, accountTypeId)
  );
  const orderedLines = [...tuitionLines, ...sortFeeLines(catalogLines)];

  return orderedLines.map((line) => {
    const feeAmount = getLineRemaining(line);
    return {
      ...line,
      fee_amount: feeAmount,
      amount_paid: 0,
      balance: feeAmount,
    };
  });
};

const applyPaymentWaterfall = (
  feeLines,
  paymentInput,
  accountTypeId = null
) => {
  const totalPayment = normalizeAmount(paymentInput);
  let remaining = totalPayment;
  const linesWithBalance = buildLineBalances(feeLines, accountTypeId);
  const allocations = [];

  for (const [priority, line] of linesWithBalance.entries()) {
    const currentBalance = normalizeAmount(line.balance);
    const displayPriority = line?.is_tuition
      ? 0
      : Number.isFinite(Number(line.sort_order))
        ? Number(line.sort_order)
        : priority;
    const allocationBase = {
      priority: displayPriority,
      key: line.fee_code,
      label: line.fee_name,
      matriculation_fee_line_id: line.id,
      fee_code: line.fee_code,
      fee_name: line.fee_name,
      sort_order: line.sort_order,
      fee_amount: line.fee_amount,
      is_tuition: Boolean(line.is_tuition),
    };
    if (currentBalance <= 0) {
      allocations.push({
        ...allocationBase,
        paid_amount: 0,
        status: "skipped",
      });
      continue;
    }

    if (remaining <= 0) {
      allocations.push({
        ...allocationBase,
        paid_amount: 0,
        status: "unpaid",
      });
      continue;
    }

    const paidNow =
      remaining >= currentBalance ? currentBalance : normalizeAmount(remaining);
    remaining = normalizeAmount(remaining - paidNow);

    allocations.push({
      ...allocationBase,
      paid_amount: paidNow,
      status:
        paidNow >= currentBalance ? "paid" : paidNow > 0 ? "partial" : "unpaid",
    });
  }

  const appliedPayment = normalizeAmount(totalPayment - remaining);

  return {
    totalPayment,
    appliedPayment,
    allocations,
    paymentStatus: appliedPayment > 0 ? 1 : 0,
  };
};

module.exports = {
  applyPaymentWaterfall,
  buildLineBalances,
  buildVirtualTuitionLine,
  computeGlobalBalance,
  computeScopedBalance,
  getLineRemaining,
  getTuitionRemaining,
  getUnpaidLinesForCashier,
  isLineEligibleForAccountType,
  isLinePaid,
};
