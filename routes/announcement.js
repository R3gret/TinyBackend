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

// JWT verification helper
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'Authorization token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.error('JWT verification error:', err);
    return res.status(403).json({ success: false, message: 'Invalid token' });
  }
};

// GET /api/announcements - Get announcements filtered by CDC
router.get('/', verifyToken, async (req, res) => {
  const { ageFilter } = req.query;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    
    // Get the user's CDC ID from the authenticated user
    const [user] = await connection.query(
      'SELECT cdc_id FROM users WHERE id = ?',
      [req.user.id]
    );
    
    if (!user.length || !user[0].cdc_id) {
      return res.status(403).json({
        success: false,
        message: 'User CDC information not found'
      });
    }

    const userCdcId = user[0].cdc_id;
    
    let query = `
      SELECT 
        a.id,
        a.title,
        a.message,
        a.author_name as author,
        a.age_filter as ageFilter,
        a.created_at as createdAt,
        a.attachment_path as attachmentUrl,
        a.attachment_name as attachmentName
      FROM announcements a
      JOIN users u ON a.author_id = u.id
      WHERE u.cdc_id = ?
    `;
    
    const params = [userCdcId];
    
    if (ageFilter && ageFilter !== 'all') {
      query += ` AND (a.age_filter = ? OR a.age_filter = 'all')`;
      params.push(ageFilter);
    }
    
    query += ` ORDER BY a.created_at DESC`;

    const [results] = await connection.query(query, params);

    // Format dates and attachment URLs
    const announcements = results.map(ann => ({
      ...ann,
      createdAt: new Date(ann.createdAt).toISOString(),
      attachmentUrl: ann.attachmentUrl 
        ? `${req.protocol}://${req.get('host')}/uploads/announcements/${path.basename(ann.attachmentUrl)}`
        : null
    }));

    res.json({ 
      success: true, 
      announcements 
    });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch announcements' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// POST /api/announcements - Create new announcement (protected)
router.post('/', verifyToken, upload.single('attachment'), async (req, res) => {
  const { title, message, ageFilter } = req.body;
  const file = req.file;
  const user = req.user; // User data from JWT verification
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

    // Get user's CDC ID to store with announcement
    const [userData] = await connection.query(
      'SELECT cdc_id, username FROM users WHERE id = ?',
      [user.id]
    );
    
    if (!userData.length) {
      throw new Error('User not found');
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
        userData[0].username || 'Unknown',
        ageFilter,
        file ? file.path : null,
        file ? file.originalname : null,
        userData[0].cdc_id
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

module.exports = router;