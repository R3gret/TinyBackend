const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const authenticate = require('./authMiddleware');

const submissionUploadDir = path.join(__dirname, '../uploads/submissions');
if (!fs.existsSync(submissionUploadDir)) {
  fs.mkdirSync(submissionUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, submissionUploadDir);
  },
  filename: (req, file, cb) => {
    const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, `${Date.now()}-${safeOriginalName}`);
  }
});
const upload = multer({ storage });

// POST /api/submissions - Parent uploads a submission for an activity
router.post('/', authenticate, upload.single('submissionFile'), async (req, res) => {
    const { activity_id, comments } = req.body;
    const file = req.file;
    const guardianUserId = req.user.id;
    const userType = req.user.type;

    if (userType !== 'parent') {
        if (file) fs.unlinkSync(file.path);
        return res.status(403).json({ error: 'Only parents can upload submissions.' });
    }
    if (!activity_id || !file) {
        if (file) fs.unlinkSync(file.path);
        return res.status(400).json({ error: 'Activity ID and a file are required.' });
    }

    let connection;
    try {
        connection = await db.promisePool.getConnection();
        // Find the student linked to the parent
        const [studentLink] = await connection.query(
            'SELECT student_id FROM guardian_info WHERE id = ?',
            [guardianUserId]
        );
        if (studentLink.length === 0 || !studentLink[0].student_id) {
            if (file) fs.unlinkSync(file.path);
            return res.status(404).json({ error: 'No student is linked to this parent account.' });
        }
        const student_id = studentLink[0].student_id;
        // Insert submission
        const [result] = await connection.query(
            `INSERT INTO activity_submissions (activity_id, student_id, file_path, comments, submitted_by_guardian_id)
             VALUES (?, ?, ?, ?, ?)`,
            [activity_id, student_id, file.path, comments, guardianUserId]
        );
        res.status(201).json({ success: true, submissionId: result.insertId });
    } catch (err) {
        if (file) fs.unlinkSync(file.path);
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to upload submission.' });
    } finally {
        if (connection) connection.release();
    }
});

// GET /api/submissions/activity/:activityId - Get all submissions for an activity
router.get('/activity/:activityId', authenticate, async (req, res) => {
    const { activityId } = req.params;
    const userType = req.user.type;
    const userCdcId = req.user.cdc_id;
    let connection;
    try {
        connection = await db.promisePool.getConnection();
        // Check if activity belongs to user's CDC
        const [activity] = await connection.query(
            'SELECT cdc_id FROM take_home_activities WHERE activity_id = ?',
            [activityId]
        );
        if (!activity.length || activity[0].cdc_id !== userCdcId) {
            return res.status(403).json({ error: 'You are not authorized to view submissions for this activity.' });
        }
        const [submissions] = await connection.query(
                `SELECT 
                    s.submission_id,
                    s.activity_id,
                    s.student_id,
                    s.file_path,
                    s.comments,
                    s.submission_date,
                    s.submitted_by_guardian_id,
                    g.guardian_name AS parent_name,
                    st.first_name AS student_first_name,
                    st.last_name AS student_last_name
                 FROM activity_submissions s
                 LEFT JOIN guardian_info g ON s.submitted_by_guardian_id = g.id
                 LEFT JOIN students st ON s.student_id = st.student_id
                 WHERE s.activity_id = ?
                 ORDER BY s.submission_date DESC`,
                [activityId]
        );
        res.json(submissions);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to fetch submissions.' });
    } finally {
        if (connection) connection.release();
    }
});

// GET /api/submissions/student/:studentId - Get all submissions for a student
router.get('/student/:studentId', authenticate, async (req, res) => {
    const { studentId } = req.params;
    const userType = req.user.type;
    const userId = req.user.id;
    const userCdcId = req.user.cdc_id;
    let connection;
    try {
        connection = await db.promisePool.getConnection();
        if (userType === 'parent') {
            // Parent can only view their own child's submissions
            const [link] = await connection.query(
                'SELECT student_id FROM guardian_info WHERE id = ?',
                [userId]
            );
            if (!link.length || link[0].student_id != studentId) {
                return res.status(403).json({ error: 'You are not authorized to view submissions for this student.' });
            }
        } else if (userType === 'worker') {
            // Worker can only view students in their CDC
            const [student] = await connection.query(
                'SELECT cdc_id FROM students WHERE student_id = ?',
                [studentId]
            );
            if (!student.length || student[0].cdc_id !== userCdcId) {
                return res.status(403).json({ error: 'You are not authorized to view submissions for this student.' });
            }
        }
        const [submissions] = await connection.query(
            'SELECT * FROM activity_submissions WHERE student_id = ? ORDER BY submission_date DESC',
            [studentId]
        );
        res.json(submissions);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to fetch submissions.' });
    } finally {
        if (connection) connection.release();
    }
});

// GET /api/submissions/mine/:activityId - Get the logged-in parent's submission for a specific activity
router.get('/mine/:activityId', authenticate, async (req, res) => {
    const { activityId } = req.params;
    const guardianUserId = req.user.id;
    const userType = req.user.type;

    if (userType !== 'parent') {
        return res.status(403).json({ error: 'This route is for parents only.' });
    }

    let connection;
    try {
        connection = await db.promisePool.getConnection();

        // 1. Find the student linked to the parent
        const [studentLink] = await connection.query(
            'SELECT student_id FROM guardian_info WHERE id = ?',
            [guardianUserId]
        );

        if (studentLink.length === 0 || !studentLink[0].student_id) {
            return res.status(404).json({ error: 'No student is linked to this parent account.' });
        }
        const studentId = studentLink[0].student_id;

        // 2. Find the submission matching the activity and student
        const [submissions] = await connection.query(
            'SELECT * FROM activity_submissions WHERE activity_id = ? AND student_id = ?',
            [activityId, studentId]
        );

        // It's possible a parent hasn't submitted yet, so return the submission or null
        if (submissions.length > 0) {
            res.json(submissions[0]); // Return the first submission found
        } else {
            res.json(null); // No submission found for this activity by this parent
        }

    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to fetch submission.' });
    } finally {
        if (connection) connection.release();
    }
});

// GET /api/submissions/exists/:activityId - Check if a submission exists for an activity
router.get('/exists/:activityId', authenticate, async (req, res) => {
    const { activityId } = req.params;
    const guardianUserId = req.user.id;
    const userType = req.user.type;

    if (userType !== 'parent') {
        return res.status(403).json({ error: 'This route is for parents only.' });
    }

    let connection;
    try {
        connection = await db.promisePool.getConnection();

        // 1. Find the student linked to the parent
        const [studentLink] = await connection.query(
            'SELECT student_id FROM guardian_info WHERE id = ?',
            [guardianUserId]
        );

        if (studentLink.length === 0 || !studentLink[0].student_id) {
            // If no student is linked, they can't have a submission.
            return res.json({ hasSubmitted: false });
        }
        const studentId = studentLink[0].student_id;

        // 2. Check for a submission matching the activity and student
        // We only need to know if it exists, so we select 1 for efficiency
        const [submissions] = await connection.query(
            'SELECT 1 FROM activity_submissions WHERE activity_id = ? AND student_id = ? LIMIT 1',
            [activityId, studentId]
        );

        // 3. Return true if a submission was found, false otherwise
        res.json({ hasSubmitted: submissions.length > 0 });

    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to check for submission.' });
    } finally {
        if (connection) connection.release();
    }
});

// PUT /api/submissions/:submissionId - Parent edits a submission
router.put('/:submissionId', authenticate, upload.single('submissionFile'), async (req, res) => {
    const { submissionId } = req.params;
    const { comments } = req.body;
    const newFile = req.file;
    const guardianUserId = req.user.id;
    const userType = req.user.type;

    if (userType !== 'parent') {
        if (newFile) fs.unlinkSync(newFile.path); // Clean up if unauthorized
        return res.status(403).json({ error: 'Only parents can edit submissions.' });
    }

    let connection;
    try {
        connection = await db.promisePool.getConnection();
        await connection.beginTransaction();

        // 1. Fetch the existing submission to verify ownership and get old file path
        const [submissions] = await connection.query(
            'SELECT file_path, submitted_by_guardian_id FROM activity_submissions WHERE submission_id = ?',
            [submissionId]
        );

        if (submissions.length === 0) {
            if (newFile) fs.unlinkSync(newFile.path);
            await connection.rollback();
            return res.status(404).json({ error: 'Submission not found.' });
        }

        const existingSubmission = submissions[0];

        // 2. Verify that the logged-in parent is the owner of the submission
        if (existingSubmission.submitted_by_guardian_id !== guardianUserId) {
            if (newFile) fs.unlinkSync(newFile.path);
            await connection.rollback();
            return res.status(403).json({ error: 'You are not authorized to edit this submission.' });
        }

        // 3. Prepare the update query
        let updateQuery = 'UPDATE activity_submissions SET';
        const queryParams = [];

        if (newFile) {
            updateQuery += ' file_path = ?,',
            queryParams.push(newFile.path);
        }
        if (comments !== undefined) {
            updateQuery += ' comments = ?,',
            queryParams.push(comments);
        }

        // Remove trailing comma and add WHERE clause
        updateQuery = updateQuery.slice(0, -1) + ' WHERE submission_id = ?';
        queryParams.push(submissionId);

        // 4. Execute the update if there's anything to update
        if (queryParams.length > 1) {
            await connection.query(updateQuery, queryParams);
        } else {
            // Nothing to update
            if (newFile) fs.unlinkSync(newFile.path); // Clean up if only file was sent but nothing else
            await connection.rollback();
            return res.status(400).json({ error: 'No new file or comments provided to update.' });
        }

        // 5. If a new file was uploaded, delete the old one
        if (newFile && existingSubmission.file_path) {
            if (fs.existsSync(existingSubmission.file_path)) {
                fs.unlinkSync(existingSubmission.file_path);
            }
        }

        await connection.commit();
        res.json({ success: true, message: 'Submission updated successfully.' });

    } catch (err) {
        if (newFile) fs.unlinkSync(newFile.path); // Clean up on error
        if (connection) await connection.rollback();
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to update submission.' });
    } finally {
        if (connection) connection.release();
    }
});

// DELETE /api/submissions/:submissionId - Delete a submission
router.delete('/:submissionId', authenticate, async (req, res) => {
    const { submissionId } = req.params;
    const loggedInUserId = req.user.id;
    const userType = req.user.type;
    const userCdcId = req.user.cdc_id;
    let connection;
    try {
        connection = await db.promisePool.getConnection();
        await connection.beginTransaction();
        const [submissions] = await connection.query(
            'SELECT file_path, submitted_by_guardian_id, activity_id FROM activity_submissions WHERE submission_id = ?',
            [submissionId]
        );
        if (submissions.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Submission not found.' });
        }
        const submission = submissions[0];
        // Only the parent who submitted or a worker from the same CDC can delete
        if (userType === 'parent' && submission.submitted_by_guardian_id !== loggedInUserId) {
            await connection.rollback();
            return res.status(403).json({ error: 'You are not authorized to delete this submission.' });
        }
        if (userType === 'worker') {
            // Check CDC match
            const [activity] = await connection.query(
                'SELECT cdc_id FROM take_home_activities WHERE activity_id = ?',
                [submission.activity_id]
            );
            if (!activity.length || activity[0].cdc_id !== userCdcId) {
                await connection.rollback();
                return res.status(403).json({ error: 'You are not authorized to delete this submission.' });
            }
        }
        // Delete DB record
        const [result] = await connection.query(
            'DELETE FROM activity_submissions WHERE submission_id = ?',
            [submissionId]
        );
        if (result.affectedRows > 0 && submission.file_path) {
            if (fs.existsSync(submission.file_path)) {
                fs.unlinkSync(submission.file_path);
            }
        }
        await connection.commit();
        res.json({ success: true, message: 'Submission deleted successfully.' });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to delete submission.' });
    } finally {
        if (connection) connection.release();
    }
});

// GET /api/submissions/activity/:activityId/all-students - Get all students' submission records for a selected activity
router.get('/activity/:activityId/all-students', authenticate, async (req, res) => {
    const { activityId } = req.params;
    const userType = req.user.type;
    const userCdcId = req.user.cdc_id;
    let connection;
    try {
        connection = await db.promisePool.getConnection();
        // Check if activity belongs to user's CDC
        const [activity] = await connection.query(
            'SELECT cdc_id FROM take_home_activities WHERE activity_id = ?',
            [activityId]
        );
        if (!activity.length || activity[0].cdc_id !== userCdcId) {
            return res.status(403).json({ error: 'You are not authorized to view submissions for this activity.' });
        }
        // Get all students in the CDC
        const [students] = await connection.query(
            'SELECT student_id, first_name, last_name FROM students WHERE cdc_id = ?',
            [userCdcId]
        );
        // For each student, check if they have a submission for the activity
        const results = [];
        for (const student of students) {
            const [submission] = await connection.query(
                `SELECT submission_id, file_path, comments, submission_date, submitted_by_guardian_id FROM activity_submissions WHERE activity_id = ? AND student_id = ? LIMIT 1`,
                [activityId, student.student_id]
            );
            results.push({
                student_id: student.student_id,
                first_name: student.first_name,
                last_name: student.last_name,
                hasSubmitted: submission.length > 0,
                submission: submission.length > 0 ? submission[0] : null
            });
        }
        res.json(results);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to fetch student submissions.' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;