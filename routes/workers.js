const express = require('express');
const router = express.Router();
const db = require('../db');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');

// Middleware to check if the user is associated with a CDC
const hasCdcAssociation = (req, res, next) => {
  // TEMPORARY DEBUG LOG: Inspect the user object
  console.log('Inspecting req.user in hasCdcAssociation:', req.user);

  if (!req.user || !req.user.cdc_id) {
    return res.status(403).json({ success: false, message: 'User is not associated with a CDC. Access denied.' });
  }
  next();
};

// Apply the middleware to all routes in this file
router.use(hasCdcAssociation);

// GET all workers for the logged-in user's CDC
router.get('/', async (req, res) => {
  try {
    const { cdc_id } = req.user;
    const { search } = req.query;

    let query = 'SELECT id, username, profile_pic FROM users WHERE type = \'worker\' AND cdc_id = ?';
    const params = [cdc_id];

    if (search) {
      query += ' AND username LIKE ?';
      params.push(`%${search}%`);
    }

    const [workers] = await db.promisePool.query(query, params);

    res.json({ success: true, data: workers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST a new worker for the logged-in user's CDC
router.post('/', [
  body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { cdc_id } = req.user;
    const { username, password } = req.body;

    const [existingUser] = await db.promisePool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existingUser.length > 0) {
      return res.status(409).json({ success: false, message: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await db.promisePool.query(
      'INSERT INTO users (username, password, type, cdc_id) VALUES (?, ?, \'worker\', ?)',
      [username, hashedPassword, cdc_id]
    );

    res.status(201).json({ success: true, message: 'Worker created successfully', data: { id: result.insertId, username } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT/update a worker by ID
router.put('/:id', [
  body('username').trim().isLength({ min: 3 }).optional().withMessage('Username must be at least 3 characters'),
  body('password').isLength({ min: 8 }).optional().withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { cdc_id } = req.user;
    const workerId = req.params.id;
    const { username, password } = req.body;

    const [worker] = await db.promisePool.query('SELECT * FROM users WHERE id = ? AND cdc_id = ? AND type = \'worker\'', [workerId, cdc_id]);
    if (worker.length === 0) {
      return res.status(404).json({ success: false, message: 'Worker not found in your CDC' });
    }

    let hashedPassword = worker[0].password;
    if (password) {
      hashedPassword = await bcrypt.hash(password, 10);
    }

    const newUsername = username || worker[0].username;

    await db.promisePool.query(
      'UPDATE users SET username = ?, password = ? WHERE id = ?',
      [newUsername, hashedPassword, workerId]
    );

    res.json({ success: true, message: 'Worker updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE a worker by ID
router.delete('/:id', async (req, res) => {
  try {
    const { cdc_id } = req.user;
    const workerId = req.params.id;

    const [result] = await db.promisePool.query(
      'DELETE FROM users WHERE id = ? AND cdc_id = ? AND type = \'worker\'',
      [workerId, cdc_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Worker not found in your CDC' });
    }

    res.json({ success: true, message: 'Worker deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
