const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

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

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// GET /api/categories - Returns all categories
router.get('/categories', verifyToken, async (req, res) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query('SELECT * FROM domain_file_categories');
    
    return res.json({
      success: true,
      categories: results
    });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch categories' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/age-groups - Returns all age groups
router.get('/age-groups', verifyToken, async (req, res) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query('SELECT * FROM age_groups');
    
    // Format the age ranges properly
    const formattedResults = results.map(group => ({
      ...group,
      age_range: group.age_range.replace(/\?/g, '-')
    }));
    
    return res.json({
      success: true,
      ageGroups: formattedResults
    });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch age groups' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/files - Takes category_id and age_group_id as query params
router.get('/', verifyToken, async (req, res) => {
  const { category_id, age_group_id } = req.query;
  
  if (!category_id || !age_group_id) {
    return res.status(400).json({ 
      success: false, 
      message: 'Both category_id and age_group_id are required' 
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    // Get user's CDC ID
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
    
    // Query files with CDC filter
    const [results] = await connection.query(
      `SELECT f.* 
       FROM files f
       JOIN users u ON f.id = u.id
       WHERE f.category_id = ? 
       AND f.age_group_id = ?
       AND u.cdc_id = ?`,
      [category_id, age_group_id, userCdcId]
    );
    
    return res.json({
      success: true,
      files: results
    });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch files' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// POST /api/files - Handles file uploads
router.post('/', verifyToken, upload.single('file_data'), async (req, res) => {
  const { category_id, age_group_id, file_name } = req.body;
  const file = req.file;

  if (!category_id || !age_group_id || !file_name || !file) {
    if (file) fs.unlinkSync(file.path);
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields' 
    });
  }

  let connection;
  try {
    // Read the file data
    const fileData = await fs.promises.readFile(file.path);
    connection = await db.promisePool.getConnection();

    // Get user's CDC ID
    const [user] = await connection.query(
      'SELECT id, cdc_id FROM users WHERE id = ?',
      [req.user.id]
    );
    
    if (!user.length || !user[0].cdc_id) {
      throw new Error('User CDC information not found');
    }

    const userId = user[0].id;
    const userCdcId = user[0].cdc_id;

    const [result] = await connection.query(
      `INSERT INTO files 
      (category_id, age_group_id, file_name, file_type, file_data, file_path, cdc_id, id) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        category_id, 
        age_group_id, 
        file_name, 
        file.mimetype, 
        fileData,
        file.path,
        userCdcId,
        userId
      ]
    );

    fs.unlinkSync(file.path);

    return res.json({
      success: true,
      message: 'File uploaded successfully',
      fileId: result.insertId
    });
  } catch (err) {
    if (file) fs.unlinkSync(file.path);
    console.error('Error processing file:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message || 'Failed to upload file' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/files/download/:fileId - Handles file downloads
router.get('/download/:fileId', verifyToken, async (req, res) => {
  const { fileId } = req.params;

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    // Get user's CDC ID
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
    
    // Verify the file belongs to the user's CDC
    const [results] = await connection.query(
      `SELECT f.file_name, f.file_type, f.file_data 
       FROM files f
       JOIN users u ON f.id = u.id
       WHERE f.file_id = ? AND u.cdc_id = ?`,
      [fileId, userCdcId]
    );

    if (results.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'File not found or not authorized' 
      });
    }

    const file = results[0];
    
    res.setHeader('Content-Type', file.file_type);
    res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`);
    res.send(file.file_data);
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to download file' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/files/counts - Returns file counts per category for a specific age group
router.get('/counts', verifyToken, async (req, res) => {
  const { age_group_id } = req.query;
  
  if (!age_group_id) {
    return res.status(400).json({ 
      success: false, 
      message: 'age_group_id is required' 
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    // Get user's CDC ID
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
    
    const [results] = await connection.query(
      `SELECT f.category_id, COUNT(*) as count 
       FROM files f
       JOIN users u ON f.id = u.id
       WHERE f.age_group_id = ? AND u.cdc_id = ?
       GROUP BY f.category_id`,
      [age_group_id, userCdcId]
    );

    const counts = {};
    results.forEach(row => {
      counts[row.category_id] = row.count;
    });

    return res.json({
      success: true,
      counts
    });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch file counts' 
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;