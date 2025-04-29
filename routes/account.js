const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');

// Enhanced promise pool wrapper with transaction support
const withConnection = async (callback) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    return await callback(connection);
  } catch (err) {
    console.error('Database error:', err);
    throw err;
  } finally {
    if (connection) connection.release();
  }
};

// Get all users with filtering
router.get('/', async (req, res) => {
  try {
    const { type, search } = req.query;
    
    const users = await withConnection(async (connection) => {
      let query = 'SELECT id, username, type, profile_pic FROM users WHERE 1=1';
      const params = [];
      
      if (type) {
        query += ' AND type = ?';
        params.push(type);
      }
      
      if (search) {
        query += ' AND username LIKE ?';
        params.push(`%${search}%`);
      }
      
      const [results] = await connection.query(query, params);
      return results;
    });

    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch users',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Get user by ID
router.get('/:id', async (req, res) => {
  try {
    const user = await withConnection(async (connection) => {
      const query = 'SELECT id, username, type, profile_pic FROM users WHERE id = ?';
      const [results] = await connection.query(query, [req.params.id]);
      
      if (results.length === 0) {
        throw new Error('User not found');
      }
      return results[0];
    });

    res.json({ success: true, user });
  } catch (err) {
    const status = err.message === 'User not found' ? 404 : 500;
    res.status(status).json({ 
      success: false, 
      message: err.message,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Create a new user with validation
router.post('/', [
  body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('type').isIn(['admin', 'worker', 'parent', 'president']).withMessage('Invalid user type'),
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

  try {
    const { username, type, password } = req.body;
    
    const userId = await withConnection(async (connection) => {
      // Start transaction
      await connection.beginTransaction();

      try {
        // Check if username exists
        const [checkResults] = await connection.query(
          'SELECT id FROM users WHERE username = ?', 
          [username]
        );
        
        if (checkResults.length > 0) {
          throw new Error('Username already in use');
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Insert new user
        const [insertResults] = await connection.query(
          'INSERT INTO users (username, type, password, profile_pic) VALUES (?, ?, ?, ?)',
          [username, type, hashedPassword, req.body.profile_pic || 'default-profile.png']
        );
        
        // Commit transaction
        await connection.commit();
        return insertResults.insertId;
      } catch (err) {
        // Rollback on error
        await connection.rollback();
        throw err;
      }
    });

    res.status(201).json({ 
      success: true,
      userId,
      message: 'User created successfully'
    });
  } catch (err) {
    res.status(400).json({ 
      success: false, 
      message: err.message,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Update a user with validation
router.put('/:id', [
  body('username').trim().isLength({ min: 3 }).optional(),
  body('type').isIn(['admin', 'worker', 'parent', 'president']).optional()
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
    const { username, type, profile_pic, password } = req.body;
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
          'UPDATE users SET username = ?, type = ?, profile_pic = ?, password = ? WHERE id = ?',
          [
            username || userCheck[0].username,
            type || userCheck[0].type,
            profile_pic || userCheck[0].profile_pic,
            hashedPassword,
            userId
          ]
        );

        if (results.affectedRows === 0) {
          throw new Error('Failed to update user');
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
    const status = err.message === 'User not found' ? 404 : 400;
    res.status(status).json({ 
      success: false, 
      message: err.message,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Delete a user
router.delete('/:id', async (req, res) => {
  try {
    await withConnection(async (connection) => {
      await connection.beginTransaction();

      try {
        // First delete associated info
        await connection.query(
          'DELETE FROM user_other_info WHERE user_id = ?',
          [req.params.id]
        );

        // Then delete user
        const [results] = await connection.query(
          'DELETE FROM users WHERE id = ?',
          [req.params.id]
        );

        if (results.affectedRows === 0) {
          throw new Error('User not found');
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        throw err;
      }
    });

    res.json({ 
      success: true,
      message: 'User deleted successfully'
    });
  } catch (err) {
    const status = err.message === 'User not found' ? 404 : 500;
    res.status(status).json({ 
      success: false, 
      message: err.message,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Get all user types
router.get('/types/all', async (req, res) => {
  try {
    const types = await withConnection(async (connection) => {
      const [results] = await connection.query('SELECT DISTINCT type FROM users');
      return results.map(row => row.type);
    });

    res.json({ success: true, types });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch user types',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Get user by ID with additional info
router.get('/:id/details', async (req, res) => {
  try {
    const user = await withConnection(async (connection) => {
      const [results] = await connection.query(`
        SELECT 
          u.*,
          o.full_name,
          o.email AS contact_email,
          o.phone,
          o.address,
          o.organization,
          o.website,
          o.social_media
        FROM users u
        LEFT JOIN user_other_info o ON u.id = o.user_id
        WHERE u.id = ?
      `, [req.params.id]);

      if (results.length === 0) {
        throw new Error('User not found');
      }

      const userData = {
        ...results[0],
        other_info: {
          full_name: results[0].full_name,
          email: results[0].contact_email,
          phone: results[0].phone,
          address: results[0].address,
          organization: results[0].organization,
          website: results[0].website,
          social_media: results[0].social_media
        }
      };

      // Clean up duplicated fields
      [
        'full_name', 'contact_email', 'phone', 'address',
        'organization', 'website', 'social_media'
      ].forEach(field => delete userData[field]);

      return userData;
    });

    res.json({ success: true, user });
  } catch (err) {
    const status = err.message === 'User not found' ? 404 : 500;
    res.status(status).json({ 
      success: false, 
      message: err.message,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// User info routes
const userInfoRouter = express.Router();

userInfoRouter.post('/', [
  body('user_id').isInt().withMessage('Invalid user ID'),
  body('email').isEmail().optional().withMessage('Invalid email format'),
  body('website').isURL().optional().withMessage('Invalid website URL'),
  body('social_media').isString().optional()
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
    const {
      user_id,
      full_name,
      email,
      phone,
      address,
      organization,
      website,
      social_media
    } = req.body;

    await withConnection(async (connection) => {
      await connection.beginTransaction();

      try {
        // Check if user exists
        const [userCheck] = await connection.query(
          'SELECT id FROM users WHERE id = ?',
          [user_id]
        );

        if (userCheck.length === 0) {
          throw new Error('User not found');
        }

        // Check if info already exists
        const [infoCheck] = await connection.query(
          'SELECT user_id FROM user_other_info WHERE user_id = ?',
          [user_id]
        );

        if (infoCheck.length > 0) {
          // Update existing info
          await connection.query(
            `UPDATE user_other_info 
            SET full_name = ?, email = ?, phone = ?, address = ?, 
                organization = ?, website = ?, social_media = ?
            WHERE user_id = ?`,
            [full_name, email, phone, address, organization, website, social_media, user_id]
          );
        } else {
          // Insert new info
          await connection.query(
            `INSERT INTO user_other_info 
            (user_id, full_name, email, phone, address, organization, website, social_media) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id, full_name, email, phone, address, organization, website, social_media]
          );
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        throw err;
      }
    });

    res.status(201).json({ 
      success: true,
      message: 'User info saved successfully'
    });
  } catch (err) {
    const status = err.message === 'User not found' ? 404 : 500;
    res.status(status).json({ 
      success: false, 
      message: err.message,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

router.use('/:userId/info', userInfoRouter);

module.exports = router;