const resolveBranch = async (db, campusId) => {
  const [[settingsRow]] = await db.query(
    `SELECT branches FROM company_settings ORDER BY id LIMIT 1`,
  );

  let branches = [];
  try {
    branches = settingsRow?.branches ? JSON.parse(settingsRow.branches) : [];
  } catch (e) {
    branches = [];
  }

  const branch = branches.find((b) => String(b.id) === String(campusId));

  return {
    letter: branch?.letter_code || "X", // fallback if campus is unset/unmapped
    name: branch?.branch || "Unassigned Campus",
  };
};

const generateFormControlNumber = async (
  db, // ADMISSION db — person_table, company_settings
  db3, // ENROLLMENT db — active_school_year_table, form_control_sequence, form_print_transaction
  { formType, applicantNumber, personId, actionType = "download" },
) => {
  if (!formType) throw new Error("formType is required");
  if (!personId) throw new Error("personId is required");

  // 1. Resolve the applicant's campus (this is what previously wasn't
  //    factored in at all — campus_id was always written as NULL).
  const [[person]] = await db.query(
    `SELECT campus FROM person_table WHERE person_id = ? LIMIT 1`,
    [personId],
  );
  if (!person) throw new Error("Applicant not found.");

  const campusId = person.campus ?? null;
  const { letter: branchLetter, name: branchName } = await resolveBranch(
    db,
    campusId,
  );

  // 2. Active school year (same active_school_year_table used elsewhere)
  // 2. Active school year (same active_school_year_table used elsewhere)
  const [[activeYear]] = await db3.query(
    `SELECT yt.year_id AS year_id,
            yt.year_description AS current_year
     FROM active_school_year_table asy
     JOIN year_table yt ON asy.year_id = yt.year_id
     WHERE asy.astatus = 1
     LIMIT 1`,
  );
  if (!activeYear) throw new Error("No active school year found.");

  const yearId = activeYear.year_id;
  const yearLabel = String(activeYear.current_year);
  // 3. Atomically bump the branch-scoped sequence, then log the issuance.
  const conn = await db3.getConnection();
  try {
    await conn.beginTransaction();

    // NULL-safe upsert key: (year_id, form_type, campus_id).
    // ⚠️ Requires a unique key on form_control_sequence covering these
    // three columns — see migration note below.
    await conn.query(
      `INSERT INTO form_control_sequence (year_id, form_type, campus_id, last_number)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE last_number = last_number + 1`,
      [yearId, formType, campusId],
    );

    const [[seqRow]] = await conn.query(
      `SELECT last_number FROM form_control_sequence
       WHERE year_id = ? AND form_type = ? AND campus_id <=> ?`,
      [yearId, formType, campusId],
    );

    const runningNumber = seqRow.last_number;
    
    const controlNumber = `${yearLabel}-${String(runningNumber).padStart(4, "0")}${branchLetter}`;


    await conn.query(
      `INSERT INTO form_print_transaction
        (control_number, year_id, campus_id, running_number, form_type, applicant_number, person_id, action_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        controlNumber,
        yearId,
        campusId,
        runningNumber,
        formType,
        applicantNumber || null,
        personId,
        actionType,
      ],
    );

    await conn.commit();
    return { controlNumber, campusId, campusName: branchName };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

module.exports = { generateFormControlNumber };