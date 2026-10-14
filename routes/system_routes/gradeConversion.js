const express = require("express");
const { db3 } = require("../database/database");
const {
    CanCreate,
    CanDelete,
    CanEdit,
} = require("../../middleware/pagePermissions");

const router = express.Router();

/* =========================================================
   PERMISSION HELPER
========================================================= */

const requireCreateOrEdit = async (req, res, next) => {
    if (req.body?.id) {
        return CanEdit(req, res, next);
    }

    return CanCreate(req, res, next);
};

/* =========================================================
   HELPERS
========================================================= */

// 🎓 Semester Honor (category = 0)
async function getSemesterHonor(gwa, highest_subject_grade) {
    const [rows] = await db3.query(
        `
        SELECT title
        FROM honors_rules
        WHERE category = 0
        AND ? BETWEEN min_gwa AND max_gwa
        AND ? <= max_subject_grade
        LIMIT 1
        `,
        [gwa, highest_subject_grade]
    );

    return rows.length ? rows[0].title : null;
}

// 🎓 Graduation Honor (category = 1)
async function getGraduationHonor(
    gwa,
    highest_subject_grade,
    year_level_id,
    semester_id
) {
    // ONLY 4th Year 2nd Sem
    if (!(year_level_id == 4 && semester_id == 2)) {
        return null;
    }

    const [rows] = await db3.query(
        `
        SELECT title
        FROM honors_rules
        WHERE category = 1
        AND ? BETWEEN min_gwa AND max_gwa
        AND ? <= max_subject_grade
        LIMIT 1
        `,
        [gwa, highest_subject_grade]
    );

    return rows.length ? rows[0].title : null;
}

/* =========================================================
   GRADE CONVERSION
========================================================= */

// GET ALL
router.get("/admin/grade-conversion", async (req, res) => {
    try {
        const [rows] = await db3.query(`
            SELECT *
            FROM grade_conversion
            ORDER BY
                CASE
                    WHEN min_score IS NULL THEN 1
                    ELSE 0
                END,
                min_score DESC
        `);

        res.json(rows);

    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: "Failed to fetch grade conversion"
        });
    }
});

// CREATE / UPDATE
router.post(
    "/admin/grade-conversion",
    requireCreateOrEdit,
    async (req, res) => {
        try {
            const {
                id,
                min_score,
                max_score,
                equivalent_grade,
                descriptive_rating,
                is_disqualified,
            } = req.body;

            // ✅ Special Grades (INC, DRP, etc.)
            const isSpecial =
                min_score === null ||
                min_score === "" ||
                max_score === null ||
                max_score === "";

            if (isSpecial) {

                if (!equivalent_grade) {
                    return res.status(400).json({
                        error: "Equivalent grade is required"
                    });
                }

                if (id) {
                    await db3.query(
                        `
                        UPDATE grade_conversion
                        SET
                            min_score = NULL,
                            max_score = NULL,
                            equivalent_grade = ?,
                            descriptive_rating = ?,
                            is_disqualified = ?
                        WHERE id = ?
                        `,
                        [
                            equivalent_grade,
                            descriptive_rating || null,
                            is_disqualified || 0,
                            id
                        ]
                    );
                } else {
                    await db3.query(
                        `
                        INSERT INTO grade_conversion
                        (
                            min_score,
                            max_score,
                            equivalent_grade,
                            descriptive_rating,
                            is_disqualified
                        )
                        VALUES (?, ?, ?, ?, ?)
                        `,
                        [
                            null,
                            null,
                            equivalent_grade,
                            descriptive_rating || null,
                            is_disqualified || 0
                        ]
                    );
                }

                return res.json({
                    success: true
                });
            }

            // ✅ Validation
            if (
                min_score === "" ||
                max_score === "" ||
                equivalent_grade === ""
            ) {
                return res.status(400).json({
                    error: "All fields are required"
                });
            }

            if (parseFloat(min_score) > parseFloat(max_score)) {
                return res.status(400).json({
                    error: "Min score cannot be greater than Max score"
                });
            }

            // UPDATE
            if (id) {
                await db3.query(
                    `
                    UPDATE grade_conversion
                    SET
                        min_score = ?,
                        max_score = ?,
                        equivalent_grade = ?,
                        descriptive_rating = ?,
                        is_disqualified = ?
                    WHERE id = ?
                    `,
                    [
                        min_score,
                        max_score,
                        equivalent_grade,
                        descriptive_rating || null,
                        is_disqualified || 0,
                        id
                    ]
                );
            }

            // INSERT
            else {
                await db3.query(
                    `
                    INSERT INTO grade_conversion
                    (
                        min_score,
                        max_score,
                        equivalent_grade,
                        descriptive_rating,
                        is_disqualified
                    )
                    VALUES (?, ?, ?, ?, ?)
                    `,
                    [
                        min_score,
                        max_score,
                        equivalent_grade,
                        descriptive_rating || null,
                        is_disqualified || 0
                    ]
                );
            }

            res.json({
                success: true
            });

        } catch (err) {
            console.error(err);

            res.status(500).json({
                error: "Save failed"
            });
        }
    }
);

// DELETE
router.delete(
    "/admin/grade-conversion/:id",
    CanDelete,
    async (req, res) => {
        try {
            await db3.query(
                `DELETE FROM grade_conversion WHERE id = ?`,
                [req.params.id]
            );

            res.json({
                success: true
            });

        } catch (err) {
            console.error(err);

            res.status(500).json({
                error: "Delete failed"
            });
        }
    }
);

/* =========================================================
   HONORS RULES
========================================================= */

// GET ALL
router.get("/admin/honors-rules", async (req, res) => {
    try {
        const [rows] = await db3.query(`
            SELECT *
            FROM honors_rules
            ORDER BY category ASC, min_gwa ASC
        `);

        res.json(rows);

    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: "Failed to fetch honors rules"
        });
    }
});

// CREATE / UPDATE
router.post(
    "/admin/honors-rules",
    requireCreateOrEdit,
    async (req, res) => {
        try {

            let {
                id,
                title,
                category,
                min_gwa,
                max_gwa,
                max_subject_grade,
            } = req.body;

            category = parseInt(category);

            // ✅ Validate category
            if (![0, 1].includes(category)) {
                return res.status(400).json({
                    error: "Invalid category"
                });
            }

            // ✅ Validation
            if (!title) {
                return res.status(400).json({
                    error: "Title is required"
                });
            }

            if (
                min_gwa === "" ||
                max_gwa === "" ||
                max_subject_grade === ""
            ) {
                return res.status(400).json({
                    error: "All fields are required"
                });
            }

            if (parseFloat(min_gwa) > parseFloat(max_gwa)) {
                return res.status(400).json({
                    error: "Min GWA cannot be greater than Max GWA"
                });
            }

            // UPDATE
            if (id) {
                await db3.query(
                    `
                    UPDATE honors_rules
                    SET
                        title = ?,
                        category = ?,
                        min_gwa = ?,
                        max_gwa = ?,
                        max_subject_grade = ?
                    WHERE id = ?
                    `,
                    [
                        title,
                        category,
                        min_gwa,
                        max_gwa,
                        max_subject_grade,
                        id
                    ]
                );
            }

            // INSERT
            else {
                await db3.query(
                    `
                    INSERT INTO honors_rules
                    (
                        title,
                        category,
                        min_gwa,
                        max_gwa,
                        max_subject_grade
                    )
                    VALUES (?, ?, ?, ?, ?)
                    `,
                    [
                        title,
                        category,
                        min_gwa,
                        max_gwa,
                        max_subject_grade
                    ]
                );
            }

            res.json({
                success: true
            });

        } catch (err) {
            console.error(err);

            res.status(500).json({
                error: "Save failed"
            });
        }
    }
);

// DELETE
router.delete(
    "/admin/honors-rules/:id",
    CanDelete,
    async (req, res) => {
        try {

            await db3.query(
                `DELETE FROM honors_rules WHERE id = ?`,
                [req.params.id]
            );

            res.json({
                success: true
            });

        } catch (err) {
            console.error(err);

            res.status(500).json({
                error: "Delete failed"
            });
        }
    }
);

module.exports = router;
module.exports.getSemesterHonor = getSemesterHonor;
module.exports.getGraduationHonor = getGraduationHonor;