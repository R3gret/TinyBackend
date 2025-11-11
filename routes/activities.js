const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('./authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const activityUploadDir = path.join(__dirname, '../uploads/activities');
if (!fs.existsSync(activityUploadDir)) {
  fs.mkdirSync(activityUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, activityUploadDir);
  },
  filename: (req, file, cb) => {
    const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, `${Date.now()}-${safeOriginalName}`);
  }
});
const upload = multer({ storage });

// CREATE activity (worker only)
router.post('/', authenticate, upload.single('activityFile'), async (req, res) => {
    const { title, description, due_date, age_group_id } = req.body;
    const file = req.file;
    const userType = req.user.type;
    const workerId = req.user.id;
    const cdcId = req.user.cdc_id;
    if (userType !== 'worker') {
        if (file) fs.unlinkSync(file.path);
        return res.status(403).json({ error: 'Only workers can create activities.' });
    }
    if (!title || !cdcId) {
        if (file) fs.unlinkSync(file.path);
        return res.status(400).json({ error: 'Title and CDC are required.' });
    }
    let connection;
    try {
        connection = await db.promisePool.getConnection();
        const filePath = file ? file.path : null;
        const [result] = await connection.query(
            'INSERT INTO take_home_activities (title, description, due_date, assigned_by_worker_id, cdc_id, file_path, age_group_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [title, description, due_date, workerId, cdcId, filePath, age_group_id]
        );
        res.status(201).json({ success: true, activityId: result.insertId });
    } catch (err) {
        if (file) fs.unlinkSync(file.path);
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to create activity.' });
    } finally {
        if (connection) connection.release();
    }
});

// READ all activities for CDC
router.get('/', authenticate, async (req, res) => {
    const userCdcId = req.user.cdc_id;
    let connection;
    try {
        connection = await db.promisePool.getConnection();
        const [activities] = await connection.query(
            `SELECT 
               tha.*, 
               ag.age_range 
             FROM take_home_activities tha
             LEFT JOIN age_groups ag ON tha.age_group_id = ag.age_group_id
             WHERE tha.cdc_id = ? 
             ORDER BY tha.creation_date DESC`,
            [userCdcId]
        );
        res.json(activities);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to fetch activities.' });
    } finally {
        if (connection) connection.release();
    }
});

// UPDATE activity (worker only)
router.put('/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    const { title, description, due_date } = req.body;
    const userType = req.user.type;
    const cdcId = req.user.cdc_id;

    if (userType !== 'worker') {
        return res.status(403).json({ error: 'Only workers can update activities.' });
    }
    let connection;
    try {
        connection = await db.promisePool.getConnection();
        const [result] = await connection.query(
            'UPDATE take_home_activities SET title = ?, description = ?, due_date = ? WHERE activity_id = ? AND cdc_id = ?',
            [title, description, due_date, id, cdcId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Activity not found or you do not have permission to update it.' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to update activity.' });
    } finally {
        if (connection) connection.release();
    }
});

// DELETE activity (worker only)
router.delete('/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    const userType = req.user.type;
    const cdcId = req.user.cdc_id;

    if (userType !== 'worker') {
        return res.status(403).json({ error: 'Only workers can delete activities.' });
    }
    let connection;
    try {
        connection = await db.promisePool.getConnection();
        const [result] = await connection.query(
            'DELETE FROM take_home_activities WHERE activity_id = ? AND cdc_id = ?',
            [id, cdcId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Activity not found or you do not have permission to delete it.' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to delete activity.' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;
