const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

transporter.verify((error) => {
  if (error) {
    console.error(" Email transporter error:", error);
  } else {
    console.log(" Email transporter is ready");
  }
});

module.exports = { transporter };
