const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

// JWT verification helper (same as your existing code)
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

// Configure multer for file uploads (same as your existing code)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/submissions');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// GET /api/announcements/:id/submissions - Get all submissions for an announcement
router.get('/:id/submissions', verifyToken, async (req, res) => {
  const { id } = req.params;
  
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    // Verify the announcement exists and belongs to the user's CDC
    const [announcement] = await connection.query(
      `SELECT a.id 
       FROM announcements a
       JOIN users u ON a.author_id = u.id
       WHERE a.id = ? AND u.cdc_id = ?`,
      [id, req.user.cdc_id]
    );
    
    if (!announcement.length) {
      return res.status(404).json({
        success: false,
        message: 'Announcement not found or not authorized'
      });
    }

    // Get submissions with files
    const [submissions] = await connection.query(
      `SELECT 
         s.submission_id,
         s.submitter_id,
         s.submitter_name,
         s.remarks,
         s.status,
         s.submission_date,
         f.file_id,
         f.file_name,
         f.file_type,
         f.file_path
       FROM announcement_submissions s
       LEFT JOIN submission_files f ON s.submission_id = f.submission_id
       WHERE s.announcement_id = ?
       ORDER BY s.submission_date DESC`,
      [id]
    );

    // Group files with their submissions
    const groupedSubmissions = submissions.reduce((acc, curr) => {
      const existing = acc.find(s => s.submission_id === curr.submission_id);
      if (existing) {
        if (curr.file_id) {
          existing.files.push({
            file_id: curr.file_id,
            file_name: curr.file_name,
            file_type: curr.file_type,
            file_path: curr.file_path
          });
        }
      } else {
        const newSubmission = {
          submission_id: curr.submission_id,
          submitter_id: curr.submitter_id,
          submitter_name: curr.submitter_name,
          remarks: curr.remarks,
          status: curr.status,
          submission_date: curr.submission_date,
          files: curr.file_id ? [{
            file_id: curr.file_id,
            file_name: curr.file_name,
            file_type: curr.file_type,
            file_path: curr.file_path
          }] : []
        };
        acc.push(newSubmission);
      }
      return acc;
    }, []);

    return res.json({
      success: true,
      submissions: groupedSubmissions
    });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch submissions' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// POST /api/announcements/:id/submissions - Create a new submission
router.post('/:id/submissions', verifyToken, upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const { remarks } = req.body;
  const file = req.file;
  
  if (!remarks && !file) {
    if (file) fs.unlinkSync(file.path);
    return res.status(400).json({ 
      success: false, 
      message: 'Either remarks or file is required' 
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // Verify the announcement exists and belongs to the user's CDC
    const [announcement] = await connection.query(
      `SELECT a.id 
       FROM announcements a
       JOIN users u ON a.author_id = u.id
       WHERE a.id = ? AND u.cdc_id = ?`,
      [id, req.user.cdc_id]
    );
    
    if (!announcement.length) {
      throw new Error('Announcement not found or not authorized');
    }

    // Get user info
    const [user] = await connection.query(
      'SELECT id, name, cdc_id FROM users WHERE id = ?',
      [req.user.id]
    );
    
    if (!user.length) {
      throw new Error('User not found');
    }

    // Create the submission
    const [submissionResult] = await connection.query(
      `INSERT INTO announcement_submissions 
       (announcement_id, submitter_id, submitter_name, remarks, cdc_id)
       VALUES (?, ?, ?, ?, ?)`,
      [id, user[0].id, user[0].name, remarks, user[0].cdc_id]
    );

    const submissionId = submissionResult.insertId;

    // Handle file upload if present
    if (file) {
      const [fileResult] = await connection.query(
        `INSERT INTO submission_files 
         (submission_id, file_name, file_type, file_path, cdc_id)
         VALUES (?, ?, ?, ?, ?)`,
        [
          submissionId,
          file.originalname,
          file.mimetype,
          file.path,
          user[0].cdc_id
        ]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: 'Submission created successfully',
      submissionId
    });
  } catch (err) {
    await connection?.rollback();
    if (file) fs.unlinkSync(file.path);
    console.error('Error creating submission:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message || 'Failed to create submission' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/announcements/submissions/:submissionId/download - Download submission file
router.get('/submissions/:submissionId/download', verifyToken, async (req, res) => {
  const { submissionId } = req.params;

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    // Verify the submission belongs to the user's CDC
    const [file] = await connection.query(
      `SELECT f.file_name, f.file_type, f.file_path 
       FROM submission_files f
       JOIN announcement_submissions s ON f.submission_id = s.submission_id
       WHERE f.submission_id = ? AND s.cdc_id = ?`,
      [submissionId, req.user.cdc_id]
    );

    if (!file.length) {
      return res.status(404).json({ 
        success: false, 
        message: 'File not found or not authorized' 
      });
    }

    const fileData = await fs.promises.readFile(file[0].file_path);
    
    res.setHeader('Content-Type', file[0].file_type);
    res.setHeader('Content-Disposition', `attachment; filename="${file[0].file_name}"`);
    res.send(fileData);
  } catch (err) {
    console.error('Error downloading file:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to download file' 
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;