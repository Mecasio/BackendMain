const multer = require("multer");
const path = require("path");
const fs = require("fs");

const announcementStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), "uploads/Announcement");

    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `temp_${Date.now()}${path.extname(file.originalname)}`);
  },
});

const announcementUpload = multer({ storage: announcementStorage });

module.exports = {
  announcementUpload,
};
