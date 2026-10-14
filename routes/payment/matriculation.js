const express = require('express');
const { db3 } = require('../database/database');
const { insertAuditLogEnrollment, resolveAuditActor } = require('../../utils/auditLogger');
const { applyPaymentWaterfall } = require('../../utils/matriculationPayment');
const {
    applyMatriculationPayment,
} = require('../../utils/matriculationPaymentLines');
const {
    applyFeeLinePaymentAllocations,
    getMatriculationFeeLines,
} = require('../../utils/matriculationFeeLines');

const router = express.Router();

const PAYMENT_STATUS = {
    PAID: "PAID",
    VOID: "VOID",
};

const RECEIPT_STATUS = {
    PAID_NOT_PRINTED: "PAID_NOT_PRINTED",
    PRINTED: "PRINTED",
    VOID: "VOID",
    REPRINTED: "REPRINTED",
    CANCELLED_PRINT: "CANCELLED_PRINT",
};

let statusColumnsReady = false;

const ensureReceiptStatusColumns = async (connection = db3) => {
    if (statusColumnsReady) return;

    await connection.query(`
        ALTER TABLE transaction_table
            ADD COLUMN IF NOT EXISTS payment_status varchar(50) NOT NULL DEFAULT 'PAID' AFTER remark,
            ADD COLUMN IF NOT EXISTS receipt_status varchar(50) NOT NULL DEFAULT 'PAID_NOT_PRINTED' AFTER payment_status,
            ADD COLUMN IF NOT EXISTS print_count int(11) NOT NULL DEFAULT 0 AFTER receipt_status,
            ADD COLUMN IF NOT EXISTS printed_at timestamp NULL DEFAULT NULL AFTER print_count,
            ADD COLUMN IF NOT EXISTS cancelled_print_at timestamp NULL DEFAULT NULL AFTER printed_at,
            ADD COLUMN IF NOT EXISTS voided_at timestamp NULL DEFAULT NULL AFTER cancelled_print_at,
            ADD COLUMN IF NOT EXISTS updated_at timestamp NULL DEFAULT NULL ON UPDATE current_timestamp() AFTER created_at
    `);

    await connection.query(`
        ALTER TABLE matriculation
            ADD COLUMN IF NOT EXISTS latest_transaction_id int(11) DEFAULT NULL AFTER payment_status,
            ADD COLUMN IF NOT EXISTS receipt_status varchar(50) NOT NULL DEFAULT 'PAID_NOT_PRINTED' AFTER latest_transaction_id
    `);

    await connection.query(`
        ALTER TABLE receipt_counter
            ADD COLUMN IF NOT EXISTS last_issued_transaction_id int(11) DEFAULT NULL AFTER counter,
            ADD COLUMN IF NOT EXISTS updated_at timestamp NULL DEFAULT NULL ON UPDATE current_timestamp() AFTER created_at
    `);

    statusColumnsReady = true;
};

const formatAuditActorRole = (role) => {
    const safeRole = String(role || "registrar").trim();
    if (!safeRole) return "Registrar";

    return safeRole
        .split(/[\s_-]+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(" ");
};

const getAuditActor = resolveAuditActor;

const insertMatriculationAuditLog = async ({ req, action, message }) => {
    const { actorId, actorRole } = getAuditActor(req);

    await insertAuditLogEnrollment({
        actorId,
        role: actorRole,
        action,
        severity: "INFO",
        message,
    });
};

const formatMoney = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return "0";
    return parsed.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
};

const formatStudentName = (row = {}) => {
    const lastName = row.last_name || "";
    const firstName = row.given_name || row.first_name || "";
    const middleName = row.middle_initial || row.middle_name || "";
    const fullName = `${lastName}${lastName && firstName ? ", " : ""}${firstName}${middleName ? ` ${middleName}` : ""}`.trim();

    return fullName || "Unknown Student";
};

const formatSchoolYear = (row = {}) => {
    if (row.current_year && row.next_year && row.semester_description) {
        return `${row.current_year}-${row.next_year}, ${row.semester_description}`;
    }

    return row.active_school_year_id || "N/A";
};

const getTransactionAuditDetails = async (connection, transactionId) => {
    const [[row]] = await connection.query(
        `SELECT
            tt.transaction_no,
            tt.student_number,
            tt.payment,
            tt.employee_id,
            tt.active_school_year_id,
            tt.remark,
            tt.payment_status,
            tt.receipt_status,
            tt.print_count,
            m.last_name,
            m.given_name,
            m.middle_initial,
            COALESCE(m.balance, 0) AS balance_status,
            COALESCE(mpl.balance, 0) AS remaining_balance,
            yt.year_description AS current_year,
            yt.year_description + 1 AS next_year,
            st.semester_description
         FROM transaction_table AS tt
         LEFT JOIN matriculation AS m
            ON m.student_number = tt.student_number
           AND m.active_school_year_id = tt.active_school_year_id
         LEFT JOIN matriculation_payment_lines AS mpl
            ON mpl.matriculation_id = m.id
          LEFT JOIN active_school_year_table AS sy ON tt.active_school_year_id = sy.id
          LEFT JOIN year_table AS yt ON sy.year_id = yt.year_id
          LEFT JOIN semester_table AS st ON sy.semester_id = st.semester_id
          WHERE tt.transaction_no = ?
          LIMIT 1`,
        [transactionId]
    );

    return row || {};
};

router.get('/payment_matriculation/transactions', async (req, res) => {
    try {
        await ensureReceiptStatusColumns();
        const [rows] = await db3.query(
            `SELECT
                tt.transaction_no,
                tt.student_number,
                tt.payment,
                tt.employee_id,
                tt.active_school_year_id,
                yt.year_description AS current_year,
                yt.year_description + 1 AS next_year,
                st.semester_description,
                tt.remark,
                tt.payment_status,
                tt.receipt_status,
                tt.print_count,
                tt.printed_at,
                tt.cancelled_print_at,
                tt.voided_at,
                tt.created_at
             FROM transaction_table AS tt
             LEFT JOIN active_school_year_table AS sy ON tt.active_school_year_id = sy.id
             LEFT JOIN year_table AS yt ON sy.year_id = yt.year_id
             LEFT JOIN semester_table AS st ON sy.semester_id = st.semester_id
             ORDER BY tt.created_at DESC, tt.transaction_no DESC`
        );

        return res.json(rows);
    } catch (error) {
        console.error("Error fetching transaction history:", error);
        return res.status(500).json({ message: "Internal server error." });
    }
});

router.put('/payment_matriculation/void/:transaction_id', async (req, res) => {
    try {
        await ensureReceiptStatusColumns();
        const { transaction_id } = req.params;
        const { void_reason, void_explanation } = req.body || {};
        const normalizedVoidReason = String(void_reason || "").trim();
        const normalizedVoidExplanation = String(void_explanation || "").trim();

        if (!transaction_id) {
            return res.status(400).json({ message: "Transaction id is required." });
        }

        if (!normalizedVoidReason) {
            return res.status(400).json({ message: "Void reason is required." });
        }

        if (normalizedVoidReason === "Others" && !normalizedVoidExplanation) {
            return res.status(400).json({ message: "Void explanation is required for Others." });
        }

        const transactionBefore = await getTransactionAuditDetails(db3, transaction_id);
        const voidRemark = normalizedVoidExplanation
            ? `Void - ${normalizedVoidReason}: ${normalizedVoidExplanation}`
            : `Void - ${normalizedVoidReason}`;

        const [result] = await db3.query(
            `UPDATE transaction_table
             SET remark = ?,
                  payment_status = ?,
                  receipt_status = ?,
                  voided_at = CURRENT_TIMESTAMP
             WHERE transaction_no = ?`,
            [voidRemark, PAYMENT_STATUS.VOID, RECEIPT_STATUS.VOID, transaction_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Transaction not found." });
        }

        const transactionDetails = await getTransactionAuditDetails(db3, transaction_id);

        await db3.query(
            `UPDATE matriculation AS m
             INNER JOIN transaction_table AS tt
                ON tt.student_number = m.student_number
               AND tt.active_school_year_id = m.active_school_year_id
             SET m.receipt_status = ?,
                 m.latest_transaction_id = tt.transaction_no
             WHERE tt.transaction_no = ?`,
            [RECEIPT_STATUS.VOID, transaction_id]
        );

        const { actorId, actorRole } = getAuditActor(req);
        const roleLabel = formatAuditActorRole(actorRole);
        await insertMatriculationAuditLog({
            req,
            action: "MATRICULATION_PAYMENT_VOID",
            message: `${roleLabel} (${actorId}) voided matriculation receipt ${transaction_id} for ${formatStudentName(transactionDetails)} (${transactionDetails.student_number || "N/A"}). Payment: ${formatMoney(transactionDetails.payment)}. Previous receipt status: ${transactionBefore.receipt_status || "N/A"}. New receipt status: ${RECEIPT_STATUS.VOID}. Void reason: ${normalizedVoidReason}${normalizedVoidExplanation ? `. Explanation: ${normalizedVoidExplanation}` : ""}.`,
        });

        return res.json({
            message: "Transaction marked as void.",
            payment_status: PAYMENT_STATUS.VOID,
            receipt_status: RECEIPT_STATUS.VOID,
        });
    } catch (error) {
        console.error("Error voiding transaction:", error);
        return res.status(500).json({ message: "Internal server error." });
    }
});

router.put('/payment_matriculation/remark/:transaction_id', async (req, res) => {
    try {
        await ensureReceiptStatusColumns();
        const { transaction_id } = req.params;
        const { remark } = req.body;

        if (!transaction_id) {
            return res.status(400).json({ message: "Transaction id is required." });
        }

        if (!remark || String(remark).trim() === "") {
            return res.status(400).json({ message: "Remark is required." });
        }

        const normalizedRemark = String(remark).trim();
        const nextReceiptStatus =
            normalizedRemark.toLowerCase() === "not printed"
                ? RECEIPT_STATUS.CANCELLED_PRINT
                : null;
        const transactionBefore = await getTransactionAuditDetails(db3, transaction_id);

        const [result] = await db3.query(
            `UPDATE transaction_table
             SET remark = ?,
                  receipt_status = COALESCE(?, receipt_status),
                  cancelled_print_at = CASE WHEN ? = ? THEN CURRENT_TIMESTAMP ELSE cancelled_print_at END
             WHERE transaction_no = ?`,
            [
                normalizedRemark,
                nextReceiptStatus,
                nextReceiptStatus,
                RECEIPT_STATUS.CANCELLED_PRINT,
                transaction_id,
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Transaction not found." });
        }

        const transactionDetails = await getTransactionAuditDetails(db3, transaction_id);

        if (nextReceiptStatus) {
            await db3.query(
                `UPDATE matriculation AS m
                 INNER JOIN transaction_table AS tt
                    ON tt.student_number = m.student_number
                   AND tt.active_school_year_id = m.active_school_year_id
                 SET m.receipt_status = ?,
                     m.latest_transaction_id = tt.transaction_no
                 WHERE tt.transaction_no = ?`,
                [nextReceiptStatus, transaction_id]
            );
        }

        const { actorId, actorRole } = getAuditActor(req);
        const roleLabel = formatAuditActorRole(actorRole);
        await insertMatriculationAuditLog({
            req,
            action: "MATRICULATION_PAYMENT_REMARK",
            message: `${roleLabel} (${actorId}) updated matriculation receipt ${transaction_id} for ${formatStudentName(transactionDetails)} (${transactionDetails.student_number || "N/A"}). Remark: ${normalizedRemark}. Receipt status: ${transactionBefore.receipt_status || "N/A"}${nextReceiptStatus ? ` to ${nextReceiptStatus}` : ""}.`,
        });

        return res.json({
            message: "Transaction remark updated successfully.",
            receipt_status: nextReceiptStatus,
        });
    } catch (error) {
        console.error("Error updating transaction remark:", error);
        return res.status(500).json({ message: "Internal server error." });
    }
});

router.put('/payment_matriculation/print/:transaction_id', async (req, res) => {
    try {
        await ensureReceiptStatusColumns();
        const { transaction_id } = req.params;

        if (!transaction_id) {
            return res.status(400).json({ message: "Transaction id is required." });
        }

        const [[transactionBefore]] = await db3.query(
            `SELECT receipt_status, print_count
             FROM transaction_table
             WHERE transaction_no = ?
             LIMIT 1`,
            [transaction_id]
        );

        if (!transactionBefore) {
            return res.status(404).json({ message: "Transaction not found." });
        }

        if (transactionBefore.receipt_status === RECEIPT_STATUS.VOID) {
            return res.status(409).json({ message: "Voided receipts cannot be printed." });
        }

        const nextReceiptStatus =
            transactionBefore.receipt_status === RECEIPT_STATUS.PRINTED ||
            transactionBefore.receipt_status === RECEIPT_STATUS.REPRINTED
                ? RECEIPT_STATUS.REPRINTED
                : RECEIPT_STATUS.PRINTED;

        await db3.query(
            `UPDATE transaction_table
             SET receipt_status = ?,
                  print_count = print_count + 1,
                  printed_at = CURRENT_TIMESTAMP,
                  remark = ?
              WHERE transaction_no = ?`,
            [nextReceiptStatus, nextReceiptStatus === RECEIPT_STATUS.REPRINTED ? "Reprinted" : "Printed", transaction_id]
        );

        await db3.query(
            `UPDATE matriculation AS m
             INNER JOIN transaction_table AS tt
                ON tt.student_number = m.student_number
               AND tt.active_school_year_id = m.active_school_year_id
             SET m.receipt_status = ?,
                 m.latest_transaction_id = tt.transaction_no
             WHERE tt.transaction_no = ?`,
            [nextReceiptStatus, transaction_id]
        );

        const transactionDetails = await getTransactionAuditDetails(db3, transaction_id);

        const { actorId, actorRole } = getAuditActor(req);
        const roleLabel = formatAuditActorRole(actorRole);
        await insertMatriculationAuditLog({
            req,
            action: nextReceiptStatus === RECEIPT_STATUS.REPRINTED
                ? "MATRICULATION_RECEIPT_REPRINT"
                : "MATRICULATION_RECEIPT_PRINT",
            message: `${roleLabel} (${actorId}) ${nextReceiptStatus === RECEIPT_STATUS.REPRINTED ? "reprinted" : "printed"} matriculation receipt ${transaction_id} for ${formatStudentName(transactionDetails)} (${transactionDetails.student_number || "N/A"}). Payment: ${formatMoney(transactionDetails.payment)}. Previous receipt status: ${transactionBefore.receipt_status || "N/A"}. New receipt status: ${nextReceiptStatus}. Print count: ${transactionDetails.print_count || 0}.`,
        });

        return res.json({
            message: "Receipt print status updated successfully.",
            receipt_status: nextReceiptStatus,
        });
    } catch (error) {
        console.error("Error updating receipt print status:", error);
        return res.status(500).json({ message: "Internal server error." });
    }
});

router.put('/payment_matriculation/cancel-print/:transaction_id', async (req, res) => {
    try {
        await ensureReceiptStatusColumns();
        const { transaction_id } = req.params;

        if (!transaction_id) {
            return res.status(400).json({ message: "Transaction id is required." });
        }

        const transactionBefore = await getTransactionAuditDetails(db3, transaction_id);

        const [result] = await db3.query(
            `UPDATE transaction_table
             SET receipt_status = ?,
                  cancelled_print_at = CURRENT_TIMESTAMP,
                  remark = ?
              WHERE transaction_no = ?
                AND receipt_status <> ?`,
            [RECEIPT_STATUS.CANCELLED_PRINT, "Cancelled Print", transaction_id, RECEIPT_STATUS.VOID]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Transaction not found or already voided." });
        }

        await db3.query(
            `UPDATE matriculation AS m
             INNER JOIN transaction_table AS tt
                ON tt.student_number = m.student_number
               AND tt.active_school_year_id = m.active_school_year_id
             SET m.receipt_status = ?,
                 m.latest_transaction_id = tt.transaction_no
             WHERE tt.transaction_no = ?`,
            [RECEIPT_STATUS.CANCELLED_PRINT, transaction_id]
        );

        const { actorId, actorRole } = getAuditActor(req);
        const roleLabel = formatAuditActorRole(actorRole);
        await insertMatriculationAuditLog({
            req,
            action: "MATRICULATION_RECEIPT_CANCEL_PRINT",
            message: `${roleLabel} (${actorId}) cancelled printing for matriculation receipt ${transaction_id} for ${formatStudentName(transactionBefore)} (${transactionBefore.student_number || "N/A"}). Payment: ${formatMoney(transactionBefore.payment)}. Previous receipt status: ${transactionBefore.receipt_status || "N/A"}. New receipt status: ${RECEIPT_STATUS.CANCELLED_PRINT}.`,
        });

        return res.json({
            message: "Receipt marked as cancelled print.",
            receipt_status: RECEIPT_STATUS.CANCELLED_PRINT,
        });
    } catch (error) {
        console.error("Error cancelling receipt print:", error);
        return res.status(500).json({ message: "Internal server error." });
    }
});

router.put('/payment_matriculation/:id', async (req, res) => {
    const connection = await db3.getConnection();
    try {
        await ensureReceiptStatusColumns(connection);
        const { id } = req.params;
        const { payment, employee_id, balance } = req.body;

        if (!id || payment === undefined || payment === null || payment === "" || !employee_id) {
            return res.status(400).json({ message: "Matriculation id, payment, and employee_id are required." });
        }

        const parsedPayment = Number(payment);
        const parsedBalance = balance === undefined || balance === null || balance === ""
            ? 0
            : Number(balance);
        const resolvedPaymentStatus = 1;

        if (!Number.isFinite(parsedPayment) || parsedPayment < 0) {
            return res.status(400).json({ message: "Payment must be a valid non-negative number." });
        }

        if (!Number.isFinite(parsedBalance) || parsedBalance < 0) {
            return res.status(400).json({ message: "Balance must be a valid non-negative number." });
        }

        await connection.beginTransaction();

        const [matriculationRows] = await connection.query(
            `SELECT student_number, last_name, given_name, middle_initial, total_tosf, active_school_year_id
             FROM matriculation
             WHERE id = ?
             LIMIT 1`,
            [id]
        );

        if (!matriculationRows.length) {
            await connection.rollback();
            return res.status(404).json({ message: "Matriculation record not found after update." });
        }

        const matriculationRow = matriculationRows[0];
        const { student_number } = matriculationRow;

        const feeLines = await getMatriculationFeeLines(connection, id);

        const [activeSchoolYearRows] = await connection.query(
            `SELECT
                asyt.id AS school_year_id,
                yt.year_id,
                st.semester_id,
                yt.year_description AS current_year,
                yt.year_description + 1 AS next_year,
                st.semester_description
            FROM active_school_year_table AS asyt
            INNER JOIN year_table AS yt ON asyt.year_id = yt.year_id
            INNER JOIN semester_table AS st ON asyt.semester_id = st.semester_id
            WHERE asyt.id = ?
            LIMIT 1`
            , [matriculationRow.active_school_year_id]
        );

        if (!activeSchoolYearRows.length) {
            await connection.rollback();
            return res.status(404).json({ message: "No active school year found." });
        }

        const active_school_year_id = activeSchoolYearRows[0].school_year_id;

        const [counterRows] = await connection.query(
            `SELECT counter, account_type_id
             FROM receipt_counter
             WHERE employee_id = ? AND active_school_year_id = ?`,
            [employee_id, active_school_year_id]
        );

        if (!counterRows.length || counterRows[0].counter === null || counterRows[0].counter === undefined) {
            await connection.rollback();
            return res.status(404).json({ message: "Receipt counter not found for this employee and active school year." });
        }

        const counterPrefix = String(counterRows[0].counter).trim();
        const assignedCounter = Number(counterPrefix);

        if (!Number.isFinite(assignedCounter) || !Number.isInteger(assignedCounter) || assignedCounter <= 0) {
            await connection.rollback();
            return res.status(400).json({ message: "Invalid counter format for transaction id generation." });
        }

        const [maxIdRows] = await connection.query(
            `SELECT MAX(CAST(transaction_no AS UNSIGNED)) AS max_id
             FROM transaction_table
             WHERE CAST(transaction_no AS CHAR) LIKE CONCAT(?, '%')`,
            [counterPrefix]
        );

        const latestId = Number(maxIdRows[0]?.max_id || 0);
        // Use the assigned counter as source of truth, but self-heal if table already has a higher id.
        const nextTransactionId = latestId > 0 ? Math.max(assignedCounter, latestId + 1) : assignedCounter;

        const cashierAccountTypeId = counterRows[0]?.account_type_id ?? null;
        const paymentSummary = applyPaymentWaterfall(
            feeLines,
            parsedPayment,
            cashierAccountTypeId
        );

        if (paymentSummary.error) {
            await connection.rollback();
            return res.status(400).json({ message: paymentSummary.error });
        }

        if (paymentSummary.totalPayment <= 0) {
            await connection.rollback();
            return res.status(400).json({ message: "Payment must be a valid non-negative number." });
        }

        await connection.query(
            `INSERT INTO transaction_table (
                transaction_no, student_number, payment, employee_id, active_school_year_id,
                remark, payment_status, receipt_status, print_count
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                nextTransactionId,
                student_number,
                parsedPayment,
                employee_id,
                active_school_year_id,
                "Matriculation payment",
                PAYMENT_STATUS.PAID,
                RECEIPT_STATUS.PAID_NOT_PRINTED,
                0,
            ]
        );

        await applyFeeLinePaymentAllocations(connection, paymentSummary.allocations);

        const updatedFeeLines = await getMatriculationFeeLines(connection, id);

        await applyMatriculationPayment(connection, {
            matriculationId: Number(id),
            transactionId: nextTransactionId,
            allocations: paymentSummary.allocations,
            feeLines: updatedFeeLines,
        });

        await connection.query(
            `UPDATE receipt_counter
             SET counter = ?,
                 last_issued_transaction_id = ?
             WHERE employee_id = ? AND active_school_year_id = ?`,
            [nextTransactionId + 1, nextTransactionId, employee_id, active_school_year_id]
        );

        await connection.query(
            `UPDATE matriculation
             SET latest_transaction_id = ?,
                 payment = ?,
                 balance = ?,
                 payment_status = ?,
                 receipt_status = ?
             WHERE id = ?`,
            [
                nextTransactionId,
                paymentSummary.totalPayment,
                paymentSummary.balance > 0 ? 1 : 0,
                resolvedPaymentStatus,
                RECEIPT_STATUS.PAID_NOT_PRINTED,
                id,
            ]
        );

        await connection.commit();
        const { actorId, actorRole } = getAuditActor(req);
        const roleLabel = formatAuditActorRole(actorRole);
        await insertMatriculationAuditLog({
            req,
            action: "MATRICULATION_PAYMENT_SAVE",
            message: `${roleLabel} (${actorId}) saved matriculation payment for ${formatStudentName(matriculationRow)} (${student_number}). Receipt No: ${nextTransactionId}. Payment: ${formatMoney(paymentSummary.totalPayment)}. Balance: ${formatMoney(paymentSummary.balance)}. Total amount to pay: ${formatMoney(matriculationRow.total_tosf)}. Academic term: ${formatSchoolYear(activeSchoolYearRows[0])}. Receipt status: ${RECEIPT_STATUS.PAID_NOT_PRINTED}.`,
        });
        return res.json({
            message: "Matriculation payment updated successfully.",
            transaction_no: nextTransactionId,
            transaction_id: nextTransactionId,
            active_school_year_id,
            balance: paymentSummary.balance,
            payment_status: resolvedPaymentStatus,
            receipt_status: RECEIPT_STATUS.PAID_NOT_PRINTED,
            payment_applied: paymentSummary.appliedPayment,
            payment_breakdown: paymentSummary.allocations,
        });
    } catch (error) {
        await connection.rollback();
        console.error("Error updating matriculation payment:", error);
        return res.status(500).json({ message: "Internal server error." });
    } finally {
        connection.release();
    }
});

module.exports = router;
