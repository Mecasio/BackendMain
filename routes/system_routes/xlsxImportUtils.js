const path = require("path");
const XLSX = require("xlsx");

const MB = 1024 * 1024;

const XLSX_IMPORT_LIMITS = {
  MAX_FILE_SIZE_MB: Number(process.env.MAX_XLSX_FILE_SIZE_MB || 120),
  MAX_ROWS: Number(process.env.MAX_XLSX_ROWS || 900000),
  MAX_COLS: Number(process.env.MAX_XLSX_COLS || 120),
  BATCH_SIZE: Number(process.env.XLSX_BATCH_SIZE || 100),
};

const ALLOWED_FILE_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);
const ALLOWED_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/csv",
  "application/octet-stream",
]);

function getFileSizeMB(sizeInBytes = 0) {
  return sizeInBytes / MB;
}

function validateSpreadsheetUpload(file) {
  if (!file) {
    return { valid: false, status: 400, error: "No file uploaded" };
  }

  const ext = path.extname(file.originalname || "").toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      status: 400,
      error: "Invalid file type. Allowed types: .xlsx, .xls, .csv",
    };
  }

  const sizeMb = getFileSizeMB(file.size || 0);
  if (sizeMb > XLSX_IMPORT_LIMITS.MAX_FILE_SIZE_MB) {
    return {
      valid: false,
      status: 413,
      error: `File too large. Max allowed is ${XLSX_IMPORT_LIMITS.MAX_FILE_SIZE_MB}MB`,
    };
  }

  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return {
      valid: false,
      status: 400,
      error: "Invalid MIME type for spreadsheet upload",
    };
  }

  return { valid: true, sizeMb };
}

function readWorkbookSafely(file) {
  const sizeMb = getFileSizeMB(file?.size || 0);
  const shouldBoundRows = sizeMb > 10;

  return XLSX.read(file.buffer, {
    type: "buffer",
    dense: true,
    cellFormula: true,
    sheetRows: shouldBoundRows ? XLSX_IMPORT_LIMITS.MAX_ROWS + 5 : 0,
  });
}

function countRowColumns(row) {
  if (!row) return 0;
  if (Array.isArray(row)) return row.length;
  return Object.keys(row).length;
}

function getSheetRowsWithLimits(sheet, options = {}) {
  const { sheetToJsonOptions = {}, maxRows, maxCols } = options;
  const enforcedMaxRows = maxRows || XLSX_IMPORT_LIMITS.MAX_ROWS;
  const enforcedMaxCols = maxCols || XLSX_IMPORT_LIMITS.MAX_COLS;

  const rows = XLSX.utils.sheet_to_json(sheet, sheetToJsonOptions);
  const totalRows = rows.length;
  const limitedRows = totalRows > enforcedMaxRows ? rows.slice(0, enforcedMaxRows) : rows;

  for (let i = 0; i < limitedRows.length; i++) {
    const row = limitedRows[i];
    if (countRowColumns(row) > enforcedMaxCols) {
      const err = new Error("Row has too many columns");
      err.code = "ROW_TOO_MANY_COLUMNS";
      err.rowIndex = i;
      throw err;
    }
  }

  return {
    rows: limitedRows,
    totalRows,
    truncatedByMaxRows: totalRows > enforcedMaxRows,
  };
}

function hasFormulaCell(sheet) {
  if (!sheet) return false;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith("!")) continue;
    const cell = sheet[key];
    if (cell && typeof cell === "object" && cell.f) {
      return true;
    }
  }
  return false;
}

function startsLikeFormula(value) {
  if (typeof value !== "string") return false;
  return /^[=+\-@]/.test(value.trim());
}

function isRowSafe(row) {
  if (Array.isArray(row)) {
    return !row.some((v) => startsLikeFormula(v));
  }
  if (!row || typeof row !== "object") return true;
  return !Object.values(row).some((v) => startsLikeFormula(v));
}

function removeFormulaLikeRows(rows) {
  const cleanRows = [];
  let flagged = 0;

  for (const row of rows) {
    if (isRowSafe(row)) cleanRows.push(row);
    else flagged++;
  }

  return { cleanRows, flaggedRows: flagged };
}

function filterRowsWithMandatoryColumns(rows, mandatoryColumns = []) {
  if (!mandatoryColumns.length) return { validRows: rows, skippedMissingMandatory: 0 };

  const normalized = mandatoryColumns.map((c) => String(c).toLowerCase().trim());
  const validRows = [];
  let skippedMissingMandatory = 0;

  for (const row of rows) {
    const ok = normalized.every((col) => {
      const matchKey = Object.keys(row).find(
        (k) => String(k).toLowerCase().trim() === col,
      );
      if (!matchKey) return false;
      const value = row[matchKey];
      return value !== null && value !== undefined && String(value).trim() !== "";
    });

    if (ok) validRows.push(row);
    else skippedMissingMandatory++;
  }

  return { validRows, skippedMissingMandatory };
}

function getDynamicRowLimitByFileSize(sizeInBytes = 0) {
  return XLSX_IMPORT_LIMITS.MAX_ROWS;
}

function prepareRowsForInsert(rows, sizeInBytes) {
  const limit = getDynamicRowLimitByFileSize(sizeInBytes);
  return { rowsToInsert: rows.slice(0, limit), limit };
}

async function processInBatches(rows, handler, batchSize = XLSX_IMPORT_LIMITS.BATCH_SIZE) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await handler(batch, i / batchSize);
  }
}

async function withTransaction(pool, handler) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await handler(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch (_) {
      // no-op
    }
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  XLSX_IMPORT_LIMITS,
  validateSpreadsheetUpload,
  readWorkbookSafely,
  getSheetRowsWithLimits,
  hasFormulaCell,
  removeFormulaLikeRows,
  filterRowsWithMandatoryColumns,
  prepareRowsForInsert,
  processInBatches,
  withTransaction,
};
