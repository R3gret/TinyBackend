const bcrypt = require('bcryptjs');
const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all users
router.get('/users', (req, res) => {
  db.query('SELECT id, username, type FROM users', (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Failed to fetch users' });
    }
    res.json(results);
  });
});

// Search users
router.get('/users/search', (req, res) => {
  const { query } = req.query;
  db.query(
    'SELECT id, username, type FROM users WHERE username LIKE ?',
    [`%${query}%`],
    (err, results) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Failed to search users' });
      }
      res.json(results);
    }
  );
});

// Create user
router.post('/users', async (req, res) => {
  const { username, password, type = 'user' } = req.body;

  // Validation
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Check if username exists
  db.query('SELECT id FROM users WHERE username = ?', [username], async (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database error checking username' });
    }

    if (results.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    try {
      const hashedPassword = await bcrypt.hash(password, 10); // Salt rounds = 10

      // Insert new user with hashed password
      db.query(
        'INSERT INTO users (username, password, type) VALUES (?, ?, ?)',
        [username, hashedPassword, type],
        (err, result) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to create user' });
          }

          res.status(201).json({
            id: result.insertId,
            username,
            type
          });
        }
      );
    } catch (hashErr) {
      console.error('Hashing error:', hashErr);
      return res.status(500).json({ error: 'Failed to hash password' });
    }
  });
});

// Add to routes/users.js
router.post('/user-info', (req, res) => {
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

  db.query(
    `INSERT INTO user_other_info 
    (user_id, full_name, email, phone, address, organization, website, social_media) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [user_id, full_name, email, phone, address, organization, website, social_media],
    (err, result) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Failed to save user info' });
      }
      res.status(201).json({ success: true });
    }
  );
});

router.get('/users/:id/password', (req, res) => {
  const { id } = req.params;
  
  db.query('SELECT password FROM users WHERE id = ?', [id], (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Failed to fetch password' });
    }
    
    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ password: results[0].password });
  });
});

// Delete user account
router.delete('/users/:id', (req, res) => {
  const { id } = req.params;

  db.query('DELETE FROM users WHERE id = ?', [id], (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Failed to delete user' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, message: 'User deleted successfully' });
  });
});

// Edit user account
router.put('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { username, password, type } = req.body;

  // Validation
  if (!username || !type) {
    return res.status(400).json({ error: 'Username and type are required' });
  }

  try {
    // Get current user data
    const [currentUser] = await new Promise((resolve, reject) => {
      db.query('SELECT * FROM users WHERE id = ?', [id], (err, results) => {
        if (err) return reject(err);
        resolve(results);
      });
    });

    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    let hashedPassword = currentUser.password;
    
    // Only update password if a new one was provided
    if (password && password.trim() !== '') {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      
      // Hash the new password (only if it's different from current)
      const isSamePassword = await bcrypt.compare(password, currentUser.password);
      if (!isSamePassword) {
        hashedPassword = await bcrypt.hash(password, 10);
      }
    }

    // Check for duplicate username
    if (username !== currentUser.username) {
      const [existingUser] = await new Promise((resolve, reject) => {
        db.query('SELECT id FROM users WHERE username = ? AND id != ?', 
          [username, id], (err, results) => {
            if (err) return reject(err);
            resolve(results);
        });
      });

      if (existingUser) {
        return res.status(400).json({ error: 'Username already exists' });
      }
    }

    // Update user
    const result = await new Promise((resolve, reject) => {
      db.query(
        'UPDATE users SET username = ?, password = ?, type = ? WHERE id = ?',
        [username, hashedPassword, type, id],
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
        }
      );
    });

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

module.exports = router;