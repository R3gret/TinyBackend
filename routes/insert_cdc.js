  const express = require('express');
  const router = express.Router();
  const db = require('../db');
  const { body, validationResult } = require('express-validator');
  const bcrypt = require('bcryptjs');
  const authenticate = require('./authMiddleware');

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
         WHERE type = 'president' AND cdc_id IS NULL`
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
  const { search, province, municipality, barangay } = req.query;
  let connection;

  try {
    // Get a connection from the pool
    connection = await db.promisePool.getConnection();
    
    let query = `
      SELECT 
        u.id, 
        u.username, 
        u.profile_pic,
        cl.Region as region,
        cl.province,
        cl.municipality,
        cl.barangay
      FROM users u
      LEFT JOIN cdc c ON u.cdc_id = c.cdc_id AND c.status = 'active'
      LEFT JOIN cdc_location cl ON c.location_id = cl.location_id
      WHERE u.type = 'president'
    `;
    
    const params = [];
    
    // Add search filter
    if (search) {
      query += ` AND (u.username LIKE ? OR cl.province LIKE ? OR cl.municipality LIKE ? OR cl.barangay LIKE ?)`;
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam, searchParam);
    }
    
    // Add location filters
    if (province) {
      query += ` AND cl.province = ?`;
      params.push(province);
    }
    
    if (municipality) {
      query += ` AND cl.municipality = ?`;
      params.push(municipality);
    }
    
    if (barangay) {
      query += ` AND cl.barangay = ?`;
      params.push(barangay);
    }

    // Execute query using the connection
    const [rows] = await connection.query(query, params);

    // Format response
    const users = rows.map(row => ({
      id: row.id,
      username: row.username,
      profile_pic: row.profile_pic,
      cdc_location: {
        region: row.region,
        province: row.province,
        municipality: row.municipality,
        barangay: row.barangay
      }
    }));

    res.json({
      success: true,
      users
    });

  } catch (error) {
    console.error('Error fetching president list:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch president list',
      error: error.message
    });
  } finally {
    // Always release the connection back to the pool
    if (connection) {
      try {
        await connection.release();
      } catch (releaseErr) {
        console.error('Error releasing connection:', releaseErr);
      }
    }
  }
});


  // Create CDC endpoint
  router.post('/', authenticate, async (req, res) => {
    const missingFields = validateCDCData(req.body);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        missingFields
      });
    }

    const { name, region, province, municipality, barangay, cd_worker_id } = req.body;
    const userId = req.user?.id;
    const userType = req.user?.type;
    let connection;

    try {
      connection = await db.promisePool.getConnection();
      await connection.beginTransaction();

      // If user is a focal person, validate location matches their profile
      if (userType === 'focal') {
        const [userInfo] = await connection.query(
          `SELECT address FROM user_other_info WHERE user_id = ?`,
          [userId]
        );

        if (userInfo.length && userInfo[0].address) {
          // Parse address: "Barangay, Municipality, Province, Region"
          const addressParts = userInfo[0].address.split(',').map(part => part.trim());
          
          if (addressParts.length >= 3) {
            const userMunicipality = addressParts[1];
            const userProvince = addressParts[2];
            const userRegion = addressParts.length >= 4 ? addressParts[3] : null;

            // Validate location matches
            if (userProvince && userProvince !== province) {
              await connection.rollback();
              return res.status(400).json({
                success: false,
                message: 'CDC location must match your assigned region, province, and municipality',
                error: 'LOCATION_MISMATCH'
              });
            }

            if (userMunicipality && userMunicipality !== municipality) {
              await connection.rollback();
              return res.status(400).json({
                success: false,
                message: 'CDC location must match your assigned region, province, and municipality',
                error: 'LOCATION_MISMATCH'
              });
            }

            if (userRegion && userRegion !== region) {
              await connection.rollback();
              return res.status(400).json({
                success: false,
                message: 'CDC location must match your assigned region, province, and municipality',
                error: 'LOCATION_MISMATCH'
              });
            }
          }
        }
      }

      // Insert location
      const [locationResults] = await connection.query(
        `INSERT INTO cdc_location 
        (Region, province, municipality, barangay) 
        VALUES (?, ?, ?, ?)`,
        [region, province, municipality, barangay]
      );

      const locationId = locationResults.insertId;

      // Insert CDC with name and active status
      const [cdcResults] = await connection.query(
        `INSERT INTO cdc (location_id, name, status) VALUES (?, ?, 'active')`,
        [locationId, name]
      );
      const newCdcId = cdcResults.insertId;

      // If a cd_worker_id is provided, associate them with the new CDC
      if (cd_worker_id) {
        // Check if the user is a worker and has no CDC assigned
        const [workers] = await connection.query(
          'SELECT * FROM users WHERE id = ? AND type = \'worker\' AND (cdc_id IS NULL OR cdc_id = 0)',
          [cd_worker_id]
        );

        if (workers.length === 0) {
          await connection.rollback();
          return res.status(404).json({
            success: false,
            message: 'CD worker not found or invalid',
            error: 'WORKER_NOT_FOUND'
          });
        }

        const worker = workers[0];
        if (worker.cdc_id) {
          await connection.rollback();
          return res.status(409).json({
            success: false,
            message: 'CD worker is already assigned to another CDC',
            error: 'WORKER_ALREADY_ASSIGNED'
          });
        }

        // Assign the new CDC to the CD worker
        await connection.query(
          'UPDATE users SET cdc_id = ? WHERE id = ?',
          [newCdcId, cd_worker_id]
        );
      }

      await connection.commit();
      
      // Get the full created CDC data
      const [newCDC] = await connection.query(
        `SELECT c.cdc_id as cdcId, c.name, c.status, cl.Region as region, 
                cl.province, cl.municipality, cl.barangay
        FROM cdc c
        JOIN cdc_location cl ON c.location_id = cl.location_id
        WHERE c.cdc_id = ?`,
        [newCdcId]
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

  // Get unassigned CD workers endpoint - MUST be before /:id and other GET routes
  router.get('/workers/unassigned', authenticate, async (req, res) => {
    let connection;
    try {
      connection = await db.promisePool.getConnection();
      
      // Get unassigned workers (type='worker' and cdc_id IS NULL)
      // Note: user_other_info may not have first_name/last_name, so we use full_name
      const [workers] = await connection.query(
        `SELECT 
          u.id,
          u.username,
          u.email,
          u.type,
          u.cdc_id,
          uoi.full_name
        FROM users u
        LEFT JOIN user_other_info uoi ON u.id = uoi.user_id
        WHERE u.type = 'worker' 
          AND (u.cdc_id IS NULL OR u.cdc_id = 0)
        ORDER BY u.username`
      );

      // Format the response to match expected structure
      // Parse full_name into first_name and last_name if available
      const formattedWorkers = workers.map(worker => {
        let first_name = null;
        let last_name = null;
        
        if (worker.full_name) {
          const nameParts = worker.full_name.trim().split(/\s+/);
          if (nameParts.length >= 2) {
            first_name = nameParts[0];
            last_name = nameParts.slice(1).join(' ');
          } else if (nameParts.length === 1) {
            first_name = nameParts[0];
          }
        }
        
        return {
          id: worker.id,
          username: worker.username,
          first_name: first_name,
          last_name: last_name,
          email: worker.email || null,
          type: worker.type,
          cdc_id: worker.cdc_id
        };
      });

      return res.json({
        success: true,
        data: formattedWorkers
      });
    } catch (err) {
      console.error('Error fetching unassigned workers:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch unassigned workers',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined,
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
      });
    } finally {
      if (connection) await connection.release();
    }
  });

  // Get all CDCs with filtering and pagination
  // Automatically filters by user's province and municipality from their profile
  router.get('/', authenticate, async (req, res) => {
    const { barangay, page = 1, limit = 20 } = req.query;
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }
    
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

        // Get user's address to extract province and municipality
        const [userInfo] = await connection.query(
          `SELECT address FROM user_other_info WHERE user_id = ?`,
          [userId]
        );

        if (!userInfo.length || !userInfo[0].address) {
          return res.status(400).json({
            success: false,
            message: 'User address not found. Please update your profile with address information.'
          });
        }

        // Parse address: "Barangay, Municipality, Province, Region"
        const addressParts = userInfo[0].address.split(',').map(part => part.trim());
        
        if (addressParts.length < 3) {
          return res.status(400).json({
            success: false,
            message: 'Invalid address format. Please update your profile with a complete address (Barangay, Municipality, Province, Region).'
          });
        }

        // Extract municipality (index 1) and province (index 2)
        const userMunicipality = addressParts[1];
        const userProvince = addressParts[2];

        // Base query with all fields
        let query = `
          SELECT 
            c.cdc_id as cdcId,
            c.name,
            c.status,
            cl.Region as region,
            cl.province,
            cl.municipality,
            cl.barangay
          FROM cdc c
          JOIN cdc_location cl ON c.location_id = cl.location_id
        `;
        
        const conditions = [];
        const params = [];
        
        // Always filter by active status
        conditions.push('c.status = ?');
        params.push('active');
        
        // Always filter by user's province and municipality
        conditions.push('cl.province = ?');
        params.push(userProvince);
        
        conditions.push('cl.municipality = ?');
        params.push(userMunicipality);
        
        // Optional barangay filter
        if (barangay) {
          conditions.push('cl.barangay = ?');
          params.push(barangay);
        }
        
        query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY cl.barangay, c.name';
        
        // Get total count
        const countQuery = `
          SELECT COUNT(*) as total 
          FROM cdc c
          JOIN cdc_location cl ON c.location_id = cl.location_id
          WHERE ${conditions.join(' AND ')}
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

  // Get all CDCs including deactivated ones (for admin purposes)
  router.get('/all', authenticate, async (req, res) => {
    const { barangay, status, page = 1, limit = 20 } = req.query;
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }
    
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

        // Get user's address to extract province and municipality
        const [userInfo] = await connection.query(
          `SELECT address FROM user_other_info WHERE user_id = ?`,
          [userId]
        );

        if (!userInfo.length || !userInfo[0].address) {
          return res.status(400).json({
            success: false,
            message: 'User address not found. Please update your profile with address information.'
          });
        }

        // Parse address: "Barangay, Municipality, Province, Region"
        const addressParts = userInfo[0].address.split(',').map(part => part.trim());
        
        if (addressParts.length < 3) {
          return res.status(400).json({
            success: false,
            message: 'Invalid address format. Please update your profile with a complete address (Barangay, Municipality, Province, Region).'
          });
        }

        // Extract municipality (index 1) and province (index 2)
        const userMunicipality = addressParts[1];
        const userProvince = addressParts[2];

        // Base query with all fields including status
        let query = `
          SELECT 
            c.cdc_id as cdcId,
            c.name,
            c.status,
            cl.Region as region,
            cl.province,
            cl.municipality,
            cl.barangay
          FROM cdc c
          JOIN cdc_location cl ON c.location_id = cl.location_id
        `;
        
        const conditions = [];
        const params = [];
        
        // Filter by status if provided (active, deactivated, or all)
        if (status && (status === 'active' || status === 'deactivated')) {
          conditions.push('c.status = ?');
          params.push(status);
        }
        // If no status filter, show all (both active and deactivated)
        
        // Always filter by user's province and municipality
        conditions.push('cl.province = ?');
        params.push(userProvince);
        
        conditions.push('cl.municipality = ?');
        params.push(userMunicipality);
        
        // Optional barangay filter
        if (barangay) {
          conditions.push('cl.barangay = ?');
          params.push(barangay);
        }
        
        query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY c.status, cl.barangay, c.name';
        
        // Get total count
        const countQuery = `
          SELECT COUNT(*) as total 
          FROM cdc c
          JOIN cdc_location cl ON c.location_id = cl.location_id
          WHERE ${conditions.join(' AND ')}
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

  // Get single CDC by ID - This must come AFTER specific routes like /workers/unassigned
  router.get('/:id', async (req, res) => {
    const { id } = req.params;

    let connection;
    try {
      connection = await db.promisePool.getConnection();
      
      const [results] = await connection.query(
        `SELECT c.cdc_id as cdcId, c.name, c.status, cl.Region as region, 
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
        `SELECT c.cdc_id as cdcId, c.name, c.status, cl.Region as region, 
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

      // Check if CDC is already deactivated
      const [cdcStatus] = await connection.query(
        'SELECT status FROM cdc WHERE cdc_id = ?',
        [id]
      );

      if (cdcStatus[0].status === 'deactivated') {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: 'CDC is already deactivated'
        });
      }

      // Soft delete: Set status to 'deactivated' instead of deleting
      await connection.query(
        'UPDATE cdc SET status = ? WHERE cdc_id = ?',
        ['deactivated', id]
      );

      await connection.commit();
      
      res.json({
        success: true,
        message: 'CDC deactivated successfully'
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
          `SELECT c.cdc_id as cdcId, c.name, c.status, cl.Region as region, 
                  cl.province, cl.municipality, cl.barangay
          FROM cdc c
          JOIN cdc_location cl ON c.location_id = cl.location_id
          WHERE c.status = 'active' 
            AND (c.name LIKE ? OR cl.province LIKE ? OR cl.municipality LIKE ? OR cl.barangay LIKE ?)
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
          c.status,
          l.Region,
          l.province,
          l.municipality,
          l.barangay
        FROM cdc c
        JOIN cdc_location l ON c.location_id = l.location_id
        WHERE c.status = 'active' AND c.name LIKE ?`,
        [`%${name}%`]
      );

      res.json({ success: true, data: results });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Search failed' });
    }
  });

  router.post('/presidents', [
    body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
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

      const { username, password } = req.body;

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
        (username, type, password) 
        VALUES (?, 'president', ?)`,
        [username, hashedPassword]
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