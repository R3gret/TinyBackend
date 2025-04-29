const bcrypt = require('bcryptjs');
const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all users
router.get('/', async (req, res) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query('SELECT id, username, type FROM users');
    res.json(results);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  } finally {
    if (connection) connection.release();
  }
});

// Search users
router.get('/search', async (req, res) => {
  const { query } = req.query;
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query(
      'SELECT id, username, type FROM users WHERE username LIKE ?',
      [`%${query}%`]
    );
    res.json(results);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: 'Failed to search users' });
  } finally {
    if (connection) connection.release();
  }
});

// Create user with hashed password
router.post('/', async (req, res) => {
  const { username, password, type = 'user' } = req.body;
  let connection;

  // Validation
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    connection = await db.promisePool.getConnection();
    
    // Check if username exists
    const [existingUsers] = await connection.query(
      'SELECT id FROM users WHERE username = ?', 
      [username]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new user
    const [result] = await connection.query(
      'INSERT INTO users (username, password, type) VALUES (?, ?, ?)',
      [username, hashedPassword, type]
    );

    res.status(201).json({
      id: result.insertId,
      username,
      type
    });
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/user-info', [
  body('user_id').isInt().withMessage('Valid user ID required'),
  body('full_name').trim().isLength({ min: 2 }).withMessage('Full name must be at least 2 characters'),
  body('email').isEmail().withMessage('Invalid email format'),
  body('phone').isMobilePhone().withMessage('Invalid phone number'),
  body('address').isString().withMessage('Address must be a string'),
  body('organization').optional().isString().withMessage('Organization must be a string'),
  body('website').optional().isURL().withMessage('Website must be a valid URL'),
  body('social_media').optional().isString().withMessage('Social media must be a string')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { user_id, full_name, email, phone, address, organization, website, social_media } = req.body;

  try {
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
          throw new Error('User info already exists');
        }

        // Insert full user info
        await connection.query(
          `INSERT INTO user_other_info 
           (user_id, full_name, email, phone, address, organization, website, social_media) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [user_id, full_name, email, phone, address, organization, website, social_media]
        );

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
    const status = err.message === 'User not found' ? 404 :
                   err.message === 'User info already exists' ? 409 : 500;
    res.status(status).json({
      success: false,
      message: err.message,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Get user password (Note: This should be secured in production)
router.get('/:id/password', async (req, res) => {
  const { id } = req.params;
  let connection;
  
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query(
      'SELECT password FROM users WHERE id = ?', 
      [id]
    );
    
    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ password: results[0].password });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: 'Failed to fetch password' });
  } finally {
    if (connection) connection.release();
  }
});

// Delete user account
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    const [result] = await connection.query(
      'DELETE FROM users WHERE id = ?', 
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  } finally {
    if (connection) connection.release();
  }
});



// Edit user account with secure password handling
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { username, password, type } = req.body;
  let connection;

  // Validation
  if (!username || !type) {
    return res.status(400).json({ error: 'Username and type are required' });
  }

  try {
    connection = await db.promisePool.getConnection();
    
    // Get current user data
    const [users] = await connection.query(
      'SELECT * FROM users WHERE id = ?', 
      [id]
    );
    const currentUser = users[0];

    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    let hashedPassword = currentUser.password;
    
    // Only update password if a new one was provided
    if (password && password.trim() !== '') {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      
      // Verify if the password is different before hashing
      const isSamePassword = await bcrypt.compare(password, currentUser.password);
      if (!isSamePassword) {
        hashedPassword = await bcrypt.hash(password, 10);
      }
    }

    // Check for duplicate username
    if (username !== currentUser.username) {
      const [existingUsers] = await connection.query(
        'SELECT id FROM users WHERE username = ? AND id != ?', 
        [username, id]
      );

      if (existingUsers.length > 0) {
        return res.status(400).json({ error: 'Username already exists' });
      }
    }

    // Update user
    const [result] = await connection.query(
      'UPDATE users SET username = ?, password = ?, type = ? WHERE id = ?',
      [username, hashedPassword, type, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  } finally {
    if (connection) connection.release();
  }
});

// User info routes (separate endpoint)
const userInfoRouter = express.Router();

userInfoRouter.post('/', async (req, res) => {
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
  
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [result] = await connection.query(
      `INSERT INTO user_other_info 
      (user_id, full_name, email, phone, address, organization, website, social_media) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [user_id, full_name, email, phone, address, organization, website, social_media]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: 'Failed to save user info' });
  } finally {
    if (connection) connection.release();
  }
});

// Mount user info routes under /info
router.use('/:userId/info', userInfoRouter);

module.exports = router;