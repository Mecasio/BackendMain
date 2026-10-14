const express = require("express");
const path = require("path");

const router = express.Router();

const sendTemplate = (res, filename) => {
  const filePath = path.join(__dirname, "../..", "excelfiles", filename);

  res.download(filePath, filename, (err) => {
    if (err) {
      console.error("Error sending file:", err);
      res.status(500).send("Error downloading file");
    }
  });
};

router.get("/ecat_scores_template", (req, res) => {
  sendTemplate(res, "ECATScoresTemplate.xlsx");
});

router.get("/qualifying_interview_template", (req, res) => {
  sendTemplate(res, "QualifyingInterviewScore.xlsx");
});

router.get("/grade_report_template", (req, res) => {
  sendTemplate(res, "GradeReport.xls");
});

router.get("/student_data", (req, res) => {
  sendTemplate(res, "StudentData.xlsx");
});

router.get("/curriculum_panel_template", (req, res) => {
  sendTemplate(res, "CurriculumPanelTemplate.xlsx");
});

router.get("/course_panel_template", (req, res) => {
  sendTemplate(res, "CoursePanelTemplate.xlsx");
});

router.get("/program_tagging_template", (req, res) => {
  sendTemplate(res, "ProgramTaggingTemplate.xlsx");
});

router.get("/program_panel_template", (req, res) => {
  sendTemplate(res, "ProgramPanelTemplate.xlsx");
});

module.exports = router;
