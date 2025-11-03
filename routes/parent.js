const bcrypt = require('bcryptjs');
const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const authenticate = require('./authMiddleware');

// Get all guardians for the current CDC
// Get all guardians for the current CDC
router.get('/guardians', authenticate, async (req, res) => {
  let connection;
  try {
    const loggedInUserId = req.user.id;
    const cdcId = req.user.cdc_id;

    // Get all guardians with their associated student info
    const [results] = await connection.query(`
      SELECT 
        gi.guardian_id, 
        gi.guardian_name, 
        gi.relationship, 
        gi.email_address, 
        gi.student_id, 
        gi.id as user_id,
        CONCAT(s.first_name, ' ', COALESCE(s.middle_name, ''), ' ', s.last_name) as student_name,
        s.student_id
      FROM guardian_info gi
      LEFT JOIN students s ON gi.student_id = s.student_id
      WHERE s.cdc_id = ? AND (gi.id IS NULL OR gi.id = '')
    `, [cdcId]);

    res.json(results);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ 
      error: 'Failed to fetch guardians',
      details: err.message
    });
  } finally {
    if (connection) connection.release();
  }
});

// Get all parent accounts
// Get all parent accounts for the current CDC
router.get('/', authenticate, async (req, res) => {
    let connection;
    try {
      const loggedInUserId = req.user.id;
      const cdcId = req.user.cdc_id;
  
      const [results] = await connection.query(
        'SELECT id, username, type, cdc_id FROM users WHERE type = ? AND cdc_id = ?', 
        ['parent', cdcId]
      );
      res.json(results);
    } catch (err) {
      console.error('Database error:', err);
      res.status(500).json({ error: 'Failed to fetch parent accounts' });
    } finally {
      if (connection) connection.release();
    }
  });
  
  // Search parent accounts for the current CDC
  router.get('/search', authenticate, async (req, res) => {
    const { query } = req.query;
    let connection;
    try {
      const loggedInUserId = req.user.id;
      const cdcId = req.user.cdc_id;
  
      const [results] = await connection.query(
        'SELECT id, username, type, cdc_id FROM users WHERE username LIKE ? AND type = ? AND cdc_id = ?',
        [`%${query}%`, 'parent', cdcId]
      );
      res.json(results);
    } catch (err) {
      console.error('Database error:', err);
      res.status(500).json({ error: 'Failed to search parent accounts' });
    } finally {
      if (connection) connection.release();
    }
  });

// Create parent account (locked to parent type with creator's CDC ID)
router.post('/', authenticate, async (req, res) => {
  const { username, password, student_id } = req.body; // Add student_id to destructuring
  let connection;

  // Validation
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const loggedInUserId = req.user.id;
    const cdcId = req.user.cdc_id;

    connection = await db.promisePool.getConnection();
    
    // Start transaction
    await connection.beginTransaction();
    
    try {

      // Check if username exists
      const [existingUsers] = await connection.query(
        'SELECT id FROM users WHERE username = ?', 
        [username]
      );

      if (existingUsers.length > 0) {
        throw new Error('Username already exists');
      }

      // Hash the password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Insert new parent account with creator's CDC ID
      const [result] = await connection.query(
        'INSERT INTO users (username, password, type, cdc_id) VALUES (?, ?, ?, ?)',
        [username, hashedPassword, 'parent', cdcId]
      );

      const newUserId = result.insertId;

      // If student_id was provided, update the guardian_info record
      if (student_id) {
        await connection.query(
          'UPDATE guardian_info SET id = ? WHERE student_id = ?',
          [newUserId, student_id]
        );
      }

      await connection.commit();

      res.status(201).json({
        id: newUserId,
        username,
        type: 'parent',
        cdc_id: cdcId
      });
    } catch (err) {
      await connection.rollback();
      throw err;
    }
  } catch (err) {
    console.error('Error creating user:', err);
    if (err.message === 'Unauthorized') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.status(500).json({ error: err.message || 'Failed to create parent account' });
  } finally {
    if (connection) connection.release();
  }
});

// Get user password (Note: This should be secured in production)
router.get('/:id/password', authenticate, async (req, res) => {
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

// Save additional user info
router.post('/user-info', authenticate, async (req, res) => {
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
    await connection.query(
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

// Delete user account
router.delete('/:id', authenticate, async (req, res) => {
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

// Edit user account
router.put('/:id', authenticate, async (req, res) => {
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


module.exports = router;