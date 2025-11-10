const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('./authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for homework uploads
const homeworkUploadDir = path.join(__dirname, '../uploads/homeworks');
if (!fs.existsSync(homeworkUploadDir)) {
  fs.mkdirSync(homeworkUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, homeworkUploadDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename
    const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, `${Date.now()}-${safeOriginalName}`);
  }
});

const upload = multer({ storage });

// POST /api/homeworks - Upload a new homework submission (for parents)
router.post('/', authenticate, upload.single('homeworkFile'), async (req, res) => {
    const { title, description } = req.body;
    const file = req.file;
    const guardianUserId = req.user.id;
    const userType = req.user.type;

    // 1. Validation
    if (userType !== 'parent') {
        if (file) fs.unlinkSync(file.path); // Clean up uploaded file
        return res.status(403).json({ error: 'Only parents can upload homework.' });
    }
    if (!title || !file) {
        if (file) fs.unlinkSync(file.path);
        return res.status(400).json({ error: 'Title and a file are required.' });
    }

    let connection;
    try {
        connection = await db.promisePool.getConnection();

        // 2. Find the student linked to the parent account
        const [studentLink] = await connection.query(
            'SELECT student_id, cdc_id FROM guardian_info WHERE id = ?',
            [guardianUserId]
        );

        if (studentLink.length === 0 || !studentLink[0].student_id) {
            if (file) fs.unlinkSync(file.path);
            return res.status(404).json({ error: 'No student is linked to this parent account.' });
        }
        const { student_id, cdc_id } = studentLink[0];

        // 3. Insert homework record into the database
        const [result] = await connection.query(
            `INSERT INTO homeworks (student_id, title, description, file_path, submitted_by_guardian_id, cdc_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [student_id, title, description, file.path, guardianUserId, cdc_id]
        );

        res.status(201).json({
            success: true,
            message: 'Homework uploaded successfully.',
            homeworkId: result.insertId
        });

    } catch (err) {
        if (file) fs.unlinkSync(file.path); // Clean up on error
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to upload homework.' });
    } finally {
        if (connection) connection.release();
    }
});

// GET /api/homeworks/student/:studentId - Get all homework for a specific student
router.get('/student/:studentId', authenticate, async (req, res) => {
    const { studentId } = req.params;
    const loggedInUserId = req.user.id;
    const userType = req.user.type;
    const userCdcId = req.user.cdc_id;

    let connection;
    try {
        connection = await db.promisePool.getConnection();

        // Authorization: Allow workers from the same CDC or the linked parent
        if (userType === 'parent') {
            const [studentLink] = await connection.query(
                'SELECT student_id FROM guardian_info WHERE id = ? AND student_id = ?',
                [loggedInUserId, studentId]
            );
            if (studentLink.length === 0) {
                return res.status(403).json({ error: 'You are not authorized to view this student\'s homework.' });
            }
        } else if (userType === 'worker') {
            const [student] = await connection.query(
                'SELECT cdc_id FROM students WHERE student_id = ?',
                [studentId]
            );
            if (student.length === 0 || student[0].cdc_id !== userCdcId) {
                return res.status(403).json({ error: 'You are not authorized to view this student\'s homework.' });
            }
        } // President/Admin can view all

        const [homeworks] = await connection.query(
            'SELECT * FROM homeworks WHERE student_id = ? ORDER BY upload_date DESC',
            [studentId]
        );

        res.json(homeworks);

    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to fetch homework.' });
    } finally {
        if (connection) connection.release();
    }
});

// GET /api/homeworks/download/:homeworkId - Download a homework file
router.get('/download/:homeworkId', authenticate, async (req, res) => {
    const { homeworkId } = req.params;
    // In a real app, you'd add authorization here to ensure the user can access this file
    let connection;
    try {
        connection = await db.promisePool.getConnection();
        const [results] = await connection.query(
            'SELECT file_path, title FROM homeworks WHERE homework_id = ?',
            [homeworkId]
        );

        if (results.length === 0) {
            return res.status(404).json({ error: 'Homework not found.' });
        }

        const { file_path, title } = results[0];

        if (!fs.existsSync(file_path)) {
            return res.status(404).json({ error: 'File not found on server.' });
        }

        res.download(file_path, `homework-${title}${path.extname(file_path)}`);

    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to download file.' });
    } finally {
        if (connection) connection.release();
    }
});


// DELETE /api/homeworks/:homeworkId - Delete a homework submission
router.delete('/:homeworkId', authenticate, async (req, res) => {
    const { homeworkId } = req.params;
    const loggedInUserId = req.user.id;
    const userType = req.user.type;

    let connection;
    try {
        connection = await db.promisePool.getConnection();
        await connection.beginTransaction();

        const [homeworks] = await connection.query(
            'SELECT file_path, submitted_by_guardian_id FROM homeworks WHERE homework_id = ?',
            [homeworkId]
        );

        if (homeworks.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Homework not found.' });
        }

        const homework = homeworks[0];

        // Authorization: Only the parent who submitted it or a worker can delete
        if (userType === 'parent' && homework.submitted_by_guardian_id !== loggedInUserId) {
            await connection.rollback();
            return res.status(403).json({ error: 'You are not authorized to delete this submission.' });
        }
        // Add worker authorization if needed

        // Delete DB record
        const [result] = await connection.query(
            'DELETE FROM homeworks WHERE homework_id = ?',
            [homeworkId]
        );

        if (result.affectedRows > 0 && homework.file_path) {
            // Delete physical file
            if (fs.existsSync(homework.file_path)) {
                fs.unlinkSync(homework.file_path);
            }
        }

        await connection.commit();
        res.json({ success: true, message: 'Homework submission deleted successfully.' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to delete homework.' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;
