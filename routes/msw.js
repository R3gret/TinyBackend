const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db');

router.post('/', async (req, res) => {
  const { username, password } = req.body;
  let connection;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    connection = await db.promisePool.getConnection();

    const [existingUsers] = await connection.query(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await connection.query(
      'INSERT INTO users (username, password, type) VALUES (?, ?, ?)',
      [username, hashedPassword, 'msw']
    );

    res.status(201).json({
      id: result.insertId,
      username,
      type: 'msw'
    });
  } catch (err) {
    console.error('Error creating MSW user:', err);
    res.status(500).json({ error: 'Failed to create MSW user' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;