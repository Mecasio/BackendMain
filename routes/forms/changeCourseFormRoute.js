const express = require("express");
const puppeteer = require("puppeteer");

const { insertAuditLogAdmission } = require("../../utils/auditLogger");

const router = express.Router();

// ─── Shared audit helpers (identical pattern to your existing admission
// PDF routes file, duplicated here so this router has no import coupling
// to that file) ───────────────────────────────────────────────────────────
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

// ─── Shared Puppeteer launch config ─────────────────────────────────────────
const launchBrowser = () =>
  puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

const buildOutputFilename = (prefix, { last_name, first_name, applicant_number }) => {
  const safeLastName = String(last_name || "Applicant").trim().replace(/\s+/g, "_");
  const safeFirstName = String(first_name || "").trim().replace(/\s+/g, "_");
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

// ─── Shared handler factory for the 4 Change Course form variants ──────────
// These all come from ExaminationProfile.jsx's printDiv(), which uses
// @page { size: Legal; margin: 0 } and a ".student-table { margin-top:
// 35px }" offset — mirrored here exactly so the PDF matches the print
// preview the same way your other routes already do for their forms.
const makeChangeCourseHandler = ({ routeLabel, filenamePrefix, auditAction, auditLabel }) =>
  async (req, res) => {
    let browser;

    try {
      const { html, applicant_number, last_name, first_name } = req.body;

      if (!html || typeof html !== "string") {
        return res.status(400).json({ message: "No HTML received" });
      }

      browser = await launchBrowser();
      const page = await browser.newPage();

      // Legal size @ 96dpi (8.5in x 14in)
      await page.setViewport({
        width: 816,
        height: 1344,
        deviceScaleFactor: 2,
      });

      page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
      page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
      page.on("requestfailed", (request) =>
        console.log("REQUEST FAILED:", request.url(), request.failure()?.errorText),
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      margin: 0;
      padding: 0;
    }

    @page {
      size: Legal;
      margin: 0;
    }

    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial, sans-serif;
      background: #ffffff;
    }

    .print-container {
      width: 100%;
      height: auto;
    }

    .student-table {
      margin-top: 35px !important;
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
        margin: { top: "0.25in", bottom: "0.25in", left: "0.25in", right: "0.25in" },
      });

      if (!pdfBuffer || pdfBuffer.length === 0) {
        throw new Error("Generated PDF buffer is empty");
      }

      const fileName = buildOutputFilename(filenamePrefix, req.body);

      try {
        const { actorId, actorRole } = getEnrollmentAuditActor(req);
        const roleLabel = formatEnrollmentAuditActorRole(actorRole);
        const printAction = String(req.body?.audit_print_action || "").trim();
        const label = String(
          req.body?.document_label || auditLabel || "document",
        ).trim();
        const applicantName = [
          String(req.body?.last_name || "").trim(),
          String(req.body?.first_name || "").trim(),
        ]
          .filter(Boolean)
          .join(", ") || "Unknown Applicant";

        if (printAction === "DOWNLOAD_EXAM_PDF") {
          await insertAuditLogAdmission({
            actorId,
            role: actorRole,
            action: "DOWNLOAD_EXAM_PDF",
            severity: "INFO",
            message: `${roleLabel} (${actorId}) downloaded ${label} PDF for applicant ${applicantName} (${applicant_number || "N/A"}).`,
          });
        } else {
          await insertAuditLogAdmission({
            actorId,
            role: actorRole,
            action: auditAction,
            severity: "INFO",
            message: `${roleLabel} (${actorId}) exported ${auditLabel} PDF${applicant_number ? ` for Applicant (${applicant_number})` : ""}.`,
          });
        }
      } catch (auditErr) {
        console.error(`${auditLabel} PDF audit log failed:`, auditErr);
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
      res.setHeader("Content-Length", pdfBuffer.length);

      return res.end(pdfBuffer);
    } catch (err) {
      console.error(`${routeLabel} PDF ERROR:`, err);
      return res.status(500).json({
        message: "PDF generation failed",
        error: err.message,
        stack: err.stack,
      });
    } finally {
      if (browser) await browser.close();
    }
  };

// ─── 1. Change Course Form — with Campus Dean approval (pre-filled) ────────
router.post(
  "/generate-change-course-dean-pdf",
  makeChangeCourseHandler({
    routeLabel: "Change Course (Dean)",
    filenamePrefix: "Change_Course_Dean",
    auditAction: "CHANGE_COURSE_DEAN_PDF_EXPORT",
    auditLabel: "Change Course Form (Dean)",
  }),
);

// ─── 2. Empty Change of Course Form — Campus Dean, blank ───────────────────
router.post(
  "/generate-empty-change-course-dean-pdf",
  makeChangeCourseHandler({
    routeLabel: "Empty Change Course (Dean)",
    filenamePrefix: "Empty_Change_Course_Dean",
    auditAction: "EMPTY_CHANGE_COURSE_DEAN_PDF_EXPORT",
    auditLabel: "Empty Change Course Form (Dean)",
  }),
);

// ─── 3. Change Course Form — with Campus Director only (pre-filled) ────────
router.post(
  "/generate-change-course-director-pdf",
  makeChangeCourseHandler({
    routeLabel: "Change Course (Director)",
    filenamePrefix: "Change_Course_Director",
    auditAction: "CHANGE_COURSE_DIRECTOR_PDF_EXPORT",
    auditLabel: "Change Course Form (Director)",
  }),
);

// ─── 4. Empty Change of Course Form — Campus Director only, blank ──────────
router.post(
  "/generate-empty-change-course-director-pdf",
  makeChangeCourseHandler({
    routeLabel: "Empty Change Course (Director)",
    filenamePrefix: "Empty_Change_Course_Director",
    auditAction: "EMPTY_CHANGE_COURSE_DIRECTOR_PDF_EXPORT",
    auditLabel: "Empty Change Course Form (Director)",
  }),
);

module.exports = router;