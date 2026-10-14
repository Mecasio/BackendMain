const { db3 } = require("../routes/database/database");

let cachedGradeConversions = [];
let cacheExpiresAt = 0;

const GRADE_CONVERSION_CACHE_MS = 5 * 60 * 1000;

const normalizeEquivalentGrade = (value) => {
  if (value === null || value === undefined || value === "") return "";

  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return String(value).trim();
  }

  return numericValue.toFixed(2);
};

const getGradeConversions = async (forceRefresh = false) => {
  const now = Date.now();
  if (!forceRefresh && cacheExpiresAt > now && cachedGradeConversions.length) {
    return cachedGradeConversions;
  }

  // Dynamic grade conversion source shared by import/update APIs.
  const [rows] = await db3.query(
    `SELECT id, min_score, max_score, equivalent_grade, descriptive_rating, is_disqualified
     FROM grade_conversion
     ORDER BY max_score DESC, equivalent_grade ASC`,
  );

  cachedGradeConversions = rows;
  cacheExpiresAt = now + GRADE_CONVERSION_CACHE_MS;

  return rows;
};

const findConversionByEquivalent = (gradeConversions, equivalentGrade) => {
  const normalizedEquivalent = normalizeEquivalentGrade(equivalentGrade);

  return gradeConversions.find(
    (row) =>
      normalizeEquivalentGrade(row.equivalent_grade) === normalizedEquivalent,
  );
};

const findConversionByScore = (gradeConversions, score) => {
  const numericScore = Number(score);
  if (Number.isNaN(numericScore)) return null;

  return (
    gradeConversions.find((row) => {
      const minScore = Number(row.min_score);
      const maxScore = Number(row.max_score);

      return (
        Number.isFinite(minScore) &&
        Number.isFinite(maxScore) &&
        numericScore >= minScore &&
        numericScore <= maxScore
      );
    }) || null
  );
};

const isPassingConversion = (conversion) => {
  if (!conversion) return false;
  if (Number(conversion.is_disqualified) === 1) return false;

  const descriptiveRating = String(
    conversion.descriptive_rating || "",
  ).toUpperCase();
  if (descriptiveRating.includes("FAIL")) return false;
  if (descriptiveRating.includes("PASS")) return true;

  const equivalentGrade = Number(conversion.equivalent_grade);
  return Number.isFinite(equivalentGrade) && equivalentGrade > 0 && equivalentGrade <= 3;
};

const isFailingConversion = (conversion) => {
  if (!conversion) return false;
  if (Number(conversion.is_disqualified) === 1) return true;

  const descriptiveRating = String(
    conversion.descriptive_rating || "",
  ).toUpperCase();
  if (descriptiveRating.includes("FAIL")) return true;

  const equivalentGrade = Number(conversion.equivalent_grade);
  return Number.isFinite(equivalentGrade) && equivalentGrade > 3;
};

const getStoredNumericGrade = (numericInput, gradeConversions) => {
  const numericValue = Number(numericInput);
  if (Number.isNaN(numericValue)) return null;

  if (numericValue <= 5) {
    const equivalentConversion = findConversionByEquivalent(
      gradeConversions,
      numericValue,
    );

    if (!equivalentConversion) return null;

    const representativeScore = Number(equivalentConversion.max_score);
    return Number.isFinite(representativeScore) ? representativeScore : null;
  }

  return numericValue;
};

const resolveConversionFromInput = (numericInput, gradeConversions) => {
  const numericValue = Number(numericInput);
  if (Number.isNaN(numericValue)) return null;

  if (numericValue <= 5) {
    return findConversionByEquivalent(gradeConversions, numericValue);
  }

  return findConversionByScore(gradeConversions, numericValue);
};

const deriveRemarkAndStatusFromNumeric = (numericInput, gradeConversions) => {
  const conversion = resolveConversionFromInput(numericInput, gradeConversions);

  if (isPassingConversion(conversion)) {
    return { enRemark: 1, status: 0, conversion };
  }

  if (isFailingConversion(conversion)) {
    return { enRemark: 2, status: 1, conversion };
  }

  return { enRemark: 6, status: 0, conversion: null };
};

module.exports = {
  getGradeConversions,
  findConversionByEquivalent,
  findConversionByScore,
  getStoredNumericGrade,
  deriveRemarkAndStatusFromNumeric,
  normalizeEquivalentGrade,
};
