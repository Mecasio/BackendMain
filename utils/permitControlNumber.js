const generatePermitControlNumber = async (
  db,
  db3,
  { personId, applicantNumber },
) => {
  if (!personId) throw new Error("personId is required");

  // 1. Confirm this applicant is FULLY verified
  const [[person]] = await db.query(
    `SELECT applyingAs FROM person_table WHERE person_id = ? LIMIT 1`,
    [personId],
  );
  if (!person) throw new Error("Applicant not found.");

  const [requiredRows] = await db.query(
    `SELECT id FROM requirements_table
     WHERE category = 'Main' AND is_verifiable = 1
       AND (applicant_type = ? OR applicant_type = '0' OR applicant_type = 0 OR applicant_type = 'All')`,
    [person.applyingAs],
  );
  if (requiredRows.length === 0) {
    throw new Error(
      "No verifiable requirements configured for this applicant type.",
    );
  }
  const requiredIds = requiredRows.map((r) => r.id);
  const placeholders = requiredIds.map(() => "?").join(",");

  const [uploadRows] = await db.query(
    `SELECT requirements_id, document_status, verified_at, created_at
     FROM requirement_uploads
     WHERE person_id = ? AND requirements_id IN (${placeholders})`,
    [personId, ...requiredIds],
  );

  const uploadedIds = new Set(uploadRows.map((u) => u.requirements_id));
  const hasAllRequired = requiredIds.every((id) => uploadedIds.has(id));
  const allVerified =
    hasAllRequired &&
    uploadRows.every((u) => u.document_status === "Documents Verified & ECAT");

  if (!allVerified) {
    const err = new Error("Applicant's documents are not fully verified yet.");
    err.code = "NOT_VERIFIED";
    throw err;
  }

  // ─────────────────────────────────────────────────────────────────────
  // ✅ FIX: the month segment of the control number ("...-09-...") must
  // reflect the month the permit is actually being GENERATED (i.e. today),
  // not the month the applicant's documents happened to get verified.
  // Previously this used `verified_at`/`created_at` from requirement_uploads,
  // so a permit generated in September still showed "07" because the
  // applicant was verified back in July.
  // ─────────────────────────────────────────────────────────────────────
  const currentDate = new Date();
  const currentMonth = String(currentDate.getMonth() + 1).padStart(2, "0");

  // 2. Get the active school year + academic year label — this table lives in ENROLLMENT (db3)
  const [[activeYear]] = await db3.query(
    `SELECT asy.id AS active_school_year_id,
            yt.year_description AS current_year,
            yt.year_description + 1 AS next_year
     FROM active_school_year_table asy
     JOIN year_table yt ON asy.year_id = yt.year_id
     WHERE asy.astatus = 1
     LIMIT 1`,
  );
  if (!activeYear) throw new Error("No active school year found.");

  const academicYear = `${String(activeYear.current_year).slice(-2)}${String(activeYear.next_year).slice(-2)}`;

  // 3. Return existing control number if already generated for this person + school year
  //    control_number_sequence / document_control_numbers live in ADMISSION (db)
  const [[existing]] = await db.query(
    `SELECT seq_number FROM document_control_numbers
   WHERE form_type = 'permit' AND person_id = ? AND active_school_year_id = ?
   LIMIT 1`,
    [personId, activeYear.active_school_year_id],
  );

  if (existing) {
    const controlNumber = `${academicYear}-${currentMonth}-${String(existing.seq_number).padStart(5, "0")}`;

    await db.query(
      `UPDATE document_control_numbers
     SET control_number = ?, verified_month = ?
     WHERE form_type = 'permit' AND person_id = ? AND active_school_year_id = ?`,
      [controlNumber, currentMonth, personId, activeYear.active_school_year_id],
    );

    return controlNumber;
  }
  // 4. Otherwise atomically bump the sequence — scoped ONLY by (form_type, active_school_year_id).
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO control_number_sequence (form_type, active_school_year_id, academic_year, next_seq)
       VALUES ('permit', ?, ?, 1)
       ON DUPLICATE KEY UPDATE next_seq = next_seq + 1`,
      [activeYear.active_school_year_id, academicYear],
    );

    const [[seqRow]] = await conn.query(
      `SELECT next_seq FROM control_number_sequence
       WHERE form_type = 'permit' AND active_school_year_id = ?`,
      [activeYear.active_school_year_id],
    );

    const seq = seqRow.next_seq;
    const controlNumber = `${academicYear}-${currentMonth}-${String(seq).padStart(5, "0")}`;

    await conn.query(
      `INSERT INTO document_control_numbers
        (form_type, person_id, applicant_number, active_school_year_id, academic_year, verified_month, seq_number, control_number, action_type)
       VALUES ('permit', ?, ?, ?, ?, ?, ?, ?, 'permit')`,
      [
        personId,
        applicantNumber || null,
        activeYear.active_school_year_id,
        academicYear,
        currentMonth,
        seq,
        controlNumber,
      ],
    );

    await conn.commit();
    return controlNumber; // e.g. "2627-09-00001"
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

module.exports = { generatePermitControlNumber };
