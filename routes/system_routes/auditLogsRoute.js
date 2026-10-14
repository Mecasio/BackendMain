const express = require("express");
const crypto = require("crypto");
const { db, db3 } = require("../database/database");
const {
  collectCategoryActions,
  uniqueActionCategories,
} = require("../../utils/auditActionCategory");

const router = express.Router();

const parsePositiveInt = (value, fallback, max) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

const formatActorDisplayName = (row, fallbackId) => {
  const lastName = String(row?.last_name || "").trim();
  const firstName = String(row?.first_name || "").trim();
  const middleName = String(row?.middle_name || "").trim();
  const employeeId = String(row?.employee_id || fallbackId || "").trim();
  const givenNames = [firstName, middleName].filter(Boolean).join(" ");
  const fullName = lastName
    ? `${lastName}${givenNames ? `, ${givenNames}` : ""}`
    : givenNames;

  if (fullName && employeeId) return `${fullName} (${employeeId})`;
  if (fullName) return fullName;
  return employeeId || fallbackId || "unknown";
};

const applyActorDisplay = (map, keys, display) => {
  keys
    .map((key) => String(key || "").trim())
    .filter(Boolean)
    .forEach((key) => {
      if (!map[key]) map[key] = display;
    });
};

const lookupActorDisplays = async (actorIds) => {
  const uniqueIds = [
    ...new Set(actorIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ];
  const map = {};
  if (!uniqueIds.length) return map;

  try {
    const [staffRows] = await db3.query(
      `SELECT employee_id, person_id, email, last_name, first_name, middle_name
       FROM user_accounts
       WHERE employee_id IN (?) OR email IN (?) OR person_id IN (?)`,
      [uniqueIds, uniqueIds, uniqueIds],
    );

    staffRows.forEach((row) => {
      applyActorDisplay(
        map,
        [row.employee_id, row.email, row.person_id],
        formatActorDisplayName(row, row.employee_id),
      );
    });
  } catch (err) {
    console.error("Audit actor staff name lookup failed:", err);
  }

  const missing = uniqueIds.filter((id) => !map[id]);
  if (!missing.length) return map;

  try {
    const [profRows] = await db3.query(
      `SELECT employee_id, email, lname AS last_name, fname AS first_name, mname AS middle_name
       FROM prof_table
       WHERE employee_id IN (?) OR email IN (?)`,
      [missing, missing],
    );

    profRows.forEach((row) => {
      applyActorDisplay(
        map,
        [row.employee_id, row.email],
        formatActorDisplayName(row, row.employee_id),
      );
    });
  } catch (err) {
    console.error("Audit actor faculty name lookup failed:", err);
  }

  return map;
};

const collectDistinctActions = async () => {
  const [admissionRows, enrollmentRows] = await Promise.all([
    db.query(
      `SELECT DISTINCT action
       FROM audit_logs
       WHERE action IS NOT NULL AND TRIM(action) <> ''`,
    ),
    db3.query(
      `SELECT DISTINCT action
       FROM audit_logs
       WHERE action IS NOT NULL AND TRIM(action) <> ''`,
    ),
  ]);

  return [
    ...new Set(
      [...(admissionRows[0] || []), ...(enrollmentRows[0] || [])]
        .map((row) => String(row.action || "").trim())
        .filter(Boolean),
    ),
  ];
};

router.get("/audit-logs/actions", async (req, res) => {
  try {
    const actions = uniqueActionCategories(await collectDistinctActions());
    res.json({ success: true, data: actions });
  } catch (error) {
    console.error("Audit log actions fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch audit log actions",
    });
  }
});

router.get("/audit-logs", async (req, res) => {
  const page = parsePositiveInt(req.query.page, 1, 100000);
  const limit = parsePositiveInt(req.query.limit, 100, 100000);
  const offset = (page - 1) * limit;
  const search = String(req.query.search || "").trim();
  const severity = String(req.query.severity || "").trim();
  const action = String(req.query.action || "").trim();
  const actorId = String(req.query.actor_id || "").trim();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  let startDate = String(req.query.start_date || "").trim();
  let endDate = String(req.query.end_date || "").trim();
  if (!datePattern.test(startDate)) startDate = "";
  if (!datePattern.test(endDate)) endDate = "";
  if (startDate && endDate && startDate > endDate) {
    const swapped = startDate;
    startDate = endDate;
    endDate = swapped;
  }

  try {
    let matchingActions = [];
    if (action) {
      matchingActions = collectCategoryActions(await collectDistinctActions(), action);
    }

    const buildWhere = () => {
      const clauses = [];
      const params = [];

      if (search) {
        clauses.push(
          "(actor_id LIKE ? OR role LIKE ? OR action LIKE ? OR message LIKE ? OR user_mac_address LIKE ?)",
        );
        const searchValue = `%${search}%`;
        params.push(searchValue, searchValue, searchValue, searchValue, searchValue);
      }

      if (severity) {
        clauses.push("severity = ?");
        params.push(severity);
      }

      if (action) {
        if (matchingActions.length === 0) {
          clauses.push("1 = 0");
        } else {
          clauses.push("action IN (?)");
          params.push(matchingActions);
        }
      }

      if (actorId) {
        clauses.push("actor_id = ?");
        params.push(actorId);
      }

      if (startDate) {
        clauses.push("timestamp >= ?");
        params.push(`${startDate} 00:00:00`);
      }

      if (endDate) {
        clauses.push("timestamp <= ?");
        params.push(`${endDate} 23:59:59`);
      }

      return {
        sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
        params,
      };
    };

    const queries = [];
    const countQueries = [];

    [
      { connection: db, sourceKey: "admission" },
      { connection: db3, sourceKey: "enrollment" },
    ].forEach(({ connection, sourceKey }) => {
      const where = buildWhere();
      queries.push(
        connection.query(
          `
          SELECT
            audit_id,
            actor_id AS email,
            role,
            action,
            message,
            severity,
            user_mac_address,
            timestamp,
            ? AS source_key
          FROM audit_logs
          ${where.sql}
          ORDER BY timestamp DESC, audit_id DESC
          `,
          [sourceKey, ...where.params],
        ),
      );
      countQueries.push(
        connection.query(
          `SELECT COUNT(*) AS total FROM audit_logs ${where.sql}`,
          where.params,
        ),
      );
    });

    const [queryResults, countResults] = await Promise.all([
      Promise.all(queries),
      Promise.all(countQueries),
    ]);
    const mergedRows = queryResults
      .flatMap(([rows]) => rows)
      .sort((a, b) => {
        const timeDiff = new Date(b.timestamp) - new Date(a.timestamp);
        if (timeDiff !== 0) return timeDiff;
        return Number(b.audit_id || 0) - Number(a.audit_id || 0);
      });

    const total = countResults.reduce(
      (sum, [rows]) => sum + Number(rows?.[0]?.total || 0),
      0,
    );
    const pageRows = mergedRows.slice(offset, offset + limit);
    const actorDisplays = await lookupActorDisplays(
      pageRows.map((row) => row.email),
    );
    const data = pageRows.map((row) => {
      const actorId = String(row.email || "").trim();
      const actorDisplay = actorDisplays[actorId] || actorId || "unknown";
      return {
        log_key: crypto
          .createHash("sha256")
          .update(`${row.source_key}:${row.audit_id}:${row.timestamp}`)
          .digest("hex"),
        email: actorDisplay,
        actor_id: actorId,
        actor_display: actorDisplay,
        role: row.role,
        action: row.action,
        message: row.message,
        severity: row.severity,
        user_mac_address: row.user_mac_address,
        timestamp: row.timestamp,
      };
    });

    res.json({
      success: true,
      data,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: offset + data.length < total,
    });
  } catch (error) {
    console.error("Audit logs fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch audit logs",
    });
  }
});

module.exports = router;
