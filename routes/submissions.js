
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
            'SELECT * FROM activity_submissions WHERE activity_id = ? ORDER BY submission_date DESC',
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

module.exports = router;