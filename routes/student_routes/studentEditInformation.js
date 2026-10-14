const express = require("express");
const webtoken = require("jsonwebtoken");
const { db3 } = require("../database/database");
const {
  insertAuditLogEnrollment,
  resolveAuditActor,
} = require("../../utils/auditLogger");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// FIELD CATALOG
//
// This mirrors the SECTIONS definitions used by the 5 admin permission
// dashboards (StudentEditPermissions / 2 / 3 / 4 / 5). It is the single
// source of truth for:
//   - which columns in person_table a student is ever allowed to touch
//   - which of those are "system" (always locked, admin cannot unlock)
//   - which are "togglable" (admin controls via student_edit_permissions)
//
// step        → matches current_step gating used elsewhere (checkStepAccess)
// system      → true = always read-only for students, never editable
// defaultOn   → fallback used ONLY if no row exists yet in
//               student_edit_permissions for that field id
// ─────────────────────────────────────────────────────────────────────────────
const FIELD_CATALOG = [
  // ---- Step 1: Personal Information -----------------------------------
  { id: "campus", label: "Campus", section: "Enrollment Info", step: 1, system: true },
  { id: "academicProgram", label: "Academic Program", section: "Enrollment Info", step: 1, system: true },
  { id: "classifiedAs", label: "Classified As", section: "Enrollment Info", step: 1, system: false, defaultOn: false },
  { id: "applyingAs", label: "Applying As", section: "Enrollment Info", step: 1, system: false, defaultOn: false },
  { id: "program", label: "Course Applied", section: "Enrollment Info", step: 1, system: true },
  { id: "yearLevel", label: "Year Level", section: "Enrollment Info", step: 1, system: true },

  { id: "last_name", label: "Last Name", section: "Personal Details", step: 1, system: true },
  { id: "first_name", label: "First Name", section: "Personal Details", step: 1, system: true },
  { id: "middle_name", label: "Middle Name", section: "Personal Details", step: 1, system: true },
  { id: "extension", label: "Extension (Jr./Sr.)", section: "Personal Details", step: 1, system: false, defaultOn: true },
  { id: "nickname", label: "Nickname", section: "Personal Details", step: 1, system: false, defaultOn: true },
  { id: "height", label: "Height (cm)", section: "Personal Details", step: 1, system: false, defaultOn: true },
  { id: "weight", label: "Weight (kg)", section: "Personal Details", step: 1, system: false, defaultOn: true },
  { id: "gender", label: "Gender / Sex", section: "Personal Details", step: 1, system: true },
  { id: "lrnNumber", label: "LRN Number", section: "Personal Details", step: 1, system: true },
  { id: "pwdMember", label: "PWD Status", section: "Personal Details", step: 1, system: false, defaultOn: true },
  { id: "birthOfDate", label: "Birth Date", section: "Personal Details", step: 1, system: true },
  { id: "birthPlace", label: "Birth Place", section: "Personal Details", step: 1, system: true },
  { id: "age", label: "Age (auto-computed)", section: "Personal Details", step: 1, system: true },

  { id: "languageDialectSpoken", label: "Language / Dialect Spoken", section: "Demographics", step: 1, system: false, defaultOn: true },
  { id: "citizenship", label: "Citizenship", section: "Demographics", step: 1, system: true },
  { id: "religion", label: "Religion", section: "Demographics", step: 1, system: false, defaultOn: true },
  { id: "civilStatus", label: "Civil Status", section: "Demographics", step: 1, system: true },
  { id: "tribeEthnicGroup", label: "Tribe / Ethnic Group", section: "Demographics", step: 1, system: false, defaultOn: true },

  { id: "cellphoneNumber", label: "Contact Number", section: "Contact Info", step: 1, system: false, defaultOn: true },
  { id: "facebook_account", label: "Facebook Account", section: "Contact Info", step: 1, system: false, defaultOn: true },
  { id: "emailAddress", label: "Email Address", section: "Contact Info", step: 1, system: true },

  { id: "presentStreet", label: "Street (Present)", section: "Present Address", step: 1, system: true },
  { id: "presentZipCode", label: "Zip Code (Present)", section: "Present Address", step: 1, system: false, defaultOn: true },
  { id: "presentRegion", label: "Region (Present)", section: "Present Address", step: 1, system: false, defaultOn: true },
  { id: "presentProvince", label: "Province (Present)", section: "Present Address", step: 1, system: false, defaultOn: true },
  { id: "presentMunicipality", label: "Municipality (Present)", section: "Present Address", step: 1, system: false, defaultOn: true },
  { id: "presentBarangay", label: "Barangay (Present)", section: "Present Address", step: 1, system: false, defaultOn: true },
  { id: "presentDswdHouseholdNumber", label: "DSWD Household No. (Present)", section: "Present Address", step: 1, system: false, defaultOn: true },

  { id: "permanentStreet", label: "Street (Permanent)", section: "Permanent Address", step: 1, system: true },
  { id: "permanentZipCode", label: "Zip Code (Permanent)", section: "Permanent Address", step: 1, system: false, defaultOn: true },
  { id: "permanentRegion", label: "Region (Permanent)", section: "Permanent Address", step: 1, system: false, defaultOn: true },
  { id: "permanentProvince", label: "Province (Permanent)", section: "Permanent Address", step: 1, system: false, defaultOn: true },
  { id: "permanentMunicipality", label: "Municipality (Permanent)", section: "Permanent Address", step: 1, system: false, defaultOn: true },
  { id: "permanentBarangay", label: "Barangay (Permanent)", section: "Permanent Address", step: 1, system: false, defaultOn: true },
  { id: "permanentDswdHouseholdNumber", label: "DSWD Household No. (Permanent)", section: "Permanent Address", step: 1, system: false, defaultOn: true },

  { id: "profile_img", label: "Upload / Change Photo", section: "Profile Photo", step: 1, system: false, defaultOn: true },

  // ---- Step 2: Family Background ---------------------------------------
  { id: "solo_parent", label: "Solo Parent / Parent Type", section: "Solo Parent", step: 2, system: false, defaultOn: true },

  { id: "father_family_name", label: "Father Last Name", section: "Father — Basic Info", step: 2, system: true },
  { id: "father_given_name", label: "Father First Name", section: "Father — Basic Info", step: 2, system: true },
  { id: "father_middle_name", label: "Father Middle Name", section: "Father — Basic Info", step: 2, system: true },
  { id: "father_ext", label: "Father Extension", section: "Father — Basic Info", step: 2, system: false, defaultOn: true },
  { id: "father_nickname", label: "Father Nickname", section: "Father — Basic Info", step: 2, system: false, defaultOn: true },

  { id: "father_education_level", label: "Father Education Level", section: "Father — Educational Background", step: 2, system: false, defaultOn: true },
  { id: "father_last_school", label: "Father Last School", section: "Father — Educational Background", step: 2, system: false, defaultOn: true },
  { id: "father_course", label: "Father Course", section: "Father — Educational Background", step: 2, system: false, defaultOn: true },
  { id: "father_year_graduated", label: "Father Year Graduated", section: "Father — Educational Background", step: 2, system: false, defaultOn: true },
  { id: "father_school_address", label: "Father School Address", section: "Father — Educational Background", step: 2, system: false, defaultOn: true },

  { id: "father_contact", label: "Father Contact Number", section: "Father — Contact Information", step: 2, system: false, defaultOn: true },
  { id: "father_occupation", label: "Father Occupation", section: "Father — Contact Information", step: 2, system: false, defaultOn: true },
  { id: "father_employer", label: "Father Employer", section: "Father — Contact Information", step: 2, system: false, defaultOn: true },
  { id: "father_income", label: "Father Income", section: "Father — Contact Information", step: 2, system: false, defaultOn: true },
  { id: "father_email", label: "Father Email", section: "Father — Contact Information", step: 2, system: false, defaultOn: true },

  { id: "mother_family_name", label: "Mother Last Name", section: "Mother — Basic Info", step: 2, system: true },
  { id: "mother_given_name", label: "Mother First Name", section: "Mother — Basic Info", step: 2, system: true },
  { id: "mother_middle_name", label: "Mother Middle Name", section: "Mother — Basic Info", step: 2, system: true },
  { id: "mother_ext", label: "Mother Extension", section: "Mother — Basic Info", step: 2, system: false, defaultOn: true },
  { id: "mother_nickname", label: "Mother Nickname", section: "Mother — Basic Info", step: 2, system: false, defaultOn: true },

  { id: "mother_education_level", label: "Mother Education Level", section: "Mother — Educational Background", step: 2, system: false, defaultOn: true },
  { id: "mother_last_school", label: "Mother Last School", section: "Mother — Educational Background", step: 2, system: false, defaultOn: true },
  { id: "mother_course", label: "Mother Course", section: "Mother — Educational Background", step: 2, system: false, defaultOn: true },
  { id: "mother_year_graduated", label: "Mother Year Graduated", section: "Mother — Educational Background", step: 2, system: false, defaultOn: true },
  { id: "mother_school_address", label: "Mother School Address", section: "Mother — Educational Background", step: 2, system: false, defaultOn: true },

  { id: "mother_contact", label: "Mother Contact Number", section: "Mother — Contact Information", step: 2, system: false, defaultOn: true },
  { id: "mother_occupation", label: "Mother Occupation", section: "Mother — Contact Information", step: 2, system: false, defaultOn: true },
  { id: "mother_employer", label: "Mother Employer", section: "Mother — Contact Information", step: 2, system: false, defaultOn: true },
  { id: "mother_income", label: "Mother Income", section: "Mother — Contact Information", step: 2, system: false, defaultOn: true },
  { id: "mother_email", label: "Mother Email", section: "Mother — Contact Information", step: 2, system: false, defaultOn: true },

  { id: "guardian", label: "Guardian Relationship", section: "Guardian / Emergency Contact", step: 2, system: false, defaultOn: true },
  { id: "guardian_family_name", label: "Guardian Last Name", section: "Guardian / Emergency Contact", step: 2, system: true },
  { id: "guardian_given_name", label: "Guardian First Name", section: "Guardian / Emergency Contact", step: 2, system: true },
  { id: "guardian_middle_name", label: "Guardian Middle Name", section: "Guardian / Emergency Contact", step: 2, system: true },
  { id: "guardian_ext", label: "Guardian Extension", section: "Guardian / Emergency Contact", step: 2, system: false, defaultOn: true },
  { id: "guardian_nickname", label: "Guardian Nickname", section: "Guardian / Emergency Contact", step: 2, system: false, defaultOn: true },
  { id: "guardian_address", label: "Guardian Address", section: "Guardian / Emergency Contact", step: 2, system: false, defaultOn: true },
  { id: "guardian_contact", label: "Guardian Contact", section: "Guardian / Emergency Contact", step: 2, system: false, defaultOn: true },
  { id: "guardian_email", label: "Guardian Email", section: "Guardian / Emergency Contact", step: 2, system: false, defaultOn: true },

  { id: "has_no_siblings", label: "No Siblings (checkbox)", section: "Siblings", step: 2, system: false, defaultOn: true },
  { id: "siblings", label: "Siblings Information", section: "Siblings", step: 2, system: false, defaultOn: true },

  { id: "annual_income", label: "Annual Income Bracket", section: "Family Annual Income", step: 2, system: false, defaultOn: true },

  // ---- Step 3: Educational Attainment -----------------------------------
  { id: "schoolLevel", label: "Educational Attainment (JHS)", section: "Junior High School — Basic Info", step: 3, system: false, defaultOn: true },
  { id: "schoolLastAttended", label: "School Last Attended (JHS)", section: "Junior High School — Basic Info", step: 3, system: false, defaultOn: true },
  { id: "schoolAddress", label: "School Full Address (JHS)", section: "Junior High School — Basic Info", step: 3, system: false, defaultOn: true },
  { id: "courseProgram", label: "Course Program (JHS)", section: "Junior High School — Basic Info", step: 3, system: false, defaultOn: true },

  { id: "honor", label: "Recognition / Awards (JHS)", section: "Junior High School — Academic Results", step: 3, system: false, defaultOn: true },
  { id: "generalAverage", label: "General Average (JHS)", section: "Junior High School — Academic Results", step: 3, system: false, defaultOn: true },
  { id: "yearGraduated", label: "Year Graduated (JHS)", section: "Junior High School — Academic Results", step: 3, system: false, defaultOn: true },

  { id: "schoolLevel1", label: "Educational Attainment (SHS)", section: "Senior High School — Basic Info", step: 3, system: false, defaultOn: true },
  { id: "schoolLastAttended1", label: "School Last Attended (SHS)", section: "Senior High School — Basic Info", step: 3, system: false, defaultOn: true },
  { id: "schoolAddress1", label: "School Full Address (SHS)", section: "Senior High School — Basic Info", step: 3, system: false, defaultOn: true },
  { id: "courseProgram1", label: "Course Program (SHS)", section: "Senior High School — Basic Info", step: 3, system: false, defaultOn: true },

  { id: "honor1", label: "Recognition / Awards (SHS)", section: "Senior High School — Academic Results", step: 3, system: false, defaultOn: true },
  { id: "generalAverage1", label: "General Average (SHS)", section: "Senior High School — Academic Results", step: 3, system: false, defaultOn: true },
  { id: "yearGraduated1", label: "Year Graduated (SHS)", section: "Senior High School — Academic Results", step: 3, system: false, defaultOn: true },

  { id: "strand", label: "SHS Strand / Track", section: "Strand", step: 3, system: false, defaultOn: true },

  // ---- Step 4: Health & Medical Records ----------------------------------
  { id: "cough", label: "Cough (symptom today)", section: "Current Symptoms", step: 4, system: false, defaultOn: true },
  { id: "colds", label: "Colds (symptom today)", section: "Current Symptoms", step: 4, system: false, defaultOn: true },
  { id: "fever", label: "Fever (symptom today)", section: "Current Symptoms", step: 4, system: false, defaultOn: true },

  { id: "asthma", label: "Asthma", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "faintingSpells", label: "Fainting Spells and Seizures", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "heartDisease", label: "Heart Disease", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "tuberculosis", label: "Tuberculosis", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "frequentHeadaches", label: "Frequent Headaches", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "hernia", label: "Hernia", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "chronicCough", label: "Chronic Cough", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "headNeckInjury", label: "Head or Neck Injury", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "hiv", label: "H.I.V", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "highBloodPressure", label: "High Blood Pressure", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "diabetesMellitus", label: "Diabetes Mellitus", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "allergies", label: "Allergies", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "cancer", label: "Cancer", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "smokingCigarette", label: "Smoking of Cigarette/Day", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },
  { id: "alcoholDrinking", label: "Alcohol Drinking", section: "Medical History Conditions", step: 4, system: false, defaultOn: true },

  { id: "hospitalized", label: "Hospitalization History (Yes/No)", section: "Hospitalization History", step: 4, system: false, defaultOn: true },
  { id: "hospitalizationDetails", label: "Hospitalization Details", section: "Hospitalization History", step: 4, system: false, defaultOn: true },

  { id: "medications", label: "Current Medications", section: "Medication", step: 4, system: false, defaultOn: true },

  { id: "hadCovid", label: "COVID-19 History (Yes/No)", section: "COVID Profile", step: 4, system: false, defaultOn: true },
  { id: "covidDate", label: "COVID-19 Date", section: "COVID Profile", step: 4, system: false, defaultOn: true },
  { id: "vaccine1Brand", label: "1st Dose Brand", section: "COVID Profile", step: 4, system: false, defaultOn: true },
  { id: "vaccine1Date", label: "1st Dose Date", section: "COVID Profile", step: 4, system: false, defaultOn: true },
  { id: "vaccine2Brand", label: "2nd Dose Brand", section: "COVID Profile", step: 4, system: false, defaultOn: true },
  { id: "vaccine2Date", label: "2nd Dose Date", section: "COVID Profile", step: 4, system: false, defaultOn: true },
  { id: "booster1Brand", label: "Booster 1 Brand", section: "COVID Profile", step: 4, system: false, defaultOn: true },
  { id: "booster1Date", label: "Booster 1 Date", section: "COVID Profile", step: 4, system: false, defaultOn: true },
  { id: "booster2Brand", label: "Booster 2 Brand", section: "COVID Profile", step: 4, system: false, defaultOn: true },
  { id: "booster2Date", label: "Booster 2 Date", section: "COVID Profile", step: 4, system: false, defaultOn: true },

  { id: "chestXray", label: "Chest X-ray Result", section: "Laboratory Results", step: 4, system: false, defaultOn: true },
  { id: "cbc", label: "CBC Result", section: "Laboratory Results", step: 4, system: false, defaultOn: true },
  { id: "urinalysis", label: "Urinalysis Result", section: "Laboratory Results", step: 4, system: false, defaultOn: true },
  { id: "otherworkups", label: "Other Workups Result", section: "Laboratory Results", step: 4, system: false, defaultOn: true },

  { id: "symptomsToday", label: "Diagnosis (Physically Fit / For Compliance)", section: "Diagnosis & Remarks (Medical Staff Only)", step: 4, system: true },
  { id: "remarks", label: "Remarks", section: "Diagnosis & Remarks (Medical Staff Only)", step: 4, system: true },

  // ---- Step 5: Other Information ----------------------------------------
  { id: "termsOfAgreement", label: "I agree to Terms of Agreement (checkbox)", section: "Terms of Agreement", step: 5, system: false, defaultOn: true },
];

// Quick lookup maps built once at module load
const FIELD_MAP = new Map(FIELD_CATALOG.map((f) => [f.id, f]));
const TOGGLABLE_FIELD_IDS = FIELD_CATALOG.filter((f) => !f.system).map((f) => f.id);
const SYSTEM_FIELD_IDS = new Set(FIELD_CATALOG.filter((f) => f.system).map((f) => f.id));

const formatAuditActorRole = (role, fallback = "Student") => {
  const safeRole = String(role || "").trim();
  if (!safeRole) return fallback;
  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

// ── Bearer-token decode (best-effort — falls back to headers/body if absent) ─
const getBearerPayload = (req) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return null;
  try {
    return webtoken.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
};

const formatPersonFullName = (person, fallback = "Unknown person") => {
  const fullName = [
    person?.first_name || person?.fname,
    person?.middle_name || person?.mname,
    person?.last_name || person?.lname,
    person?.extension,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  return fullName || fallback;
};

// ── Resolve WHO is making a permissions change (registrar/superadmin) ───────
// Looks up user_accounts + access_table for a friendly display name and
// access-level label, falling back gracefully to headers/body if the DB
// lookup misses. This is the same resolution logic the permissions
// endpoints relied on in server.js, kept local so this router has no
// dependency on server.js internals.
const getAuditEventActorFromRequest = async (req) => {
  const tokenPayload = getBearerPayload(req) || {};
  const lookupId =
    req.body?.actor_person_id ||
    tokenPayload.person_id ||
    req.headers["x-audit-actor-person-id"] ||
    req.headers["x-audit-actor-id"] ||
    tokenPayload.employee_id ||
    req.body?.actor_employee_id ||
    "unknown";
  const lookupEmail = tokenPayload.email || req.headers["x-audit-actor-email"] || "";

  try {
    const [rows] = await db3.query(
      `
      SELECT
        ua.employee_id,
        ua.email,
        ua.first_name,
        ua.middle_name,
        ua.last_name,
        at.access_description
      FROM user_accounts ua
      LEFT JOIN access_table at ON at.access_id = ua.access_level
      WHERE ua.person_id = ? OR ua.employee_id = ? OR ua.email = ?
      LIMIT 1
      `,
      [lookupId, lookupId, lookupEmail || lookupId],
    );

    if (rows?.[0]) {
      const actor = rows[0];
      return {
        id: actor.employee_id || lookupId,
        email: actor.email || lookupEmail || "unknown",
        name: formatPersonFullName(actor, actor.email || lookupId),
        accessDescription: actor.access_description || "",
      };
    }
  } catch (error) {
    console.error("Audit actor lookup failed:", error);
  }

  return {
    id: req.body?.actor_employee_id || lookupId,
    email: lookupEmail || "unknown",
    name: req.headers["x-audit-actor-name"] || lookupEmail || lookupId,
    accessDescription: req.headers["x-audit-actor-role"] || "",
  };
};

// ── Load the current admin-configured permission map ────────────────────────
// Returns { fieldId: true/false }. Any togglable field with no saved row
// falls back to its defaultOn value (mirrors buildDefaultState() on the
// dashboards) so behavior matches what the admin UI shows before the first
// save.
const getPermissionMap = async () => {
  const [rows] = await db3.query(
    "SELECT field_id, is_editable FROM student_edit_permissions",
  );
  const saved = {};
  rows.forEach((r) => {
    saved[r.field_id] = Number(r.is_editable) === 1;
  });

  const map = {};
  TOGGLABLE_FIELD_IDS.forEach((fieldId) => {
    map[fieldId] = Object.prototype.hasOwnProperty.call(saved, fieldId)
      ? saved[fieldId]
      : Boolean(FIELD_MAP.get(fieldId)?.defaultOn);
  });
  return map;
};

const isFieldEditableByStudent = (fieldId, permissionMap) => {
  const field = FIELD_MAP.get(fieldId);
  if (!field) return false; // unknown field — never allowed
  if (field.system) return false; // system fields are never student-editable
  return Boolean(permissionMap[fieldId]);
};

const getStudentActor = (req) => {
  const { actorId, actorRole } = resolveAuditActor(req);
  return {
    actorId: actorId || req.params.person_id || "unknown",
    actorRole: actorRole || "student",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/student_edit_permissions
// Used by the 5 admin permission dashboards (StudentEditPermissions,
// StudentEditPermissions2-5) to load current toggle state on mount.
// Returns { fieldId: true/false, ... } — NOT wrapped in { success, data }
// on purpose, since the dashboards' fetchPermissions() consumes the raw
// object directly (see Object.entries(res.data)).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student_edit_permissions", async (req, res) => {
  try {
    const [rows] = await db3.query(
      "SELECT field_id, is_editable FROM student_edit_permissions",
    );
    const result = {};
    rows.forEach((r) => {
      result[r.field_id] = r.is_editable === 1;
    });
    res.json(result);
  } catch (err) {
    console.error("GET student_edit_permissions:", err);
    res.status(500).json({ error: "Failed to fetch permissions" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/student_edit_permissions
// Used by the 5 admin permission dashboards' handleSave()/handleReset() to
// persist toggle changes. Body shapes accepted:
//   { fieldId: true/false, ... }
//   or: {
//         permissions: { fieldId: true/false },
//         field_labels?: { fieldId: "Label" },
//         field_sections?: { fieldId: "Section Title" },
//         reset_to_defaults?: true
//       }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/student_edit_permissions", async (req, res) => {
  try {
    const rawBody = req.body || {};
    const permissions =
      rawBody.permissions &&
        typeof rawBody.permissions === "object" &&
        !Array.isArray(rawBody.permissions)
        ? rawBody.permissions
        : rawBody;
    const fieldSections =
      rawBody.field_sections &&
        typeof rawBody.field_sections === "object" &&
        !Array.isArray(rawBody.field_sections)
        ? rawBody.field_sections
        : {};

    const entries = Object.entries(permissions).filter(
      ([key]) =>
        key !== "permissions" &&
        key !== "field_labels" &&
        key !== "field_sections" &&
        key !== "reset_to_defaults",
    );
    if (entries.length === 0) return res.json({ success: true });

    const isResetToDefaults = Boolean(rawBody.reset_to_defaults);

    const fieldIds = entries.map(([fieldId]) => fieldId);
    const [existingRows] = await db3.query(
      `SELECT field_id, is_editable
       FROM student_edit_permissions
       WHERE field_id IN (?)`,
      [fieldIds],
    );
    const existingMap = {};
    (existingRows || []).forEach((row) => {
      existingMap[row.field_id] = Number(row.is_editable) === 1;
    });

    const turnedOnBySection = {};
    const turnedOffBySection = {};
    entries.forEach(([fieldId, val]) => {
      const nextValue = Boolean(val);
      const previousValue = Object.prototype.hasOwnProperty.call(existingMap, fieldId)
        ? existingMap[fieldId]
        : null;
      if (previousValue === nextValue) return;

      const sectionTitle =
        String(fieldSections[fieldId] || "").trim() || "General";
      if (nextValue) {
        turnedOnBySection[sectionTitle] =
          (turnedOnBySection[sectionTitle] || 0) + 1;
      } else {
        turnedOffBySection[sectionTitle] =
          (turnedOffBySection[sectionTitle] || 0) + 1;
      }
    });

    const formatTogglePhrase = (count, direction) => {
      const noun = count === 1 ? "toggle" : "toggles";
      const verb = count === 1 ? "was" : "were";
      return `${count} ${noun} ${verb} turned ${direction}`;
    };

    const changedSections = [
      ...new Set([
        ...Object.keys(turnedOnBySection),
        ...Object.keys(turnedOffBySection),
      ]),
    ];
    const changeParts = changedSections.map((sectionTitle) => {
      const phrases = [];
      if (turnedOnBySection[sectionTitle]) {
        phrases.push(formatTogglePhrase(turnedOnBySection[sectionTitle], "on"));
      }
      if (turnedOffBySection[sectionTitle]) {
        phrases.push(formatTogglePhrase(turnedOffBySection[sectionTitle], "off"));
      }
      return `${sectionTitle} and ${phrases.join(" and ")}`;
    });

    // Build bulk upsert
    const values = entries.map(([fieldId, val]) => [fieldId, val ? 1 : 0]);
    await db3.query(
      `INSERT INTO student_edit_permissions (field_id, is_editable)
       VALUES ?
       ON DUPLICATE KEY UPDATE is_editable = VALUES(is_editable)`,
      [values],
    );

    const actor = await getAuditEventActorFromRequest(req);
    const roleLabel =
      String(actor.accessDescription || "").trim() ||
      formatAuditActorRole(
        req.headers["x-audit-actor-role"] ||
          req.body?.audit_actor_role ||
          "registrar",
        "Registrar",
      );
    const actorId = actor.id || "unknown";
    const actorName = actor.name || actor.email || actorId;
    const pageLabel =
      String(req.headers["x-audit-change-section"] || "").trim() ||
      "Student Edit Permissions";
    const actorDisplay = `${roleLabel} ${actorName} (${actorId})`;
    const lockedCount = entries.filter(([, val]) => !Boolean(val)).length;
    const changeSummary =
      changeParts.length > 0 ? changeParts.join("; ") : "no field changes";

    const auditAction = isResetToDefaults
      ? "STUDENT_EDIT_PERMISSIONS_RESET"
      : "STUDENT_EDIT_PERMISSIONS_UPDATE";
    const auditMessage = isResetToDefaults
      ? `${actorDisplay} reset student edit permissions for ${pageLabel} to defaults (all fields locked${lockedCount ? `, ${lockedCount} toggle${lockedCount === 1 ? "" : "s"}` : ""}).`
      : `${actorDisplay} updated student edit permissions for ${pageLabel}: ${changeSummary}.`;

    await insertAuditLogEnrollment({
      actorId,
      role: roleLabel,
      action: auditAction,
      severity: "INFO",
      message: auditMessage,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("POST student_edit_permissions:", err);
    res.status(500).json({ error: "Failed to save permissions" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/student-edit-info/catalog
// Returns the full field catalog (id, label, section, step, system flag).
// Used by the frontend to render forms without hardcoding field metadata.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student-edit-info/catalog", (req, res) => {
  res.json({ success: true, fields: FIELD_CATALOG });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/student-edit-info/:person_id
// Returns the student's own person_table row (ENROLLMENT / db3), each
// catalog field annotated with whether the student is currently allowed to
// edit it. This lets the frontend disable/lock inputs in sync with what the
// PUT endpoint will actually accept.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student-edit-info/:person_id", async (req, res) => {
  const { person_id } = req.params;

  try {
    const [[person]] = await db3.query(
      "SELECT * FROM person_table WHERE person_id = ? LIMIT 1",
      [person_id],
    );

    if (!person) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    const permissionMap = await getPermissionMap();

    const fields = FIELD_CATALOG.map((field) => ({
      id: field.id,
      label: field.label,
      section: field.section,
      step: field.step,
      system: field.system,
      editable: field.system ? false : Boolean(permissionMap[field.id]),
      value: Object.prototype.hasOwnProperty.call(person, field.id)
        ? person[field.id]
        : null,
    }));

    res.json({
      success: true,
      person_id,
      fields,
    });
  } catch (err) {
    console.error("GET /student-edit-info/:person_id error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/student-edit-info/:person_id
// Student self-service update. Body: { fields: { fieldId: value, ... } }
//
// Server-side enforcement:
//   - Unknown keys (not in FIELD_CATALOG) are always rejected.
//   - system:true fields are always rejected, regardless of admin toggles.
//   - system:false fields are only accepted if student_edit_permissions
//     currently has that field turned ON.
// Any rejected field is reported back in `skipped` rather than silently
// failing, so the frontend can surface why a save was partial.
// ─────────────────────────────────────────────────────────────────────────────
router.put("/student-edit-info/:person_id", async (req, res) => {
  const { person_id } = req.params;
  const submittedFields =
    req.body && typeof req.body.fields === "object" && !Array.isArray(req.body.fields)
      ? req.body.fields
      : {};

  const submittedEntries = Object.entries(submittedFields);
  if (submittedEntries.length === 0) {
    return res.status(400).json({ success: false, message: "No fields provided" });
  }

  try {
    const [[personBefore]] = await db3.query(
      "SELECT person_id FROM person_table WHERE person_id = ? LIMIT 1",
      [person_id],
    );
    if (!personBefore) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    const permissionMap = await getPermissionMap();

    const accepted = [];
    const skipped = [];

    submittedEntries.forEach(([fieldId, value]) => {
      if (!FIELD_MAP.has(fieldId)) {
        skipped.push({ id: fieldId, reason: "Unknown field" });
        return;
      }
      if (SYSTEM_FIELD_IDS.has(fieldId)) {
        skipped.push({ id: fieldId, reason: "System-locked field" });
        return;
      }
      if (!isFieldEditableByStudent(fieldId, permissionMap)) {
        skipped.push({ id: fieldId, reason: "Locked by admin" });
        return;
      }
      accepted.push([fieldId, value === "" ? null : value]);
    });

    if (accepted.length === 0) {
      return res.status(403).json({
        success: false,
        message: "None of the submitted fields are currently editable.",
        skipped,
      });
    }

    const setClause = accepted.map(([key]) => `${key} = ?`).join(", ");
    const values = accepted.map(([, val]) => val);
    values.push(person_id);

    await db3.query(
      `UPDATE person_table SET ${setClause} WHERE person_id = ?`,
      values,
    );

    // ── Audit trail ──────────────────────────────────────────────────────
    const { actorId, actorRole } = getStudentActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const fieldLabels = accepted
      .map(([fieldId]) => FIELD_MAP.get(fieldId)?.label || fieldId)
      .join(", ");

    await insertAuditLogEnrollment({
      actorId,
      role: actorRole,
      action: "STUDENT_SELF_PROFILE_UPDATE",
      severity: "INFO",
      message: `${roleLabel} (${actorId}) updated their own profile fields: ${fieldLabels}.`,
    });

    res.json({
      success: true,
      message: "Profile updated successfully.",
      updatedFields: accepted.map(([fieldId]) => fieldId),
      skipped,
    });
  } catch (err) {
    console.error("PUT /student-edit-info/:person_id error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;