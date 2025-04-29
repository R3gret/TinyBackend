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