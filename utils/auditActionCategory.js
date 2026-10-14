const AUDIT_ACTION_CATEGORIES = [
  "AUTH",
  "CREATE",
  "READ",
  "UPDATE",
  "DELETE",
  "UPLOAD",
  "NOTIFY",
  "OTHER",
];

const hasToken = (action, tokens) =>
  tokens.some(
    (token) =>
      action === token ||
      action.startsWith(`${token}_`) ||
      action.endsWith(`_${token}`) ||
      action.includes(`_${token}_`),
  );

const normalizeAuditAction = (action) => {
  const raw = String(action || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (!raw) return "OTHER";

  if (hasToken(raw, ["UPLOAD", "IMPORT"])) return "UPLOAD";
  if (hasToken(raw, ["EXPORT", "DOWNLOAD", "PRINT", "PRINTING", "READ", "VIEW"])) {
    return "READ";
  }

  if (
    raw === "AUTH" ||
    raw === "REGISTER" ||
    hasToken(raw, ["AUTH", "LOGIN", "LOGOUT", "TOTP", "PASSWORD", "FORGOT_PASSWORD"])
  ) {
    return "AUTH";
  }

  if (
    hasToken(raw, [
      "DELETE",
      "REMOVE",
      "REVOKE",
      "UNASSIGN",
      "UNENROLL",
      "UNTAG",
      "CLOSE",
    ])
  ) {
    return "DELETE";
  }

  if (hasToken(raw, ["CREATE", "INSERT", "ADD", "GRANT", "ASSIGN", "ENROLL", "TAG"])) {
    return "CREATE";
  }

  if (
    hasToken(raw, [
      "UPDATE",
      "EDIT",
      "CHANGE",
      "SAVE",
      "STATUS",
      "TOGGLE",
      "ACTIVATE",
      "DEACTIVATE",
    ])
  ) {
    return "UPDATE";
  }

  if (hasToken(raw, ["EMAIL", "NOTIFY", "SEND"])) return "NOTIFY";

  return "OTHER";
};

const collectCategoryActions = (actions, category) => {
  const selected = String(category || "").trim().toUpperCase();
  if (!selected) return [];

  return [
    ...new Set(
      (actions || [])
        .map((action) => String(action || "").trim())
        .filter((action) => action && normalizeAuditAction(action) === selected),
    ),
  ];
};

const uniqueActionCategories = (actions) => {
  const present = new Set(
    (actions || []).map((action) => normalizeAuditAction(action)),
  );
  return AUDIT_ACTION_CATEGORIES.filter((category) => present.has(category));
};

module.exports = {
  AUDIT_ACTION_CATEGORIES,
  normalizeAuditAction,
  collectCategoryActions,
  uniqueActionCategories,
};
