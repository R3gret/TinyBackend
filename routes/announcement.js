// routes/announcements.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

// GET /api/announcements - Get all announcements (public)
router.get('/', (req, res) => {
  const { ageFilter } = req.query;
  
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
  `;
  
  const params = [];
  
  if (ageFilter && ageFilter !== 'all') {
    query += ` WHERE a.age_filter = ? OR a.age_filter = 'all'`;
    params.push(ageFilter);
  }
  
  query += ` ORDER BY a.created_at DESC`;

  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch announcements' 
      });
    }

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
  });
});

const authenticate = require('./authMiddleware');

// POST /api/announcements - Create new announcement (protected)
router.post('/', authenticate, upload.single('attachment'), (req, res) => {
  const { title, message, ageFilter } = req.body;
  const file = req.file;
  const user = req.user; // User data from authentication middleware

  if (!title || !message || !ageFilter) {
    // Clean up uploaded file if validation fails
    if (file) fs.unlinkSync(file.path);
    return res.status(400).json({ 
      success: false, 
      message: 'Title, message and age filter are required' 
    });
  }

  const query = `
    INSERT INTO announcements (
      title, 
      message, 
      author_id, 
      author_name, 
      age_filter, 
      attachment_path, 
      attachment_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    title,
    message,
    user.id, // From your localStorage user data
    user.username || 'Unknown', // From your localStorage user data
    ageFilter,
    file ? file.path : null,
    file ? file.originalname : null
  ];

  db.query(query, params, (err, result) => {
    if (err) {
      console.error('Database error:', err);
      if (file) fs.unlinkSync(file.path);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to create announcement' 
      });
    }

    // Get the newly created announcement
    const getQuery = `
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
      WHERE a.id = ?
    `;

    db.query(getQuery, [result.insertId], (err, results) => {
      if (err || results.length === 0) {
        console.error('Failed to fetch new announcement:', err);
        return res.json({ 
          success: true, 
          message: 'Announcement created but failed to return details' 
        });
      }

      const announcement = {
        ...results[0],
        createdAt: new Date(results[0].createdAt).toISOString(),
        attachmentUrl: results[0].attachmentUrl 
          ? `${req.protocol}://${req.get('host')}/uploads/announcements/${path.basename(results[0].attachmentUrl)}`
          : null
      };

      res.json({ 
        success: true, 
        message: 'Announcement created successfully',
        announcement 
      });
    });
  });
});

module.exports = router;