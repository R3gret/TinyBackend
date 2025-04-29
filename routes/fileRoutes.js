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
// In your backend route handler for age-groups
router.get('/age-groups', async (req, res) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query('SELECT * FROM age_groups');
    
    // Format the age ranges properly
    const formattedResults = results.map(group => ({
      ...group,
      age_range: group.age_range.replace(/\?/g, '-') // Replace any question marks with hyphens
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
router.get('/', async (req, res) => {
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
    const [results] = await connection.query(
      'SELECT * FROM files WHERE category_id = ? AND age_group_id = ?',
      [category_id, age_group_id]
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
router.post('/', upload.single('file_data'), async (req, res) => {
  const { category_id, age_group_id, file_name } = req.body;
  const file = req.file;

  if (!category_id || !age_group_id || !file_name || !file) {
    // Clean up the uploaded file if validation fails
    if (file) {
      fs.unlinkSync(file.path);
    }
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

    const [result] = await connection.query(
      `INSERT INTO files 
      (category_id, age_group_id, file_name, file_type, file_data, file_path) 
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        category_id, 
        age_group_id, 
        file_name, 
        file.mimetype, 
        fileData,
        file.path // Store the path for later downloads
      ]
    );

    // Clean up the file now that it's stored in DB
    fs.unlinkSync(file.path);

    return res.json({
      success: true,
      message: 'File uploaded successfully',
      fileId: result.insertId
    });
  } catch (err) {
    // Clean up the file if there was an error
    if (file) {
      fs.unlinkSync(file.path);
    }
    console.error('Error processing file:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to upload file' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/files/download/:fileId - Handles file downloads
router.get('/download/:fileId', async (req, res) => {
  const { fileId } = req.params;

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query(
      'SELECT file_name, file_type, file_data FROM files WHERE file_id = ?',
      [fileId]
    );

    if (results.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'File not found' 
      });
    }

    const file = results[0];
    
    // Set headers for file download
    res.setHeader('Content-Type', file.file_type);
    res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`);
    
    // Send the file data
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
  
  if (!age_group_id) {
    return res.status(400).json({ 
      success: false, 
      message: 'age_group_id is required' 
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query(
      `SELECT category_id, COUNT(*) as count 
      FROM files 
      WHERE age_group_id = ?
      GROUP BY category_id`,
      [age_group_id]
    );

    // Convert the array to an object for easier lookup
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