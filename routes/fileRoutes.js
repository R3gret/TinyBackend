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

// --- Specific Routes First ---

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

// GET /api/files/get-age-groups - Returns all age groups
router.get('/get-age-groups', async (req, res) => {
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

// GET /api/files/get-categories - Returns all categories for the user's CDC
router.get('/get-categories', async (req, res) => {
  const { cdc_id: userCdcId } = req.user;
  let connection;

  if (!userCdcId) {
    return res.status(403).json({ success: false, message: 'User is not associated with a CDC. Access denied.' });
  }

  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query('SELECT * FROM domain_file_categories WHERE cdc_id = ?', [userCdcId]);
    
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

// POST /api/files/categories - Create a new category for the user's CDC
router.post('/categories', async (req, res) => {
  const { category_name } = req.body;
  const { cdc_id: userCdcId } = req.user;

  if (!userCdcId) {
    return res.status(403).json({ success: false, message: 'User must be associated with a CDC to create a category.' });
  }
  if (!category_name) {
    return res.status(400).json({ success: false, message: 'Category name is required' });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [result] = await connection.query(
      'INSERT INTO domain_file_categories (category_name, cdc_id) VALUES (?, ?)',
      [category_name, userCdcId]
    );
    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      category: { category_id: result.insertId, category_name, cdc_id: userCdcId }
    });
  } catch (err) {
    console.error('Database query error:', err);
    // Check for duplicate entry
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Category name already exists' });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to create category'
    });
  } finally {
    if (connection) connection.release();
  }
});

// PUT /api/files/categories/:id - Update a category within the user's CDC
router.put('/categories/:id', async (req, res) => {
  const { id } = req.params;
  const { category_name } = req.body;
  const { cdc_id: userCdcId } = req.user;

  if (!userCdcId) {
    return res.status(403).json({ success: false, message: 'User is not associated with a CDC. Access denied.' });
  }
  if (!category_name) {
    return res.status(400).json({ success: false, message: 'Category name is required' });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [result] = await connection.query(
      'UPDATE domain_file_categories SET category_name = ? WHERE category_id = ? AND cdc_id = ?',
      [category_name, id, userCdcId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Category not found or not owned by your CDC' });
    }

    res.json({
      success: true,
      message: 'Category updated successfully'
    });
  } catch (err) {
    console.error('Database query error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Category name already exists' });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to update category'
    });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /api/files/categories/:id - Delete a category within the user's CDC
router.delete('/categories/:id', async (req, res) => {
  const { id } = req.params;
  const { cdc_id: userCdcId } = req.user;

  if (!userCdcId) {
    return res.status(403).json({ success: false, message: 'User is not associated with a CDC. Access denied.' });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [result] = await connection.query(
      'DELETE FROM domain_file_categories WHERE category_id = ? AND cdc_id = ?',
      [id, userCdcId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Category not found or not owned by your CDC' });
    }

    res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (err) {
    console.error('Database query error:', err);
     // Handle foreign key constraint error
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
        return res.status(409).json({ success: false, message: 'Cannot delete category as it is currently in use by existing files.' });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to delete category'
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

// --- Generic Routes Last ---

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

// PUT /api/files/:id - Rename a file
router.put('/:id', async (req, res) => {
  const { id: fileId } = req.params;
  const { file_name } = req.body;
  const { cdc_id: userCdcId } = req.user;

  if (!file_name) {
    return res.status(400).json({ success: false, message: 'New file name is required' });
  }
  if (!userCdcId) {
    return res.status(403).json({ success: false, message: 'User is not associated with a CDC. Access denied.' });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [result] = await connection.query(
      'UPDATE files SET file_name = ? WHERE file_id = ? AND cdc_id = ?',
      [file_name, fileId, userCdcId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'File not found or you do not have permission to edit it.' });
    }

    res.json({ success: true, message: 'File renamed successfully.' });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to rename file.'
    });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /api/files/:id - Delete a file
router.delete('/:id', async (req, res) => {
  const { id: fileId } = req.params;
  const { cdc_id: userCdcId } = req.user;

  if (!userCdcId) {
    return res.status(403).json({ success: false, message: 'User is not associated with a CDC. Access denied.' });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // First, get the file path before deleting the record
    const [files] = await connection.query(
      'SELECT file_path FROM files WHERE file_id = ? AND cdc_id = ?',
      [fileId, userCdcId]
    );

    if (files.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'File not found or you do not have permission to delete it.' });
    }
    
    const filePath = files[0].file_path;

    // Next, delete the database record
    const [result] = await connection.query(
      'DELETE FROM files WHERE file_id = ? AND cdc_id = ?',
      [fileId, userCdcId]
    );

    if (result.affectedRows > 0 && filePath) {
      // Finally, delete the physical file from the server
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    
    await connection.commit();
    res.json({ success: true, message: 'File deleted successfully.' });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Database query error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete file.'
    });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/files - This must be the last GET route
router.get('/', async (req, res) => {
  const { cdc_id: userCdcId } = req.user;
  let connection;

  if (!userCdcId) {
    return res.status(403).json({ success: false, message: 'User is not associated with a CDC. Access denied.' });
  }

  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query('SELECT * FROM files WHERE cdc_id = ?', [userCdcId]);
    
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

module.exports = router;