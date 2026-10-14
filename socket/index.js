const {
  startApplicantForgotPasswordSocketApi,
} = require("./applicantForgotPasswordSocketApi");
const {
  startStudentNumberingSocketApi,
} = require("./studentNumberingSocketApi");
const {
  startInterviewScheduleSocketApi,
} = require("./interviewScheduleSocketApi");
const {
  startEntranceExamScheduleSocketApi,
} = require("./entranceExamScheduleSocketApi");
const {
  startVerifyDocumentScheduleSocketApi,
} = require("./verifyDocumentScheduleSocketApi");

function startSocketApis(io, deps) {
  startApplicantForgotPasswordSocketApi(io, deps);
  startStudentNumberingSocketApi(io, deps);
  startInterviewScheduleSocketApi(io, deps);
  startEntranceExamScheduleSocketApi(io, deps);
  startVerifyDocumentScheduleSocketApi(io, deps);
}

module.exports = {
  startSocketApis,
  startApplicantForgotPasswordSocketApi,
  startStudentNumberingSocketApi,
  startInterviewScheduleSocketApi,
  startEntranceExamScheduleSocketApi,
  startVerifyDocumentScheduleSocketApi,
};
