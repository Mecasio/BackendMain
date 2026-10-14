const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs");

const {
  insertAuditLogAdmission,
  insertAuditLogEnrollment,
} = require("../../utils/auditLogger");

const router = express.Router();

// ─── Shared audit helpers (same pattern as facultyRoute.js) ────────────────
const formatEnrollmentAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getEnrollmentAuditActor = (req) => ({
  actorId:
    req.body?.audit_actor_id ||
    req.headers["x-audit-actor-id"] ||
    req.headers["x-employee-id"] ||
    "unknown",
  actorRole:
    req.body?.audit_actor_role ||
    req.headers["x-audit-actor-role"] ||
    "registrar",
});

const buildPersonPrintName = (
  { last_name, first_name },
  fallback = "Unknown Applicant",
) => {
  const lastName = String(last_name || "").trim();
  const firstName = String(first_name || "").trim();
  if (lastName) return `${lastName}, ${firstName}`.trim();
  return firstName || fallback;
};

const insertPdfExportAudit = async (
  req,
  { documentLabel, legacyAction, legacyMessage },
) => {
  try {
    const { actorId, actorRole } = getEnrollmentAuditActor(req);
    const roleLabel = formatEnrollmentAuditActorRole(actorRole);
    const printAction = String(req.body?.audit_print_action || "").trim();
    const applicantNumber = String(req.body?.applicant_number || "").trim();
    const studentNumber = String(
      req.body?.student_number || req.body?.applicant_number || "",
    ).trim();
    const label = String(
      req.body?.document_label || documentLabel || "document",
    ).trim();

    if (printAction === "PRINTING_APPLICANT_DOCS") {
      const applicantName = buildPersonPrintName(
        req.body || {},
        "Unknown Applicant",
      );

      await insertAuditLogAdmission({
        actorId,
        role: actorRole,
        action: "PRINTING_APPLICANT_DOCS",
        severity: "INFO",
        message: `${roleLabel} (${actorId}) printed ${label} for applicant ${applicantName} (${applicantNumber || "N/A"}).`,
      });
      return;
    }

    if (printAction === "PRINTING_STUDENT_DOCS") {
      const studentName = buildPersonPrintName(
        req.body || {},
        "Unknown Student",
      );

      await insertAuditLogEnrollment({
        actorId,
        role: actorRole,
        action: "PRINTING_STUDENT_DOCS",
        severity: "INFO",
        message: `${roleLabel} (${actorId}) printed ${label} for student ${studentName} (${studentNumber || "N/A"}).`,
      });
      return;
    }

    if (printAction === "DOWNLOAD_EXAM_PDF") {
      const applicantName = buildPersonPrintName(
        req.body || {},
        "Unknown Applicant",
      );

      await insertAuditLogAdmission({
        actorId,
        role: actorRole,
        action: "DOWNLOAD_EXAM_PDF",
        severity: "INFO",
        message: `${roleLabel} (${actorId}) downloaded ${label} PDF for applicant ${applicantName} (${applicantNumber || "N/A"}).`,
      });
      return;
    }

    await insertAuditLogAdmission({
      actorId,
      role: actorRole,
      action: legacyAction,
      severity: "INFO",
      message: legacyMessage({
        roleLabel,
        actorId,
        applicant_number: applicantNumber,
      }),
    });
  } catch (auditErr) {
    console.error(
      `${legacyAction || documentLabel} PDF audit log failed:`,
      auditErr,
    );
  }
};

// ─── Shared Puppeteer launch config ─────────────────────────────────────────
const resolveBrowserExecutablePath = () => {
  const configuredPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath;
  }

  if (process.platform === "win32") {
    const windowsChromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    if (fs.existsSync(windowsChromePath)) {
      return windowsChromePath;
    }
  }

  return undefined;
};

const launchBrowser = () => {
  const executablePath = resolveBrowserExecutablePath();
  return puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
};

const buildOutputFilename = (
  prefix,
  { last_name, first_name, applicant_number },
) => {
  const safeLastName = String(last_name || "Applicant")
    .trim()
    .replace(/\s+/g, "_");
  const safeFirstName = String(first_name || "")
    .trim()
    .replace(/\s+/g, "_");
  const applicantSuffix = applicant_number ? `_${applicant_number}` : "";
  return `${prefix}_${safeLastName}${safeFirstName ? "_" + safeFirstName : ""}${applicantSuffix}.pdf`;
};

const waitForImages = (page) =>
  page.evaluate(async () => {
    const images = Array.from(document.images);
    await Promise.all(
      images.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
        });
      }),
    );
  });

// ─── 1. Admission Form (Process) ────────────────────────────────────────────
router.post("/generate-admission-form-pdf", async (req, res) => {
  let browser;

  try {
    const { html, applicant_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Match the print window's real page proportions (A4 in mm at high-res),
    // not the COR route's 816px pattern — that mismatch is what caused the
    // blank second page.
    await page.setViewport({
      width: 794, // 210mm @ 96dpi
      height: 1123, // 297mm @ 96dpi
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Wrap the admission form HTML with the SAME print CSS used by the
    // Print button in AdminAdmissionFormProcess.jsx (@page A4, the 0.88
    // scale, .print-container, etc.) so Puppeteer lays it out identically
    // to what the browser's own print preview shows.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      margin: 0;
      padding: 0;
    }

    html, body {
      margin: 0;
      padding: 0;
      width: 210mm;
      height: 297mm;
      background: #ffffff;
      font-family: Arial, sans-serif;
      overflow: hidden;
    }

    @page {
      size: A4;
      margin: 0;
    }

    @media print {
      button { display: none !important; }
    }

    .print-container {
      width: 100%;
      height: auto;
      padding: 10px 20px;
     transform: scale(0.836);
      /* no transform-origin override — match the working print window's default (50% 50%) */
    }

    .student-table {
      margin-top: -90px !important;
    }

    button {
      display: none;
    }

    .dataField {
      margin-top: 2px !important;
    }

    svg.MuiSvgIcon-root {
      margin-top: -53px;
      width: 70px !important;
      height: 70px !important;
    }

    table {
      border-collapse: collapse;
    }

    img {
      max-width: 100%;
    }

    [style*="background-color"],
    [style*="backgroundColor"] {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      // Matches @page { size: 8.5in 11in; margin: 0.25in; } from the
      // component's own embedded print styles.
      margin: {
        top: "0.25in",
        bottom: "0.25in",
        left: "0.25in",
        right: "0.25in",
      },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const fileName = buildOutputFilename("Admission_Form_Process", req.body);

    await insertPdfExportAudit(req, {
      documentLabel: "Admission Form (Process)",
      legacyAction: "ADMISSION_FORM_PROCESS_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId, applicant_number }) =>
        `${roleLabel} (${actorId}) exported Admission Form (Process) PDF${applicant_number ? ` for Applicant (${applicant_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Admission Form PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-empty-admission-form-pdf", async (req, res) => {
  let browser;

  try {
    const { html } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Same A4 @96dpi proportions as the filled Admission Form route —
    // EmptyAdmissionFormProcess.jsx uses the identical .student-table /
    // logo -25px offset structure, so the same print CSS lines up.
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Reuses the SAME print CSS as /generate-admission-form-pdf (scale,
    // .student-table offset, .dataField, svg.MuiSvgIcon-root, etc) since
    // EmptyAdmissionFormProcess.jsx mirrors that component's header/table
    // structure exactly — just with blank ruled fields instead of
    // person.* data. These two rules were previously MISSING here, which
    // is what caused the layout to drift from the filled PDF:
    //   .dataField { margin-top: 2px !important; }
    //   svg.MuiSvgIcon-root { margin-top: -53px; width: 70px !important; height: 70px !important; }
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      margin: 0;
      padding: 0;
    }
 
    html, body {
      margin: 0;
      padding: 0;
      width: 210mm;
      height: 297mm;
      background: #ffffff;
      font-family: Arial, sans-serif;
      overflow: hidden;
    }
 
    @page {
      size: A4;
      margin: 0;
    }
 
    @media print {
      button { display: none !important; }
    }
 
    .print-container {
      width: 100%;
      height: auto;
      padding: 10px 20px;
      transform: scale(0.836);
    }
 
    .student-table {
      margin-top: -90px !important;
    }
 
    button {
      display: none;
    }
 
    /* ── ADDED: matches /generate-admission-form-pdf exactly ── */
    .dataField {
      margin-top: 2px !important;
    }
 
    svg.MuiSvgIcon-root {
      margin-top: -53px;
      width: 70px !important;
      height: 70px !important;
    }
    /* ── end additions ── */
 
    table {
      border-collapse: collapse;
    }
 
    img {
      max-width: 100%;
    }
 
    [style*="background-color"],
    [style*="backgroundColor"] {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: "0.25in",
        bottom: "0.25in",
        left: "0.25in",
        right: "0.25in",
      },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    // No applicant is tied to a blank form, so date-stamp the filename
    // instead of naming it after a person (same convention as the
    // Admission Services CSM / Exam Scores routes above).
    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = `Empty_Admission_Form_Process_${timestamp}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Empty Admission Form (Process)",
      legacyAction: "EMPTY_ADMISSION_FORM_PROCESS_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the blank Admission Form (Process) PDF.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Empty Admission Form PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── 2. Office of the Registrar ─────────────────────────────────────────────
router.post("/generate-registrar-form-pdf", async (req, res) => {
  let browser;

  try {
    const { html, applicant_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Mirrors printDiv()'s CSS in OfficeOfTheRegistrar.jsx EXACTLY.
    // Note: no transform/scale on .print-container for this form —
    // don't add one, or spacing will drift from the real print preview.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page {
      size: A4;
      margin: 0;
    }

    html, body {
      margin: 0;
      padding: 0;
      width: 210mm;
      height: 297mm;
      font-family: Arial;
      background: #ffffff;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 1;
      padding: 0;
    }

    .print-container {
      width: 100%;
      height: auto;
      padding: 10px;
    }

    button {
      display: none;
    }

    .student-table {
      margin-top: -10px !important;
    }

    svg.MuiSvgIcon-root {
      width: 24px !important;
      height: 24px !important;
    }

    table {
      border-collapse: collapse;
    }

    img {
      max-width: 100%;
    }

    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: false,
      // Matches @page { size: 8.5in 11in; margin: 0.25in; } from the
      // component's own embedded print styles.
      margin: {
        top: "0.25in",
        bottom: "0.25in",
        left: "0.25in",
        right: "0.25in",
      },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const fileName = buildOutputFilename("Office_Of_The_Registrar", req.body);

    await insertPdfExportAudit(req, {
      documentLabel: "Office of the Registrar Form",
      legacyAction: "REGISTRAR_FORM_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId, applicant_number }) =>
        `${roleLabel} (${actorId}) exported Office of the Registrar PDF${applicant_number ? ` for Applicant (${applicant_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Registrar Form PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── 3. Personal Data Form ──────────────────────────────────────────────────
router.post("/generate-personal-data-form-pdf", async (req, res) => {
  let browser;

  try {
    const { html, applicant_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: 794, // 210mm @ 96dpi
      height: 1123, // 297mm @ 96dpi
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Wrap using the SAME print CSS as printDiv() in PersonalDataForm.jsx
    // (scale 0.90, top-left origin, 110%/100% container — this form's
    // print rules are DIFFERENT from the Admission Form's, don't reuse
    // that route's CSS block here).
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page {
      size: A4;
      margin: 0;
    }

    html, body {
      margin: 0;
      padding: 0;
      width: 210mm;
      height: 297mm;
      font-family: Arial;
      overflow: hidden;
      background: #ffffff;
    }

    .print-container {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      zoom: 0.82;
    }

    .student-table {
      margin-top: 15px !important;
    }

    input[type="checkbox"] {
      width: 12px;
      height: 12px;
      transform: scale(1);
      margin: 2px;
    }

    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    button {
      display: none;
    }

    /* Custom checkbox checkmark rendering — must be present here too,
       since Puppeteer parses this as a fresh document, not inheriting
       the <style> blocks the React component injected inline. */
    .custom-checkbox {
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      display: inline-block;
      position: relative;
      border: 1px solid black;
      background-color: white;
    }
    .custom-checkbox:checked::after {
      content: '✓';
      position: absolute;
      top: -2px;
      left: 3px;
      font-size: 16px;
      color: black;
    }

    table {
      border-collapse: collapse;
    }

    img {
      max-width: 100%;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      // Matches @page { size: 8.5in 11in; margin: 0.25in; } from the
      // component's own embedded print styles.
      margin: { top: "0", bottom: "0", left: "0.15in", right: "0.15in" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const fileName = buildOutputFilename("Personal_Data_Form", req.body);

    await insertPdfExportAudit(req, {
      documentLabel: "Personal Data Form",
      legacyAction: "PERSONAL_DATA_FORM_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId, applicant_number }) =>
        `${roleLabel} (${actorId}) exported Personal Data Form PDF${applicant_number ? ` for Applicant (${applicant_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Personal Data Form PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── 4. ECAT Application Form ───────────────────────────────────────────────
router.post("/generate-ecat-form-pdf", async (req, res) => {
  let browser;

  try {
    const { html, applicant_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Mirrors printDiv()'s CSS in ECATApplicationForm.jsx EXACTLY, including
    // the negative body margin / .student-table offset trick. That offset is
    // designed to counteract the browser's own @page margin reservation —
    // since Puppeteer's page.pdf() margin option reserves space the same
    // way, we keep the same offset here and set the PDF margin to 10mm
    // (matching @page) rather than 0, or the offset math won't line up.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body {
      margin: 0;
      margin-top: -80px;
      padding: 0;
      font-family: Arial;
      width: auto;
      height: auto;
      overflow: visible;
      background: #ffffff;
    }

    .print-container {
      width: 100%;
      box-sizing: border-box;
    }

    .student-table {
      margin-top: 170px !important;
    }

    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    button {
      display: none;
    }

    table {
      border-collapse: collapse;
    }

    img {
      max-width: 100%;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      // Matches the @page { margin: 10mm 10mm 10mm 10mm; } rule from
      // printDiv() — needed for the -100px / 170px offset trick to
      // resolve to the same visual position as the real print preview.
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const fileName = buildOutputFilename("ECAT_Application_Form", req.body);

    await insertPdfExportAudit(req, {
      documentLabel: "ECAT Application Form",
      legacyAction: "ECAT_FORM_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId, applicant_number }) =>
        `${roleLabel} (${actorId}) exported ECAT Application Form PDF${applicant_number ? ` for Applicant (${applicant_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("ECAT Form PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── 5. Admission Services (Client Satisfaction Measurement form) ─────────
router.post("/generate-admission-services-pdf", async (req, res) => {
  let browser;

  try {
    const { html } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: 794, // 210mm @ 96dpi
      height: 1123, // 297mm @ 96dpi
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Mirrors printDiv()'s CSS in AdmissionServices.jsx EXACTLY, including
    // the "50xpx" typo on svg.MuiSvgIcon-root — that's an invalid CSS value,
    // so the browser (and Chromium here, identically) silently drops just
    // that one declaration and keeps width: 50px. Reproducing it verbatim
    // keeps the icon sizing pixel-identical to the real print preview;
    // "fixing" the typo here would make the PDF diverge from print.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page {
      size: A4;
      margin: 0;
    }

    html, body {
      margin: 0;
      padding: 0;
      width: 210mm;
      height: 297mm;
      font-family: Arial;
      overflow: hidden;
      background: #ffffff;
    }

    .print-container {
      width: 115%;
      height: 100%;
      box-sizing: border-box;
      transform: scale(0.85);
      transform-origin: top left;
      margin-left: 10px;
    }

    input[type="checkbox"] {
      width: 12px;
      height: 12px;
      transform: scale(1);
      margin: 2px;
    }

    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    button {
      display: none;
    }

    /* FIX ICON SIZE ON PRINT — kept verbatim from printDiv(), see comment above */
    svg.MuiSvgIcon-root {
      width: 50px !important;
      height: 50xpx !important;
    }

    table {
      border-collapse: collapse;
    }

    img {
      max-width: 100%;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      // Matches @page { size: 8.5in 11in; margin: 0.25in; } from the
      // component's own embedded print styles.
      margin: { top: "0.25in", bottom: "0.25in", left: "0in", right: "0in" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    // No applicant-specific data is printed on this form (it's a blank
    // CSM template), so the filename is date-stamped rather than named
    // after a person.
    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = `Admission_Services_CSM_Form_${timestamp}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Application/Student Satisfactory Survey",
      legacyAction: "ADMISSION_SERVICES_CSM_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the Admission Services CSM form PDF.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Admission Services PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-exam-permit-pdf", async (req, res) => {
  let browser;

  try {
    const { html, applicant_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // A4 size (8.27in x 11.69in) — viewport, inline CSS width, and
    // page.pdf() format below are all kept in sync to this.
    await page.setViewport({
      width: 794, // 8.27in @ 96dpi
      height: 1123, // 11.69in @ 96dpi
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Mirrors the <style> block embedded directly in ExamPermit.jsx.
    // Content width is now pinned to A4 (8.27in) instead of Letter
    // (8.5in) so it matches the page.pdf() format below and doesn't
    // get clipped or off-center.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 8.27in;
      background: #ffffff;
      font-family: Arial, sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    button {
      display: none;
    }

    table {
      border-collapse: collapse;
    }

    img {
      max-width: 100%;
    }
  </style>
</head>
<body>
  ${html}
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    // Wait for logo, profile picture, and QR code to finish rendering
    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: "0.25in",
        bottom: "0.25in",
        left: "0.50in",
        right: "0.50in",
      },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const fileName = buildOutputFilename("Exam_Permit", req.body);

    await insertPdfExportAudit(req, {
      documentLabel: "Examination Permit",
      legacyAction: "EXAM_PERMIT_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId, applicant_number }) =>
        `${roleLabel} (${actorId}) exported Exam Permit PDF${applicant_number ? ` for Applicant (${applicant_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Exam Permit PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ADD THESE TWO ROUTES to your existing router file (the one with
// /generate-admission-form-pdf, /generate-exam-permit-pdf, etc).
// Paste them in above `module.exports = router;`.
// They reuse launchBrowser(), waitForImages(), and insertPdfExportAudit()
// which are already defined in that file — no new imports needed.
// ─────────────────────────────────────────────────────────────────────────

// ─── 7. Entrance Examination Scores ─────────────────────────────────────────
router.post("/generate-exam-scores-pdf", async (req, res) => {
  let browser;

  try {
    const { html } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Portrait A4 @ 96dpi, matches the @page { size: A4 portrait; margin: 8mm; }
    // rule from the original printDiv() window.
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Mirrors the <style> block from printDiv() in the Exam Scores component
    // exactly (corner labels, table-wrapper, header-content, etc). The
    // `html` payload here is just the .print-container's inner markup —
    // the client no longer sends the onload="window.print()" wrapper since
    // we're not opening a browser print dialog anymore.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page { size: A4 portrait; margin: 8mm; }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial;
      background: #ffffff;
    }

    .print-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding-left: 10px;
      padding-right: 10px;
    }

    .print-header {
      position: relative;
      width: 100%;
      margin-top: 10px;
    }

    .header-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
    }

    .header-content img {
      width: 90px;
      height: 90px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      margin-top: 50px;
    }

    .header-text {
      text-align: center;
      margin-top: 50px;
    }

    .print-corner-label {
      position: absolute;
      top: 0;
      font-size: 12px;
      font-weight: bold;
    }

    .print-corner-label.left {
      left: 0;
      text-align: left;
    }

    .print-corner-label.right {
      right: 0;
      text-align: right;
    }

    .table-wrapper {
      width: 100%;
      margin-top: 20px;
    }

    table {
      border-collapse: collapse;
      width: 100%;
      border: 1.5px solid black;
      table-layout: fixed;
    }

    th, td {
      border: 1.5px solid black;
      padding: 4px 3px;
      font-size: 9px;
      text-align: center;
      word-wrap: break-word;
      white-space: normal;
    }

    th {
      background-color: lightgray;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    td.applicant-name {
      text-align: left;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "8mm", bottom: "8mm", left: "8mm", right: "8mm" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    // Not tied to a single applicant, so date-stamp the filename like the
    // Admission Services CSM route does.
    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = `Entrance_Exam_Scores_${timestamp}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Entrance Examination Scores",
      legacyAction: "EXAM_SCORES_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the Entrance Examination Scores PDF.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Exam Scores PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── 8. Applicant List ──────────────────────────────────────────────────────
router.post("/generate-applicant-list-pdf", async (req, res) => {
  let browser;

  try {
    const { html } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Portrait A4 @ 96dpi, matches @page { size: A4 portrait; margin: 8mm; }
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Mirrors the corner-label header style used by the Entrance Examination
    // Scores printDiv() (Department left / Program right, centered logo +
    // school name block), now applied to the Applicant List export as well.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page { size: A4 portrait; margin: 8mm; }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial;
      background: #ffffff;
    }

    .print-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding-left: 10px;
      padding-right: 10px;
    }

    .print-header {
      position: relative;
      width: 100%;
      margin-top: 10px;
    }

    .header-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
    }

    .header-content img {
      width: 90px;
      height: 90px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      margin-top: 50px;
    }

    .header-text {
      text-align: center;
      margin-top: 50px;
    }

    .print-corner-label {
      position: absolute;
      top: 0;
      font-size: 12px;
      font-weight: bold;
    }

    .print-corner-label.left {
      left: 0;
      text-align: left;
    }

    .print-corner-label.right {
      right: 0;
      text-align: right;
    }

    .table-wrapper {
      width: 100%;
      margin-top: 20px;
    }

    table {
      border-collapse: collapse;
      width: 100%;
      border: 1.5px solid black;
      table-layout: fixed;
    }

    th, td {
      border: 1.5px solid black;
      padding: 4px 3px;
      font-size: 9px;
      text-align: center;
      word-wrap: break-word;
      white-space: normal;
    }

    th {
      background-color: lightgray;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    td.applicant-name {
      text-align: left;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "8mm", bottom: "8mm", left: "8mm", right: "8mm" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = `Applicant_List_${timestamp}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Applicant List",
      legacyAction: "APPLICANT_LIST_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the Applicant List PDF.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Applicant List PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-schedule-applicant-list-pdf", async (req, res) => {
  let browser;

  try {
    const { html, title, fileNamePrefix } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }
    if (!title || typeof title !== "string") {
      return res.status(400).json({ message: "No title received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Portrait A4 @ 96dpi, matches @page { size: A4 portrait; margin: 8mm; }
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Same corner-label header style used by the Entrance Examination Scores /
    // Applicant List export (Department|College left / Program right, centered
    // logo + school name block), reused here for Proctor / Interviewer /
    // Evaluator applicant list exports.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
    @page { size: A4 portrait; margin: 8mm; }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial;
      background: #ffffff;
    }

    .print-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding-left: 10px;
      padding-right: 10px;
    }

    .print-header {
      position: relative;
      width: 100%;
  
    }

    .header-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
    }

    .header-content img {
      width: 90px;
      height: 90px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
  
    }

    .header-text {
      text-align: center;
     
    }


    .info-row {
      margin-top: 16px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .info-row-line {
      display: flex;
      justify-content: space-between;
      width: 100%;
      font-size: 12px;
    }

    .table-wrapper {
      width: 100%;
      margin-top: 20px;
    }

    table {
      border-collapse: collapse;
      width: 100%;
      border: 1.5px solid black;
      table-layout: fixed;
    }

    th, td {
      border: 1.5px solid black;
      padding: 4px 3px;
      font-size: 9px;
      text-align: center;
      word-wrap: break-word;
      white-space: normal;
    }

    th {
      background-color: lightgray;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    td.applicant-name {
      text-align: left;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "8mm", bottom: "8mm", left: "8mm", right: "8mm" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const prefix = fileNamePrefix || title.replace(/[^a-z0-9]+/gi, "_");
    const fileName = `${prefix}_${timestamp}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: title,
      legacyAction: "SCHEDULE_APPLICANT_LIST_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the ${title} PDF.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Schedule Applicant List PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-qualifying-interview-score-pdf", async (req, res) => {
  let browser;

  try {
    const { html } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Portrait A4 @ 96dpi, matches @page { size: A4 portrait; margin: 8mm; }
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page { size: A4 portrait; margin: 8mm; }
 
    * { box-sizing: border-box; }
 
    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial;
      background: #ffffff;
    }
 
    .print-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding-left: 10px;
      padding-right: 10px;
    }
 
    .print-header {
      position: relative;
      width: 100%;
      margin-top: 10px;
    }
 
    .header-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
    }
 
    .header-content img {
      width: 90px;
      height: 90px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      margin-top: 50px;
    }
 
    .header-text {
      text-align: center;
      margin-top: 50px;
    }
 
    .print-corner-label {
      position: absolute;
      top: 0;
      font-size: 12px;
      font-weight: bold;
    }
 
    .print-corner-label.left {
      left: 0;
      text-align: left;
    }
 
    .print-corner-label.right {
      right: 0;
      text-align: right;
    }
 
    .table-wrapper {
      width: 100%;
      margin-top: 20px;
    }
 
    table {
      border-collapse: collapse;
      width: 100%;
      border: 1.5px solid black;
      table-layout: fixed;
    }
 
    th, td {
      border: 1.5px solid black;
      padding: 4px 3px;
      font-size: 9px;
      text-align: center;
      word-wrap: break-word;
      white-space: normal;
    }
 
    th {
      background-color: lightgray;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
 
    td.applicant-name {
      text-align: left;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "8mm", bottom: "8mm", left: "8mm", right: "8mm" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = `Qualifying_Interview_Score_${timestamp}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Qualifying / Interview Score",
      legacyAction: "QUALIFYING_INTERVIEW_SCORE_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the Qualifying / Interview Score PDF.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Qualifying/Interview Score PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-student-list-pdf", async (req, res) => {
  let browser;

  try {
    const { html } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Portrait A4 @ 96dpi, matches @page { size: A4 portrait; margin: 8mm; }
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Mirrors the corner-label header style used by the Applicant List /
    // Entrance Examination Scores export (Department left / Program right,
    // centered logo + school name block), applied to the Student List.
    //
    // font-size is now HARDCODED at 12px (was 9px) so it never needs to
    // be manually bumped up per export — cells wrap to a second line
    // instead of shrinking or truncating.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page { size: A4 portrait; margin: 8mm; }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial;
      background: #ffffff;
    }

    .print-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding-left: 10px;
      padding-right: 10px;
    }

    .print-header {
      position: relative;
      width: 100%;
      margin-top: 10px;
    }

    .header-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
    }

    .header-content img {
      width: 90px;
      height: 90px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      margin-top: 50px;
    }

    .header-text {
      text-align: center;
      margin-top: 50px;
    }

    .print-corner-label {
      position: absolute;
      top: 0;
      font-size: 12px;
      font-weight: bold;
    }

    .print-corner-label.left {
      left: 0;
      text-align: left;
    }

    .print-corner-label.right {
      right: 0;
      text-align: right;
    }

    .table-wrapper {
      width: 100%;
      margin-top: 20px;
    }

    table {
      border-collapse: collapse;
      width: 100%;
      border: 1.5px solid black;
      table-layout: fixed;
    }

    th, td {
      border: 1.5px solid black;
      padding: 6px 5px;
      font-size: 12px;
      text-align: center;
      word-wrap: break-word;
      overflow-wrap: break-word;
      white-space: normal;
    }

    th {
      background-color: lightgray;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    td.student-name {
      text-align: left;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "8mm", bottom: "8mm", left: "8mm", right: "8mm" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = `Student_List_${timestamp}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Student List",
      legacyAction: "STUDENT_LIST_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the Student List PDF.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Student List PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-report-of-grades-pdf", async (req, res) => {
  let browser;

  try {
    const { html, student_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: 794, // 210mm @ 96dpi
      height: 1123, // 297mm @ 96dpi
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Mirrors the on-screen scaling math from ReportOfGrade.jsx EXACTLY:
    // the report is authored at a fixed design width of 1280px
    // (REPORT_DESIGN_WIDTH) and shrunk with a CSS transform so it fits an
    // A4 sheet with EXACTLY 1.5rem of margin on the left/right/top
    // (PRINT_MARGIN_REM). Same geometry, reproduced server-side:
    //   a4WidthPx      = 210mm * (96/25.4)             ≈ 793.7px
    //   printMarginPx  = 1.5rem * 16px                  = 24px
    //   contentWidthPx = a4WidthPx - printMarginPx * 2  ≈ 745.7px
    //   scale          = contentWidthPx / 1280          ≈ 0.5825
    const REPORT_DESIGN_WIDTH = 1280;
    const PRINT_MARGIN_REM = 1.5;
    const PX_PER_REM = 16;
    const PX_PER_MM = 96 / 25.4;
    const A4_WIDTH_MM = 210;
    const printMarginPx = PRINT_MARGIN_REM * PX_PER_REM;
    const a4WidthPx = A4_WIDTH_MM * PX_PER_MM;
    const printContentWidthPx = a4WidthPx - printMarginPx * 2;
    const PRINT_SCALE = printContentWidthPx / REPORT_DESIGN_WIDTH;

    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page {
      size: A4;
      margin: 0;
    }

    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    html, body {
      margin: 0;
      padding: 0;
      width: 210mm;
      background: #ffffff;
      font-family: "Poppins", Arial, sans-serif;
    }

    .rog-page {
      margin-top: ${PRINT_MARGIN_REM}rem;
      margin-left: ${PRINT_MARGIN_REM}rem;
    }

    .rog-content {
      width: ${REPORT_DESIGN_WIDTH}px;
      transform: scale(${PRINT_SCALE});
      transform-origin: top left;
    }

    table {
      border-collapse: collapse;
    }

    img {
      max-width: 100%;
    }

    button {
      display: none;
    }
  </style>
</head>
<body>
  <div class="rog-page">
    <div class="rog-content">
      ${html}
    </div>
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const safeLastName = String(last_name || "Student")
      .trim()
      .replace(/\s+/g, "_");
    const safeFirstName = String(first_name || "")
      .trim()
      .replace(/\s+/g, "_");
    const numberSuffix = student_number ? `_${student_number}` : "";
    const fileName = `Report_Of_Grades_${safeLastName}${safeFirstName ? "_" + safeFirstName : ""}${numberSuffix}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Report of Grades",
      legacyAction: "REPORT_OF_GRADES_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported Report of Grades PDF${student_number ? ` for Student (${student_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Report of Grades PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── 11. Transcript of Records (Registrar) ─────────────────────────────────
router.post("/generate-tor-pdf", async (req, res) => {
  let browser;

  try {
    const { html, student_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // TOR uses Philippine "long" bond paper: 8.5in x 13in
    // (215.9mm x 330.2mm), NOT 8.5in x 14in (legal/folio). Matches the
    // .page-card min-width/min-height in TOR.jsx's on-screen CSS and the
    // @page { size: 215.9mm 330.2mm; } print rule.
    await page.setViewport({
      width: 816, // 215.9mm @ 96dpi
      height: 1344,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page {
  size: 215.9mm 355.6mm;
      margin: 0;
    }

    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      font-family: Arial, sans-serif;
    }


  .tor-page {
      width: 215.9mm;
      min-height: 345.4mm; 
      padding: 10mm 12mm;
      overflow: visible;   
      position: relative;
    }


    .tor-page:not(:last-of-type) {
      page-break-after: always;
      break-after: page;
    }

    /*
     * buildTorPageHtml() lays out content at ~80rem (1280px @ 16px root)
     * because it was authored for the on-screen "page-card" preview.
     * The actual PDF page is only 215.9mm (~816px) wide, so without
     * scaling, everything past ~64% of the width gets clipped by
     * .tor-page's overflow:hidden — that's the missing-data bug.
     *
     * zoom (not transform) shrinks BOTH the visual size AND each
     * element's contribution to layout flow, so the header/info/table/
     * footer blocks still stack correctly at the smaller size.
     *
     * 725px available width / 1280px natural width ≈ 0.566
     * Nudge this up/down slightly if text wraps oddly or margins look off.
     */
    .tor-page > * {
      zoom: 0.544;
    }

    table {
      border-collapse: collapse;
    }

    img {
      max-width: 100%;
    }

    button {
      display: none;
    }
  </style>
</head>
<body>
  ${html}
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await Promise.race([
      waitForImages(page),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      width: "215.9mm",
      height: "355.6mm",
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: "0.20in",
        bottom: "0",
        left: "0",
        right: "0"
      },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const safeLastName = String(last_name || "Student")
      .trim()
      .replace(/\s+/g, "_");
    const safeFirstName = String(first_name || "")
      .trim()
      .replace(/\s+/g, "_");
    const numberSuffix = student_number ? `_${student_number}` : "";
    const fileName = `TOR_${safeLastName}${safeFirstName ? "_" + safeFirstName : ""}${numberSuffix}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Transcript of Records",
      legacyAction: "TOR_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported Transcript of Records PDF${student_number ? ` for Student (${student_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("TOR PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── Class List (Registrar Class Roster) ───────────────────────────────────
router.post("/generate-class-list-pdf", async (req, res) => {
  let browser;

  try {
    const { html, footerLeft = "", footerCenter = "" } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    const escapeFooter = (value) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Portrait A4 @ 96dpi, matches @page { size: A4 portrait; margin: 8mm; }
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Class List PDF uses the shared layout from EXAMPLES/ClassList.pdf.
    // Frontend embeds CLASS_LIST_PRINT_CSS in the submitted HTML.
    // Header is duplicated per page in HTML (Chromium cannot reliably repeat
    // complex letterhead via <thead>). Footer with live page numbers is
    // injected by Puppeteer; in-document .print-footer is hidden.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page { size: A4 portrait; margin: 8mm; }
    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial, sans-serif;
      background: #ffffff;
    }
    .pdf-hide-doc-footer .print-footer {
      display: none !important;
    }
  </style>
</head>
<body class="pdf-hide-doc-footer">
  ${html}
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const footerTemplate = `
      <div style="width:100%;box-sizing:border-box;padding:4px 10mm 0;font-family:Arial,Helvetica,sans-serif;font-size:9px;color:#000;border-top:1px solid #000;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="white-space:nowrap;">Print Info: ${escapeFooter(footerLeft)}</span>
        <span style="flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeFooter(footerCenter)}</span>
        <span style="white-space:nowrap;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `;

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: false,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate,
      margin: { top: "8mm", bottom: "14mm", left: "8mm", right: "8mm" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = `Class_List_${timestamp}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Class List",
      legacyAction: "CLASS_LIST_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the Class List PDF.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Class List PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-class-program-pdf", async (req, res) => {
  let browser;

  try {
    const { html, styles, section_label = "", program_code = "" } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Letter landscape: 11in wide x 8.5in tall
    await page.setViewport({
      width: 1056,
      height: 816,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    const safeStyles = typeof styles === "string" ? styles : "";

    // Fixed landscape layout (no max-content scale-to-fit). That approach
    // crushed this schedule table into a thin strip because width:100%
    // inside width:max-content measured incorrectly.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    ${safeStyles}

    @page {
      size: Letter landscape;
      margin: 0.2in;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      font-family: Arial, Helvetica, sans-serif;
    }

    .print-container {
      width: 10.5in;
      margin: 0 auto;
    }

    button {
      display: none !important;
    }

    table {
      border-collapse: collapse;
    }

    img {
      max-width: 100%;
    }
  </style>
</head>
<body>
  <div class="print-container">${html}</div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "Letter",
      landscape: true,
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: "0.2in",
        bottom: "0.2in",
        left: "0.2in",
        right: "0.2in",
      },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const safeSection = String(section_label || program_code || "Section")
      .trim()
      .replace(/[^\w\-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 60);
    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = `Class_Program_${safeSection || "Section"}_${timestamp}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Class Program",
      legacyAction: "CLASS_PROGRAM_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the Class Program PDF${section_label ? ` for ${section_label}` : ""
        }.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Class Program PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-medical-certificate-pdf", async (req, res) => {
  let browser;

  try {
    const { html, student_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: 794, // 210mm @ 96dpi
      height: 1123, // 297mm @ 96dpi
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Mirrors printDiv()'s CSS in MedicalCertificate.jsx EXACTLY —
    // the 110% width + scale(0.90) top-left trick, NOT the Personal
    // Data Form's zoom variant. Don't swap these, the offsets differ.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial;
      width: auto;
      height: auto;
      overflow: visible;
      background: #ffffff;
    }

    .print-container {
      width: 100%;
      box-sizing: border-box;
    }

    .student-table {
      margin-top: 0 !important;
    }

    input[type="checkbox"] {
      width: 12px;
      height: 12px;
      transform: scale(1);
      margin: 2px;
    }

    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    button { display: none; }
    table { border-collapse: collapse; }
    img { max-width: 100%; }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
`.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: "0.25in",
        bottom: "0.25in",
        left: "0.25in",
        right: "0.25in",
      },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const safeLastName = String(last_name || "Student")
      .trim()
      .replace(/\s+/g, "_");
    const safeFirstName = String(first_name || "")
      .trim()
      .replace(/\s+/g, "_");
    const numberSuffix = student_number ? `_${student_number}` : "";
    const fileName = `Medical_Certificate_${safeLastName}${safeFirstName ? "_" + safeFirstName : ""}${numberSuffix}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Medical Certificate",
      legacyAction: "MEDICAL_CERTIFICATE_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported Medical Certificate PDF${student_number ? ` for Student (${student_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Medical Certificate PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-health-record-pdf", async (req, res) => {
  let browser;
  try {
    const { html, student_number, last_name, first_name } = req.body;
    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") request.abort();
      else request.continue();
    });

    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial;
      width: auto;
      height: auto;
      overflow: visible;
      background: #ffffff;
    }
    .print-container { width: 100%; box-sizing: border-box; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    button { display: none; }
    table { border-collapse: collapse; }
    img { max-width: 100%; }
  </style>
</head>
<body>
  <div class="print-container">${html}</div>
</body>
</html>`.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });
    await waitForImages(page);
    await new Promise((r) => setTimeout(r, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "2mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });

    if (!pdfBuffer?.length) throw new Error("Generated PDF buffer is empty");

    const safeLastName = String(last_name || "Student")
      .trim()
      .replace(/\s+/g, "_");
    const safeFirstName = String(first_name || "")
      .trim()
      .replace(/\s+/g, "_");
    const numberSuffix = student_number ? `_${student_number}` : "";
    const fileName = `Health_Record_${safeLastName}${safeFirstName ? "_" + safeFirstName : ""}${numberSuffix}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Student Health Record",
      legacyAction: "HEALTH_RECORD_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported Health Record PDF${student_number ? ` for Student (${student_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Health Record PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── Faculty Workload ──────────────────────────────────────────────────────
router.post("/generate-faculty-workload-pdf", async (req, res) => {
  let browser;

  try {
    const { html, styles, employee_id, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // American Legal: 8.5in x 13in. Use a wide viewport so the form can
    // lay out at its natural ~63rem width before we scale it down.
    const LEGAL_WIDTH_PX = 816; // 8.5in @ 96dpi
    const LEGAL_HEIGHT_PX = 1248; // 13in @ 96dpi
    const PRINT_MARGIN_IN = 0.2;
    const PRINT_MARGIN_PX = PRINT_MARGIN_IN * 96;

    await page.setViewport({
      width: 1200,
      height: 1800,
      deviceScaleFactor: 1,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    const safeStyles = typeof styles === "string" ? styles : "";

    // Render at natural size first, then measure and scale to fill Legal
    // while keeping everything on a single page.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    ${safeStyles}

    @page {
      size: 8.5in 13in;
      margin: 0;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      font-family: Arial, sans-serif;
      overflow: hidden;
    }

    .fw-pdf-page {
      position: relative;
      width: 8.5in;
      height: 13in;
      overflow: hidden;
    }

    .fw-pdf-content {
      position: absolute;
      top: ${PRINT_MARGIN_IN}in;
      left: 0;
      margin-top: -20px;
      width: max-content;
      max-width: none;
      transform-origin: top left;
      transform: scale(1);
    }

    .print-container {
      position: static !important;
      transform: none !important;
      scale: 1 !important;
      margin: 0 !important;
      margin-bottom: 0 !important;
      padding: 0 !important;
      min-height: 0 !important;
      width: max-content !important;
      max-width: none !important;
      visibility: visible !important;
    }

    .print-container.mb-\\[16rem\\],
    .mb-\\[16rem\\],
    .min-h-\\[10rem\\] {
      margin-bottom: 0 !important;
      min-height: 0 !important;
    }

    .print-container, .print-container * {
      visibility: visible !important;
    }

    button {
      display: none !important;
    }

    table {
      border-collapse: collapse;
    }

    img {
      max-width: 100%;
    }
  </style>
</head>
<body>
  <div class="fw-pdf-page">
    <div class="fw-pdf-content" id="fw-pdf-content">
      <div class="print-container">${html}</div>
    </div>
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Scale content to fill available Legal page area, then center horizontally.
    await page.evaluate(
      ({ marginPx, pageWidthPx, pageHeightPx }) => {
        const content = document.getElementById("fw-pdf-content");
        if (!content) return;

        content.style.transform = "scale(1)";
        content.style.transformOrigin = "top left";
        content.style.left = "0px";

        const rect = content.getBoundingClientRect();
        const contentWidth = Math.max(rect.width, content.scrollWidth, 1);
        const contentHeight = Math.max(rect.height, content.scrollHeight, 1);

        const availableWidth = pageWidthPx - marginPx * 2;
        const availableHeight = pageHeightPx - marginPx * 2;

        const scale = Math.min(
          availableWidth / contentWidth,
          availableHeight / contentHeight,
        );

        // Slightly under-scale so borders aren't clipped by rounding.
        const safeScale = Math.max(0.1, Math.min(scale * 0.98, 1.5));
        const scaledWidth = contentWidth * safeScale;
        const scaledHeight = contentHeight * safeScale;
        const left = Math.max(marginPx, (pageWidthPx - scaledWidth) / 2) + 13;
        const top = Math.max(marginPx, (pageHeightPx - scaledHeight) / 2);

        content.style.transform = `scale(${safeScale})`;
        content.style.left = `${left}px`;
        content.style.top = `${top}px`;
      },
      {
        marginPx: PRINT_MARGIN_PX,
        pageWidthPx: LEGAL_WIDTH_PX,
        pageHeightPx: LEGAL_HEIGHT_PX,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    const pdfBuffer = await page.pdf({
      width: "8.5in",
      height: "13in",
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const safeLastName = String(last_name || "Faculty")
      .trim()
      .replace(/\s+/g, "_");
    const safeFirstName = String(first_name || "")
      .trim()
      .replace(/\s+/g, "_");
    const employeeSuffix = employee_id
      ? `_${String(employee_id).trim().replace(/\s+/g, "_")}`
      : "";
    const fileName = `Faculty_Workload_${safeLastName}${safeFirstName ? "_" + safeFirstName : ""}${employeeSuffix}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Faculty Workload",
      legacyAction: "FACULTY_WORKLOAD_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported Faculty Workload PDF${employee_id ? ` for Employee (${employee_id})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Faculty Workload PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── Faculty Grading Sheet ─────────────────────────────────────────────────
router.post("/generate-grading-sheet-pdf", async (req, res) => {
  let browser;

  try {
    const {
      html,
      footerLeft = "",
      footerCenter = "",
      fileNamePrefix = "",
    } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    const escapeFooter = (value) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Grade Sheet HTML embeds GRADING_REPORT_PRINT_CSS. Puppeteer footer
    // carries page numbers; in-document .print-info is hidden to avoid
    // duplicating the print timestamp.
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page { size: A4 portrait; margin: 8mm; }
    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial, sans-serif;
      background: #ffffff;
    }
    .pdf-hide-doc-print-info .print-info {
      display: none !important;
    }
  </style>
</head>
<body class="pdf-hide-doc-print-info">
  ${html}
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const footerTemplate = `
      <div style="width:100%;box-sizing:border-box;padding:4px 10mm 0;font-family:Arial,Helvetica,sans-serif;font-size:9px;color:#000;border-top:1px solid #000;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="white-space:nowrap;">Date Printed: ${escapeFooter(footerLeft)}</span>
        <span style="flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeFooter(footerCenter)}</span>
        <span style="white-space:nowrap;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `;

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: false,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate,
      margin: { top: "8mm", bottom: "14mm", left: "8mm", right: "8mm" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const safePrefix =
      String(fileNamePrefix || "GradingSheet")
        .trim()
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "GradingSheet";
    const fileName = `${safePrefix}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Grading Sheet",
      legacyAction: "GRADING_SHEET_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the Grading Sheet PDF.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Grading Sheet PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── Faculty Evaluation Report ─────────────────────────────────────────────
router.post("/generate-faculty-evaluation-pdf", async (req, res) => {
  let browser;

  try {
    const { html, employee_id, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    const trimmed = html.trim();
    const wrappedHtml = /^<!DOCTYPE html|<html[\s>]/i.test(trimmed)
      ? trimmed
      : `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page { size: A4 portrait; margin: 6mm; }
    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial, sans-serif;
      background: #ffffff;
    }
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
  </style>
</head>
<body>${html}</body>
</html>
      `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "6mm", bottom: "6mm", left: "6mm", right: "6mm" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const safeLastName = String(last_name || "Faculty")
      .trim()
      .replace(/\s+/g, "_");
    const safeFirstName = String(first_name || "")
      .trim()
      .replace(/\s+/g, "_");
    const employeeSuffix = employee_id
      ? `_${String(employee_id).trim().replace(/\s+/g, "_")}`
      : "";
    const fileName = `Faculty_Evaluation_${safeLastName}${safeFirstName ? "_" + safeFirstName : ""}${employeeSuffix}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Faculty Evaluation Report",
      legacyAction: "FACULTY_EVALUATION_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported Faculty Evaluation PDF${employee_id ? ` for Employee (${employee_id})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Faculty Evaluation PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-student-schedule-pdf", async (req, res) => {
  let browser;

  try {
    const { html, student_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Portrait A4 @ 96dpi
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Letterhead header (logo + centered "Republic of the Philippines /
    // school name / address / Student Schedule / semester" block),
    // followed by a two-corner student meta row (Student Number + Name on
    // the left, Department + Program & Section on the right), the
    // student's CLASS SCHEDULE table, then the weekly Mon–Sun time grid
    // (built in studentSchedulePrintLayout.js) below the Total Units row —
    // mirrors the on-screen desktop grid in StudentSchedule.jsx
    // (yellow-filled merged blocks per course).
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page { size: A4 portrait; margin: 10mm; }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial, sans-serif;
      background: #ffffff;
      color: #000;
    }

    .print-header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      /* No border-bottom here anymore — that was the long divider line
         running the full page width under the letterhead. Spacing below
         the header is now handled purely by margin-bottom. */
      padding-bottom: 8px;
      margin-bottom: 12px;
    }

    .print-header img {
      width: 72px;
      height: 72px;
      object-fit: contain;
      flex-shrink: 0;
    }

    .header-text {
      text-align: center;
    }

    .header-text p {
      margin: 0;
      line-height: 1.35;
    }

    .header-text .republic {
      font-size: 11px;
    }

    .header-text .school-name {
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .header-text .address {
      font-size: 11px;
    }

    .header-text .program-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      margin-top: 4px;
    }

    .header-text .semester {
      font-size: 11px;
      font-weight: 600;
    }

    .schedule-title {
      text-align: center;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin: 10px 0;
      text-transform: uppercase;
    }

    /* ── Two-corner student meta row: Student Number / Student Name on
       the left, Department / Program & Section on the right ── */
    .student-meta {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 6px 24px;
      font-size: 11px;
      margin-bottom: 12px;
    }

    .student-meta .meta-col {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 220px;
    }

    .student-meta .meta-col-right {
      text-align: right;
    }

    .student-meta p {
      margin: 0;
    }

    .student-meta strong {
      font-weight: 700;
    }

    table.schedule-table {
      width: 100%;
      border-collapse: collapse;
    }

    table.schedule-table th,
    table.schedule-table td {
      border: 1px solid #000;
      padding: 5px 6px;
      font-size: 10px;
      text-align: left;
      vertical-align: top;
      word-wrap: break-word;
    }

    table.schedule-table th {
      background-color: #e0e0e0;
      text-align: center;
      font-weight: 700;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    table.schedule-table td.center {
      text-align: center;
    }

    table.schedule-table tfoot td {
      font-weight: 700;
    }

    .weekly-grid-section {
      margin-top: 22px;
      page-break-inside: avoid;
    }

    .weekly-grid-title {
      text-align: center;
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-bottom: 8px;
    }

    table.weekly-grid-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    table.weekly-grid-table th {
      border: 1px solid #000;
      background: #d9d9d9;
      color: #000;
      font-weight: 700;
      font-size: 9px;
      text-transform: uppercase;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    table.weekly-grid-table td {
      border: 1px solid #000;
      text-align: center;
      vertical-align: middle;
      padding: 4px 2px;
      word-wrap: break-word;
      overflow: hidden;
    }

    table.weekly-grid-table .wg-official-time {
      font-size: 7.5px;
      font-weight: 700;
      color: #000;
      text-transform: none;
      margin-top: 2px;
    }

    table.weekly-grid-table .wg-time-col {
      width: 84px;
      font-weight: 600;
      font-size: 8px;
      white-space: nowrap;
    }

    table.weekly-grid-table .wg-empty {
      background: #ffffff;
    }

    table.weekly-grid-table .wg-filled {
      background-color: #fef08a;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      padding: 5px 3px;
    }

    table.weekly-grid-table .wg-course {
      font-weight: 700;
      font-size: 9px;
      color: #7a5b00;
    }

    table.weekly-grid-table .wg-room,
    table.weekly-grid-table .wg-prof {
      font-size: 7.5px;
      color: #333;
      line-height: 1.3;
    }

    button { display: none; }
  </style>
</head>
<body>
  ${html}
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // ── Force everything onto a single A4 page ──────────────────────────
    // Course count (and therefore content height) varies per student, so a
    // fixed font-size/padding can't guarantee one page for everyone.
    // Instead, measure the actual rendered height and shrink via
    // Puppeteer's print `scale` option only as much as needed to fit
    // within one page's usable height (A4 height minus top/bottom margins).
    const contentHeightPx = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );

    const A4_HEIGHT_PX = 1123; // A4 @ 96dpi
    const MARGIN_PX = 37.8; // 10mm top + 10mm bottom, each side
    const usableHeightPx = A4_HEIGHT_PX - MARGIN_PX * 2;

    let scale = 1;
    if (contentHeightPx > usableHeightPx) {
      // Clamp so very long schedules don't shrink past a readable size —
      // 0.6 (60%) is the floor; below that the text becomes hard to read.
      scale = Math.max(0.6, usableHeightPx / contentHeightPx);
    }

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      scale,
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const safeLastName = String(last_name || "Student")
      .trim()
      .replace(/\s+/g, "_");
    const safeFirstName = String(first_name || "")
      .trim()
      .replace(/\s+/g, "_");
    const numberSuffix = student_number ? `_${student_number}` : "";
    const fileName = `Class_Schedule_${safeLastName}${safeFirstName ? "_" + safeFirstName : ""}${numberSuffix}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Class Schedule",
      legacyAction: "STUDENT_CLASS_SCHEDULE_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the Class Schedule PDF${student_number ? ` for Student (${student_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Student Class Schedule PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-cor-pdf", async (req, res) => {
  let browser;

  try {
    const { html, student_number } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    console.log("Received HTML length:", html.length);

    browser = await puppeteer.launch({
      headless: true,
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    // Set viewport to match exactly 8.5in wide at 96dpi (816px) with extra height
    await page.setViewport({
      width: 816,
      height: 1200,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => {
      console.log("PAGE LOG:", msg.text());
    });

    page.on("pageerror", (err) => {
      console.log("PAGE ERROR:", err.message);
    });

    page.on("requestfailed", (request) => {
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      );
    });

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Wrap the received HTML fragment with proper page-level styles
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    /* ── Reset ── */
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      font-family: Arial, sans-serif;
      /* 96 px/in × 8.5 in = 816 px  →  set page width to 8in content = 768px */
      width: 816px;
    }

    /* ── Page setup for @print ── */
    @page {
      size: A4 portrait;
      margin: 6mm 10mm 6mm 10mm;
    }

    @media print {
      html, body {
        width: 100%;
      }
      button { display: none !important; }
      .certificate-watermark {
        color: rgba(0, 0, 0, 0.15) !important;
      }
    }

    /* ── Ensure the certificate tables stay at 8in ── */
    .certificate-wrapper {
      position: relative;
      width: 8in;
      margin: 0 auto;
      background: #ffffff;
    }

    .certificate-watermark {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-45deg);
      font-size: 7rem;
      font-weight: 900;
      color: rgba(0, 0, 0, 0.08);
      text-transform: uppercase;
      white-space: nowrap;
      pointer-events: none;
      user-select: none;
      z-index: 9999;
    }

    /* ── Table normalization ── */
    table {
      border-collapse: collapse;
    }

    /* ── Input → plain text in PDF ── */
    input[type="text"],
    input[readonly] {
      -webkit-appearance: none;
      appearance: none;
      border: none !important;
      outline: none !important;
      background: transparent !important;
      box-shadow: none !important;
      padding: 0;
    }

    /* ── Keep background colors when printing ── */
    [style*="background-color"],
    [style*="backgroundColor"] {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Gray header rows ── */
    td[style*="background-color: gray"],
    td[style*="backgroundColor: gray"],
    td[style*="background: gray"] {
      background-color: #808080 !important;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Hide MUI Container padding that pushes layout ── */
    .MuiContainer-root {
      padding: 0 !important;
      min-height: unset !important;
      display: block !important;
    }

    .flex-container,
    .section {
      display: block !important;
      width: 100% !important;
    }

    img {
      max-width: 100%;
    }
  </style>
</head>
<body>
  ${html}
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    // Wait for all images to finish loading
    await page.evaluate(async () => {
      const images = Array.from(document.images);
      await Promise.all(
        images.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((resolve) => {
            img.onload = resolve;
            img.onerror = resolve;
          });
        }),
      );
    });

    // Let the layout settle after images load
    await new Promise((resolve) => setTimeout(resolve, 500));

    const pdfBuffer = await page.pdf({
         format: "A4",
      printBackground: true,
      preferCSSPageSize: false, // Puppeteer's format:"A4" wins over any @page size in the HTML
      margin: {
        top: "0.25in",
        bottom: "0.25in",
        left: "0.25in",
        right: "0.25in",
      },
    });

    console.log("PDF buffer size:", pdfBuffer.length);

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const { actorId, actorRole } = getEnrollmentAuditActor(req);
    const roleLabel = formatEnrollmentAuditActorRole(actorRole);
    await insertAuditLogEnrollment({
      actorId,
      role: actorRole,
      action: "STUDENT_SCHOLARSHIP_COR_EXPORT",
      severity: "INFO",
      message: `${roleLabel} (${actorId}) exported Certificate of Registration PDF${student_number ? ` for Student (${student_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=certificate-of-registration-${student_number || "student"}.pdf`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

router.post("/generate-student-grades-pdf", async (req, res) => {
  let browser;

  try {
    const { html, student_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    // ── Block only media (audio/video), and give every other request
    // (including images like the school logo) a hard per-request timeout
    // so an unreachable asset host can't stall the whole render for 60s.
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page { size: A4 portrait; margin: 10mm; }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial, sans-serif;
      background: #ffffff;
      color: #000;
    }

    .print-header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding-bottom: 6px;
      margin-bottom: 10px;
    }

    .print-header img {
      width: 58px;
      height: 58px;
      object-fit: contain;
      flex-shrink: 0;
    }

    .header-text {
      text-align: center;
    }

    .header-text p {
      margin: 0;
      line-height: 1.3;
    }

    .header-text .republic {
      font-size: 10px;
    }

    .header-text .school-name {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .header-text .address {
      font-size: 10px;
    }

    .schedule-title {
      text-align: center;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.4px;
      margin: 6px 0 10px;
      text-transform: uppercase;
    }

    .student-meta {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 4px 24px;
      font-size: 10.5px;
      border: 1.5px solid #000;
      padding: 8px 12px;
      margin-bottom: 12px;
    }

    .student-meta .meta-col {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 220px;
    }

    .student-meta .meta-col-right {
      text-align: right;
    }

    .student-meta p {
      margin: 0;
    }

    .student-meta strong {
      font-weight: 700;
    }

    .term-section {
      border: 1.5px solid #000;
      margin-bottom: 12px;
      page-break-inside: avoid;
    }

    .term-heading {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 5px 10px;
      border-bottom: 1.5px solid #000;
    }

    table.grade-table {
      width: 100%;
      border-collapse: collapse;
      border-left: none;
      border-right: none;
    }

    table.grade-table th,
    table.grade-table td {
      border: 1px solid #000;
      padding: 3px 5px;
      font-size: 9px;
      text-align: left;
      vertical-align: top;
      word-wrap: break-word;
    }

    table.grade-table tr:first-child th {
      border-top: none;
    }
    table.grade-table tr:last-child td {
      border-bottom: none;
    }
    table.grade-table th:first-child,
    table.grade-table td:first-child {
      border-left: none;
    }
    table.grade-table th:last-child,
    table.grade-table td:last-child {
      border-right: none;
    }

    table.grade-table th {
      background-color: #e8e8e8;
      text-align: center;
      font-weight: 700;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    table.grade-table td.center {
      text-align: center;
    }

    table.grade-table td.grade-cell {
      font-weight: 700;
    }

    .term-gwa {
      text-align: right;
      font-size: 10px;
      font-weight: 700;
      padding: 5px 10px;
      border-top: 1.5px solid #000;
    }

    button { display: none; }
  </style>
</head>
<body>
  ${html}
</body>
</html>
    `.trim();

    // Give page.setContent its own timeout distinct from the outer
    // request, and don't let a slow/unreachable image (logo, etc.)
    // block rendering forever — 'domcontentloaded' plus our own image
    // wait (with a cap) is more resilient than 'networkidle0' alone,
    // which never resolves if any asset never finishes loading.
    await page.setContent(wrappedHtml, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for images, but cap it — don't let one broken image URL
    // hang the whole export for 60s+.
    await Promise.race([
      waitForImages(page),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 400));

    const contentHeightPx = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );

    const A4_HEIGHT_PX = 1123;
    const MARGIN_PX = 37.8;
    const usableHeightPerPagePx = A4_HEIGHT_PX - MARGIN_PX * 2;
    const MAX_PAGES = 3;
    const maxAllowedHeightPx = usableHeightPerPagePx * MAX_PAGES;

    let scale = 1;
    if (contentHeightPx > maxAllowedHeightPx) {
      scale = Math.max(0.55, maxAllowedHeightPx / contentHeightPx);
    }

    const footerTemplate = `
      <div style="width:100%;box-sizing:border-box;padding:4px 10mm 0;font-family:Arial,Helvetica,sans-serif;font-size:9px;color:#000;border-top:1px solid #000;display:flex;justify-content:flex-end;align-items:center;">
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `;

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: false,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate,
      margin: { top: "10mm", bottom: "14mm", left: "10mm", right: "10mm" },
      scale,
      timeout: 30000,
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const safeLastName = String(last_name || "Student")
      .trim()
      .replace(/\s+/g, "_");
    const safeFirstName = String(first_name || "")
      .trim()
      .replace(/\s+/g, "_");
    const numberSuffix = student_number ? `_${student_number}` : "";
    const fileName = `Grades_${safeLastName}${safeFirstName ? "_" + safeFirstName : ""}${numberSuffix}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Student Grades",
      legacyAction: "STUDENT_GRADES_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported Student Grades PDF${student_number ? ` for Student (${student_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Student Grades PDF ERROR:", err);
    // Always send JSON back so the frontend's axios catch block has a
    // real message to show, instead of the request just hanging or the
    // client getting a blank/broken blob response.
    if (!res.headersSent) {
      return res.status(500).json({
        message: "PDF generation failed",
        error: err.message,
      });
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error("Error closing browser:", closeErr.message);
      }
    }
  }
});

// ─── Entrance Exam Attendance Report ────────────────────────────────────────
router.post("/generate-attendance-report-pdf", async (req, res) => {
  let browser;

  try {
    const { html, title, fileNamePrefix } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title || "Attendance Report"}</title>
  <style>
    @page { size: A4 portrait; margin: 8mm; }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial;
      background: #ffffff;
    }

    .print-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding-left: 10px;
      padding-right: 10px;
    }

    .print-header {
      position: relative;
      width: 100%;
    }

    .header-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
    }

    .header-content img {
      width: 90px;
      height: 90px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      
    }

    .header-text {
      text-align: center;
    }

    .print-corner-label {
      position: absolute;
      top: 0;
      font-size: 12px;
      font-weight: bold;
    }

    .print-corner-label.left {
      left: 0;
      text-align: left;
    }

    .print-corner-label.right {
      right: 0;
      text-align: right;
    }

    .info-row {
      margin-top: 16px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .info-row-line {
      display: flex;
      justify-content: space-between;
      width: 100%;
      font-size: 12px;
    }

    .table-wrapper {
      width: 100%;
      margin-top: 20px;
    }

    table {
      border-collapse: collapse;
      width: 100%;
      border: 1.5px solid black;
      table-layout: fixed;
    }

         th, td {
      border: 1.5px solid black;
      padding: 3px 4px;
      font-size: 12px;
      text-align: center;
      white-space: normal;
      overflow-wrap: break-word;
      word-break: break-word;
    }

    
    th {
      background-color: lightgray;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    td.applicant-name {
      text-align: left;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${html}
  </div>
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "0mm", bottom: "8mm", left: "8mm", right: "8mm" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const prefix =
      fileNamePrefix ||
      (title || "Attendance_Report").replace(/[^a-z0-9]+/gi, "_");
    const fileName = `${prefix}_${timestamp}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: title || "Attendance Report",
      legacyAction: "EXAM_ATTENDANCE_REPORT_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported the ${title || "Attendance Report"} PDF.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Attendance Report PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

router.post("/generate-program-evaluation-pdf", async (req, res) => {
  let browser;

  try {
    const { html, student_number, last_name, first_name } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "No HTML received" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();

    // Long bond paper: 8.5in x 13in (215.9mm x 330.2mm).
    await page.setViewport({
      width: 816, // 215.9mm @ 96dpi
      height: 1248, // 330.2mm @ 96dpi
      deviceScaleFactor: 2,
    });

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (request) =>
      console.log(
        "REQUEST FAILED:",
        request.url(),
        request.failure()?.errorText,
      ),
    );

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Reproduces the ORIGINAL on-screen/print layout (letterhead, OFFICE OF
    // THE REGISTRAR / ACADEMIC PROGRAM EVALUATION titles, student info
    // strip, 2-column set of per-semester GRADE / COURSE CODE-TITLE /
    // UNIT(LEC,LAB) tables — 1st sem left, 2nd sem right, Summer
    // full-width below). Block header rows now use the same lightgray +
    // bordered-table treatment as the Applicant List PDF export, and
    // Important Reminders sits directly below the last course block
    // (no forced bottom-of-page push).
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page {
      size: 215.9mm 330.2mm;
      margin: 0;
    }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      font-family: "Poppins", Arial, sans-serif;
      color: #000;
    }

    body {
      padding: 6mm 6mm 4mm;
    }

    .pe-print-layout {
      width: 82rem;
      margin: 0 auto;
      zoom: 0.60;
    }

    .pe-print-header-row {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 70rem;
      margin: 0 auto;
    }

    .pe-print-logo-wrap {
      padding-top: 1.5rem;
      padding-right: 3rem;
    }

    .pe-print-logo {
      width: 8rem;
      height: 8rem;
      display: block;
      object-fit: cover;
      border-radius: 50%;
    }

    .pe-print-header-text {
      margin-top: 1.5rem;
      text-align: center;
      font-size: 10px;
      line-height: 1.5;
    }

    .pe-print-republic {
      font-family: Arial;
      font-size: 13px;
    }

    .pe-print-school-name {
      text-align: center;
      margin-top: 0;
      line-height: 1;
      font-size: 1.6rem;
      letter-spacing: -1px;
      font-weight: 600;
    }

    .pe-print-address {
      margin-top: 0.5rem;
      text-align: center;
      font-size: 12px;
      letter-spacing: 1px;
    }

    .pe-print-office-title {
      margin-left: 1rem;
      text-align: center;
      width: 80rem;
      font-size: 1.6rem;
      letter-spacing: -1px;
      font-weight: 500;
    }

    .pe-print-main-title {
      margin-left: 1rem;
      margin-top: -0.2rem;
      width: 80rem;
      text-align: center;
      font-size: 1.8rem;
      letter-spacing: -1px;
      font-weight: 600;
    }

    .pe-print-student-info {
      padding: 0.7rem 1rem;
      margin-left: 1rem;
      border-bottom: solid #000 1px;
      width: 80rem;
    }

    .pe-print-student-info .row {
      display: flex;
      line-height: 1.14;
      margin-top: 0.28rem;
    }
    .pe-print-student-info .row:first-child { margin-top: 0; }

    .pe-print-student-info .col-wide {
      display: flex;
      width: 38rem;
    }
    .pe-print-student-info .col {
      display: flex;
    }

    .pe-print-student-info .label {
      font-size: 1rem;
      letter-spacing: -1px;
      width: 9rem;
      display: inline-block;
    }
    .pe-print-student-info .label-narrow {
      width: 6rem;
    }
    .pe-print-student-info .value {
      font-size: 1.06rem;
      font-weight: 500;
    }

    .pe-print-semester-row {
      display: flex;
      flex-wrap: nowrap;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .pe-print-semester-column {
      flex: 1 1 50%;
      width: 50%;
      max-width: 50%;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0.35rem;
      padding-left: 1rem;
    }

    .pe-print-summer-row {
      width: 100%;
      margin-top: 0.35rem;
      padding-left: 1rem;
    }

    .pe-print-block {
      width: 100%;
      align-self: flex-start;
      height: fit-content;
      margin-bottom: 0.35rem;
    }

    /* ── Bordered table, matching the Applicant List PDF's table style ── */
    .pe-print-block table {
      border-collapse: collapse;
      width: auto;
      border: 1.5px solid #000;
    }

    .pe-print-block td {
      border: 1.5px solid #000;
    }


    .pe-print-header-row1 td,
    .pe-print-header-row2 td {
      background-color: lightgray;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .pe-print-block-title {
      text-align: center;
      font-weight: 700;
      font-size: 0.8rem;
      padding: 3px 0;
    }

    .pe-print-header-row2 td {
      font-weight: 700;
      font-size: 0.8rem;
      text-align: center;
      padding: 3px 2px;
    }

    .pe-col-grade {
      width: 6rem;
      text-align: center;
    }
    .pe-col-course {
      width: 28rem;
    }
    .pe-col-unit {
      width: 5rem;
      text-align: center;
    }

    .pe-unit-label {
      font-weight: 700;
      text-align: center;
      font-size: 0.8rem;
    }
    .pe-unit-sub {
      display: flex;
    }
    .pe-unit-sub span {
      width: 50%;
      text-align: center;
      font-weight: 700;
      font-size: 0.8rem;
    }

    .pe-print-row td {
      font-size: 0.8rem;
      line-height: 1.12;
      vertical-align: top;
      padding: 4px 3px;
    }

    .pe-course-code {
      display: inline-block;
      width: 6.4rem;
      vertical-align: top;
    }
    .pe-course-title {
      display: inline-block;
      vertical-align: top;
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
      line-height: 1.15;
    }

    .pe-unit-values {
      display: flex;
    }
    .pe-unit-values span {
      width: 50%;
      text-align: center;
      font-size: 0.8rem;
    }

    .pe-print-totals-row td {
      font-weight: 700;
      padding: 4px 3px;
    }
    .pe-totals-label {
      text-align: right;
      padding-right: 0.5rem !important;
    }

    /* ── Sits directly below the last block, no forced bottom push ── */
    .pe-print-reminders {
      margin-top: 1rem;
      padding-left: 1rem;
      padding-top: 0.5rem;
      border-top: solid 1px #000;
      width: 80rem;
      font-size: 0.8rem;
    }

    .pe-print-reminders-title {
      font-weight: 700;
      margin-bottom: 0.25rem;
    }

    .pe-print-reminders ol {
      margin: 0;
      padding-left: 1.25rem;
    }

    .pe-print-reminders li {
      margin-bottom: 0.15rem;
      line-height: 1.3;
    }

    button { display: none; }
    img { max-width: 100%; }
  </style>
</head>
<body>
  ${html}
</body>
</html>
    `.trim();

    await page.setContent(wrappedHtml, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await waitForImages(page);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const pdfBuffer = await page.pdf({
      width: "215.9mm",
      height: "330.2mm",
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF buffer is empty");
    }

    const safeLastName = String(last_name || "Student")
      .trim()
      .replace(/\s+/g, "_");
    const safeFirstName = String(first_name || "")
      .trim()
      .replace(/\s+/g, "_");
    const numberSuffix = student_number ? `_${student_number}` : "";
    const fileName = `Program_Evaluation_${safeLastName}${safeFirstName ? "_" + safeFirstName : ""}${numberSuffix}.pdf`;

    await insertPdfExportAudit(req, {
      documentLabel: "Academic Program Evaluation",
      legacyAction: "PROGRAM_EVALUATION_PDF_EXPORT",
      legacyMessage: ({ roleLabel, actorId }) =>
        `${roleLabel} (${actorId}) exported Academic Program Evaluation PDF${student_number ? ` for Student (${student_number})` : ""}.`,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (err) {
    console.error("Program Evaluation PDF ERROR:", err);
    return res.status(500).json({
      message: "PDF generation failed",
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
  }
});

module.exports = router;
