require("dotenv").config();

const express = require("express");
const cors = require("cors");
const webtoken = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const bodyparser = require("body-parser");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const {
  getGradeConversions,
  getStoredNumericGrade,
} = require("./utils/gradeConversion");
const { auditRequestStore } = require("./utils/auditLogger");
const { transporter } = require("./utils/mailer");
const { upload, profileUpload } = require("./utils/uploadMiddleware");

const app = express();
const http = require("http").createServer(app);

const { db, db3 } = require("./routes/database/database");

const { initializeSocket } = require("./socket/socketServer");
const { startSocketApis } = require("./socket");
const registerSocketHandlers = require("./utils/registerSocketHandlers");

app.use((req, res, next) => {
  auditRequestStore.run(req, next);
});

app.use(express.json({ limit: "50mb" }));
app.use(bodyparser.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

const allowedOrigins = [
  "http://192.168.5.116:5173", "http://136.239.248.62:5173", "http://127.0.0.1:5173", "http://127.0.0.1", "http://136.239.248.62", "https://ap.earist.edu.ph", "http://ap.earist.edu.ph"
  ,"http://192.168.50.36:5173",
]; 

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api/uploads", express.static(path.join(__dirname, "uploads")));
app.use(
  "/Applicant1by1",
  express.static(path.join(__dirname, "uploads", "Applicant1by1")),
);
app.use(
  "/ApplicantOnlineDocuments",
  express.static(path.join(__dirname, "uploads", "ApplicantOnlineDocuments")),
);
app.use(
  "/StudentOnlineDocuments",
  express.static(path.join(__dirname, "uploads", "StudentOnlineDocuments")),
);
app.use("/assets", express.static(path.join(__dirname, "assets")));

const applicantDocsDir = path.join(
  __dirname,
  "uploads",
  "ApplicantOnlineDocuments",
);

const io = initializeSocket(http, allowedOrigins);
app.set("io", io);
app.locals.io = io;

startSocketApis(io, {
  db,
  db3,
  transporter,
  bcrypt,
  QRCode,
  baseDir: __dirname,
});

const uploadPath = path.join(__dirname, "uploads");
const signatureDir = path.join(__dirname, "uploads", "signature");
const torSignatoriesDir = path.join(__dirname, "uploads", "TOR_Signatories");

if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}
if (!fs.existsSync(signatureDir)) {
  fs.mkdirSync(signatureDir, { recursive: true });
}
if (!fs.existsSync(torSignatoriesDir)) {
  fs.mkdirSync(torSignatoriesDir, { recursive: true });
}

app.use("/uploads", express.static(uploadPath));

const {
  authenticateTokenUnlessPublic,
} = require("./middleware/auth");

app.use("/api", authenticateTokenUnlessPublic);

const authRoute = require("./routes/auth_routes/authRoutes");
const applicantFormRoute = require("./routes/applicant_routes/applicantFormRoute");
const examPermit = require("./routes/applicant_routes/examPermitRoute");
const requirementsUploaderRoute = require("./routes/applicant_routes/requirementsUploaderRoute");
const studentRoute = require("./routes/student_routes/studentRoute");
const studentEditInformation = require("./routes/student_routes/studentEditInformation");
const studentListRoute = require("./routes/student_routes/studentListRoute");
const enrollmentPersonRoute = require("./routes/student_routes/enrollmentPersonRoute");
const adminRoute = require("./routes/admin_routes/registrarRoute");
const signature = require("./routes/admin_routes/signature");
const facultyRoute = require("./routes/faculty_routes/facultyRoute");
const programTagging = require("./routes/system_routes/programTaggingRoute");
const coursePanel = require("./routes/system_routes/coursePanelRoute");
const courseTagged = require("./routes/system_routes/courseTaggedRoute");
const tosfPanel = require("./routes/system_routes/tosfRoute");
const paymentExporting = require("./routes/system_routes/paymentExportingRoute");
const corExporting = require("./routes/system_routes/corExportingRoute");
const entranceExamSchedule = require("./routes/admission_routes/entranceExamSchedule");
const applicantScoringRoute = require("./routes/admission_routes/applicantScoringRoute");
const subjectsRoute = require("./routes/admission_routes/subjectsRoute");
const interviewQualifyingRoute = require("./routes/admission_routes/interviewQualifyingRoute");
const verifyDocumentSchedule = require("./routes/admission_routes/verifyDocumentSchedule");
const QualifyingInterviewExam = require("./routes/admission_routes/QualifyingInterviewExam");
const medicalExamRoute = require("./routes/admission_routes/medicalExamRoute");
const qrCodeForStudents = require("./routes/qrCodeForStudents");
const studentPayment = require("./routes/payment/studentScholarship");
const receiptCounter = require("./routes/payment/receiptCounter");
const matriculationPayment = require("./routes/payment/matriculation");
const programRoute = require("./routes/system_routes/programRoute");
const requirementsRoute = require("./routes/system_routes/requirementsRoute");
const applicantRoutesResetPassword = require("./routes/reset_password_routes/applicantresetpasswordRoutes");
const studentRoutesResetPassword = require("./routes/reset_password_routes/studentresetpasswordRoutes");
const facultyRoutesResetPassword = require("./routes/reset_password_routes/facultyresetpasswordRoutes");
const registrarRoutesResetPassword = require("./routes/reset_password_routes/registrarresetpasswordRoutes");
const announcementRoute = require("./routes/system_routes/announcement");
const programSlots = require("./routes/system_routes/programSlots");
const departmentRoute = require("./routes/system_routes/dprmntRoute");
const roomRegistrationRoute = require("./routes/system_routes/roomRegistrationRoute");
const departmentRoomRoute = require("./routes/system_routes/departmentRoom");
const departmentSectionRoute = require("./routes/system_routes/departmentSection");
const sectionSlotManagementRoute = require("./routes/system_routes/sectionSlotManagement");
const courseTaggingRoute = require("./routes/system_routes/courseTagging");
const reportsRoute = require("./routes/system_routes/reportsRoute");
const settingsRoute = require("./routes/system_routes/settingsRoute");
const importRoutes = require("./routes/import");
const templateRoute = require("./routes/system_routes/template");
const accessRoutes = require("./routes/auth_routes/accessRoute");
const userPageAccess = require("./routes/auth_routes/userPageAccessRoute");
const dprtmntCurriculum = require("./routes/system_routes/dprtmntCurriculum");
const section = require("./routes/system_routes/section");
const emailTemplate = require("./routes/system_routes/emailTemplate");
const changePassword = require("./routes/auth_routes/changePassword");
const facultyDegree = require("./routes/faculty_routes/facultyDegree");
const feeRules = require("./routes/payment/feeRules");
const registerStudent = require("./routes/student_routes/registerStudent");
const studentPaymentModule = require("./routes/student_routes/studentPaymentModule");
const studentAccountRoute = require("./routes/student_routes/studentAccounts");
const studentBalanceListRoute = require("./routes/system_routes/studentBalanceListRoute");
const curriculum = require("./routes/system_routes/curriculumRoute");
const schoolYear = require("./routes/system_routes/schoolYear");
const statistics = require("./routes/system_routes/statistics");
const payment = require("./routes/payment/payment");
const evaluation = require("./routes/system_routes/evaluation");
const yearLevelRoute = require("./routes/system_routes/yearLevel");
const gradeConversionRoute = require("./routes/system_routes/gradeConversion");
const studentGradeRoute = require("./routes/system_routes/studentGradeRoute");
const honorRoutes = require("./routes/system_routes/honorRoutes");
const nstpTagging = require("./routes/system_routes/nstpTagging");
const departmentSectionTagging = require("./routes/system_routes/departmentSectionTagging");
const auditLogsRoute = require("./routes/system_routes/auditLogsRoute");
const auditEventRoute = require("./routes/system_routes/auditEventRoute");
const studentHistoryLogsRoute = require("./routes/system_routes/studentHistoryLogsRoute");
const applicantAdminRequirements = require("./routes/admission_routes/applicantAdminRequirements");
const studentAdminRequirements = require("./routes/admission_routes/studentAdminRequirements");
const uploadApplicants = require("./routes/admission_routes/uploadApplicants");
const workload = require("./routes/system_routes/workload");
const downloadableFormsRoute = require("./routes/forms/downloadableFormsRoute");
const changeCourseFormRoute = require("./routes/forms/changeCourseFormRoute");
const controlNumberRoute = require("./routes/forms/controlNumberRoute");
const admissionContact = require("./routes/system_routes/admissionContact");
const examAttendanceRoute = require("./routes/admission_routes/examAttendanceRoute");
const admissionReportRoute = require("./routes/admission_routes/admissionReportRoute");
const courseTypeRoutes = require("./routes/system_routes/courseTypeRoutes");
const torRoute = require("./routes/admin_routes/torRoute");
const graduateVerification = require("./routes/student_routes/graduateVerificationRoute");

app.use("/api", graduateVerification);
app.use("/api", torRoute);
app.use("/api", courseTypeRoutes);
app.use("/api", admissionReportRoute);
app.use("/api", examAttendanceRoute);
app.use("/api", admissionContact);
app.use("/api", workload);
app.use("/api", uploadApplicants);
app.use("/api", applicantAdminRequirements);
app.use("/api", studentAdminRequirements);
app.use("/api", evaluation);
app.use("/api", payment);
app.use("/api", statistics);
app.use("/api", schoolYear);
app.use("/api", curriculum);
app.use("/api", registerStudent);
app.use("/api", studentPaymentModule);
app.use("/api", feeRules);
app.use("/api", facultyDegree);
app.use("/api", changePassword);
app.use("/api", emailTemplate);
app.use("/api", userPageAccess);
app.use("/api", programRoute);
app.use("/api/", authRoute);
app.use("/api/", accessRoutes);
app.use("/api", signature);
app.use("/api/", applicantFormRoute);
app.use("/api/", examPermit);
app.use("/api", requirementsUploaderRoute);
app.use("/api", studentRoute);
app.use("/api", studentListRoute);
app.use("/api", enrollmentPersonRoute);
app.use("/api/", adminRoute);
app.use("/api/", facultyRoute);
app.use("/api", programTagging);
app.use("/api", coursePanel);
app.use("/api", courseTagged);
app.use("/api", tosfPanel);
app.use("/api", paymentExporting);
app.use("/api", corExporting);
app.use("/api", entranceExamSchedule);
app.use("/api", applicantScoringRoute);
app.use("/api", subjectsRoute);
app.use("/api", interviewQualifyingRoute);
app.use("/api", verifyDocumentSchedule);
app.use("/api", QualifyingInterviewExam);
app.use("/api", medicalExamRoute);
app.use("/api", qrCodeForStudents);
app.use("/api", receiptCounter);
app.use("/api", studentEditInformation);
app.use("/api", matriculationPayment);
app.use("/api", studentPayment);
app.use("/api", importRoutes);
app.use("/api", templateRoute);
app.use("/api", nstpTagging);
app.use("/api", departmentSectionTagging);
app.use("/api", auditLogsRoute);
app.use("/api", auditEventRoute);
app.use("/api", studentHistoryLogsRoute);
app.use("/api", applicantRoutesResetPassword);
app.use("/api", studentRoutesResetPassword);
app.use("/api", facultyRoutesResetPassword);
app.use("/api", registrarRoutesResetPassword);
app.use("/api", announcementRoute);
app.use("/api", programSlots);
app.use("/api", departmentRoomRoute);
app.use("/api", departmentRoute);
app.use("/api", roomRegistrationRoute);
app.use("/api", requirementsRoute);
app.use("/api", dprtmntCurriculum);
app.use("/api", departmentSectionRoute);
app.use("/api", sectionSlotManagementRoute);
app.use("/api", courseTaggingRoute);
app.use("/api", reportsRoute);
app.use("/api", settingsRoute);
app.use("/api", section);
app.use("/api", studentAccountRoute);
app.use("/api", studentBalanceListRoute);
app.use("/api", yearLevelRoute);
app.use("/api", gradeConversionRoute);
app.use("/api", studentGradeRoute);
app.use("/api", honorRoutes);
app.use("/api", downloadableFormsRoute);
app.use("/api", changeCourseFormRoute);
app.use("/api", controlNumberRoute);

registerSocketHandlers({
  app,
  db,
  db3,
  transporter,
  bcrypt,
  webtoken,
  fs,
  path,
  QRCode,
  applicantDocsDir,
  getGradeConversions,
  getStoredNumericGrade,
  profileUpload,
  upload,
  baseDir: __dirname,
});

const getDbHost = () => {
  if (process.env.NODE_ENV === "production") {
    return process.env.DB_HOST_PUBLIC;
  } else if (process.env.NODE_ENV === "local") {
    return process.env.DB_HOST_LOCAL;
  }
  return "192.168.50.36";
};

const PORT = process.env.WEB_PORT || 5000;

http.listen(PORT, "0.0.0.0", () => {
  const localIP = getDbHost();
  console.log(` Server running on:`);
  console.log(`   Local:   http://192.168.50.36:${PORT}`);
  console.log(`   Network: http://${localIP}:${PORT}`);
});
