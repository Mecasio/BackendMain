const express = require("express");
const webtoken = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const speakeasy = require("speakeasy");
const path = require("path");
const fs = require("fs")
const QRCode = require("qrcode");
const {
  db,
  db3,
  ensureApplicantProgramAssignmentColumn,
} = require("../database/database");
const { CanDelete, CanEdit } = require("../../middleware/pagePermissions");
const {
  insertAuditLogAdmission,
  insertAuditLogEnrollment,
  insertAuditLogBoth,
} = require("../../utils/auditLogger");
const { resolveUserMacAddress } = require("../../utils/macAddress");
const {
  resolveRegistrarLoginFields,
} = require("../../utils/registrarScopeService");
// Shared academic-program window helper (also used by the /branches routes)
const {
  getNowInManila,
  computeIsOpen,
} = require("../../utils/registrationWindow");
const crypto = require("crypto");
const router = express.Router();
const dns = require("dns").promises;

// small helper so you're not repeating this SELECT everywhere
async function getShortTerm() {
  const [rows] = await db.query(
    "SELECT short_term FROM company_settings WHERE id = 1"
  );
  return rows?.[0]?.short_term || "Institution";
}

router.get("/user-mac-address", async (req, res) => {
  try {
    const macAddress = await resolveUserMacAddress(req);
    return res.json({
      success: true,
      mac_address: macAddress,
    });
  } catch (error) {
    console.error("MAC address lookup failed:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to resolve MAC address.",
    });
  }
});


const generateTempPassword = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 8 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join("");
};

// Looks up an account by ID (student number, or employee ID for
// registrar/faculty) and returns its type + email + current totp state.
// Does NOT verify email here — caller compares it.
const buildForgotPasswordDisplayName = (row = {}) => {
  const fullName = [
    row.first_name || row.fname,
    row.middle_name || row.mname,
    row.last_name || row.lname,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || row.email || "Unknown User";
};

async function resolveForgotPasswordAccount(identifier) {
  const normalizedIdentifier = String(identifier || "").trim();
  if (!normalizedIdentifier) return null;

  const [studentRows] = await db3.query(
    `SELECT ua.id, ua.email, ua.totp_secret, ua.totp_verified,
            pt.first_name, pt.middle_name, pt.last_name
     FROM student_numbering_table snt
     JOIN user_accounts ua ON ua.person_id = snt.person_id AND ua.role = 'student'
     LEFT JOIN person_table pt ON pt.person_id = ua.person_id
     WHERE snt.student_number = ?
     LIMIT 1`,
    [normalizedIdentifier]
  );
  if (studentRows.length > 0) {
    return {
      ...studentRows[0],
      type: "student",
      displayName: buildForgotPasswordDisplayName(studentRows[0]),
    };
  }

  const [registrarRows] = await db3.query(
    `SELECT ua.id, ua.email, ua.totp_secret, ua.totp_verified,
            pt.first_name, pt.middle_name, pt.last_name
     FROM user_accounts ua
     LEFT JOIN person_table pt ON pt.person_id = ua.person_id
     WHERE ua.employee_id = ? AND ua.role IN ('administrator', 'superadmin', 'technical')
     LIMIT 1`,
    [normalizedIdentifier]
  );
  if (registrarRows.length > 0) {
    return {
      ...registrarRows[0],
      type: "registrar",
      displayName: buildForgotPasswordDisplayName(registrarRows[0]),
    };
  }

  const [facultyRows] = await db3.query(
    `SELECT prof_id AS id, email, totp_secret, totp_verified, fname, mname, lname
     FROM prof_table
     WHERE employee_id = ? AND role = 'faculty'
     LIMIT 1`,
    [normalizedIdentifier]
  );
  if (facultyRows.length > 0) {
    return {
      ...facultyRows[0],
      type: "faculty",
      displayName: buildForgotPasswordDisplayName(facultyRows[0]),
    };
  }

  // ── NEW: applicant lookup (lives in the ADMISSION db, keyed by applicant_number) ──
  const [applicantRows] = await db.query(
    `SELECT ua.person_id AS id, ua.email, ua.totp_secret, ua.totp_verified, pt.birthOfDate,
            pt.first_name, pt.middle_name, pt.last_name
     FROM applicant_numbering_table ant
     JOIN person_table pt ON pt.person_id = ant.person_id
     JOIN user_accounts ua ON ua.person_id = ant.person_id AND ua.role = 'applicant'
     WHERE ant.applicant_number = ?
     LIMIT 1`,
    [normalizedIdentifier]
  );
  if (applicantRows.length > 0) {
    return {
      ...applicantRows[0],
      type: "applicant",
      displayName: buildForgotPasswordDisplayName(applicantRows[0]),
    };
  }

  return null;
}

const TYPE_TABLE_MAP = {
  student: { table: "user_accounts", idColumn: "id", db: db3 },
  registrar: { table: "user_accounts", idColumn: "id", db: db3 },
  faculty: { table: "prof_table", idColumn: "prof_id", db: db3 },
  applicant: { table: "user_accounts", idColumn: "person_id", db: db }, // NEW
};

// ─── In-memory stores ───────────────────────────────────────────────────────
let otpStore = {};
let loginAttempts = {};

// ─── Helpers ────────────────────────────────────────────────────────────────
const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const calculateAge = (birthDate) => {
  const date = new Date(birthDate);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const m = today.getMonth() - date.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < date.getDate())) age -= 1;
  return age;
};

// ─── Dynamic domain reachability check (no hardcoded domain list) ──────────
const isDomainReachable = async (email) => {
  const domain = String(email || "").split("@")[1];
  if (!domain) return false;
  try {
    const mxRecords = await dns.resolveMx(domain);
    if (Array.isArray(mxRecords) && mxRecords.length > 0) return true;
  } catch (err) {
    // fall through — try A/AAAA as a fallback for domains that accept
    // mail without an explicit MX record (rare, but some do)
  }
  try {
    const aRecords = await dns.resolve(domain);
    return Array.isArray(aRecords) && aRecords.length > 0;
  } catch (err) {
    return false;
  }
};

const COMMON_EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com"];

const levenshtein = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array(b.length + 1).fill(0).map((_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
};

const suggestEmailDomain = (domain) => {
  if (!domain) return null;
  const lower = domain.toLowerCase();
  if (COMMON_EMAIL_DOMAINS.includes(lower)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const known of COMMON_EMAIL_DOMAINS) {
    const dist = levenshtein(lower, known);
    if (dist < bestDist) {
      bestDist = dist;
      best = known;
    }
  }
  return bestDist > 0 && bestDist <= 2 ? best : null;
};

async function getApplicantNumberByPersonId(personId) {
  if (!personId) return null;
  try {
    const [rows] = await db.query(
      "SELECT applicant_number FROM applicant_numbering_table WHERE person_id = ? LIMIT 1",
      [personId]
    );
    return rows?.[0]?.applicant_number || null;
  } catch (err) {
    console.error("Applicant number lookup failed:", err);
    return null;
  }
}

const createLoginAuditLogger = (req) => {
  let resolvedMac = null;

  const ensureMac = async () => {
    if (!resolvedMac) {
      resolvedMac = await resolveUserMacAddress(req);
    }
    return resolvedMac;
  };

  return async (payload) => {
    const userMacAddress = await ensureMac();
    await insertAuditLogBoth({
      ...payload,
      userMacAddress,
    });
  };
};

const buildRegistrationAuditMessage = ({ actorId, event, reason }) => {
  const safeActor = actorId || "unknown";
  const reasonText = reason ? ` Reason: ${reason}.` : "";
  return `Applicant (${safeActor}) ${event}.${reasonText}`;
};

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";
  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const insertRegistrationAuditLog = ({
  actorId,
  event,
  outcome = "SUCCESS",
  severity,
  reason,
}) =>
  insertAuditLogAdmission({
    actorId,
    role: "applicant",
    action: "REGISTER",
    outcome,
    severity,
    reason,
    message: buildRegistrationAuditMessage({ actorId, event, reason }),
  });

const normalizePersonName = (value) => String(value || "").trim().toUpperCase();

// ─── Duplicate check (enrollment DB) ────────────────────────────────────────
const checkEnrollmentPersonDuplicate = async ({
  email,
  firstName,
  lastName,
  birthday,
}) => {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedFirstName = normalizePersonName(firstName);
  const normalizedLastName = normalizePersonName(lastName);
  const normalizedBirthday = String(birthday || "").trim();

  if (normalizedEmail) {
    const [emailRows] = await db3.query(
      `SELECT person_id
       FROM person_table
       WHERE LOWER(TRIM(emailAddress)) = ?
       LIMIT 1`,
      [normalizedEmail]
    );
    if (emailRows.length > 0) {
      return {
        duplicate: true,
        reason: "email",
        message:
          "This email already exists in the enrollment records. Duplicate registration is not allowed.",
      };
    }
  }

  if (
    normalizedFirstName &&
    normalizedLastName &&
    normalizedBirthday &&
    normalizedEmail
  ) {
    const [personRows] = await db3.query(
      `SELECT person_id
       FROM person_table
       WHERE UPPER(TRIM(first_name)) = ?
         AND UPPER(TRIM(last_name)) = ?
         AND birthOfDate = ?
         AND LOWER(TRIM(emailAddress)) = ?
       LIMIT 1`,
      [
        normalizedFirstName,
        normalizedLastName,
        normalizedBirthday,
        normalizedEmail,
      ]
    );
    if (personRows.length > 0) {
      return {
        duplicate: true,
        reason: "name_birthday_email",
        message:
          "An applicant/student with the same first name, last name, birthday, and email address already exists in the enrollment records. Duplicate registration is not allowed.",
      };
    }
  }

  return { duplicate: false };
};

// ════════════════════════════════════════════════════════════════════════════
//  ROUTE: POST /check-registration-duplicate
// ════════════════════════════════════════════════════════════════════════════
router.post("/check-registration-duplicate", async (req, res) => {
  try {
    const { email, firstName, lastName, birthday } = req.body;

    const domainOk = await isDomainReachable(email);
    if (!domainOk) {
      await insertRegistrationAuditLog({
        actorId: email || "unknown",
        outcome: "FAILED",
        event: "failed duplicate registration check",
        reason: "Email domain has no valid mail records",
      });
      return res.status(400).json({
        success: false,
        duplicate: false,
        reason: "invalid_domain",
        message:
          "This email domain doesn't appear to exist or can't receive mail. Please double-check for typos.",
      });
    }

    const duplicateCheck = await checkEnrollmentPersonDuplicate({
      email,
      firstName,
      lastName,
      birthday,
    });

    if (duplicateCheck.duplicate) {
      await insertRegistrationAuditLog({
        actorId: email || "unknown",
        outcome: "FAILED",
        event: "failed duplicate registration check",
        reason: duplicateCheck.message,
      });
      return res.status(400).json({
        success: false,
        duplicate: true,
        reason: duplicateCheck.reason,
        message: duplicateCheck.message,
      });
    }

    return res.json({ success: true, duplicate: false });
  } catch (error) {
    console.error("Registration duplicate check failed:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to validate duplicate registration",
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ROUTE: POST /register-totp-setup
//  Called BEFORE /register. Returns a QR code the user scans with Google
//  Authenticator. Stores the TOTP secret in otpStore (10-min TTL).
// ════════════════════════════════════════════════════════════════════════════
router.post("/register-totp-setup", async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = email?.trim().toLowerCase();

    if (!normalizedEmail) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    const [existingUser] = await db.query(
      "SELECT 1 FROM user_accounts WHERE email = ?",
      [normalizedEmail]
    );
    if (existingUser.length > 0) {
      await insertRegistrationAuditLog({
        actorId: normalizedEmail,
        outcome: "FAILED",
        event: "failed to set up TOTP",
        reason: "Email already registered",
      });
      return res.status(400).json({
        success: false,
        message:
          "This email has already been used for registration. Each applicant can only register once.",
      });
    }

    const [[company]] = await db.query(
      "SELECT short_term FROM company_settings WHERE id = 1"
    );
    const issuer = company?.short_term || "School";

    const secret = speakeasy.generateSecret({
      name: `${issuer} Registration (${normalizedEmail})`,
      issuer,
      length: 20,
    });

    // ── Invalidate any earlier pending setups for this same email ──────────
    // Prevents a stale QR code from an abandoned earlier attempt from ever
    // being scannable/usable again once a fresh one has been issued.
    Object.keys(otpStore).forEach((key) => {
      if (otpStore[key]?.email === normalizedEmail && otpStore[key]?.totpSecret) {
        delete otpStore[key];
      }
    });

    // ── Unique setup token — THIS, not the email, is what /register will
    //    use to look up the secret. Binds one specific QR code to one
    //    specific verification attempt so a code from a different setup
    //    (different email, different browser tab, stale attempt) can never
    //    accidentally validate this registration. ────────────────────────
    const setupId = crypto.randomUUID();

    otpStore[setupId] = {
      email: normalizedEmail,
      totpSecret: secret.base32,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };

    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url, {
      color: { dark: "#000000", light: "#FFFFFF" },
      width: 220,
      margin: 2,
    });

    await insertRegistrationAuditLog({
      actorId: normalizedEmail,
      outcome: "SUCCESS",
      event: "requested TOTP setup for registration",
    });

    return res.json({
      success: true,
      qrDataUrl,
      manualKey: secret.base32,
      setupId, // frontend must store this and send it back on /register
    });
  } catch (error) {
    console.error("TOTP setup error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate authenticator setup. Please try again.",
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ROUTE: POST /register  (APPLICANT ONLY)
// ════════════════════════════════════════════════════════════════════════════
router.post("/register", async (req, res) => {
  const {
    email,
    password,
    campus,
    otp,
    setupId, // NEW — required, ties this submission to one specific QR setup
    firstName,
    middleName,
    lastName,
    birthday,
    academicProgram,
    applyingAs,
    program,
    active_school_year_id,
  } = req.body;
  const normalizedEmail = email?.trim().toLowerCase();

  const domainOk = await isDomainReachable(normalizedEmail);
  if (!domainOk) {
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: "Email domain has no valid mail records",
    });
    return res.status(400).json({
      success: false,
      message: "This email domain doesn't appear to exist or can't receive mail.",
    });
  }

  const [existingEmail] = await db.query(
    "SELECT 1 FROM user_accounts WHERE email = ?",
    [normalizedEmail]
  );

  const [[company]] = await db.query(
    "SELECT short_term FROM company_settings WHERE id = 1"
  );

  const issuer = company?.short_term || "School";


  if (existingEmail.length > 0) {
    return res
      .status(400)
      .json({ success: false, message: "Email is already registered" });
  }

  const duplicateEnrollmentPerson = await checkEnrollmentPersonDuplicate({
    email: normalizedEmail,
    firstName,
    lastName,
    birthday,
  });
  if (duplicateEnrollmentPerson.duplicate) {
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: duplicateEnrollmentPerson.message,
    });
    return res.status(400).json({
      success: false,
      message: duplicateEnrollmentPerson.message,
    });
  }

  const [personMatch] = await db.query(
    `SELECT person_id
     FROM person_table
     WHERE first_name = ?
       AND last_name = ?
       AND birthOfDate = ?
       AND LOWER(TRIM(emailAddress)) = ?
     LIMIT 1`,
    [firstName.trim(), lastName.trim(), birthday, normalizedEmail]
  );
  if (personMatch.length > 0) {
    const personId = personMatch[0].person_id;
    const [applicant] = await db.query(
      `SELECT applicant_number FROM applicant_numbering_table WHERE person_id = ? LIMIT 1`,
      [personId]
    );
    if (applicant.length > 0) {
      const [exam] = await db.query(
        `SELECT email_sent FROM exam_applicants WHERE applicant_id = ? LIMIT 1`,
        [applicant[0].applicant_number]
      );
      if (exam.length > 0 && exam[0].email_sent === 1) {
        return res.status(400).json({
          success: false,
          message: `We are sorry to inform you that you are no longer allowed to take the ${issuer} College Admission Test (ECAT). Based on our records, you have already taken the examination.`,
        });
      }
    }
  }

  const [partialMatch] = await db.query(
    `SELECT person_id
     FROM person_table
     WHERE last_name = ?
       AND middle_name = ?
       AND first_name = ?
     LIMIT 1`,
    [lastName.trim(), middleName?.trim() || null, firstName.trim()]
  );
  if (partialMatch.length > 0) {
    const personId = partialMatch[0].person_id;
    const [applicant] = await db.query(
      `SELECT applicant_number FROM applicant_numbering_table WHERE person_id = ? LIMIT 1`,
      [personId]
    );
    if (applicant.length > 0) {
      const [exam] = await db.query(
        `SELECT email_sent FROM exam_applicants WHERE applicant_id = ? LIMIT 1`,
        [applicant[0].applicant_number]
      );
      if (exam.length > 0 && exam[0].email_sent === 1) {
        return res.status(400).json({
          success: false,
          message:
            "A similar applicant already received an email. Registration denied.",
        });
      }
    }
  }

  if (
    !normalizedEmail ||
    !password ||
    !campus ||
    !academicProgram ||
    !applyingAs ||
    !program
  ) {
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: "Missing required fields",
    });
    return res.json({
      success: false,
      message: "Please fill up all required fields",
    });
  }

  const [[row]] = await db.query(
    "SELECT branches FROM company_settings WHERE id = 1"
  );
  const branches = JSON.parse(row.branches || "[]");
  const branch = branches.find((b) => b.id == campus);
  if (!branch) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid branch selected" });
  }

  // ════════════════════════════════════════════════════════════════════
  //  REGISTRATION WINDOW CHECK
  //  A branch no longer has its own independent admission-season schedule.
  //  Registration is gated PURELY by the selected academic program's own
  //  DAILY window (Undergraduate, Graduate, TechVoc each carry their own
  //  start_date/end_date on the academicPrograms entry, evaluated against
  //  Manila time, wrapping past midnight where needed e.g. 18:00 -> 06:00).
  //  This is enforced server-side below via the default
  //  { dailyWindow: true } behavior of computeIsOpen — never trust the
  //  frontend-only check.
  // ════════════════════════════════════════════════════════════════════
  const nowManila = getNowInManila();

  const selectedProgram = (branch.academicPrograms || []).find(
    (p) => String(p.id) === String(academicProgram)
  );

  if (!selectedProgram) {
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: `Selected academic program (${academicProgram}) does not exist on this branch`,
    });
    return res.status(400).json({
      success: false,
      message: "Invalid academic program selected.",
    });
  }

  const allProgramsEnabled = Number(selectedProgram.all_programs) === 1;

  // Single live check: computeIsOpen now handles BOTH the manual master
  // switch (manual_enabled) AND the daily hours window (start_date/end_date)
  // in one place, so there's no risk of trusting a stale cached `open`
  // value read straight from the DB before this request re-syncs it.
  const programOpenNow = computeIsOpen(selectedProgram, nowManila, "open");
  if (!programOpenNow) {
    const startTime = selectedProgram.start_date?.split("T")[1] || "";
    const endTime = selectedProgram.end_date?.split("T")[1] || "";
    const hoursNote =
      startTime && endTime
        ? ` Registration hours: ${startTime}–${endTime} (Manila time), daily.`
        : "";
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: `Attempted registration outside ${selectedProgram.name || "program"}'s daily window`,
    });
    return res.status(400).json({
      success: false,
      message: `${selectedProgram.name || "This program"}'s registration is closed right now.${hoursNote}`,
    });
  }

  if (!allProgramsEnabled) {
    const [selectedCurriculumRows] = await db3.query(
      `SELECT ct.curriculum_id
       FROM curriculum_table AS ct
       INNER JOIN program_table AS pt ON pt.program_id = ct.program_id
       WHERE ct.curriculum_id = ?
         AND pt.components = ?
         AND pt.academic_program = ?
         AND ct.lock_status = 1
       LIMIT 1`,
      [program, campus, academicProgram]
    );
    if (selectedCurriculumRows.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid curriculum selected" });
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  TOTP VERIFICATION — now keyed by setupId, not by email.
  //  This guarantees the code being verified was generated by the exact
  //  QR code issued for THIS registration attempt, and additionally
  //  cross-checks that the email on file for that setup matches the
  //  email in this submission.
  // ════════════════════════════════════════════════════════════════════
  const now = Date.now();

  if (!setupId) {
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: "Missing setupId — no authenticator setup reference provided",
    });
    return res.status(400).json({
      success: false,
      message:
        "No authenticator setup found. Please go back and scan the QR code first.",
    });
  }

  const stored = otpStore[setupId];

  if (!stored || !stored.totpSecret) {
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: "No TOTP setup found for this setupId — user may not have scanned QR code yet, or it was already used/invalidated",
    });
    return res.status(400).json({
      success: false,
      message:
        "No authenticator setup found. Please go back and scan the QR code first.",
    });
  }

  // Belt-and-suspenders: the email this secret was issued for must match
  // the email being registered right now. If they differ, someone is
  // trying to complete registration for one email using a code that was
  // generated for a different email's QR setup.
  if (stored.email !== normalizedEmail) {
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: `Authenticator setup email mismatch — code was issued for a different email`,
    });
    return res.status(400).json({
      success: false,
      message:
        "This authenticator code was issued for a different email address. Please restart registration and scan a new QR code.",
    });
  }

  if (stored.expiresAt < now) {
    delete otpStore[setupId];
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: "TOTP setup expired",
    });
    return res.status(400).json({
      success: false,
      message:
        "Authenticator setup has expired (10 minutes). Please restart the registration process.",
    });
  }

  if (!otp || !/^\d{6}$/.test(otp.trim())) {
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: "Malformed TOTP token",
    });
    return res.status(400).json({
      success: false,
      message: "Please enter the 6-digit code from Google Authenticator.",
    });
  }

  const isValidToken = speakeasy.totp.verify({
    secret: stored.totpSecret,
    encoding: "base32",
    token: otp.trim(),
    window: 1,
  });

  if (!isValidToken) {
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: "Invalid TOTP token",
    });
    return res.status(400).json({
      success: false,
      message:
        "Invalid code. The code from Google Authenticator did not match. Please wait for it to refresh and try again.",
    });
  }

  delete otpStore[setupId];

  let person_id = null;
  try {
    await ensureApplicantProgramAssignmentColumn();
    const [[company]] = await db.query(
      "SELECT company_name FROM company_settings WHERE id = 1"
    );
    const companyName = company?.company_name || "Main Campus";

    const hashedPassword = await bcrypt.hash(password, 10);

    const [existingUser] = await db.query(
      "SELECT * FROM user_accounts WHERE email = ?",
      [normalizedEmail]
    );
    if (existingUser.length > 0) {
      await insertRegistrationAuditLog({
        actorId: normalizedEmail || "unknown",
        outcome: "FAILED",
        event: "failed to register",
        reason: "Email already registered (race condition)",
      });
      return res.json({ success: false, message: "Email is already registered" });
    }

    const age = calculateAge(birthday);

    const [personResult] = await db.query(
      `INSERT INTO person_table
       (campus, emailAddress, first_name, middle_name, last_name, birthOfDate, age,
        academicProgram, applyingAs, program, program_assignment_pending,
        termsOfAgreement, current_step)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        campus,
        normalizedEmail,
        firstName.trim(),
        middleName?.trim() || null,
        lastName.trim(),
        birthday,
        age,
        academicProgram,
        applyingAs,
        allProgramsEnabled ? null : program,
        allProgramsEnabled ? 1 : 0,
        0,
        1,
      ]
    );

    person_id = personResult.insertId;

    let schoolYearId = Number(active_school_year_id);
    if (!Number.isInteger(schoolYearId) || schoolYearId <= 0) {
      const [[activeSchoolYear]] = await db3.query(
        "SELECT id AS school_year_id FROM active_school_year_table WHERE astatus = 1 LIMIT 1"
      );
      schoolYearId = activeSchoolYear?.school_year_id || null;
    }

    await db.query(
      `INSERT INTO user_accounts (person_id, email, password, role, status, school_year_id)
       VALUES (?, ?, ?, 'applicant', ?, ?)`,
      [person_id, normalizedEmail, hashedPassword, 1, schoolYearId]
    );

    const [activeYearResult] = await db3.query(`
      SELECT yt.year_description, st.semester_code
      FROM active_school_year_table sy
      JOIN year_table yt ON yt.year_id = sy.year_id
      JOIN semester_table st ON st.semester_id = sy.semester_id
      WHERE sy.astatus = 1
      LIMIT 1
    `);
    if (activeYearResult.length === 0) {
      throw new Error("No active school year/semester found.");
    }

    const year = String(activeYearResult[0].year_description).split("-")[0];
    const semCode = activeYearResult[0].semester_code;

    const [countRes] = await db.query(
      "SELECT counter, query FROM applicant_counter WHERE id = 1"
    );
    const padded = String(countRes[0].query).padStart(5, "0");
    const applicant_number = `${year}${semCode}${padded}`;

    await db.query(
      "INSERT INTO applicant_numbering_table (applicant_number, person_id) VALUES (?, ?)",
      [applicant_number, person_id]
    );

    const qrData = `${process.env.DB_HOST_LOCAL}:5173/applicant_profile/${applicant_number}`;
    const qrFilename = `${applicant_number}_qrcode.png`;

    const qrPath = path.join(
      __dirname,
      "../../uploads/QrCodeGenerated",
      qrFilename
    );

    await QRCode.toFile(qrPath, qrData, {
      color: { dark: "#000", light: "#FFF" },
      width: 300,
    });


    await db.query(
      "UPDATE applicant_numbering_table SET qr_code = ? WHERE applicant_number = ?",
      [qrFilename, applicant_number]
    );

    await db.query(
      `INSERT INTO person_status_table
       (person_id, applicant_id, exam_status, requirements, residency,
        student_registration_status, exam_result, hs_ave, qualifying_result, interview_result)
       VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
      [person_id, applicant_number]
    );

    await db.query(
      `INSERT INTO interview_applicants
       (schedule_id, applicant_id, email_sent, status, qualifying_status, interview_status)
       VALUES (?, ?, 0, 0, null, null)`,
      [null, applicant_number]
    );

    const nextQuery = countRes[0].query + 1;
    await db.query(
      "UPDATE applicant_counter SET counter = ?, query = ? WHERE id = 1",
      [countRes[0].query, nextQuery]
    );

    res.status(201).json({
      success: true,
      message: "Registered Successfully",
      person_id,
      applicant_number,
      campus,
    });

    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "SUCCESS",
      event: "successfully registered",
    });
  } catch (error) {
    if (person_id) {
      await db.query("DELETE FROM person_table WHERE person_id = ?", [
        person_id,
      ]);
    }
    console.log(error);
    await insertRegistrationAuditLog({
      actorId: normalizedEmail || "unknown",
      outcome: "FAILED",
      event: "failed to register",
      reason: "Internal server error",
    });
    res.json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
});

router.post("/login", async (req, res) => {
  const { email: loginCredentials, password } = req.body;
  const insertLoginAuditLog = createLoginAuditLogger(req);

  if (!loginCredentials || !password) {
    return res
      .status(400)
      .json({ success: false, message: "All fields are required" });
  }

  const MAX_LOGIN_ATTEMPTS = 3;
  const LOCK_TIME = 3 * 60 * 1000;

  const loginKey = String(loginCredentials).trim().toLowerCase();
  const now = Date.now();

  if (!loginAttempts[loginKey]) {
    loginAttempts[loginKey] = { count: 0, lockUntil: null };
  }
  const record = loginAttempts[loginKey];

  // ── Lockout check ──────────────────────────────────────────────────────
  if (record.lockUntil && record.lockUntil > now) {
    const remainingSeconds = Math.ceil((record.lockUntil - now) / 1000);
    await insertLoginAuditLog({
      actorId: loginKey,
      role: "unknown",
      outcome: "LOCKED",
      reason: `Account locked. Remaining ${remainingSeconds}s`,
    });
    return res.status(429).json({
      success: false,
      locked: true,
      remainingSeconds,
      message: `Too many failed attempts. Try again in ${remainingSeconds} seconds.`,
    });
  }

  if (record.lockUntil && record.lockUntil <= now) {
    loginAttempts[loginKey] = { count: 0, lockUntil: null };
  }

  try {
    // ── UNION ALL: check user_accounts (students/registrar) + prof_table ──
    const query = `
    (
      SELECT ua.id AS account_id, ua.person_id, ua.email, ua.password,
            ua.employee_id, snt.student_number AS student_number, ua.role,
            ua.totp_secret, ua.totp_enabled, NULL AS profile_image,
            NULL AS fname, NULL AS mname, NULL AS lname,
            ua.status, 'user' AS source, ua.dprtmnt_id,
            dt.dprtmnt_name, NULL AS curriculum_id,
            ua.force_password_change
      FROM user_accounts AS ua
      LEFT JOIN dprtmnt_table AS dt ON ua.dprtmnt_id = dt.dprtmnt_id
      LEFT JOIN student_numbering_table AS snt ON snt.person_id = ua.person_id
      WHERE ua.email = ? OR snt.student_number = ? OR ua.employee_id = ?
    )
    UNION ALL
    (
      SELECT ua.prof_id AS account_id, ua.person_id, ua.email, ua.password,
            ua.employee_id, NULL AS student_number, ua.role,
            ua.totp_secret, ua.totp_enabled, ua.profile_image,
            ua.fname, ua.mname, ua.lname, ua.status,
            'prof' AS source, NULL AS dprtmnt_id, NULL AS dprtmnt_name,
            NULL AS curriculum_id, ua.force_password_change
      FROM prof_table AS ua
      WHERE ua.email = ? OR ua.employee_id = ?
    )
  `;

    const [results] = await db3.query(query, [
      loginCredentials,
      loginCredentials,
      loginCredentials,
      loginCredentials,
      loginCredentials,
    ]);

    // ── User not found ─────────────────────────────────────────────────────
    if (results.length === 0) {
      record.count++;
      if (record.count >= MAX_LOGIN_ATTEMPTS) {
        record.lockUntil = now + LOCK_TIME;
        loginAttempts[loginKey] = record;
        await insertLoginAuditLog({
          actorId: loginKey,
          role: "unknown",
          outcome: "LOCKED",
          reason: `Invalid email/student number (Attempt ${record.count}/${MAX_LOGIN_ATTEMPTS}) — account locked`,
        });
        return res.status(429).json({
          success: false,
          locked: true,
          remainingSeconds: Math.ceil(LOCK_TIME / 1000),
          message: `Too many failed attempts. Account locked for ${Math.ceil(LOCK_TIME / 1000)} seconds.`,
        });
      }
      loginAttempts[loginKey] = record;
      await insertLoginAuditLog({
        actorId: loginKey,
        role: "unknown",
        outcome: "FAILED",
        reason: `Invalid email, employee ID, or student number (Attempt ${record.count}/${MAX_LOGIN_ATTEMPTS})`,
      });
      return res.status(401).json({
        success: false,
        remaining: MAX_LOGIN_ATTEMPTS - record.count,
        message: `Invalid Email, Employee ID, or Student number. ${MAX_LOGIN_ATTEMPTS - record.count} attempt(s) remaining.`,
      });
    }

    const user = results[0];
    const actorId =
      user.employee_id || user.student_number || user.person_id || user.email;

    // ── Password check ─────────────────────────────────────────────────────
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      record.count++;
      if (record.count >= MAX_LOGIN_ATTEMPTS) {
        record.lockUntil = now + LOCK_TIME;
        loginAttempts[loginKey] = record;
        await insertLoginAuditLog({
          actorId,
          role: user.role,
          outcome: "LOCKED",
          reason: `Invalid password (Attempt ${record.count}/${MAX_LOGIN_ATTEMPTS}) — account locked`,
        });
        return res.status(429).json({
          success: false,
          locked: true,
          remainingSeconds: Math.ceil(LOCK_TIME / 1000),
          message: `Too many failed attempts. Account locked for ${Math.ceil(LOCK_TIME / 1000)} seconds.`,
        });
      }
      loginAttempts[loginKey] = record;
      await insertLoginAuditLog({
        actorId,
        role: user.role,
        outcome: "FAILED",
        reason: `Invalid password (Attempt ${record.count}/${MAX_LOGIN_ATTEMPTS})`,
      });
      return res.status(401).json({
        success: false,
        remaining: MAX_LOGIN_ATTEMPTS - record.count,
        message: `Invalid password or email. ${MAX_LOGIN_ATTEMPTS - record.count} attempt(s) remaining.`,
      });
    }

    // ── Account status check ───────────────────────────────────────────────
    if (user.status === 0) {
      await insertLoginAuditLog({
        actorId,
        role: user.role,
        outcome: "FAILED",
        reason: "Inactive account",
      });
      return res.json({
        success: false,
        message: "The user didn't exist or account is inactive",
      });
    }

    // ── Password matched — build token & shared payload ────────────────────
    const [rows] = await db3.query(
      "SELECT * FROM page_access WHERE user_id = ?",
      [user.employee_id]
    );
    const accessList = rows.map((r) => Number(r.page_id));
    const failureCount = record.count || 0;
    const registrarFields = await resolveRegistrarLoginFields(
      user.employee_id,
      user.role,
      user.dprtmnt_id,
    );

    const token = webtoken.sign(
      {
        person_id: user.person_id,
        employee_id: user.employee_id,
        email: user.email,
        role: user.role,
        department: registrarFields.department,
        curriculum_id: registrarFields.curriculum_id,
        prof_id: user.source === "prof" ? user.account_id : null,
        accessList,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const loginPayload = {
      success: true,
      token,
      email: user.email,
      role: user.role,
      person_id: user.person_id,
      prof_id: user.source === "prof" ? user.account_id : null,
      employee_id: user.employee_id,
      department: registrarFields.department,
      curriculum_id: registrarFields.curriculum_id,
      accessList,
      force_password_change: user.force_password_change === 1,
      source: user.source,
    };

    delete loginAttempts[loginKey]; // creds were correct regardless of TOTP path
    const successOutcome = failureCount >= 2 ? "SUCCESS_AFTER_FAILURES" : "SUCCESS";

    // ── TOTP disabled for this user — straight through ─────────────────────
    if (Number(user.totp_enabled) === 0) {
      await insertLoginAuditLog({
        actorId,
        role: user.role,
        outcome: successOutcome,
        message: `User (${actorId}) logged in (TOTP disabled).`,
      });

      return res.json({
        ...loginPayload,
        requireTotpSetup: false,
        requireTotp: false,
        message: "Login successful.",
      });
    }

    // ── TOTP enabled — first-ever login, no secret yet → prompt QR setup ──
    if (!user.totp_secret) {
      // Invalidate any earlier pending login-setup attempts for this email —
      // a stale QR from an abandoned attempt should never remain usable
      // once a fresh one is issued (same reasoning as registration).
      Object.keys(otpStore).forEach((key) => {
        if (otpStore[key]?.email === user.email && otpStore[key]?.loginSetup) {
          delete otpStore[key];
        }
      });

      // Unique per-attempt token — THIS, not the email, is what
      // /login-totp-setup and /verify-login-totp will key off of. It's
      // only ever generated here, right after a real password check.
      const loginSetupId = crypto.randomUUID();
      otpStore[loginSetupId] = {
        email: user.email,
        source: user.source,
        loginSetup: true,
        totpSecret: null, // filled in by /login-totp-setup
        expiresAt: Date.now() + 10 * 60 * 1000,
      };

      await insertLoginAuditLog({
        actorId,
        role: user.role,
        outcome: "TOTP_SETUP_REQUIRED",
        message: `User (${actorId}) authenticated but needs to set up Google Authenticator.`,
      });

      return res.json({
        ...loginPayload,
        requireTotpSetup: true,
        requireTotp: false,
        loginSetupId, // frontend must store this and send it back
        message: "Please set up Google Authenticator to complete login.",
      });
    }

    // ── TOTP enabled — has secret → ask for current code ──────────────────
    // NEW: also issue a loginSetupId here (previously this only happened
    // in the "no secret yet" branch above). Without it, a returning user
    // who deleted/lost their authenticator entry had NO way to get a new
    // QR code — the frontend had nothing to call /login-totp-setup with.
    // This is safe to hand out at this point because the user has already
    // proven identity via a correct password just above; it does not by
    // itself change any stored secret — /login-totp-setup only PREPARES a
    // new pending secret, and /verify-login-totp only PERSISTS it if the
    // user explicitly opts into "regenerate" and then proves the new code.
    Object.keys(otpStore).forEach((key) => {
      if (otpStore[key]?.email === user.email && otpStore[key]?.loginSetup) {
        delete otpStore[key];
      }
    });
    const loginSetupId = crypto.randomUUID();
    otpStore[loginSetupId] = {
      email: user.email,
      source: user.source,
      loginSetup: true,
      totpSecret: null, // only populated if the user asks to regenerate
      expiresAt: Date.now() + 10 * 60 * 1000,
    };

    await insertLoginAuditLog({
      actorId,
      role: user.role,
      outcome: successOutcome,
      message: `User (${actorId}) authenticated. Awaiting TOTP verification.`,
    });

    return res.json({
      ...loginPayload,
      requireTotpSetup: false,
      requireTotp: true,
      loginSetupId,
      message: "Enter the code from Google Authenticator.",
    });

  } catch (error) {
    console.error("Login error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error during login" });
  }
});

router.post("/login-totp-setup", async (req, res) => {
  try {
    const { loginSetupId, email, source } = req.body;

    if (!loginSetupId) {
      return res.status(400).json({
        success: false,
        message: "Missing setup reference. Please log in again.",
      });
    }

    const stored = otpStore[loginSetupId];
    const now = Date.now();

    if (!stored || !stored.loginSetup) {
      return res.status(400).json({
        success: false,
        message: "No pending authenticator setup found. Please log in again.",
      });
    }

    if (stored.expiresAt < now) {
      delete otpStore[loginSetupId];
      return res.status(400).json({
        success: false,
        message: "Setup session expired. Please log in again.",
      });
    }

    const normalizedEmail = email?.trim().toLowerCase();
    if (normalizedEmail && stored.email.toLowerCase() !== normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: "Setup reference does not match this account.",
      });
    }

    const [[company]] = await db.query(
      "SELECT short_term FROM company_settings WHERE id = 1"
    );
    const issuer = company?.short_term || "School";

    const secret = speakeasy.generateSecret({
      name: `${issuer} Login (${stored.email})`,
      issuer,
      length: 20,
    });

    // Bind the freshly generated secret to this SAME loginSetupId — don't
    // create a new key, so the id issued at /login stays the single
    // source of truth for the whole setup attempt.
    stored.totpSecret = secret.base32;
    stored.source = source || stored.source || "user";
    stored.expiresAt = Date.now() + 10 * 60 * 1000; // refresh the window

    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url, {
      color: { dark: "#000000", light: "#FFFFFF" },
      width: 220,
      margin: 2,
    });

    return res.json({
      success: true,
      qrDataUrl,
      manualKey: secret.base32,
    });
  } catch (error) {
    console.error("Login TOTP setup error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate authenticator setup. Please try again.",
    });
  }
});

router.post("/verify-login-totp", async (req, res) => {
  try {
    const { email, token: totpToken, isSetup, source, loginSetupId } = req.body;
    const normalizedEmail = email?.trim().toLowerCase();
    const insertLoginAuditLog = createLoginAuditLogger(req);

    if (!normalizedEmail || !totpToken) {
      return res
        .status(400)
        .json({ success: false, message: "Email and code are required" });
    }

    if (!/^\d{6}$/.test(totpToken.trim())) {
      return res
        .status(400)
        .json({ success: false, message: "Please enter a valid 6-digit code." });
    }

    const now = Date.now();

    if (isSetup) {
      // ── First-time setup OR regeneration after losing the app entry:
      //    verify against the pending secret, keyed by the unique
      //    loginSetupId issued at /login (not by email). ──────────────
      if (!loginSetupId) {
        return res.status(400).json({
          success: false,
          message: "Missing setup reference. Please log in again.",
        });
      }

      const stored = otpStore[loginSetupId];

      if (!stored || !stored.totpSecret) {
        return res.status(400).json({
          success: false,
          message:
            "No setup in progress. Please go back and scan the QR code again.",
        });
      }
      if (stored.expiresAt < now) {
        delete otpStore[loginSetupId];
        return res.status(400).json({
          success: false,
          message:
            "QR code expired (10 minutes). Please log in again to restart setup.",
        });
      }

      // Belt-and-suspenders, same as registration: the code being
      // verified must belong to the same account this setup was issued for.
      if (stored.email.toLowerCase() !== normalizedEmail) {
        return res.status(400).json({
          success: false,
          message: "This authenticator code was issued for a different account.",
        });
      }

      const isValid = speakeasy.totp.verify({
        secret: stored.totpSecret,
        encoding: "base32",
        token: totpToken.trim(),
        window: 1,
      });

      if (!isValid) {
        return res.status(400).json({
          success: false,
          message:
            "Incorrect code. Wait for it to refresh in Google Authenticator and try again.",
        });
      }

      // Code is correct — persist the secret to DB. This intentionally
      // OVERWRITES any existing totp_secret, which is exactly what a
      // "lost my authenticator app" regeneration needs to do.
      const tableSource = stored.source || source || "user";
      if (tableSource === "prof") {
        await db3.query(
          "UPDATE prof_table SET totp_secret = ? WHERE email = ?",
          [stored.totpSecret, normalizedEmail]
        );
      } else {
        await db3.query(
          "UPDATE user_accounts SET totp_secret = ? WHERE email = ?",
          [stored.totpSecret, normalizedEmail]
        );
      }

      delete otpStore[loginSetupId];

      await insertLoginAuditLog({
        actorId: normalizedEmail,
        role: "user",
        action: "TOTP_SETUP",
        outcome: "SUCCESS",
        message: `User (${normalizedEmail}) completed Google Authenticator setup.`,
      });

      return res.json({
        success: true,
        message: "Google Authenticator set up successfully.",
      });
    } else {
      // ── Normal login: verify against the secret stored in DB ─────────────
      let totpSecret = null;
      const tableSource = source || "user";

      if (tableSource === "prof") {
        const [[profRow]] = await db3.query(
          "SELECT totp_secret FROM prof_table WHERE email = ? LIMIT 1",
          [normalizedEmail]
        );
        totpSecret = profRow?.totp_secret || null;
      } else {
        const [[userRow]] = await db3.query(
          "SELECT totp_secret FROM user_accounts WHERE email = ? LIMIT 1",
          [normalizedEmail]
        );
        totpSecret = userRow?.totp_secret || null;
      }

      if (!totpSecret) {
        return res.status(400).json({
          success: false,
          message:
            "No authenticator secret found. Please contact your administrator.",
        });
      }

      const isValid = speakeasy.totp.verify({
        secret: totpSecret,
        encoding: "base32",
        token: totpToken.trim(),
        window: 1,
      });

      if (!isValid) {
        return res.status(400).json({
          success: false,
          message:
            "Incorrect code. Wait for it to refresh in Google Authenticator and try again.",
        });
      }

      await insertLoginAuditLog({
        actorId: normalizedEmail,
        role: "user",
        action: "LOGIN",
        outcome: "SUCCESS",
        message: `User (${normalizedEmail}) verified TOTP and logged in successfully.`,
      });

      return res.json({ success: true, message: "TOTP verified successfully." });
    }
  } catch (error) {
    console.error("Verify login TOTP error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error verifying code." });
  }
});


router.post("/login_applicant", async (req, res) => {
  const { email, password } = req.body;
  const insertLoginAuditLog = createLoginAuditLogger(req);

  if (!email || !password) {
    return res
      .status(400)
      .json({ success: false, message: "All fields are required" });
  }

  const MAX_LOGIN_ATTEMPTS = 3;
  const LOCK_TIME = 180 * 1000;

  const loginCredential = email.trim();
  const loginKey = loginCredential.toLowerCase();
  const now = Date.now();

  if (!loginAttempts[loginKey]) {
    loginAttempts[loginKey] = { count: 0, lockUntil: null };
  }
  const record = loginAttempts[loginKey];

  if (record.lockUntil && record.lockUntil > now) {
    const remainingSeconds = Math.ceil((record.lockUntil - now) / 1000);
    await insertLoginAuditLog({
      actorId: loginKey,
      role: "applicant",
      outcome: "LOCKED",
      reason: `Account locked. Remaining ${remainingSeconds}s`,
    });
    return res.status(429).json({
      success: false,
      locked: true,
      remainingSeconds,
      message: `Too many failed attempts. Try again in ${remainingSeconds} seconds.`,
    });
  }

  if (record.lockUntil && record.lockUntil <= now) {
    loginAttempts[loginKey] = { count: 0, lockUntil: null };
  }

  try {
    const query = `
      SELECT ua.*, pt.*, ant.applicant_number AS existing_applicant_number
      FROM user_accounts AS ua
      LEFT JOIN person_table AS pt ON pt.person_id = ua.person_id
      LEFT JOIN applicant_numbering_table AS ant ON ant.person_id = ua.person_id
      WHERE ua.email = ? OR ant.applicant_number = ?
    `;
    const [results] = await db.query(query, [loginCredential, loginCredential]);

    if (results.length === 0) {
      record.count++;
      if (record.count >= MAX_LOGIN_ATTEMPTS) {
        record.lockUntil = now + LOCK_TIME;
        loginAttempts[loginKey] = record;
        await insertLoginAuditLog({
          actorId: loginKey,
          role: "applicant",
          outcome: "LOCKED",
          reason: `Invalid email or password (Attempt ${record.count}/${MAX_LOGIN_ATTEMPTS}) — account locked`,
        });
        return res.status(429).json({
          success: false,
          locked: true,
          remainingSeconds: Math.ceil(LOCK_TIME / 1000),
          message: `Too many failed attempts. Account locked for ${Math.ceil(LOCK_TIME / 1000)} seconds.`,
        });
      }
      loginAttempts[loginKey] = record;
      await insertLoginAuditLog({
        actorId: loginKey,
        role: "applicant",
        outcome: "FAILED",
        reason: `Invalid email or password (Attempt ${record.count}/${MAX_LOGIN_ATTEMPTS})`,
      });
      return res.status(401).json({
        success: false,
        remaining: MAX_LOGIN_ATTEMPTS - record.count,
        message: `Invalid email or password. ${MAX_LOGIN_ATTEMPTS - record.count} attempt(s) remaining.`,
      });
    }

    const user = results[0];
    const existingApplicantNumber = await getApplicantNumberByPersonId(
      user.person_id
    );
    const applicantActor = existingApplicantNumber || loginKey;

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      record.count++;
      if (record.count >= MAX_LOGIN_ATTEMPTS) {
        record.lockUntil = now + LOCK_TIME;
        loginAttempts[loginKey] = record;
        await insertLoginAuditLog({
          actorId: applicantActor,
          role: "applicant",
          outcome: "LOCKED",
          reason: `Invalid password (Attempt ${record.count}/${MAX_LOGIN_ATTEMPTS}) — account locked`,
        });
        return res.status(429).json({
          success: false,
          locked: true,
          remainingSeconds: Math.ceil(LOCK_TIME / 1000),
          message: `Too many failed attempts. Account locked for ${Math.ceil(LOCK_TIME / 1000)} seconds.`,
        });
      }
      loginAttempts[loginKey] = record;
      await insertLoginAuditLog({
        actorId: applicantActor,
        role: "applicant",
        outcome: "FAILED",
        reason: `Invalid password (Attempt ${record.count}/${MAX_LOGIN_ATTEMPTS})`,
      });
      return res.status(401).json({
        success: false,
        remaining: MAX_LOGIN_ATTEMPTS - record.count,
        message: `Invalid password. ${MAX_LOGIN_ATTEMPTS - record.count} attempt(s) remaining.`,
      });
    }

    if (user.status === 0) {
      await insertLoginAuditLog({
        actorId: applicantActor,
        role: "applicant",
        outcome: "FAILED",
        reason: "Inactive account",
      });
      return res.json({
        success: false,
        message: "The user didn't exist or is inactive",
      });
    }

    const person_id = user.person_id;
    const [existing] = await db.query(
      `SELECT applicant_number, qr_code FROM applicant_numbering_table WHERE person_id = ?`,
      [person_id]
    );

    let applicantNumber, qrFilename;

    if (existing.length === 0) {
      const [activeYear] = await db3.query(`
        SELECT yt.year_description, st.semester_description, st.semester_code
        FROM active_school_year_table AS sy
        JOIN year_table AS yt ON yt.year_id = sy.year_id
        JOIN semester_table AS st ON st.semester_id = sy.semester_id
        WHERE sy.astatus = 1
        LIMIT 1
      `);
      if (activeYear.length === 0) {
        return res
          .status(500)
          .json({ success: false, message: "No active school year found" });
      }

      const year = String(activeYear[0].year_description).split("-")[0];
      const semCode = activeYear[0].semester_code;
      const [countRes] = await db.query(
        "SELECT counter, query FROM applicant_counter WHERE id = 1"
      );
      const padded = String(countRes[0].query).padStart(5, "0");
      applicantNumber = `${year}${semCode}${padded}`;

      await db.query(
        `INSERT INTO applicant_numbering_table (applicant_number, person_id) VALUES (?, ?)`,
        [applicantNumber, person_id]
      );

      const qrData = `${process.env.DB_HOST_LOCAL}:5173/examination_profile/${applicantNumber}`;
      qrFilename = `${applicantNumber}_qrcode.png`;
      const qrPath = path.join(__dirname, "uploads", qrFilename);
      await QRCode.toFile(qrPath, qrData, {
        color: { dark: "#000", light: "#FFF" },
        width: 300,
      });
      await db.query(
        `UPDATE applicant_numbering_table SET qr_code = ? WHERE applicant_number = ?`,
        [qrFilename, applicantNumber]
      );

      const nextQuery = countRes[0].query + 1;
      await db.query(
        `UPDATE applicant_counter SET counter = ?, query = ? WHERE id = 1`,
        [countRes[0].query, nextQuery]
      );
    } else {
      applicantNumber = existing[0].applicant_number;
      qrFilename = existing[0].qr_code;
    }

    delete loginAttempts[loginKey];

    const token = webtoken.sign(
      { person_id: user.person_id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    await insertLoginAuditLog({
      actorId: applicantNumber,
      role: user.role,
      outcome: "SUCCESS",
    });

    return res.json({
      success: true,
      message: "Login successful",
      force_password_change: user.force_password_change === 1,
      token,
      email: user.email,
      registered_email: user.emailAddress,
      first_name: user.first_name,
      last_name: user.last_name,
      middle_name: user.middle_name,
      birthday: user.birthOfDate,
      birthOfDate: user.birthOfDate,
      academicProgram: user.academicProgram,
      applyingAs: user.applyingAs,
      role: user.role,
      person_id: user.person_id,
      applicant_number: applicantNumber,
      qr_code: qrFilename,
    });
  } catch (error) {
    console.error("Login error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error during login" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ROUTE: DELETE /delete-account/:person_id
// ════════════════════════════════════════════════════════════════════════════
router.delete("/delete-account/:person_id", CanDelete, async (req, res) => {
  const { person_id } = req.params;
  if (!person_id) {
    return res
      .status(400)
      .json({ success: false, message: "Person ID is required" });
  }

  try {
    const [[accountBefore]] = await db.query(
      `SELECT ua.person_id, ua.email, ua.role, ant.applicant_number,
              pt.first_name, pt.middle_name, pt.last_name
       FROM user_accounts ua
       LEFT JOIN person_table pt ON pt.person_id = ua.person_id
       LEFT JOIN applicant_numbering_table ant ON ant.person_id = ua.person_id
       WHERE ua.person_id = ?
       LIMIT 1`,
      [person_id]
    );

    const [result] = await db.query(
      `UPDATE user_accounts SET is_archived = 1 WHERE person_id = ?`,
      [person_id]
    );
    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    const actorId =
      req.body?.audit_actor_id ||
      req.headers["x-audit-actor-id"] ||
      req.headers["x-employee-id"] ||
      "unknown";
    const actorRole =
      req.body?.audit_actor_role ||
      req.headers["x-audit-actor-role"] ||
      "registrar";
    const roleLabel = formatAuditActorRole(actorRole);
    const applicantName = [
      accountBefore?.last_name,
      accountBefore?.first_name,
      accountBefore?.middle_name,
    ]
      .filter(Boolean)
      .join(", ");
    const accountLabel =
      accountBefore?.applicant_number ||
      applicantName ||
      accountBefore?.email ||
      `person_id ${person_id}`;

    await insertAuditLogAdmission({
      actorId,
      role: actorRole,
      action: "APPLICATION_ACCOUNT_ARCHIVE",
      severity: "INFO",
      message: `${roleLabel} (${actorId}) archived account for Applicant (${accountLabel}).`,
    });

    res.json({ success: true, message: "Account archived successfully" });
  } catch (error) {
    console.error("Archive account error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to archive account" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ROUTE: GET /archived-accounts
// ════════════════════════════════════════════════════════════════════════════
router.get("/archived-accounts", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT ua.person_id, ua.email, p.extension, p.first_name, p.last_name,
              p.middle_name, p.campus, p.created_at, ant.applicant_number
       FROM user_accounts AS ua
       LEFT JOIN person_table AS p ON p.person_id = ua.person_id
       LEFT JOIN applicant_numbering_table AS ant ON ant.person_id = ua.person_id
       WHERE COALESCE(ua.is_archived, 0) = 1
       ORDER BY p.created_at DESC, ua.person_id DESC`
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("Fetch archived accounts error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch archived accounts" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ROUTE: PUT /restore-account/:person_id
// ════════════════════════════════════════════════════════════════════════════
router.put("/restore-account/:person_id", CanEdit, async (req, res) => {
  const { person_id } = req.params;
  if (!person_id) {
    return res
      .status(400)
      .json({ success: false, message: "Person ID is required" });
  }

  try {
    const [accountRows] = await db.query(
      `SELECT ua.email, pt.first_name, pt.middle_name, pt.last_name, ant.applicant_number
       FROM user_accounts ua
       LEFT JOIN person_table pt ON pt.person_id = ua.person_id
       LEFT JOIN applicant_numbering_table ant ON ant.person_id = ua.person_id
       WHERE ua.person_id = ?
       LIMIT 1`,
      [person_id]
    );

    const [result] = await db.query(
      `UPDATE user_accounts SET is_archived = 0 WHERE person_id = ?`,
      [person_id]
    );
    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    const actorId =
      req.body?.audit_actor_id ||
      req.headers["x-audit-actor-id"] ||
      req.headers["x-employee-id"] ||
      "unknown";
    const actorRole =
      req.body?.audit_actor_role ||
      req.headers["x-audit-actor-role"] ||
      "registrar";
    const roleLabel = formatAuditActorRole(actorRole);
    const accountBefore = accountRows?.[0];
    const applicantName = [
      accountBefore?.last_name,
      accountBefore?.first_name,
      accountBefore?.middle_name,
    ]
      .filter(Boolean)
      .join(", ");
    const accountLabel =
      accountBefore?.applicant_number ||
      applicantName ||
      accountBefore?.email ||
      `person_id ${person_id}`;

    await insertAuditLogAdmission({
      actorId,
      role: actorRole,
      action: "APPLICATION_ACCOUNT_RESTORE",
      severity: "INFO",
      message: `${roleLabel} (${actorId}) restored account for Applicant (${accountLabel}).`,
    });

    res.json({ success: true, message: "Account restored successfully" });
  } catch (error) {
    console.error("Restore account error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to restore account" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ROUTE: DELETE /permanent-delete-account/:person_id
// ════════════════════════════════════════════════════════════════════════════
router.delete(
  "/permanent-delete-account/:person_id",
  CanDelete,
  async (req, res) => {
    const { person_id } = req.params;
    if (!person_id) {
      return res
        .status(400)
        .json({ success: false, message: "Person ID is required" });
    }

    try {
      const [applicant] = await db.query(
        `SELECT ant.applicant_number, pt.first_name, pt.middle_name, pt.last_name, ua.email
         FROM applicant_numbering_table ant
         LEFT JOIN person_table pt ON pt.person_id = ant.person_id
         LEFT JOIN user_accounts ua ON ua.person_id = ant.person_id
         WHERE ant.person_id = ?`,
        [person_id]
      );

      const applicantBefore = applicant?.[0] || null;
      const applicantNumber = applicantBefore?.applicant_number || null;

      if (applicantNumber) {
        await db.query(
          `DELETE FROM interview_applicants WHERE applicant_id = ?`,
          [applicantNumber]
        );
        await db.query(
          `DELETE FROM person_status_table WHERE applicant_id = ?`,
          [applicantNumber]
        );
        await db.query(
          `DELETE FROM applicant_numbering_table WHERE applicant_number = ?`,
          [applicantNumber]
        );
      }

      await db.query(`DELETE FROM user_accounts WHERE person_id = ?`, [
        person_id,
      ]);

      const [personResult] = await db.query(
        `DELETE FROM person_table WHERE person_id = ?`,
        [person_id]
      );
      if (personResult.affectedRows === 0) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }

      const actorId =
        req.body?.audit_actor_id ||
        req.headers["x-audit-actor-id"] ||
        req.headers["x-employee-id"] ||
        "unknown";
      const actorRole =
        req.body?.audit_actor_role ||
        req.headers["x-audit-actor-role"] ||
        "registrar";
      const roleLabel = formatAuditActorRole(actorRole);
      const applicantName = [
        applicantBefore?.last_name,
        applicantBefore?.first_name,
        applicantBefore?.middle_name,
      ]
        .filter(Boolean)
        .join(", ");
      const accountLabel =
        applicantBefore?.applicant_number ||
        applicantName ||
        applicantBefore?.email ||
        `person_id ${person_id}`;

      await insertAuditLogAdmission({
        actorId,
        role: actorRole,
        action: "APPLICATION_ACCOUNT_PERMANENT_DELETE",
        severity: "CRITICAL",
        message: `${roleLabel} (${actorId}) permanently deleted account for Applicant (${accountLabel}).`,
      });

      res.json({
        success: true,
        message: "Account permanently deleted successfully",
      });
    } catch (error) {
      console.error("Permanent delete account error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to permanently delete account",
      });
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════
//  ROUTE: POST /verify-otp  (kept for any legacy flows — unchanged)
// ════════════════════════════════════════════════════════════════════════════
router.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res
      .status(400)
      .json({ message: "Email and OTP are required" });
  }

  const now = Date.now();
  const stored = otpStore[email];
  const record = loginAttempts[email] || { count: 0, lockUntil: null };

  if (record.lockUntil && record.lockUntil > now) {
    const secondsLeft = Math.ceil((record.lockUntil - now) / 1000);
    return res.status(429).json({
      message: `Too many failed attempts. Try again in ${secondsLeft}s.`,
    });
  }

  if (!stored) {
    return res
      .status(400)
      .json({ message: "No OTP request found for this email" });
  }

  if (stored.totpSecret) {
    return res
      .status(400)
      .json({ message: "No login OTP found for this email." });
  }

  if (stored.expiresAt < now) {
    delete otpStore[email];
    return res
      .status(400)
      .json({ message: "OTP has expired. Please request a new one." });
  }

  if (stored.otp !== otp.trim()) {
    record.count++;
    if (record.count >= 3) {
      record.lockUntil = now + 3 * 60 * 1000;
      loginAttempts[email] = record;
      return res.status(429).json({
        message: "Too many failed OTP attempts. Locked for 3 minutes.",
      });
    }
    loginAttempts[email] = record;
    return res.status(400).json({ message: "Invalid OTP. Please try again." });
  }

  const failureCount = stored?.authFailureCount || 0;
  const auditContext = stored?.auditContext || {};
  const successOutcome = failureCount >= 2 ? "SUCCESS_AFTER_FAILURES" : "SUCCESS";
  const insertOtpAuditLog = auditContext.auditLogger || insertAuditLogAdmission;
  await insertOtpAuditLog({
    actorId: auditContext.actorId || email,
    role: auditContext.role || "unknown",
    outcome: successOutcome,
  });

  delete otpStore[email];
  delete loginAttempts[email];

  res.json({ message: "OTP verified successfully" });
});

// ════════════════════════════════════════════════════════════════════════════
//  TOTP TOGGLE SETTINGS
//  Replaces the old require_otp routes. The UI (RegistrarResetPassword, etc.)
//  calls these to let each user turn TOTP on or off for their own account.
//  The column is now `totp_enabled` (1 = on, 0 = off, default 1).
// ════════════════════════════════════════════════════════════════════════════

// GET /get-otp-setting/:person_id  (legacy single-param form)
router.get("/get-otp-setting/:person_id", async (req, res) => {
  const { person_id } = req.params;
  try {
    const [[row]] = await db3.query(
      "SELECT totp_enabled FROM user_accounts WHERE person_id = ? LIMIT 1",
      [person_id]
    );
    res.json({ require_otp: row ? Number(row.totp_enabled) : 1 });
  } catch (err) {
    console.error("OTP fetch error:", err);
    res.status(500).json({ message: "Server error loading TOTP setting" });
  }
});

// GET /get-otp-setting/:type/:person_id  (typed form used by frontend)
router.get("/get-otp-setting/:type/:person_id", async (req, res) => {
  const { type, person_id } = req.params;
  if (!person_id || !type)
    return res.status(400).json({ message: "Missing parameters" });

  let table, idColumn;
  if (type === "user") { table = "user_accounts"; idColumn = "person_id"; }
  else if (type === "prof") { table = "prof_table"; idColumn = "employee_id"; }
  else return res.status(400).json({ message: "Invalid type" });

  try {
    const [[row]] = await db3.query(
      `SELECT totp_enabled FROM ${table} WHERE ${idColumn} = ? LIMIT 1`,
      [person_id]
    );
    res.json({ require_otp: row ? Number(row.totp_enabled) : 1 });
  } catch (err) {
    console.error("OTP fetch error:", err);
    res.status(500).json({ message: "Server error loading TOTP setting" });
  }
});

// POST /update-otp-setting
router.post("/update-otp-setting", async (req, res) => {
  const { type, person_id, employee_id, require_otp } = req.body;
  const accountId = type === "prof" ? employee_id || person_id : person_id;

  if (!accountId || !type)
    return res.status(400).json({ message: "Missing parameters" });

  let table, idColumn;
  if (type === "user") { table = "user_accounts"; idColumn = "person_id"; }
  else if (type === "prof") { table = "prof_table"; idColumn = "employee_id"; }
  else return res.status(400).json({ message: "Invalid type" });

  const newValue = Number(require_otp) === 1 ? 1 : 0;

  try {
    const [result] = await db3.query(
      `UPDATE ${table} SET totp_enabled = ? WHERE ${idColumn} = ?`,
      [newValue, accountId]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ message: "User not found" });

    res.json({
      success: true,
      message: newValue === 1
        ? "Google Authenticator has been enabled for your account."
        : "Google Authenticator has been disabled for your account.",
    });
  } catch (err) {
    console.error("Failed to update TOTP setting:", err);
    res.status(500).json({ message: "Server error updating TOTP setting" });
  }
});

router.get("/check-domain-mx", async (req, res) => {
  try {
    const { domain } = req.query;
    if (!domain) return res.json({ valid: false, suggestion: null });
    const valid = await isDomainReachable(`x@${domain}`);
    const suggestion = suggestEmailDomain(domain);
    return res.json({ valid, suggestion });
  } catch (error) {
    console.error("Domain MX check error:", error);
    return res.json({ valid: false, suggestion: null });
  }
});


// ────────────────────────────────────────────────────────────────────────────
//  STEP 2: verify the new code, THEN swap the secret in + reset password
// ────────────────────────────────────────────────────────────────────────────
router.post("/forgot-password-confirm", async (req, res) => {
  const { identifier, type, token } = req.body;
  const normalizedIdentifier = String(identifier || "").trim();
  const normalizedType = String(type || "").trim();
  const userMacAddress = await resolveUserMacAddress(req);
  const forgotPasswordAuditLogger =
    normalizedType === "applicant"
      ? insertAuditLogAdmission
      : insertAuditLogEnrollment;

  if (!normalizedIdentifier || !normalizedType || !token) {
    return res.status(400).json({
      success: false,
      message: "Missing identifier, type, or code.",
    });
  }

  if (!/^\d{6}$/.test(String(token).trim())) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid 6-digit code.",
    });
  }

  const tableInfo = TYPE_TABLE_MAP[normalizedType];
  if (!tableInfo) {
    return res.status(400).json({ success: false, message: "Invalid account type." });
  }

  // Basic brute-force guard on the confirm step, separate from login lockouts.
  const attemptKey = `fp_confirm::${normalizedType}::${normalizedIdentifier}`;
  const now = Date.now();
  if (!loginAttempts[attemptKey]) {
    loginAttempts[attemptKey] = { count: 0, lockUntil: null };
  }
  const record = loginAttempts[attemptKey];

  if (record.lockUntil && record.lockUntil > now) {
    const remainingSeconds = Math.ceil((record.lockUntil - now) / 1000);
    return res.status(429).json({
      success: false,
      locked: true,
      remainingSeconds,
      message: `Too many failed attempts. Try again in ${remainingSeconds} seconds.`,
    });
  }
  if (record.lockUntil && record.lockUntil <= now) {
    loginAttempts[attemptKey] = { count: 0, lockUntil: null };
  }

  const storeKey = `forgot_password_setup::${normalizedType}::${normalizedIdentifier}`;
  const stored = otpStore[storeKey];

  if (!stored) {
    return res.status(400).json({
      success: false,
      message: "No pending recovery request found. Please start over.",
    });
  }

  if (stored.expiresAt < now) {
    delete otpStore[storeKey];
    return res.status(400).json({
      success: false,
      message: "This recovery QR code has expired. Please start over.",
    });
  }

  const isValid = speakeasy.totp.verify({
    secret: stored.totpSecret,
    encoding: "base32",
    token: String(token).trim(),
    window: 1,
  });

  if (!isValid) {
    loginAttempts[attemptKey].count++;
    if (loginAttempts[attemptKey].count >= 3) {
      loginAttempts[attemptKey].lockUntil = now + 3 * 60 * 1000;
      await forgotPasswordAuditLogger({
        actorId: normalizedIdentifier,
        role: normalizedType,
        action: "FORGOT_PASSWORD_QR_CONFIRM",
        outcome: "LOCKED",
        reason: "Too many invalid recovery codes",
        userMacAddress,
      });
      return res.status(429).json({
        success: false,
        locked: true,
        remainingSeconds: 180,
        message: "Too many failed attempts. Locked for 3 minutes.",
      });
    }
    await forgotPasswordAuditLogger({
      actorId: normalizedIdentifier,
      role: normalizedType,
      action: "FORGOT_PASSWORD_QR_CONFIRM",
      outcome: "FAILED",
      reason: "Invalid recovery code",
      userMacAddress,
    });
    return res.status(400).json({
      success: false,
      message: "Incorrect code. Wait for it to refresh and try again.",
    });
  }

  try {
    const newPassword = generateTempPassword();
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await tableInfo.db.query(
      `UPDATE ${tableInfo.table}
       SET totp_secret = ?, totp_verified = 1, password = ?, force_password_change = 1
       WHERE ${tableInfo.idColumn} = ?`,
      [stored.totpSecret, hashedPassword, stored.accountId]
    );

    const displayName = stored.displayName || "Unknown User";
    const accountEmail = stored.email || "unknown";

    delete otpStore[storeKey];
    delete loginAttempts[attemptKey];

    await forgotPasswordAuditLogger({
      actorId: normalizedIdentifier,
      role: normalizedType,
      action: "FORGOT_PASSWORD_QR_CONFIRM",
      severity: "WARNING",
      outcome: "SUCCESS",
      message: `The user ${displayName} ${accountEmail} reset the password.`,
      userMacAddress,
    });

    return res.json({
      success: true,
      temp_password: newPassword,
      message: "Authenticator re-linked and password reset successfully.",
    });
  } catch (error) {
    console.error("forgot-password-confirm error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

router.post("/forgot-password-init", async (req, res) => {
  const { identifier, email, birthdate } = req.body;
  const normalizedIdentifier = String(identifier || "").trim();
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedIdentifier || !normalizedEmail) {
    return res.status(400).json({
      success: false,
      message: "ID and email are required.",
    });
  }

  const genericFailure = {
    success: false,
    message:
      "We couldn't find a matching account. Please check your ID and email address.",
  };

  try {
    const account = await resolveForgotPasswordAccount(normalizedIdentifier);

    const emailMatches =
      account && String(account.email || "").trim().toLowerCase() === normalizedEmail;

    // Applicants get an extra birthdate check to match the old flow's strength
    const birthdateMatches =
      !account || account.type !== "applicant"
        ? true
        : String(account.birthOfDate || "").slice(0, 10) ===
        String(birthdate || "").slice(0, 10);

    if (!account || !emailMatches || !birthdateMatches) {
      await insertAuditLogAdmission({
        actorId: normalizedIdentifier,
        role: account?.type || "unknown",
        action: "FORGOT_PASSWORD_QR_INIT",
        outcome: "FAILED",
        reason: "Identifier/email/birthdate did not match any account",
      });
      return res.status(404).json(genericFailure);
    }

    const shortTerm = await getShortTerm();
    const secret = speakeasy.generateSecret({
      name: `${shortTerm} Recovery (${normalizedIdentifier})`,
      issuer: shortTerm,
      length: 20,
    });

    otpStore[`forgot_password_setup::${account.type}::${normalizedIdentifier}`] = {
      totpSecret: secret.base32,
      accountId: account.id,
      email: account.email || normalizedEmail,
      displayName: account.displayName || buildForgotPasswordDisplayName(account),
      expiresAt: Date.now() + 10 * 60 * 1000,
    };

    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url, {
      color: { dark: "#000000", light: "#FFFFFF" },
      width: 220,
      margin: 2,
    });

    await insertAuditLogAdmission({
      actorId: normalizedIdentifier,
      role: account.type,
      action: "FORGOT_PASSWORD_QR_INIT",
      outcome: "SUCCESS",
      message: `Identity verified for (${normalizedIdentifier}); new recovery QR issued.`,
    });

    return res.json({
      success: true,
      qrDataUrl,
      manualKey: secret.base32,
      type: account.type,
      identifier: normalizedIdentifier,
    });
  } catch (error) {
    console.error("forgot-password-init error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

router.get("/get_user_account_id/:person_id", async (req, res) => {
  const { person_id } = req.params;
  try {
    const [rows] = await db3.query(
      "SELECT id FROM user_accounts WHERE person_id = ? LIMIT 1",
      [person_id],
    );
    if (rows.length === 0)
      return res.status(404).json({ message: "User not found" });
    res.json({ user_account_id: rows[0].id });
  } catch (err) {
    console.error(" Error fetching user_account_id:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const passwordVerifyAttempts = new Map();

const MAX_ATTEMPTS = 3;

const LOCK_DURATION_MS = 3 * 60 * 1000;

router.get("/check-lock-status/:person_id", (req, res) => {
  const { person_id } = req.params;
  const key = `person_${person_id}`;
  const now = Date.now();
  const record = passwordVerifyAttempts.get(key) || { attempts: 0, lockedUntil: null };

  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingMs = record.lockedUntil - now;
    const remainingSec = Math.ceil(remainingMs / 1000);
    return res.json({
      locked: true,
      remainingSeconds: remainingSec,
    });
  }

  if (record.lockedUntil && now >= record.lockedUntil) {
    passwordVerifyAttempts.set(key, { attempts: 0, lockedUntil: null });
  }

  res.json({ locked: false, remainingSeconds: 0 });
});

router.post("/verify-password", async (req, res) => {
  const { person_id, password } = req.body;

  if (!person_id || !password) {
    return res.status(400).json({ success: false, message: "Person ID and password required" });
  }

  const key = `person_${person_id}`;
  const now = Date.now();

  // 🔒 Check if currently locked
  const record = passwordVerifyAttempts.get(key) || { attempts: 0, lockedUntil: null };

  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingMs = record.lockedUntil - now;
    const remainingSec = Math.ceil(remainingMs / 1000);
    return res.status(429).json({
      success: false,
      locked: true,
      remainingSeconds: remainingSec,
      message: `Account locked. Try again in ${Math.ceil(remainingSec / 60)} minute(s).`,
    });
  }

  // Reset if lock expired
  if (record.lockedUntil && now >= record.lockedUntil) {
    passwordVerifyAttempts.set(key, { attempts: 0, lockedUntil: null });
  }

  try {
    const [rows] = await db3.query(
      "SELECT * FROM user_accounts WHERE person_id = ?",
      [person_id]
    );

    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: "User not found" });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      const current = passwordVerifyAttempts.get(key) || { attempts: 0, lockedUntil: null };
      const newAttempts = current.attempts + 1;

      if (newAttempts >= MAX_ATTEMPTS) {
        passwordVerifyAttempts.set(key, { attempts: newAttempts, lockedUntil: now + LOCK_DURATION_MS });
        return res.status(429).json({
          success: false,
          locked: true,
          remainingSeconds: LOCK_DURATION_MS / 1000,
          message: "Too many failed attempts. Locked for 3 minutes.",
        });
      }

      passwordVerifyAttempts.set(key, { attempts: newAttempts, lockedUntil: null });
      return res.status(401).json({
        success: false,
        locked: false,
        attemptsLeft: MAX_ATTEMPTS - newAttempts,
        message: `Invalid password. ${MAX_ATTEMPTS - newAttempts} attempt(s) remaining.`,
      });
    }

    // ✅ Success — clear attempts
    passwordVerifyAttempts.delete(key);
    res.json({ success: true });

  } catch (err) {
    console.error("verify-password error:", err);
    res.status(500).json({ success: false, message: "Server error during password verification" });
  }
});

module.exports = router;
