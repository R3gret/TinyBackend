  const express = require('express');
  const router = express.Router();
  const db = require('../db');
  const { body, validationResult } = require('express-validator');
  const bcrypt = require('bcryptjs');

  // Enhanced database error handler
  const handleDatabaseError = (err, res) => {
    console.error('Database Error:', {
      message: err.message,
      code: err.code,
      sqlMessage: err.sqlMessage,
      sql: err.sql,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      message: 'Database operation failed',
      ...(process.env.NODE_ENV === 'development' && {
        debug: {
          error: err.message,
          code: err.code,
          sql: err.sql
        }
      })
    });
  };

  // Helper function to validate CDC data
  const validateCDCData = (data) => {
    const { name, region, province, municipality, barangay } = data;
    const missingFields = [];
    
    if (!name) missingFields.push('name');
    if (!region) missingFields.push('region');
    if (!province) missingFields.push('province');
    if (!municipality) missingFields.push('municipality');
    if (!barangay) missingFields.push('barangay');

    return missingFields;
  };


  // Add this helper function at the top
const withConnection = async (callback) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    return await callback(connection);
  } finally {
    if (connection) await connection.release();
  }
};

// Admin Users Endpoints
router.get('/admins', async (req, res) => {
  try {
    const admins = await withConnection(async (connection) => {
      const [results] = await connection.query(
        `SELECT id, username, type, cdc_id 
         FROM users 
         WHERE type = 'president'`
      );
      return results;
    });

    res.json({ 
      success: true,
      data: admins 
    });
  } catch (err) {
    console.error('Admin fetch error:', {
      error: err.message,
      sql: err.sql,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch admin users',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

router.get('/admins/search', async (req, res) => {
  const { query } = req.query;

  if (!query?.trim()) {
    return res.status(400).json({
      success: false,
      message: 'Search query is required'
    });
  }

  try {
    const admins = await withConnection(async (connection) => {
      const [results] = await connection.query(
        `SELECT id, username, type, cdc_id 
         FROM users 
         WHERE type = 'president' AND username LIKE ?`,
        [`%${query}%`]
      );
      return results;
    });

    res.json({ 
      success: true,
      data: admins 
    });
  } catch (err) {
    console.error('Admin search error:', {
      error: err.message,
      sql: err.sql,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
    res.status(500).json({ 
      success: false,
      message: 'Failed to search admin users',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

router.put('/users/cdc/:id', [
  body('username').trim().isLength({ min: 3 }).optional(),
  body('type').isIn(['admin', 'worker', 'parent', 'president']).optional(),
  body('cdc_id').isInt().optional()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      message: 'Validation failed',
      errors: errors.array() 
    });
  }

  try {
    const { username, type, password, cdc_id } = req.body;
    const userId = req.params.id;
    
    await withConnection(async (connection) => {
      await connection.beginTransaction();

      try {
        // Check if user exists
        const [userCheck] = await connection.query(
          'SELECT * FROM users WHERE id = ?', 
          [userId]
        );
        
        if (userCheck.length === 0) {
          throw new Error('User not found');
        }

        // Check for duplicate username if changed
        if (username && username !== userCheck[0].username) {
          const [existingUsers] = await connection.query(
            'SELECT id FROM users WHERE username = ? AND id != ?', 
            [username, userId]
          );

          if (existingUsers.length > 0) {
            throw new Error('Username already in use');
          }
        }

        // Handle password update if provided
        let hashedPassword = userCheck[0].password;
        if (password) {
          if (password.length < 8) {
            throw new Error('Password must be at least 8 characters');
          }
          hashedPassword = await bcrypt.hash(password, 10);
        }

        // Update user
        const [results] = await connection.query(
          'UPDATE users SET username = ?, type = ?, password = ? WHERE id = ?',
          [
            username || userCheck[0].username,
            type || userCheck[0].type,
            hashedPassword,
            userId
          ]
        );

        if (results.affectedRows === 0) {
          throw new Error('Failed to update user');
        }

        // Handle CDC association
        if (type === 'president') {
          if (!cdc_id) {
            throw new Error('CDC ID is required for president');
          }
          
          // Verify CDC exists
          const [cdcCheck] = await connection.query(
            'SELECT cdc_id FROM cdc WHERE cdc_id = ?',
            [cdc_id]
          );
          
          if (cdcCheck.length === 0) {
            throw new Error('CDC not found');
          }

          // Update CDC association
          await connection.query(
            'UPDATE users SET cdc_id = ? WHERE id = ?',
            [cdc_id, userId]
          );
        } else {
          // Remove CDC association if changing from president to another type
          await connection.query(
            'UPDATE users SET cdc_id = NULL WHERE id = ?',
            [userId]
          );
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        throw err;
      }
    });

    res.json({ 
      success: true,
      message: 'User updated successfully'
    });
  } catch (err) {
    const status = err.message === 'User not found' || err.message === 'CDC not found' ? 404 : 400;
    res.status(status).json({ 
      success: false, 
      message: err.message,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

router.get('/preslist', async (req, res) => {
  try {
    const { search } = req.query;
    console.log('Fetching admin users with search:', search); // Debug log
    
    const users = await withConnection(async (connection) => {
      let query = 'SELECT id, username, type, profile_pic FROM users WHERE type = "admin"';
      const params = [];
      
      if (search) {
        query += ' AND username LIKE ?';
        params.push(`%${search}%`);
      }
      
      console.log('Executing query:', query, params); // Debug log
      const [results] = await connection.query(query, params);
      return results;
    });

    console.log('Found users:', users); // Debug log
    res.json({ success: true, users });
  } catch (err) {
    console.error('Error in /preslist:', err); // Detailed error log
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch admin users',
      error: err.message // Include actual error message
    });
  }
});

  // Create CDC endpoint
  router.post('/', async (req, res) => {
    const missingFields = validateCDCData(req.body);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        missingFields
      });
    }

    const { name, region, province, municipality, barangay } = req.body;
    let connection;

    try {
      connection = await db.promisePool.getConnection();
      await connection.beginTransaction();

      // Insert location
      const [locationResults] = await connection.query(
        `INSERT INTO cdc_location 
        (Region, province, municipality, barangay) 
        VALUES (?, ?, ?, ?)`,
        [region, province, municipality, barangay]
      );

      const locationId = locationResults.insertId;

      // Insert CDC with name
      const [cdcResults] = await connection.query(
        `INSERT INTO cdc (location_id, name) VALUES (?, ?)`,
        [locationId, name]
      );

      await connection.commit();
      
      // Get the full created CDC data
      const [newCDC] = await connection.query(
        `SELECT c.cdc_id as cdcId, c.name, cl.Region as region, 
                cl.province, cl.municipality, cl.barangay
        FROM cdc c
        JOIN cdc_location cl ON c.location_id = cl.location_id
        WHERE c.cdc_id = ?`,
        [cdcResults.insertId]
      );

      return res.status(201).json({
        success: true,
        message: 'CDC created successfully',
        data: newCDC[0]
      });

    } catch (err) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackErr) {
          console.error('Rollback Error:', rollbackErr);
        }
      }
      handleDatabaseError(err, res);
    } finally {
      if (connection) {
        try {
          await connection.release();
        } catch (releaseErr) {
          console.error('Connection Release Error:', releaseErr);
        }
      }
    }
  });

  // Get all CDCs with filtering and pagination
  router.get('/', async (req, res) => {
    const { province, municipality, barangay, page = 1, limit = 20 } = req.query;
    
    try {
      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const offset = (pageNum - 1) * limitNum;

      if (isNaN(pageNum) || isNaN(limitNum) || pageNum < 1 || limitNum < 1) {
        return res.status(400).json({
          success: false,
          message: 'Invalid pagination parameters'
        });
      }

      let connection;
      try {
        connection = await db.promisePool.getConnection();

        // Base query with all fields
        let query = `
          SELECT 
            c.cdc_id as cdcId,
            c.name,
            cl.Region as region,
            cl.province,
            cl.municipality,
            cl.barangay
          FROM cdc c
          JOIN cdc_location cl ON c.location_id = cl.location_id
        `;
        
        const conditions = [];
        const params = [];
        
        // Add filters if provided
        if (province) {
          conditions.push('cl.province LIKE ?');
          params.push(`%${province}%`);
        }
        
        if (municipality) {
          conditions.push('cl.municipality LIKE ?');
          params.push(`%${municipality}%`);
        }
        
        if (barangay) {
          conditions.push('cl.barangay LIKE ?');
          params.push(`%${barangay}%`);
        }
        
        if (conditions.length > 0) {
          query += ' WHERE ' + conditions.join(' AND ');
        }
        
        query += ' ORDER BY cl.province, cl.municipality, cl.barangay';
        
        // Get total count (optimized version)
        const countQuery = `
          SELECT COUNT(*) as total 
          FROM cdc c
          JOIN cdc_location cl ON c.location_id = cl.location_id
          ${conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''}
        `;
        
        const [countResult] = await connection.query(countQuery, params);
        const total = countResult[0].total;

        // Get paginated results
        const [results] = await connection.query(
          query + ` LIMIT ? OFFSET ?`,
          [...params, limitNum, offset]
        );
        
        res.json({ 
          success: true,
          data: results,
          pagination: {
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum)
          }
        });
        
      } catch (err) {
        console.error('Database error:', {
          query: err.sql,
          message: err.message,
          stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
        res.status(500).json({
          success: false,
          message: 'Failed to fetch CDC data',
          error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      } finally {
        if (connection) await connection.release();
      }
    } catch (err) {
      console.error('Unexpected error:', err);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  });

  // Get single CDC by ID
  router.get('/:id', async (req, res) => {
    const { id } = req.params;

    let connection;
    try {
      connection = await db.promisePool.getConnection();
      
      const [results] = await connection.query(
        `SELECT c.cdc_id as cdcId, c.name, cl.Region as region, 
                cl.province, cl.municipality, cl.barangay
        FROM cdc c
        JOIN cdc_location cl ON c.location_id = cl.location_id
        WHERE c.cdc_id = ?`,
        [id]
      );
      
      if (results.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'CDC not found'
        });
      }
      
      res.json({
        success: true,
        data: results[0]
      });
      
    } catch (err) {
      console.error('Database error:', err);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch CDC',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    } finally {
      if (connection) await connection.release();
    }
  });

  // Update CDC endpoint
  router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const missingFields = validateCDCData(req.body);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        missingFields
      });
    }

    const { name, region, province, municipality, barangay } = req.body;
    let connection;

    try {
      connection = await db.promisePool.getConnection();
      await connection.beginTransaction();

      // Get the location_id for this CDC
      const [cdcResults] = await connection.query(
        'SELECT location_id FROM cdc WHERE cdc_id = ?',
        [id]
      );

      if (cdcResults.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'CDC not found'
        });
      }

      const locationId = cdcResults[0].location_id;

      // Update CDC name
      await connection.query(
        'UPDATE cdc SET name = ? WHERE cdc_id = ?',
        [name, id]
      );

      // Update location
      await connection.query(
        `UPDATE cdc_location SET 
          Region = ?,
          province = ?,
          municipality = ?,
          barangay = ?
        WHERE location_id = ?`,
        [region, province, municipality, barangay, locationId]
      );

      await connection.commit();
      
      // Get the updated CDC data
      const [updatedCDC] = await connection.query(
        `SELECT c.cdc_id as cdcId, c.name, cl.Region as region, 
                cl.province, cl.municipality, cl.barangay
        FROM cdc c
        JOIN cdc_location cl ON c.location_id = cl.location_id
        WHERE c.cdc_id = ?`,
        [id]
      );
      
      res.json({
        success: true,
        message: 'CDC updated successfully',
        data: updatedCDC[0]
      });

    } catch (err) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackErr) {
          console.error('Rollback Error:', rollbackErr);
        }
      }
      handleDatabaseError(err, res);
    } finally {
      if (connection) {
        try {
          await connection.release();
        } catch (releaseErr) {
          console.error('Connection Release Error:', releaseErr);
        }
      }
    }
  });

  // Delete CDC endpoint
  router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    let connection;

    try {
      connection = await db.promisePool.getConnection();
      await connection.beginTransaction();

      // Get the location_id for this CDC
      const [cdcResults] = await connection.query(
        'SELECT location_id FROM cdc WHERE cdc_id = ?',
        [id]
      );

      if (cdcResults.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'CDC not found'
        });
      }

      const locationId = cdcResults[0].location_id;

      // Delete CDC record
      await connection.query(
        'DELETE FROM cdc WHERE cdc_id = ?',
        [id]
      );

      // Delete location record
      await connection.query(
        'DELETE FROM cdc_location WHERE location_id = ?',
        [locationId]
      );

      await connection.commit();
      
      res.json({
        success: true,
        message: 'CDC deleted successfully'
      });

    } catch (err) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackErr) {
          console.error('Rollback Error:', rollbackErr);
        }
      }
      handleDatabaseError(err, res);
    } finally {
      if (connection) {
        try {
          await connection.release();
        } catch (releaseErr) {
          console.error('Connection Release Error:', releaseErr);
        }
      }
    }
  });

  // User-CDC Association Endpoints (simplified version for your schema)

  // Associate user with CDC (or update existing association)
  router.post('/:cdcId/users', async (req, res) => {
    const { cdcId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    let connection;
    try {
      connection = await db.promisePool.getConnection();
      await connection.beginTransaction();

      // Check if CDC exists
      const [cdcCheck] = await connection.query(
        'SELECT cdc_id FROM cdc WHERE cdc_id = ?',
        [cdcId]
      );

      if (cdcCheck.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'CDC not found'
        });
      }

      // Check if user exists
      const [userCheck] = await connection.query(
        'SELECT id FROM users WHERE id = ?',
        [userId]
      );

      if (userCheck.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Update user's cdc_id directly
      await connection.query(
        'UPDATE users SET cdc_id = ? WHERE id = ?',
        [cdcId, userId]
      );

      await connection.commit();

      res.status(200).json({
        success: true,
        message: 'User successfully associated with CDC'
      });

    } catch (err) {
      if (connection) await connection.rollback();
      handleDatabaseError(err, res);
    } finally {
      if (connection) await connection.release();
    }
  });

  // Get all users associated with a CDC
  router.get('/:cdcId/users', async (req, res) => {
    const { cdcId } = req.params;

    try {
      const users = await withConnection(async (connection) => {
        const [results] = await connection.query(
          `SELECT id, username, type 
          FROM users
          WHERE cdc_id = ?`,
          [cdcId]
        );
        return results;
      });

      res.json({ success: true, users });
    } catch (err) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch CDC users',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  // Remove user from CDC (set cdc_id to NULL)
  router.delete('/:cdcId/users/:userId', async (req, res) => {
    const { cdcId, userId } = req.params;

    let connection;
    try {
      connection = await db.promisePool.getConnection();
      await connection.beginTransaction();

      // Check if user exists and is associated with this CDC
      const [userCheck] = await connection.query(
        'SELECT id FROM users WHERE id = ? AND cdc_id = ?',
        [userId, cdcId]
      );

      if (userCheck.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'User not found or not associated with this CDC'
        });
      }

      // Remove association by setting cdc_id to NULL
      await connection.query(
        'UPDATE users SET cdc_id = NULL WHERE id = ?',
        [userId]
      );

      await connection.commit();

      res.json({
        success: true,
        message: 'User removed from CDC successfully'
      });

    } catch (err) {
      if (connection) await connection.rollback();
      handleDatabaseError(err, res);
    } finally {
      if (connection) await connection.release();
    }
  });

  // Search CDCs by name or location (unchanged from previous version)
  router.get('/search', async (req, res) => {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required'
      });
    }

    try {
      const cdcs = await withConnection(async (connection) => {
        const searchTerm = `%${query}%`;
        const [results] = await connection.query(
          `SELECT c.cdc_id as cdcId, c.name, cl.Region as region, 
                  cl.province, cl.municipality, cl.barangay
          FROM cdc c
          JOIN cdc_location cl ON c.location_id = cl.location_id
          WHERE c.name LIKE ? OR cl.province LIKE ? OR cl.municipality LIKE ? OR cl.barangay LIKE ?
          LIMIT 20`,
          [searchTerm, searchTerm, searchTerm, searchTerm]
        );
        return results;
      });

      res.json({ success: true, data: cdcs });
    } catch (err) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to search CDCs',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  router.get('/search/name', async (req, res) => {
    const { name } = req.query;

    try {
      const [results] = await db.promisePool.query(
        `SELECT 
          c.cdc_id, 
          c.name,
          l.Region,
          l.province,
          l.municipality,
          l.barangay
        FROM cdc c
        JOIN cdc_location l ON c.location_id = l.location_id
        WHERE c.name LIKE ?`,
        [`%${name}%`]
      );

      res.json({ success: true, data: results });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Search failed' });
    }
  });

  router.post('/presidents', [
    body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('cdc_id').isInt().withMessage('Valid CDC ID is required')
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed',
        errors: errors.array() 
      });
    }

    let connection;
    try {
      connection = await db.promisePool.getConnection();
      await connection.beginTransaction();

      // Use both cdc_id and cdcId for compatibility
      const cdcId = req.body.cdc_id || req.body.cdcId;
      const { username, password } = req.body;

      if (!cdcId) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: 'CDC ID is required'
        });
      }

      // Verify CDC exists - more thorough check
      const [cdcCheck] = await connection.query(
        `SELECT 1 FROM cdc WHERE cdc_id = ? LIMIT 1`,
        [cdcId]
      );

      if (cdcCheck.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'CDC not found',
          details: `CDC with ID ${cdcId} doesn't exist`
        });
      }

      // Check for existing username
      const [existingUser] = await connection.query(
        'SELECT id FROM users WHERE username = ? LIMIT 1',
        [username]
      );
      
      if (existingUser.length > 0) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message: 'Username already exists'
        });
      }

      // Hash password with error handling
      let hashedPassword;
      try {
        hashedPassword = await bcrypt.hash(password, 10);
      } catch (hashError) {
        console.error('Password hashing failed:', hashError);
        await connection.rollback();
        return res.status(500).json({
          success: false,
          message: 'Failed to process password'
        });
      }
      
      // Insert user with explicit field names
      const [insertResults] = await connection.query(
        `INSERT INTO users 
        (username, type, password, cdc_id) 
        VALUES (?, 'president', ?, ?)`,
        [username, hashedPassword, cdcId]
      );

      await connection.commit();
      
      // Get the created user details
      const [newUser] = await connection.query(
        `SELECT id, username, type, cdc_id 
        FROM users WHERE id = ?`,
        [insertResults.insertId]
      );

      return res.status(201).json({ 
        success: true,
        data: newUser[0],
        message: 'President created successfully'
      });

    } catch (err) {
      if (connection) await connection.rollback();
      console.error('President creation error:', {
        error: err.message,
        stack: err.stack,
        sql: err.sql,
        sqlMessage: err.sqlMessage
      });
      
      res.status(500).json({ 
        success: false, 
        message: 'Failed to create president',
        ...(process.env.NODE_ENV === 'development' && {
          error: err.message,
          details: err.sqlMessage
        })
      });
    } finally {
      if (connection) await connection.release();
    }
  });


  module.exports = router;