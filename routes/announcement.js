const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

// Configure multer for announcement attachments
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/announcements');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// POST /api/announcements - Create new announcement (protected)
router.post('/', upload.single('attachment'), async (req, res) => {
  const { title, message, ageFilter } = req.body;
  const file = req.file;
  const user = req.user; // User data from the standardized 'authenticate' middleware
  let connection;

  if (!title || !message || !ageFilter) {
    // Clean up uploaded file if validation fails
    if (file) fs.unlinkSync(file.path);
    return res.status(400).json({ 
      success: false, 
      message: 'Title, message and age filter are required' 
    });
  }

  try {
    connection = await db.promisePool.getConnection();
    
    if (!user || !user.id || !user.cdc_id) {
        if (file) fs.unlinkSync(file.path);
        return res.status(403).json({
            success: false,
            message: 'User CDC information not found in token.'
        });
    }

    const [result] = await connection.query(
      `INSERT INTO announcements (
        title, 
        message, 
        author_id, 
        author_name, 
        age_filter, 
        attachment_path, 
        attachment_name,
        cdc_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        message,
        user.id,
        user.username || 'Unknown',
        ageFilter,
        file ? file.path : null,
        file ? file.originalname : null,
        user.cdc_id
      ]
    );

    // Get the newly created announcement
    const [announcementResults] = await connection.query(
      `SELECT 
        a.id,
        a.title,
        a.message,
        a.author_name as author,
        a.age_filter as ageFilter,
        a.created_at as createdAt,
        a.attachment_path as attachmentUrl,
        a.attachment_name as attachmentName
      FROM announcements a
      WHERE a.id = ?`,
      [result.insertId]
    );

    if (announcementResults.length === 0) {
      console.error('Failed to fetch new announcement');
      return res.json({ 
        success: true, 
        message: 'Announcement created but failed to return details' 
      });
    }

    const announcement = {
      ...announcementResults[0],
      createdAt: new Date(announcementResults[0].createdAt).toISOString(),
      attachmentUrl: announcementResults[0].attachmentUrl 
        ? `${req.protocol}://${req.get('host')}/uploads/announcements/${path.basename(announcementResults[0].attachmentUrl)}`
        : null
    };

    res.json({ 
      success: true, 
      message: 'Announcement created successfully',
      announcement 
    });
  } catch (err) {
    console.error('Database error:', err);
    if (file) fs.unlinkSync(file.path);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create announcement' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/announcements - Fetch all announcements for the user's CDC
router.get('/', async (req, res) => {
  const user = req.user;
  let connection;

  if (!user || !user.cdc_id) {
    return res.status(403).json({
      success: false,
      message: 'User CDC information not found in token.'
    });
  }

  try {
    connection = await db.promisePool.getConnection();

    const [results] = await connection.query(
      `SELECT 
        a.id,
        a.title,
        a.message,
        a.author_name as author,
        a.age_filter as ageFilter,
        a.created_at as createdAt,
        a.attachment_path as attachmentUrl,
        a.attachment_name as attachmentName
      FROM announcements a
      WHERE a.cdc_id = ?
      ORDER BY a.created_at DESC`,
      [user.cdc_id]
    );

    const announcements = results.map(announcement => ({
      ...announcement,
      createdAt: new Date(announcement.createdAt).toISOString(),
      attachmentUrl: announcement.attachmentUrl
        ? `${req.protocol}://${req.get('host')}/uploads/announcements/${path.basename(announcement.attachmentUrl)}`
        : null
    }));

    res.json({
      success: true,
      announcements
    });

  } catch (err) {
    console.error('Database error fetching announcements:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch announcements'
    });
  } finally {
    if (connection) connection.release();
  }
});


module.exports = router;