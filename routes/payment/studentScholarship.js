const express = require('express');
const { db, db3 } = require('../database/database');

const router = express.Router();

router.get('/not_assigned', async (req, res) => {
    try {
        const [students] = await db3.query(`
            SELECT 
                es.student_number,
                pt.last_name,
                pt.first_name,
                pt.middle_name,
                pt.extension,
                pgt.program_code, 
                pgt.program_description,
                pgt.major
            FROM enrolled_subject es
                INNER JOIN student_status_table sst 
                    ON es.student_number = sst.student_number
                INNER JOIN student_numbering_table snt 
                    ON sst.student_number = snt.student_number
                INNER JOIN person_table pt 
                    ON snt.person_id = pt.person_id
                INNER JOIN active_school_year_table sy 
                    ON es.active_school_year_id = sy.id
                INNER JOIN curriculum_table ct 
                    ON sst.active_curriculum = ct.curriculum_id
                INNER JOIN program_table pgt 
                    ON ct.program_id = pgt.program_id
            WHERE 
                sy.astatus = 1 
                AND sst.enrolled_status = 1

                AND NOT EXISTS (
                    SELECT 1 
                    FROM unifast u
                    INNER JOIN active_school_year_table sy2 
                        ON u.active_school_year_id = sy2.id
                    WHERE u.student_number = es.student_number
                        AND sy2.astatus = 1
                )

                AND NOT EXISTS (
                    SELECT 1 
                    FROM matriculation m
                    INNER JOIN active_school_year_table sy3 
                        ON m.active_school_year_id = sy3.id
                    WHERE m.student_number = es.student_number
                        AND sy3.astatus = 1
                )

            GROUP BY es.student_number
        `);

        res.json(students);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});


module.exports = router