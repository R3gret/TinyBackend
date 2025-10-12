const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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
router.get('/categories', async (req, res) => {
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
router.get('/age-groups', async (req, res) => {
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

// Add this to your parentannouncements.js file

// GET /api/parentannouncements/filtered-classworks - Returns classworks filtered by student's age and CDC
router.get('/filtered-classworks', async (req, res) => {
  let connection;
  
  try {
    // Get student info (reusing the same middleware as announcements)
    const { student_id, age, cdc_id } = await getStudentInfo(req);
    connection = await db.promisePool.getConnection();

    // Determine age group (same logic as announcements)
    let ageGroup;
    if (age >= 3 && age < 4) {
      ageGroup = '3-4';
    } else if (age >= 4 && age < 5) {
      ageGroup = '4-5';
    } else if (age >= 5 && age <= 6) {
      ageGroup = '5-6';
    } else {
      ageGroup = 'other';
    }

    // Query classworks that match:
    // 1. The student's age group OR 'all' age filter
    // AND
    // 2. Either:
    //    - No specific CDC (cdc_id IS NULL) - applies to all CDCs
    //    - OR matches the student's CDC (cdc_id = student's cdc_id)
    const [classworks] = await connection.query(
      `SELECT 
        c.*, 
        cat.category_name,
        ag.age_range,
        u.name as author_name
       FROM classworks c
       JOIN domain_file_categories cat ON c.category_id = cat.category_id
       JOIN age_groups ag ON c.age_group_id = ag.age_group_id
       LEFT JOIN users u ON c.author_id = u.id
       WHERE (ag.age_range = ? OR ag.age_range = 'all')
       AND (c.cdc_id IS NULL OR c.cdc_id = ?)
       ORDER BY c.created_at DESC`,
      [ageGroup, cdc_id]
    );

    // Format the results
    const formattedClassworks = classworks.map(cw => ({
      ...cw,
      age_range: cw.age_range.replace(/\?/g, '-')
    }));

    return res.json({
      success: true,
      student_id,
      age,
      ageGroup,
      cdc_id,
      classworks: formattedClassworks
    });
  } catch (err) {
    console.error('Error fetching filtered classworks:', {
      message: err.message,
      stack: err.stack,
      sql: err.sql,
      code: err.code
    });
    
    if (err.message === 'Unauthorized') {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (err.message === 'Parent not found') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    if (err.message === 'Student not found for this parent') {
      return res.status(404).json({ success: false, message: 'No associated student found' });
    }
    
    return res.status(500).json({ 
      success: false, 
      message: 'Database error',
      errorDetails: process.env.NODE_ENV === 'development' ? {
        message: err.message,
        code: err.code
      } : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/files - Takes category_id and age_group_id as query params
router.get('/', async (req, res) => {
  const { category_id, age_group_id } = req.query;
  const { cdc_id: userCdcId } = req.user;

  if (!category_id || !age_group_id) {
    return res.status(400).json({
      success: false,
      message: 'Both category_id and age_group_id are required'
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();

    if (!userCdcId) {
      return res.status(403).json({
        success: false,
        message: 'User is not associated with a CDC. Access denied.'
      });
    }

    const query = `
      SELECT f.* 
      FROM files f
      JOIN users u ON f.id = u.id
      WHERE f.category_id = ? AND f.age_group_id = ? AND u.cdc_id = ?
    `;
    const params = [category_id, age_group_id, userCdcId];

    const [results] = await connection.query(query, params);

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
router.post('/', upload.single('file_data'), async (req, res) => {
  const { category_id, age_group_id, file_name } = req.body;
  const file = req.file;
  const { id: userId, cdc_id: userCdcId } = req.user;

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

    // For file uploads, the user must be associated with a CDC, even a President
    if (!userCdcId) {
        if (file) fs.unlinkSync(file.path);
        return res.status(403).json({
            success: false,
            message: 'User must be associated with a CDC to upload files.'
        });
    }

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
router.get('/download/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const { cdc_id: userCdcId } = req.user;

  let connection;
  try {
    connection = await db.promisePool.getConnection();

    if (!userCdcId) {
      return res.status(403).json({
        success: false,
        message: 'User is not associated with a CDC. Access denied.'
      });
    }

    const query = `
      SELECT f.file_name, f.file_type, f.file_data 
      FROM files f
      JOIN users u ON f.id = u.id
      WHERE f.file_id = ? AND u.cdc_id = ?
    `;
    const params = [fileId, userCdcId];

    const [results] = await connection.query(query, params);

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
router.get('/counts', async (req, res) => {
  const { age_group_id } = req.query;
  const { cdc_id: userCdcId } = req.user;

  if (!age_group_id) {
    return res.status(400).json({
      success: false,
      message: 'age_group_id is required'
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();

    if (!userCdcId) {
      return res.status(403).json({
        success: false,
        message: 'User is not associated with a CDC. Access denied.'
      });
    }

    const query = `
      SELECT f.category_id, COUNT(*) as count 
      FROM files f
      JOIN users u ON f.id = u.id
      WHERE f.age_group_id = ? AND u.cdc_id = ?
      GROUP BY f.category_id
    `;
    const params = [age_group_id, userCdcId];

    const [results] = await connection.query(query, params);

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