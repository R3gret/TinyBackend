const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
// Query param: scope - 'all' (only available to all), 'cdc' (only user's CDC), 'both' (default, both)
router.get('/counts', async (req, res) => {
  const { age_group_id, scope = 'both' } = req.query;
  const { cdc_id: userCdcId } = req.user || {};

  if (!age_group_id) {
    return res.status(400).json({
      success: false,
      message: 'age_group_id is required'
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();

    // Build query based on scope parameter
    let query, params;
    
    if (scope === 'all') {
      // Only files available to all
      query = `
        SELECT f.category_id, COUNT(*) as count 
        FROM files f
        WHERE f.age_group_id = ? AND f.cdc_id IS NULL
        GROUP BY f.category_id
      `;
      params = [age_group_id];
    } else if (scope === 'cdc' && userCdcId) {
      // Only files for user's CDC
      query = `
        SELECT f.category_id, COUNT(*) as count 
        FROM files f
        WHERE f.age_group_id = ? AND f.cdc_id = ?
        GROUP BY f.category_id
      `;
      params = [age_group_id, userCdcId];
    } else if (scope === 'cdc' && !userCdcId) {
      // User has no CDC, so no CDC-specific files
      return res.json({
        success: true,
        counts: {}
      });
    } else {
      // Default: both (available to all OR user's CDC)
      if (!userCdcId) {
        query = `
          SELECT f.category_id, COUNT(*) as count 
          FROM files f
          WHERE f.age_group_id = ? AND f.cdc_id IS NULL
          GROUP BY f.category_id
        `;
        params = [age_group_id];
      } else {
        query = `
          SELECT f.category_id, COUNT(*) as count 
          FROM files f
          WHERE f.age_group_id = ? AND (f.cdc_id IS NULL OR f.cdc_id = ?)
          GROUP BY f.category_id
        `;
        params = [age_group_id, userCdcId];
      }
    }

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

// GET /api/files/get-categories - Returns categories based on scope
// Query param: scope - 'all' (only available to all), 'cdc' (only user's CDC), 'both' (default, both)
router.get('/get-categories', async (req, res) => {
  const { cdc_id: userCdcId } = req.user || {};
  const { age_group_id, scope = 'both' } = req.query;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    
    // Build query based on scope parameter
    let query, params;
    
    if (scope === 'all') {
      // Only categories available to all
      query = 'SELECT * FROM domain_file_categories WHERE cdc_id IS NULL';
      params = [];
    } else if (scope === 'cdc' && userCdcId) {
      // Only categories for user's CDC
      query = 'SELECT * FROM domain_file_categories WHERE cdc_id = ?';
      params = [userCdcId];
    } else if (scope === 'cdc' && !userCdcId) {
      // User has no CDC, so no CDC-specific categories
      return res.json({
        success: true,
        categories: []
      });
    } else {
      // Default: both (available to all OR user's CDC)
      if (!userCdcId) {
        query = 'SELECT * FROM domain_file_categories WHERE cdc_id IS NULL';
        params = [];
      } else {
        query = 'SELECT * FROM domain_file_categories WHERE cdc_id IS NULL OR cdc_id = ?';
        params = [userCdcId];
      }
    }

    // If age_group_id is provided, add it to the filter
    if (age_group_id) {
      query += ' AND age_group_id = ?';
      params.push(age_group_id);
    }

    const [results] = await connection.query(query, params);
    
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

// POST /api/files/categories - Create a new category (available to all if cdc_id is null, or for user's CDC)
router.post('/categories', async (req, res) => {
  const { category_name, age_group_id } = req.body;
  const { cdc_id: userCdcId } = req.user || {};

  if (!category_name || !age_group_id) {
    return res.status(400).json({ success: false, message: 'Category name and age_group_id are required' });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    // If userCdcId is null, create category available to all (cdc_id = NULL)
    // If userCdcId is provided, create category for that CDC
    const [result] = await connection.query(
      'INSERT INTO domain_file_categories (category_name, cdc_id, age_group_id) VALUES (?, ?, ?)',
      [category_name, userCdcId || null, age_group_id]
    );
    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      category: { category_id: result.insertId, category_name, cdc_id: userCdcId || null, age_group_id }
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

// PUT /api/files/categories/:id - Update a category (available to all or within user's CDC)
router.put('/categories/:id', async (req, res) => {
  const { id } = req.params;
  const { category_name } = req.body;
  const { cdc_id: userCdcId } = req.user || {};

  if (!category_name) {
    return res.status(400).json({ success: false, message: 'Category name is required' });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    // If userCdcId is null, allow updating only categories available to all (cdc_id IS NULL)
    // If userCdcId is provided, allow updating categories available to all OR belonging to that CDC
    let query, params;
    if (!userCdcId) {
      query = 'UPDATE domain_file_categories SET category_name = ? WHERE category_id = ? AND cdc_id IS NULL';
      params = [category_name, id];
    } else {
      query = 'UPDATE domain_file_categories SET category_name = ? WHERE category_id = ? AND (cdc_id IS NULL OR cdc_id = ?)';
      params = [category_name, id, userCdcId];
    }
    
    const [result] = await connection.query(query, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Category not found or you do not have permission to update it' });
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

// DELETE /api/files/categories/:id - Delete a category (available to all or within user's CDC)
router.delete('/categories/:id', async (req, res) => {
  const { id } = req.params;
  const { cdc_id: userCdcId } = req.user || {};

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    // If userCdcId is null, allow deleting only categories available to all (cdc_id IS NULL)
    // If userCdcId is provided, allow deleting categories available to all OR belonging to that CDC
    let query, params;
    if (!userCdcId) {
      query = 'DELETE FROM domain_file_categories WHERE category_id = ? AND cdc_id IS NULL';
      params = [id];
    } else {
      query = 'DELETE FROM domain_file_categories WHERE category_id = ? AND (cdc_id IS NULL OR cdc_id = ?)';
      params = [id, userCdcId];
    }
    
    const [result] = await connection.query(query, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Category not found or you do not have permission to delete it' });
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
  const { cdc_id: userCdcId } = req.user || {};

  let connection;
  try {
    connection = await db.promisePool.getConnection();

    // If userCdcId is null, allow downloading only files available to all (cdc_id IS NULL)
    // If userCdcId is provided, allow downloading files available to all OR belonging to that CDC
    let query, params;
    if (!userCdcId) {
      query = `
        SELECT f.file_name, f.file_type, f.file_path 
        FROM files f
        WHERE f.file_id = ? AND f.cdc_id IS NULL
      `;
      params = [fileId];
    } else {
      query = `
        SELECT f.file_name, f.file_type, f.file_path 
        FROM files f
        WHERE f.file_id = ? AND (f.cdc_id IS NULL OR f.cdc_id = ?)
      `;
      params = [fileId, userCdcId];
    }

    const [results] = await connection.query(query, params);

    if (results.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'File not found or not authorized' 
      });
    }

    const file = results[0];
    
    // Check if the file exists on the filesystem
    if (!fs.existsSync(file.file_path)) {
        return res.status(404).json({
            success: false,
            message: 'File not found on server.'
        });
    }

    // Stream the file for download
    res.download(file.file_path, file.file_name, (err) => {
        if (err) {
            console.error('File download error:', err);
            // Don't try to send another response if headers are already sent
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    message: 'Could not download the file.'
                });
            }
        }
    });
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

// Helper to normalize FormData arrays (cdc_ids[] or csv string)
const parseIdsArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    if (value.includes(',')) {
      return value.split(',').map(part => part.trim()).filter(Boolean);
    }
    return [value];
  }
  return [];
};

// --- Generic Routes Last ---

// POST /api/files/multi-cdc-upload - Upload selected files to multiple CDCs under the same folder/category
router.post('/multi-cdc-upload', upload.array('files', 25), async (req, res) => {
  const { folder_name, age_group_id } = req.body;
  const { id: userId } = req.user || {};
  const fileUploads = req.files || [];

  let rawCdcIds = req.body['cdc_ids[]'] ?? req.body.cdc_ids ?? [];
  rawCdcIds = parseIdsArray(rawCdcIds);
  const cdcIds = rawCdcIds
    .map(id => parseInt(id, 10))
    .filter(id => !Number.isNaN(id));

  if (!userId) {
    fileUploads.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
    return res.status(401).json({
      success: false,
      message: 'User authentication required'
    });
  }

  if (!folder_name || !folder_name.trim()) {
    fileUploads.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
    return res.status(400).json({
      success: false,
      message: 'Folder name is required'
    });
  }

  if (!age_group_id) {
    fileUploads.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
    return res.status(400).json({
      success: false,
      message: 'age_group_id is required'
    });
  }

  if (!cdcIds.length) {
    fileUploads.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
    return res.status(400).json({
      success: false,
      message: 'Select at least one CDC to upload'
    });
  }

  if (!fileUploads.length) {
    return res.status(400).json({
      success: false,
      message: 'No files uploaded'
    });
  }

  let connection;
  const createdFilePaths = [];
  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // Validate CDCs and ensure they exist & active
    const validatedCdcMap = new Map();
    for (const cdcId of cdcIds) {
      if (validatedCdcMap.has(cdcId)) continue;
      const [cdcRows] = await connection.query(
        'SELECT cdc_id, status FROM cdc WHERE cdc_id = ?',
        [cdcId]
      );

      if (!cdcRows.length) {
        throw new Error(`CDC ${cdcId} not found`);
      }

      if (cdcRows[0].status && cdcRows[0].status !== 'active') {
        throw new Error(`CDC ${cdcId} is not active`);
      }

      validatedCdcMap.set(cdcId, true);
    }

    // Cache category IDs per CDC to minimize queries
    const categoryCache = new Map();
    const folderName = folder_name.trim();

    const getOrCreateCategory = async (cdcId) => {
      if (categoryCache.has(cdcId)) {
        return categoryCache.get(cdcId);
      }

      const [existing] = await connection.query(
        'SELECT category_id FROM domain_file_categories WHERE category_name = ? AND age_group_id = ? AND cdc_id = ?',
        [folderName, age_group_id, cdcId]
      );

      if (existing.length) {
        categoryCache.set(cdcId, existing[0].category_id);
        return existing[0].category_id;
      }

      const [insertResult] = await connection.query(
        'INSERT INTO domain_file_categories (category_name, cdc_id, age_group_id) VALUES (?, ?, ?)',
        [folderName, cdcId, age_group_id]
      );

      categoryCache.set(cdcId, insertResult.insertId);
      return insertResult.insertId;
    };

    let insertedCount = 0;

    for (const uploadedFile of fileUploads) {
      const sourcePath = uploadedFile.path;
      const sourceExt = path.extname(uploadedFile.originalname);
      const sourceBase = path.basename(uploadedFile.filename, sourceExt);

      for (const cdcId of cdcIds) {
        const categoryId = await getOrCreateCategory(cdcId);
        const uniqueSuffix = crypto.randomUUID();
        const targetFileName = `${sourceBase}-cdc-${cdcId}-${uniqueSuffix}${sourceExt}`;
        const targetPath = path.join(path.dirname(sourcePath), targetFileName);

        fs.copyFileSync(sourcePath, targetPath);
        createdFilePaths.push(targetPath);

        await connection.query(
          `INSERT INTO files 
          (category_id, age_group_id, file_name, file_type, file_path, cdc_id, id) 
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            categoryId,
            age_group_id,
            uploadedFile.originalname,
            uploadedFile.mimetype,
            targetPath,
            cdcId,
            userId
          ]
        );
        insertedCount += 1;
      }
    }

    await connection.commit();

    // Remove the original uploaded temp files since copies were created
    fileUploads.forEach(file => {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    });

    return res.json({
      success: true,
      message: `Uploaded ${fileUploads.length} file(s) to ${cdcIds.length} CDC(s)`,
      insertedRecords: insertedCount
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
    }
    // Cleanup copied files
    createdFilePaths.forEach(filePath => {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
    // Cleanup originals
    fileUploads.forEach(file => {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    });
    console.error('Multi CDC upload error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to upload files to selected CDCs'
    });
  } finally {
    if (connection) connection.release();
  }
});

// POST /api/files - Handles file uploads (available to all if cdc_id is null, or for user's CDC)
router.post('/', upload.single('file_data'), async (req, res) => {
  const { category_id, age_group_id, file_name } = req.body;
  const file = req.file;
  const { id: userId, cdc_id: userCdcId } = req.user || {};

  if (!category_id || !age_group_id || !file_name || !file) {
    if (file) fs.unlinkSync(file.path); // Clean up orphaned file
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields' 
    });
  }

  if (!userId) {
    if (file) fs.unlinkSync(file.path); // Clean up orphaned file
    return res.status(401).json({ 
      success: false, 
      message: 'User authentication required' 
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();

    // If userCdcId is null, upload file available to all (cdc_id = NULL)
    // If userCdcId is provided, upload file for that CDC
    const [result] = await connection.query(
      `INSERT INTO files 
      (category_id, age_group_id, file_name, file_type, file_path, cdc_id, id) 
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        category_id, 
        age_group_id, 
        file_name, 
        file.mimetype, 
        file.path,
        userCdcId || null,
        userId
      ]
    );

    return res.json({
      success: true,
      message: 'File uploaded successfully',
      fileId: result.insertId
    });
  } catch (err) {
    // If there's an error, delete the uploaded file
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

// PUT /api/files/:id - Rename a file (available to all or within user's CDC)
router.put('/:id', async (req, res) => {
  const { id: fileId } = req.params;
  const { file_name } = req.body;
  const { cdc_id: userCdcId } = req.user || {};

  if (!file_name) {
    return res.status(400).json({ success: false, message: 'New file name is required' });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    // If userCdcId is null, allow updating only files available to all (cdc_id IS NULL)
    // If userCdcId is provided, allow updating files available to all OR belonging to that CDC
    let query, params;
    if (!userCdcId) {
      query = 'UPDATE files SET file_name = ? WHERE file_id = ? AND cdc_id IS NULL';
      params = [file_name, fileId];
    } else {
      query = 'UPDATE files SET file_name = ? WHERE file_id = ? AND (cdc_id IS NULL OR cdc_id = ?)';
      params = [file_name, fileId, userCdcId];
    }
    
    const [result] = await connection.query(query, params);

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

// DELETE /api/files/:id - Delete a file (available to all or within user's CDC)
router.delete('/:id', async (req, res) => {
  const { id: fileId } = req.params;
  const { cdc_id: userCdcId } = req.user || {};

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // If userCdcId is null, allow deleting only files available to all (cdc_id IS NULL)
    // If userCdcId is provided, allow deleting files available to all OR belonging to that CDC
    let selectQuery, selectParams, deleteQuery, deleteParams;
    if (!userCdcId) {
      selectQuery = 'SELECT file_path FROM files WHERE file_id = ? AND cdc_id IS NULL';
      selectParams = [fileId];
      deleteQuery = 'DELETE FROM files WHERE file_id = ? AND cdc_id IS NULL';
      deleteParams = [fileId];
    } else {
      selectQuery = 'SELECT file_path FROM files WHERE file_id = ? AND (cdc_id IS NULL OR cdc_id = ?)';
      selectParams = [fileId, userCdcId];
      deleteQuery = 'DELETE FROM files WHERE file_id = ? AND (cdc_id IS NULL OR cdc_id = ?)';
      deleteParams = [fileId, userCdcId];
    }

    // First, get the file path before deleting the record
    const [files] = await connection.query(selectQuery, selectParams);

    if (files.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'File not found or you do not have permission to delete it.' });
    }
    
    const filePath = files[0].file_path;

    // Next, delete the database record
    const [result] = await connection.query(deleteQuery, deleteParams);

    if (result.affectedRows > 0 && filePath && fs.existsSync(filePath)) {
      // Finally, delete the physical file from the server
      fs.unlink(filePath, (err) => {
        if (err) {
          // Log the error but don't block the response, as the DB entry is already gone
          console.error("Failed to delete physical file:", err);
        }
      });
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
// Query param: scope - 'all' (only available to all), 'cdc' (only user's CDC), 'both' (default, both)
router.get('/', async (req, res) => {
  const { cdc_id: userCdcId } = req.user || {};
  const { scope = 'both' } = req.query;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    
    // Build query based on scope parameter
    let query, params;
    
    if (scope === 'all') {
      // Only files available to all
      query = 'SELECT * FROM files WHERE cdc_id IS NULL';
      params = [];
    } else if (scope === 'cdc' && userCdcId) {
      // Only files for user's CDC
      query = 'SELECT * FROM files WHERE cdc_id = ?';
      params = [userCdcId];
    } else if (scope === 'cdc' && !userCdcId) {
      // User has no CDC, so no CDC-specific files
      return res.json({
        success: true,
        files: []
      });
    } else {
      // Default: both (available to all OR user's CDC)
      if (!userCdcId) {
        query = 'SELECT * FROM files WHERE cdc_id IS NULL';
        params = [];
      } else {
        query = 'SELECT * FROM files WHERE cdc_id IS NULL OR cdc_id = ?';
        params = [userCdcId];
      }
    }
    
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

module.exports = router;