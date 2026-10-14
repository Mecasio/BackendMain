const jwt = require("jsonwebtoken");

/**
 * HRIS-style JWT auth. Protected APIs require Authorization: Bearer <token>.
 * Public login / register / branding / QR-verify routes are skipped by
 * authenticateTokenUnlessPublic.
 */

const PUBLIC_EXACT = new Set([
  "POST /login",
  "POST /login_applicant",
  "POST /login-totp-setup",
  "POST /verify-login-totp",
  "POST /register",
  "POST /register-totp-setup",
  "POST /check-registration-duplicate",
  "POST /forgot-password-init",
  "POST /forgot-password-confirm",
  "GET /check-domain-mx",
  "GET /user-mac-address",
  "GET /settings",
  "GET /branches",
  "GET /applied_program",
  "GET /active_school_year",
  "GET /programs/availability",
  "GET /announcements",
]);

const PUBLIC_PATTERNS = [
  { method: "GET", regex: /^\/registration-status\/[^/]+$/ },
  { method: "GET", regex: /^\/student-qr-information\/[^/]+$/ },
  { method: "GET", regex: /^\/verify-graduate\/[^/]+$/ },
  { method: "GET", regex: /^\/tor-qr-information\/[^/]+$/ },
  { method: "GET", regex: /^\/tor-qr-status\/[^/]+$/ },
  { method: "GET", regex: /^\/graduate-qr\/[^/]+$/ },
];

function normalizeApiPath(req) {
  const raw = req.path || req.url || "";
  const withoutQuery = String(raw).split("?")[0];
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

function isPublicApi(req) {
  if (req.method === "OPTIONS") return true;

  const path = normalizeApiPath(req);
  if (path === "/socket.io" || path.startsWith("/socket.io/")) return true;

  const key = `${String(req.method || "GET").toUpperCase()} ${path}`;
  if (PUBLIC_EXACT.has(key)) return true;

  const method = String(req.method || "GET").toUpperCase();
  return PUBLIC_PATTERNS.some(
    (rule) => rule.method === method && rule.regex.test(path),
  );
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const token = authHeader && String(authHeader).split(" ")[1];

  if (!token || token === "null" || token === "undefined") {
    return res.status(401).json({ error: "No token provided" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({
          error: "TOKEN_EXPIRED",
          message: "Token has expired",
        });
      }

      return res.status(401).json({
        error: "INVALID_TOKEN",
        message: "Invalid token",
      });
    }
    req.user = user;
    next();
  });
}

function authenticateTokenUnlessPublic(req, res, next) {
  if (isPublicApi(req)) {
    return next();
  }
  return authenticateToken(req, res, next);
}

module.exports = {
  authenticateToken,
  authenticateTokenUnlessPublic,
  isPublicApi,
};
