// routes/forms/controlNumberRoute.js
const express = require("express");
const router = express.Router();

const { db, db3 } = require("../database/database");
const { generateFormControlNumber } = require("../../utils/formControlNumber");
const { generatePermitControlNumber } = require("../../utils/permitControlNumber");

router.post("/generate-control-number", async (req, res) => {
  try {
    const { form_type, applicant_number, person_id, action_type } = req.body;

    if (!form_type) {
      return res.status(400).json({ message: "form_type is required" });
    }
    if (!person_id) {
      return res.status(400).json({ message: "person_id is required" });
    }

    // ✅ now passes db (admission) as well, so campus/branch can be resolved
    const { controlNumber, campusName } = await generateFormControlNumber(
      db,
      db3,
      {
        formType: form_type,
        applicantNumber: applicant_number,
        personId: person_id,
        actionType: action_type || "download",
      },
    );

    return res.json({ control_number: controlNumber, campus: campusName });
  } catch (err) {
    console.error("Control number generation failed:", err);
    return res.status(500).json({
      message: "Failed to generate control number",
      error: err.message,
    });
  }
});

// ─── PERMIT — unchanged, still the old global (form_type + school year) sequence ───
router.post("/generate-permit-number", async (req, res) => {
  try {
    const { person_id, applicant_number } = req.body;
    if (!person_id) return res.status(400).json({ message: "person_id is required" });

    const controlNumber = await generatePermitControlNumber(db, db3, {
      personId: person_id,
      applicantNumber: applicant_number,
    });

    return res.json({ control_number: controlNumber });
  } catch (err) {
    if (err.code === "NOT_VERIFIED") {
      return res.status(409).json({ message: err.message });
    }
    console.error("Permit number generation failed:", err);
    return res.status(500).json({ message: "Failed to generate permit number", error: err.message });
  }
});

module.exports = router;