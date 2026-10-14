const normalizeFeeCode = (feeOrCode) =>
  String(feeOrCode?.fee_code ?? feeOrCode ?? "").trim().toUpperCase();

const normalizeFeeName = (feeOrLine) =>
  String(feeOrLine?.fee_name ?? "").trim().toUpperCase();

const normalizeCourseCode = (courseCode) =>
  String(courseCode ?? "").trim().toUpperCase();

const normalizeBooleanFlag = (value) =>
  Number(value) === 1 || value === true || Number(value) > 0;

const normalizeYearLevelId = (yearLevelId) => {
  const parsed = Number(yearLevelId);
  return Number.isFinite(parsed) ? parsed : null;
};

const isNstpCourseCode = (courseCode) =>
  normalizeCourseCode(courseCode).includes("NSTP");

const isNstpCatalogFee = (feeOrLine) => {
  const code = normalizeFeeCode(feeOrLine);
  const name = normalizeFeeName(feeOrLine);
  return code.includes("NSTP") || name.includes("NSTP");
};

const normalizeHasNstpSubject = ({
  nstpCount = 0,
  enrolled = [],
  hasNstpFlag = null,
} = {}) => {
  if (hasNstpFlag != null) {
    return normalizeBooleanFlag(hasNstpFlag);
  }
  if (normalizeBooleanFlag(nstpCount)) {
    return true;
  }
  return enrolled.some(
    (course) =>
      Number(course?.is_nstp) === 1 || isNstpCourseCode(course?.course_code),
  );
};

const normalizeIsFirstYear = (yearLevelId) =>
  normalizeYearLevelId(yearLevelId) === 1;

const shouldApplyNstpCatalogFee = ({
  hasNstpSubject,
  hasNstpFlag = null,
  nstpCount = 0,
  enrolled = [],
} = {}) =>
  normalizeHasNstpSubject({
    hasNstpFlag: hasNstpSubject ?? hasNstpFlag,
    nstpCount,
    enrolled,
  });

module.exports = {
  normalizeFeeCode,
  normalizeFeeName,
  normalizeCourseCode,
  normalizeBooleanFlag,
  normalizeYearLevelId,
  isNstpCourseCode,
  isNstpCatalogFee,
  normalizeHasNstpSubject,
  normalizeIsFirstYear,
  shouldApplyNstpCatalogFee,
};