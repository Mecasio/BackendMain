const express = require("express");
const { db, db3 } = require("../database/database");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");

const router = express.Router();

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const insertEvaluationAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    message,
    severity: "INFO",
  });
};

const getActorLabel = (req) => {
  const { actorId, actorRole } = getAuditActor(req);
  return {
    actorId,
    roleLabel: formatAuditActorRole(actorRole),
  };
};
//11/29/2025 UPDATE
router.post("/insert_question", CanCreate, async (req, res) => {
  const {
    category,
    question,
    choice1,
    choice2,
    choice3,
    choice4,
    choice5,
    school_year_id,
  } = req.body;

  try {
    // Step 1: Insert question
    const [result] = await db3.query(
      `
      INSERT INTO question_table
      (category, question_description, first_choice, second_choice, third_choice, fourth_choice, fifth_choice)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [category, question, choice1, choice2, choice3, choice4, choice5],
    );

    // Step 2: Get the inserted question's ID
    const question_id = result.insertId;

    // Step 3: Insert into evaluation_table using that question_id
    await db3.query(
      `
      INSERT INTO evaluation_table (school_year_id, question_id)
      VALUES (?, ?)
      `,
      [school_year_id, question_id],
    );

    const { actorId, roleLabel } = getActorLabel(req);
    await insertEvaluationAuditLog({
      req,
      action: "EVALUATION_QUESTION_CREATE",
      message: `${roleLabel} (${actorId}) created evaluation question ${question_id}.`,
    });

    res.status(200).send({
      message: "Question successfully added and linked to evaluation!",
    });
  } catch (err) {
    console.error("Database / Server Error:", err);
    res.status(500).send({ message: "Database / Server Error", error: err });
  }
});

//11/29/2025 UPDATE
router.post("/insert_category", CanCreate, async (req, res) => {
  const { title, description } = req.body;

  try {
    // Step 1: Insert question
    const [result] = await db3.query(
      `
      INSERT INTO question_category_table (title, description) VALUES (?, ?)
      `,
      [title, description],
    );

    const { actorId, roleLabel } = getActorLabel(req);
    await insertEvaluationAuditLog({
      req,
      action: "EVALUATION_CATEGORY_CREATE",
      message: `${roleLabel} (${actorId}) created evaluation category ${title}.`,
    });

    res.status(200).send({ message: "Category Created" });
  } catch (err) {
    console.error("Database / Server Error:", err);
    res.status(500).send({ message: "Database / Server Error", error: err });
  }
});

//11/29/2025 UPDATE
router.get("/get_category", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT * FROM question_category_table
    `);
    res.status(200).send(rows);
  } catch (err) {
    console.error("Database / Server Error:", err);
    res.status(500).send({ message: "Database / Server Error", error: err });
  }
});

//11/29/2025 UPDATE
router.put("/update_category/:id", CanEdit, async (req, res) => {
  const { title, description } = req.body;
  const { id } = req.params;

  try {
    const updateQuery = `
      UPDATE question_category_table
      SET
        title = ?,
        description = ?
      WHERE id = ?
    `;
    const [result] = await db3.query(updateQuery, [title, description, id]);
    if (result.affectedRows === 0) {
      return res.status(404).send({ message: "Category not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertEvaluationAuditLog({
      req,
      action: "EVALUATION_CATEGORY_UPDATE",
      message: `${roleLabel} (${actorId}) updated evaluation category ${title}.`,
    });
    res.status(200).send({ message: "Question successfully updated" });
  } catch (err) {
    console.error("Database / Server Error:", err);
    res.status(500).send({ message: "Database / Server Error", error: err });
  }
});

// DELETE CATEGORY
router.delete("/delete_category/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[category]] = await db3.query(
      "SELECT title FROM question_category_table WHERE id = ? LIMIT 1",
      [id],
    );
    const [result] = await db3.query(`DELETE FROM question_category_table WHERE id = ?`, [id]);
    if (result.affectedRows === 0) {
      return res.status(404).send({ message: "Category not found" });
    }

    const categoryLabel = category?.title || `category ID ${id}`;
    const { actorId, roleLabel } = getActorLabel(req);
    await insertEvaluationAuditLog({
      req,
      action: "EVALUATION_CATEGORY_DELETE",
      message: `${roleLabel} (${actorId}) deleted evaluation category ${categoryLabel}.`,
    });
    res.status(200).send({ message: "Category successfully deleted" });
  } catch (err) {
    console.error("Database / Server Error:", err);
    res.status(500).send({ message: "Database / Server Error", error: err });
  }
});

//11/29/2025 UPDATE
router.get("/get_questions", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT qt.category, qt.question_description, qt.first_choice, qt.second_choice, qt.third_choice, qt.fourth_choice, qt.fifth_choice, qt.id AS question_id, sy.year_id, sy.semester_id, sy.id as school_year, et.created_at FROM question_table AS qt
      INNER JOIN evaluation_table AS et ON qt.id = et.question_id
      INNER JOIN active_school_year_table AS sy ON et.school_year_id = sy.id
      ORDER BY qt.id ASC;
    `);
    res.status(200).send(rows);
  } catch (err) {
    console.error("Database / Server Error:", err);
    res.status(500).send({ message: "Database / Server Error", error: err });
  }
});

router.post("/reuse_questions", CanCreate, async (req, res) => {
  const { source_school_year_id, target_school_year_id } = req.body;

  if (!source_school_year_id || !target_school_year_id) {
    return res.status(400).send({ message: "Source and target school year are required." });
  }

  if (String(source_school_year_id) === String(target_school_year_id)) {
    return res.status(400).send({ message: "Source and target semester must be different." });
  }

  try {
    const [result] = await db3.query(
      `
      INSERT INTO evaluation_table (school_year_id, question_id)
      SELECT ?, et.question_id
      FROM evaluation_table AS et
      WHERE et.school_year_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM evaluation_table AS existing
          WHERE existing.school_year_id = ?
            AND existing.question_id = et.question_id
        )
      `,
      [target_school_year_id, source_school_year_id, target_school_year_id],
    );

    const { actorId, roleLabel } = getActorLabel(req);
    await insertEvaluationAuditLog({
      req,
      action: "EVALUATION_QUESTION_REUSE",
      message: `${roleLabel} (${actorId}) reused ${result.affectedRows} evaluation question(s) from school year ${source_school_year_id} to ${target_school_year_id}.`,
    });

    res.status(200).send({
      message: `${result.affectedRows} question(s) reused successfully.`,
      inserted: result.affectedRows,
    });
  } catch (err) {
    console.error("Database / Server Error:", err);
    res.status(500).send({ message: "Database / Server Error", error: err });
  }
});

//11/29/2025 UPDATE
router.put("/update_question/:id", CanEdit, async (req, res) => {
  const { category, question, choice1, choice2, choice3, choice4, choice5 } =
    req.body;
  const { id } = req.params;

  try {
    const updateQuery = `
      UPDATE question_table
      SET
        category = ?,
        question_description = ?,
        first_choice = ?,
        second_choice = ?,
        third_choice = ?,
        fourth_choice = ?,
        fifth_choice = ?
      WHERE id = ?;
    `;
    const [result] = await db3.query(updateQuery, [
      category,
      question,
      choice1,
      choice2,
      choice3,
      choice4,
      choice5,
      id,
    ]);
    if (result.affectedRows === 0) {
      return res.status(404).send({ message: "Question not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertEvaluationAuditLog({
      req,
      action: "EVALUATION_QUESTION_UPDATE",
      message: `${roleLabel} (${actorId}) updated evaluation question ${id}.`,
    });
    res.status(200).send({ message: "Question successfully updated" });
  } catch (err) {
    console.error("Database / Server Error:", err);
    res.status(500).send({ message: "Database / Server Error", error: err });
  }
});

// DELETE QUESTION
router.delete("/delete_question/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[question]] = await db3.query(
      "SELECT question_description FROM question_table WHERE id = ? LIMIT 1",
      [id],
    );
    // First delete from evaluation_table (foreign key constraint)
    await db3.query(`DELETE FROM evaluation_table WHERE question_id = ?`, [id]);
    
    // Then delete from question_table
    const [result] = await db3.query(`DELETE FROM question_table WHERE id = ?`, [id]);
    if (result.affectedRows === 0) {
      return res.status(404).send({ message: "Question not found" });
    }

    const questionLabel = question?.question_description || `question ID ${id}`;
    const { actorId, roleLabel } = getActorLabel(req);
    await insertEvaluationAuditLog({
      req,
      action: "EVALUATION_QUESTION_DELETE",
      message: `${roleLabel} (${actorId}) deleted evaluation question ${questionLabel}.`,
    });
    
    res.status(200).send({ message: "Question successfully deleted" });
  } catch (err) {
    console.error("Database / Server Error:", err);
    res.status(500).send({ message: "Database / Server Error", error: err });
  }
});

//11/29/2025 UPDATE
router.get("/get_questions_for_evaluation", async (req, res) => {
  const { school_year_id } = req.query;

  try {
    const params = [];
    let whereClause = "WHERE sy.astatus = 1";

    if (school_year_id) {
      whereClause = "WHERE sy.id = ?";
      params.push(school_year_id);
    }

    const [rows] = await db3.query(`
      SELECT qt.category, qct.title, qct.description as meaning, qt.question_description, qt.first_choice, qt.second_choice, qt.third_choice, qt.fourth_choice, qt.fifth_choice, qt.id AS question_id, sy.year_id, sy.semester_id, sy.id as school_year, et.created_at FROM question_table AS qt
      INNER JOIN evaluation_table AS et ON qt.id = et.question_id
      INNER JOIN active_school_year_table AS sy ON et.school_year_id = sy.id
      INNER JOIN question_category_table AS qct ON qt.category = qct.id
      ${whereClause} ORDER BY qt.id ASC;
    `, params);
    console.log(rows);
    res.status(200).send(rows);
  } catch (err) {
    console.error("Database / Server Error:", err);
    res.status(500).send({ message: "Database / Server Error", error: err });
  }
});

router.post("/student_evaluation", async (req, res) => {
  const {
    student_number,
    school_year_id,
    prof_id,
    course_id,
    question_id,
    answer,
  } = req.body;

  try {
    await db3.execute(
      `
      INSERT INTO student_evaluation_table
      (student_number, school_year_id, prof_id, course_id, question_id, question_answer)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [student_number, school_year_id, prof_id, course_id, question_id, answer],
    );

    await db3.execute(
      `
      UPDATE enrolled_subject
      SET fe_status = 1
      WHERE student_number = ? AND course_id = ? AND active_school_year_id = ?
      `,
      [student_number, course_id, school_year_id],
    );

    res.status(200).send({ message: "Evaluation successfully recorded!" });
  } catch (err) {
    console.error("Database / Server Error:", err);
    res
      .status(500)
      .send({ message: "Database / Server Error", error: err.message });
  }
});

router.get("/faculty_evaluation", async (req, res) => {
  const { prof_id, year_id, semester_id } = req.query;

  try {
    const [rows] = await db3.query(
      `
      SELECT
        pt.prof_id,
        st.course_id,
        ct.course_code,
        st.question_id,
        qt.question_description,
        sy.year_id,
        sy.semester_id,

        SUM(CASE WHEN st.question_answer = 1 THEN 1 ELSE 0 END) AS answered_one_count,
        SUM(CASE WHEN st.question_answer = 2 THEN 1 ELSE 0 END) AS answered_two_count,
        SUM(CASE WHEN st.question_answer = 3 THEN 1 ELSE 0 END) AS answered_three_count,
        SUM(CASE WHEN st.question_answer = 4 THEN 1 ELSE 0 END) AS answered_four_count,
        SUM(CASE WHEN st.question_answer = 5 THEN 1 ELSE 0 END) AS answered_five_count

      FROM student_evaluation_table AS st
      INNER JOIN prof_table AS pt ON st.prof_id = pt.prof_id
      INNER JOIN active_school_year_table AS sy ON st.school_year_id = sy.id
      INNER JOIN question_table AS qt ON st.question_id = qt.id
      INNER JOIN course_table AS ct ON st.course_id = ct.course_id

      WHERE pt.prof_id = ? AND sy.year_id = ? AND sy.semester_id = ?

      GROUP BY st.course_id, st.question_id, pt.prof_id
      ORDER BY st.course_id, st.question_id;
      `,
      [prof_id, year_id, semester_id],
    );
    console.log(rows);

    res.json(rows);
  } catch (err) {
    console.error("⚠️ Error fetching evaluation:", err);
    res.status(500).json({ message: "Database error" });
  }
});

module.exports = router
