const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer");
const { db, db3 } = require("../database/database");
const { insertAuditLogEnrollment } = require("../../utils/auditLogger");

const router = express.Router();
const exportJobs = new Map();
const exportDir = path.join(os.tmpdir(), "earist-cor-exports");

if (!fs.existsSync(exportDir)) {
  fs.mkdirSync(exportDir, { recursive: true });
}

const sanitizeFileName = (value) =>
  String(value || "cor")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim() || "cor";

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// Create a dependency-free ZIP using stored entries. COR PDFs are already
// compressed internally, so deflating them again would consume CPU for little
// size benefit.
const createZipBuffer = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    name.copy(localHeader, 30);
    localParts.push(localHeader, data);

    const centralHeader = Buffer.alloc(46 + name.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    name.copy(centralHeader, 46);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

const getFrontendOrigin = (req) =>
  req.body.frontend_origin ||
  req.headers.origin ||
  process.env.FRONTEND_URL ||
  "http://localhost:5173";

const getBrowserExecutablePath = () => {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
};

const updateJob = (job, patch) => {
  Object.assign(job, patch, { updated_at: new Date().toISOString() });
};

const COR_EXPORT_BATCH_SIZE = Math.max(
  1,
  Math.min(200, Number(process.env.COR_EXPORT_BATCH_SIZE || 200)),
);
const COR_EXPORT_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.COR_EXPORT_CONCURRENCY || 4)),
);
const COR_EXPORT_RETRY_LIMIT = Math.max(
  0,
  Math.min(3, Number(process.env.COR_EXPORT_RETRY_LIMIT || 2)),
);

let browserPromise = null;
const pagePool = []; // array of { page, busy, origin, bootstrapped }

const launchBrowser = () =>
  puppeteer.launch({
    headless: "new",
    ...(getBrowserExecutablePath()
      ? { executablePath: getBrowserExecutablePath() }
      : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

const getBrowser = async () => {
  if (!browserPromise) {
    browserPromise = launchBrowser()
      .then((browser) => {
        browser.on("disconnected", () => {
          // Browser crashed / was closed externally.
          // Clear state so the next request relaunches it lazily.
          browserPromise = null;
          pagePool.length = 0;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null; // allow retry on next call
        throw err;
      });
  }
  return browserPromise;
};

const bootstrapPage = async (page, origin) => {
  const url = new URL("/cor_export_render", origin);
  url.searchParams.set("fast", "1");

  await page.goto(url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForFunction(
    () =>
      typeof window.__loadCorForExport === "function" &&
      window.__COR_EXPORT_BOOTSTRAPPED === true,
    { timeout: 30000, polling: 50 },
  );

  await page.addStyleTag({
    content:
      "@page { size: A4; margin: 0; } html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }",
  });
};

const acquirePage = async (origin) => {
  const browser = await getBrowser();

  for (;;) {
    const free = pagePool.find(
      (entry) => !entry.busy && entry.origin === origin && entry.bootstrapped,
    );
    if (free) {
      free.busy = true;
      return free;
    }

    if (pagePool.length < COR_EXPORT_CONCURRENCY) {
      const entry = { page: null, busy: true, origin, bootstrapped: false };
      pagePool.push(entry);
      try {
        const page = await browser.newPage();
        await page.setViewport({
          width: 1240,
          height: 1754,
          deviceScaleFactor: 1,
        });
        await bootstrapPage(page, origin);
        entry.page = page;
        entry.bootstrapped = true;
        return entry;
      } catch (err) {
        // Bootstrap failed — remove the broken slot so the pool can retry.
        const idx = pagePool.indexOf(entry);
        if (idx !== -1) pagePool.splice(idx, 1);
        throw err;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const releasePage = (entry) => {
  entry.busy = false;
};

const discardPage = async (entry) => {
  const idx = pagePool.indexOf(entry);
  if (idx !== -1) pagePool.splice(idx, 1);
  if (entry.page) {
    await entry.page.close().catch(() => {});
  }
};

const waitForCorReady = async (page, studentNumber, timeoutMs = 45000) => {
  await page.waitForFunction(
    (expectedStudentNumber) => {
      if (window.__COR_READY !== true) return false;
      if (window.__COR_ENROLLED_READY !== true) return false;

      const root = document.getElementById("server-cor-export");
      if (!root) return false;

      const enrolledCount = Number(window.__COR_ENROLLED_COUNT || 0);
      if (enrolledCount > 0) {
        const subjectRows = root.querySelectorAll("tr[data-cor-subject='1']");
        if (subjectRows.length < enrolledCount) return false;
      }

      const filledValues = Array.from(
        root.querySelectorAll("input, textarea, select"),
      )
        .map((element) =>
          String(element.value || element.getAttribute("value") || "").trim(),
        )
        .filter(Boolean);

      return (
        filledValues.includes(String(expectedStudentNumber)) ||
        filledValues.length >= 4
      );
    },
    { timeout: timeoutMs, polling: 50 },
    studentNumber,
  );
};

const withTimeout = (promise, timeoutMs, message) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), timeoutMs),
    ),
  ]);

const renderCorPdf = async (page, student, token) => {
  const studentNumber = student.student_number;
  const payload = {
    student_number: studentNumber,
    person_id: student.person_id || "",
    preload: student.preload || null,
  };

  await page.evaluate((nextToken) => {
    if (nextToken) localStorage.setItem("token", nextToken);
    else localStorage.removeItem("token");
  }, token || "");

  await withTimeout(
    page.evaluate(async (nextPayload) => {
    window.__COR_READY = false;
    window.__COR_FIT_COMPLETE = false;
    window.__COR_FITS_A4 = false;
    window.__COR_ENROLLED_READY = false;
    window.__COR_ENROLLED_COUNT = 0;
    await window.__loadCorForExport(nextPayload);
    }, payload),
    60000,
    `COR data loading timed out for ${studentNumber}`,
  );

  await waitForCorReady(page, studentNumber);

  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

  // Match the on-screen COR before capturing the PDF. The QR code, logo,
  // profile image, and tuition mark may finish loading after the data state is
  // ready, so wait for all rendered images and fonts to settle first.
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("#server-cor-export img")).every(
        (image) => image.complete,
      ),
    { timeout: 15000, polling: 50 },
  );

  const pdf = await withTimeout(
    page.pdf({
      width: "210mm",
      height: "297mm",
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    }),
    30000,
    `COR PDF generation timed out for ${studentNumber}`,
  );

  return {
    name: `${sanitizeFileName(studentNumber)}_Certificate_Of_Registration.pdf`,
    data: Buffer.from(pdf),
  };
};

const runCorExportJob = async (job) => {
  let completed = 0;
  let failed = 0;

  const updateProgress = (message, extra = {}) => {
    updateJob(job, {
      pending: job.jobs.filter((item) => item.status === "Pending").length,
      processing: job.jobs.filter((item) => item.status === "Processing").length,
      current: completed + failed,
      completed,
      failed,
      progress: Math.round(((completed + failed) / job.total) * 90),
      message,
      ...extra,
    });
  };

  const processJob = async (exportJob) => {
    exportJob.status = "Processing";
    exportJob.started_at = new Date().toISOString();
    updateProgress(`Processing ${exportJob.student.student_number}`);

    let lastError = null;
    for (let attempt = 1; attempt <= COR_EXPORT_RETRY_LIMIT + 1; attempt += 1) {
      exportJob.attempts = attempt;
      let entry = null;

      try {
        entry = await acquirePage(job.frontend_origin);
        const rendered = await renderCorPdf(entry.page, exportJob.student, job.auth_token);

        exportJob.file_name = rendered.name;
        exportJob.file_path = path.join(
          job.output_dir,
          `${String(exportJob.sequence).padStart(6, "0")}_${rendered.name}`,
        );
        await fs.promises.writeFile(exportJob.file_path, rendered.data);

        const fileStats = await fs.promises.stat(exportJob.file_path);
        if (!fileStats.isFile() || fileStats.size === 0) {
          throw new Error("Generated COR PDF is missing or empty.");
        }

        exportJob.status = "Completed";
        exportJob.completed_at = new Date().toISOString();
        exportJob.error = "";
        completed += 1;
        updateProgress(`Completed ${completed}/${job.total}`);
        return;
      } catch (error) {
        lastError = error;
        exportJob.error = error.message || "COR generation failed";

        if (entry) {
          await discardPage(entry);
          entry = null;
        }

        if (attempt <= COR_EXPORT_RETRY_LIMIT) {
          exportJob.status = "Pending";
          updateProgress(
            `Retrying ${exportJob.student.student_number} (${attempt}/${COR_EXPORT_RETRY_LIMIT})`,
          );
        }
      } finally {
        if (entry) releasePage(entry);
      }
    }

    exportJob.status = "Failed";
    exportJob.failed_at = new Date().toISOString();
    exportJob.error = lastError?.message || "COR generation failed";
    failed += 1;
    updateProgress(`Failed ${failed} job(s)`);
  };

  const processBatch = async (batch) => {
    const queue = [...batch];

    const worker = async () => {
      while (queue.length > 0) {
      const exportJob = queue.shift();
      if (!exportJob) return;
        try {
          await processJob(exportJob);
        } finally {
          // The PDF is already saved. Release the prepared COR payload before
          // the next batch starts so completed batch data is not retained.
          if (exportJob.student) exportJob.student.preload = null;
        }
      }
    };

    const workerCount = Math.min(COR_EXPORT_CONCURRENCY, batch.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  };

  try {
    await fs.promises.mkdir(job.output_dir, { recursive: true });

    const batches = [];
    for (let index = 0; index < job.jobs.length; index += COR_EXPORT_BATCH_SIZE) {
      batches.push(job.jobs.slice(index, index + COR_EXPORT_BATCH_SIZE));
    }

    updateJob(job, {
      status: "running",
      batch_size: COR_EXPORT_BATCH_SIZE,
      batch_count: batches.length,
      current_batch: 0,
      message: `Queued ${job.total} CORs in ${batches.length} batch(es)`,
      pending: job.total,
      processing: 0,
      completed: 0,
      failed: 0,
    });

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      updateJob(job, {
        current_batch: batchIndex + 1,
        message: `Processing batch ${batchIndex + 1}/${batches.length}`,
      });
      await processBatch(batch);
    }

    const missingFiles = [];
    for (const exportJob of job.jobs) {
      if (exportJob.status !== "Completed") continue;
      if (!exportJob.file_path || !fs.existsSync(exportJob.file_path)) {
        exportJob.status = "Failed";
        exportJob.error = "Completed job file could not be verified.";
        missingFiles.push(exportJob.student.student_number);
        completed = Math.max(0, completed - 1);
        failed += 1;
      }
    }

    if (completed === 0) {
      throw new Error("No CORs were generated successfully.");
    }

    updateJob(job, {
      message: "Collecting verified COR files...",
      progress: 93,
      missing_files: missingFiles,
    });

    const verifiedFiles = job.jobs
      .filter((item) => item.status === "Completed")
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => ({
        name: item.file_name,
        data: fs.readFileSync(item.file_path),
      }));

    updateJob(job, { message: "Creating export package...", progress: 97 });

    const packageBuffer =
      verifiedFiles.length === 1
        ? verifiedFiles[0].data
        : createZipBuffer(verifiedFiles);

    await fs.promises.writeFile(job.file_path, packageBuffer);

    for (const exportJob of job.jobs) {
      if (exportJob.file_path) {
        await fs.promises.unlink(exportJob.file_path).catch(() => {});
      }
    }

    updateJob(job, {
      status: "done",
      progress: 100,
      current: completed,
      completed,
      failed,
      pending: 0,
      processing: 0,
      message: failed ? "Completed with failed COR jobs" : "Ready to download",
      missing_files: missingFiles,
    });
  } catch (error) {
    console.error("Server COR export failed:", error);
    updateJob(job, {
      status: "error",
      error: error.message || "Server COR export failed",
      message: "Export failed",
      completed,
      failed: Math.max(failed, job.total - completed),
      pending: job.jobs.filter((item) => item.status === "Pending").length,
      processing: job.jobs.filter((item) => item.status === "Processing").length,
    });
  } finally {
    await fs.promises.rm(job.output_dir, { recursive: true, force: true }).catch(() => {});
  }
};

router.get("/get_student_number", async (req, res) => {
  try {
    const [rows] = await db3.query(`
        SELECT DISTINCT
            sts.student_number,
            pt.person_id,
            sts.year_level_id,
            pt.campus,
            ct.curriculum_id,
            sy.id AS active_school_year_id,
            sy.year_id,
            sy.semester_id
        FROM student_status_table sts
            JOIN student_numbering_table snt ON sts.student_number = snt.student_number
            JOIN person_table pt ON snt.person_id = pt.person_id
            JOIN curriculum_table ct ON sts.active_curriculum = ct.curriculum_id
            JOIN dprtmnt_curriculum_table dct ON ct.curriculum_id = dct.curriculum_id
            JOIN dprtmnt_table dt ON dct.dprtmnt_id = dt.dprtmnt_id
            JOIN active_school_year_table sy ON sts.active_school_year_id = sy.id
        WHERE enrolled_status = 1;
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching data" });
  }
});

router.post("/cor-export/jobs", async (req, res) => {
  const students = Array.isArray(req.body.students) ? req.body.students : [];
  const filteredStudents = students
    .filter((student) => student?.student_number)
    .map((student) => ({
      student_number: String(student.student_number),
      person_id: student.person_id ? String(student.person_id) : "",
      preload: student.preload || null,
    }));

  if (filteredStudents.length === 0) {
    return res.status(400).json({ message: "No students selected for export" });
  }

  const authHeader = String(
    req.headers.authorization || req.headers.Authorization || "",
  );
  const authToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!authToken) {
    return res.status(401).json({
      message: "Authorization token is required to generate the COR.",
    });
  }

  const id = crypto.randomUUID();
  const packageBaseName = sanitizeFileName(req.body.file_name || `cor_export_${id}`);
  const fileName = `${packageBaseName}.${filteredStudents.length > 1 ? "zip" : "pdf"}`;
  const outputDir = path.join(exportDir, id);
  const jobs = filteredStudents.map((student, index) => ({
    id: `${id}-${index + 1}`,
    sequence: index,
    student,
    status: "Pending",
    attempts: 0,
    error: "",
  }));
  const job = {
    id,
    status: "queued",
    total: filteredStudents.length,
    current: 0,
    progress: 0,
    message: "Queued",
    error: "",
    file_name: fileName,
    file_path: path.join(exportDir, fileName),
    output_dir: outputDir,
    frontend_origin: getFrontendOrigin(req),
    auth_token: authToken,
    students: filteredStudents,
    jobs,
    pending: jobs.length,
    processing: 0,
    completed: 0,
    failed: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  exportJobs.set(id, job);
  setImmediate(() => runCorExportJob(job));

  res.status(202).json({
    job_id: id,
    total: job.total,
    pending: job.pending,
    batch_size: COR_EXPORT_BATCH_SIZE,
    concurrency: COR_EXPORT_CONCURRENCY,
    retry_limit: COR_EXPORT_RETRY_LIMIT,
  });
});

router.get("/cor-export/jobs/:jobId", (req, res) => {
  const job = exportJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ message: "Export job not found" });

  res.json({
    job_id: job.id,
    status: job.status,
    total: job.total,
    current: job.current,
    progress: job.progress,
    pending: job.pending,
    processing: job.processing,
    completed: job.completed,
    failed: job.failed,
    batch_size: job.batch_size || COR_EXPORT_BATCH_SIZE,
    batch_count: job.batch_count || 0,
    current_batch: job.current_batch || 0,
    message: job.message,
    error: job.error,
    file_name: job.file_name,
    failed_jobs: job.jobs
      .filter((item) => item.status === "Failed")
      .map((item) => ({
        job_id: item.id,
        student_number: item.student.student_number,
        attempts: item.attempts,
        error: item.error,
      })),
  });
});

router.get("/cor-export/jobs/:jobId/preload/:studentNumber", (req, res) => {
  const job = exportJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ message: "Export job not found" });

  const student = job.students.find(
    (item) => item.student_number === req.params.studentNumber,
  );
  if (!student) return res.status(404).json({ message: "Student not found" });

  res.json({ preload: student.preload || null });
});

router.get("/cor-export/jobs/:jobId/download", (req, res) => {
  const job = exportJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ message: "Export job not found" });
  if (job.status !== "done" || !fs.existsSync(job.file_path)) {
    return res.status(409).json({ message: "Export job is not ready" });
  }

  res.download(job.file_path, job.file_name, (error) => {
    if (error) {
      console.error("COR export download failed:", error);
      return;
    }

    exportJobs.delete(job.id);
    fs.unlink(job.file_path, (unlinkError) => {
      if (unlinkError && unlinkError.code !== "ENOENT") {
        console.error("Failed to delete COR export PDF:", unlinkError);
      }
    });
  });
});

const closeCorExportBrowser = async () => {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (err) {
    console.error("Failed to close COR export browser:", err);
  } finally {
    browserPromise = null;
    pagePool.length = 0;
  }
};

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

router.post("/cor-export/audit", async (req, res) => {
  const {
    exported_count,
    department_label,
    program_label,
    year_level_label,
  } = req.body;

  try {
    const { actorId, actorRole } = getEnrollmentAuditActor(req);
    const roleLabel = formatEnrollmentAuditActorRole(actorRole);
    const filters = [
      department_label ? `department ${department_label}` : null,
      program_label ? `program ${program_label}` : null,
      year_level_label ? `year level ${year_level_label}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    await insertAuditLogEnrollment({
      actorId,
      role: actorRole,
      action: "COR_EXPORT",
      severity: "INFO",
      message: `${roleLabel} (${actorId}) exported ${Number(exported_count) || 0} Certificate of Registration PDF file(s)${filters ? ` for ${filters}` : ""}.`,
    });

    res.json({ success: true, message: "COR export audit log inserted" });
  } catch (err) {
    console.error("COR export audit log failed:", err);
    res.status(500).json({ message: "Failed to insert COR export audit log" });
  }
});

module.exports = router;
module.exports.closeCorExportBrowser = closeCorExportBrowser;
