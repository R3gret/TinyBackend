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
router.get('/categories', (req, res) => {
  const query = 'SELECT * FROM domain_file_categories';
  
  db.query(query, (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch categories' 
      });
    }

    return res.json({
      success: true,
      categories: results
    });
  });
});

// GET /api/age-groups - Returns all age groups
router.get('/age-groups', (req, res) => {
  const query = 'SELECT * FROM age_groups';
  
  db.query(query, (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch age groups' 
      });
    }

    return res.json({
      success: true,
      ageGroups: results
    });
  });
});

// GET /api/files - Takes category_id and age_group_id as query params
router.get('/', (req, res) => {
  const { category_id, age_group_id } = req.query;
  
  if (!category_id || !age_group_id) {
    return res.status(400).json({ 
      success: false, 
      message: 'Both category_id and age_group_id are required' 
    });
  }

  const query = 'SELECT * FROM files WHERE category_id = ? AND age_group_id = ?';
  
  db.query(query, [category_id, age_group_id], (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch files' 
      });
    }

    return res.json({
      success: true,
      files: results
    });
  });
});

// POST /api/files - Handles file uploads
router.post('/', upload.single('file_data'), (req, res) => {
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

  // Read the file data
  fs.readFile(file.path, (err, fileData) => {
    if (err) {
      console.error('Error reading file:', err);
      fs.unlinkSync(file.path);
      return res.status(500).json({ 
        success: false, 
        message: 'Error processing file' 
      });
    }

    const query = `
      INSERT INTO files 
      (category_id, age_group_id, file_name, file_type, file_data, file_path) 
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    const params = [
      category_id, 
      age_group_id, 
      file_name, 
      file.mimetype, 
      fileData,
      file.path // Store the path for later downloads
    ];

    db.query(query, params, (err, result) => {
      // Clean up the file now that it's stored in DB
      fs.unlinkSync(file.path);

      if (err) {
        console.error('Database query error:', err);
        return res.status(500).json({ 
          success: false, 
          message: 'Failed to upload file' 
        });
      }

      return res.json({
        success: true,
        message: 'File uploaded successfully',
        fileId: result.insertId
      });
    });
  });
});

// GET /api/files/download/:fileId - Handles file downloads
router.get('/download/:fileId', (req, res) => {
  const { fileId } = req.params;

  const query = 'SELECT file_name, file_type, file_data FROM files WHERE file_id = ?';
  
  db.query(query, [fileId], (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to download file' 
      });
    }

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
  });
});

// GET /api/files/counts - Returns file counts per category for a specific age group
router.get('/counts', (req, res) => {
  const { age_group_id } = req.query;
  
  if (!age_group_id) {
    return res.status(400).json({ 
      success: false, 
      message: 'age_group_id is required' 
    });
  }

  const query = `
    SELECT category_id, COUNT(*) as count 
    FROM files 
    WHERE age_group_id = ?
    GROUP BY category_id
  `;
  
  db.query(query, [age_group_id], (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch file counts' 
      });
    }

    // Convert the array to an object for easier lookup
    const counts = {};
    results.forEach(row => {
      counts[row.category_id] = row.count;
    });

    return res.json({
      success: true,
      counts
    });
  });
});



module.exports = router;