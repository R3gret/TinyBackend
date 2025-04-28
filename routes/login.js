const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');

const jwt = require('jsonwebtoken'); // Add this at the top

// Login route
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  const query = 'SELECT * FROM users WHERE username = ?';
  db.query(query, [username], async (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ success: false, message: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    const user = results[0];

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, username: user.username, type: user.type },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '1h' }
    );

    return res.json({
      success: true,
      token, // Send the token to the client
      user: {
        id: user.id,
        username: user.username,
        type: user.type
      }
    });
  });
});

module.exports = router;
