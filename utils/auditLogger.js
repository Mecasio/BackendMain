const { AsyncLocalStorage } = require("async_hooks");
const { db, db3 } = require("../routes/database/database");
const webtoken = require("jsonwebtoken");
const { resolveUserMacAddress } = require("./macAddress");

const auditRequestStore = new AsyncLocalStorage();

const DEFAULT_ACTION = "AUTH";
const ACCESS_DESCRIPTION_EXCLUDED_ROLES = new Set([
  "student",
  "applicant",
  "faculty",
  "professor",
]);

const formatAuditTimestamp = (date = new Date()) => {
  const month = date.toLocaleString("en-US", {
    month: "long",
    timeZone: "Asia/Manila",
  });
  const day = date.toLocaleString("en-US", {
    day: "numeric",
    timeZone: "Asia/Manila",
  });
  const year = date.toLocaleString("en-US", {
    year: "numeric",
    timeZone: "Asia/Manila",
  });
  const time = date.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  });

  return `${month} ${day}, ${year} ${time}`;
};

const formatRole = (role) => {
  const safeRole = String(role || "unknown").trim();
  if (!safeRole) return "Unknown";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getBearerPayload = (req) => {
  const authHeader = req?.headers?.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return null;

  try {
    return webtoken.verify(token, process.env.JWT_SECRET);
  } catch {
    try {
      return webtoken.decode(token);
    } catch {
      return null;
    }
  }
};

const resolveAuditActor = (req = {}) => {
  const tokenPayload = getBearerPayload(req) || {};
  const body = req.body || {};
  const headers = req.headers || {};

  const actorId =
    body.audit_actor_id ||
    headers["x-audit-actor-id"] ||
    headers["x-employee-id"] ||
    tokenPayload.employee_id ||
    tokenPayload.person_id ||
    tokenPayload.email ||
    "unknown";

  const actorRole =
    body.audit_actor_role ||
    headers["x-audit-actor-role"] ||
    tokenPayload.role ||
    "registrar";

  return {
    actorId: String(actorId || "unknown").trim() || "unknown",
    actorRole: String(actorRole || "registrar").trim() || "registrar",
  };
};

const getAccessDescriptionForActor = async (actorId) => {
  const safeActorId = String(actorId || "").trim();
  if (!safeActorId || safeActorId === "unknown") return "";

  try {
    const [rows] = await db3.query(
      `SELECT at.access_description
       FROM user_accounts ua
       LEFT JOIN access_table at ON at.access_id = ua.access_level
       WHERE ua.employee_id = ?
          OR ua.person_id = ?
          OR ua.email = ?
       LIMIT 1`,
      [safeActorId, safeActorId, safeActorId],
    );

    return String(rows?.[0]?.access_description || "").trim();
  } catch (err) {
    console.error("Audit access description lookup failed:", err);
    return "";
  }
};

const shouldUseAccessDescription = (role) => {
  const normalizedRole = String(role || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "_");

  return !ACCESS_DESCRIPTION_EXCLUDED_ROLES.has(normalizedRole);
};

const replaceActorMessagePrefix = ({ message, actorId, originalRole, finalRole }) => {
  if (!message || !actorId || !finalRole) return message;

  const formattedOriginalRole = formatRole(originalRole);
  const possiblePrefixes = [
    `${formattedOriginalRole} (${actorId})`,
    `${originalRole || ""} (${actorId})`,
    `Registrar (${actorId})`,
  ].filter((value, index, arr) => value.trim() && arr.indexOf(value) === index);

  const nextPrefix = `${finalRole} (${actorId})`;
  const matchingPrefix = possiblePrefixes.find((prefix) =>
    message.startsWith(prefix),
  );

  if (!matchingPrefix || matchingPrefix === nextPrefix) return message;

  return `${nextPrefix}${message.slice(matchingPrefix.length)}`;
};

const getAuthSeverity = ({ outcome }) => {
  if (outcome === "LOCKED") return "CRITICAL";
  if (outcome === "FAILED") return "WARN";
  if (outcome === "SUCCESS_AFTER_FAILURES") return "WARN";
  return "INFO";
};

const buildAuthAuditMessage = ({
  actorId,
  role,
  outcome,
  reason,
}) => {
  const safeActor = actorId || "unknown";
  const roleLabel = formatRole(role);
  const reasonText = reason ? ` Reason: ${reason}.` : "";

  if (outcome === "LOCKED") {
    return `${roleLabel} (${safeActor}) was locked from login.${reasonText}`;
  }

  if (outcome === "FAILED") {
    return `${roleLabel} (${safeActor}) failed to login.${reasonText}`;
  }

  if (outcome === "SUCCESS_AFTER_FAILURES") {
    return `${roleLabel} (${safeActor}) successfully login after previous failed attempts.${reasonText}`;
  }

  return `${roleLabel} (${safeActor}) successfully login.${reasonText}`;
};

const insertAuditLog = async ({
  auditDb,
  actorId,
  role,
  action = DEFAULT_ACTION,
  outcome = "SUCCESS",
  reason,
  message,
  severity,
  userMacAddress,
}) => {
  try {
    const safeActorId = actorId || "unknown";
    const accessDescription = shouldUseAccessDescription(role)
      ? await getAccessDescriptionForActor(safeActorId)
      : "";
    const finalRole = accessDescription || role || "unknown";
    const finalMessage =
      message ||
      buildAuthAuditMessage({
        actorId: safeActorId,
        role: finalRole,
        outcome,
        reason,
      });
    const normalizedMessage = replaceActorMessagePrefix({
      message: finalMessage,
      actorId: safeActorId,
      originalRole: role,
      finalRole,
    });

    const req = auditRequestStore.getStore();
    const resolvedMac =
      userMacAddress ||
      (req ? await resolveUserMacAddress(req) : null) ||
      null;

    const severityValue = severity || getAuthSeverity({ outcome });

    await auditDb.query(
      `INSERT INTO audit_logs
        (actor_id, role, action, message, severity, user_mac_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        safeActorId,
        finalRole,
        action,
        normalizedMessage,
        severityValue,
        resolvedMac,
      ],
    );

    try {
      const { broadcastNewAuditLog } = require("../socket/socketService");
      broadcastNewAuditLog({
        actor_id: safeActorId,
        role: finalRole,
        action,
        message: normalizedMessage,
        severity: severityValue,
        user_mac_address: resolvedMac,
      });
    } catch (socketErr) {
      console.error("Failed to broadcast audit log:", socketErr.message);
    }
  } catch (err) {
    console.error("Audit log insert failed:", err);
  }
};

const insertAuditLogAdmission = (payload) =>
  insertAuditLog({
    ...payload,
    auditDb: db,
  });

const insertAuditLogEnrollment = (payload) =>
  insertAuditLog({
    ...payload,
    auditDb: db3,
  });

const insertAuditLogBoth = async (payload) => {
  await Promise.all([
    insertAuditLogAdmission(payload),
    insertAuditLogEnrollment(payload),
  ]);
};

module.exports = {
  auditRequestStore,
  buildAuthAuditMessage,
  formatAuditTimestamp,
  insertAuditLogAdmission,
  insertAuditLogEnrollment,
  insertAuditLogBoth,
  resolveAuditActor,
};
