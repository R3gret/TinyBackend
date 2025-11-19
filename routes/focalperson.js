const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db');

// Check if focal account exists in a municipality
router.get('/check', async (req, res) => {
  const { municipality } = req.query;
  let connection;

  if (!municipality) {
    return res.status(400).json({ 
      success: false,
      error: 'Municipality is required' 
    });
  }

  try {
    connection = await db.promisePool.getConnection();

    // Check if there's already a focal person in this municipality
    // Check via user_other_info address field (municipality stored in address)
    // Also check via CDC location for backward compatibility with existing focal persons
    const [existingFocal] = await connection.query(
      `SELECT DISTINCT u.id, u.username, COALESCE(cl.municipality, '') as municipality
       FROM users u
       LEFT JOIN user_other_info o ON u.id = o.user_id
       LEFT JOIN cdc c ON u.cdc_id = c.cdc_id
       LEFT JOIN cdc_location cl ON c.location_id = cl.location_id
       WHERE u.type = 'focal' 
       AND (o.address LIKE ? OR cl.municipality = ?)`,
      [`%${municipality}%`, municipality]
    );

    if (existingFocal.length > 0) {
      return res.json({
        success: true,
        exists: true,
        message: 'A focal person already exists in this municipality',
        data: {
          id: existingFocal[0].id,
          username: existingFocal[0].username,
          municipality: existingFocal[0].municipality
        }
      });
    }

    res.json({
      success: true,
      exists: false,
      message: 'No focal person exists in this municipality'
    });
  } catch (err) {
    console.error('Error checking focal person:', err);
    res.status(500).json({ 
      success: false,
      error: 'Failed to check focal person',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

// Create focal account (only one per municipality)
router.post('/', async (req, res) => {
  const { username, password, municipality, province, barangay } = req.body;
  let connection;

  if (!username || !password) {
    return res.status(400).json({ 
      success: false,
      error: 'Username and password are required' 
    });
  }

  if (!municipality) {
    return res.status(400).json({ 
      success: false,
      error: 'Municipality is required' 
    });
  }

  if (password.length < 8) {
    return res.status(400).json({ 
      success: false,
      error: 'Password must be at least 8 characters' 
    });
  }

  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    try {
      // Check if username already exists
      const [existingUsers] = await connection.query(
        'SELECT id FROM users WHERE username = ?',
        [username]
      );

      if (existingUsers.length > 0) {
        throw new Error('Username already exists');
      }

      // Check if there's already a focal person in this municipality
      // Check via user_other_info address field (municipality stored in address)
      // Also check via CDC location for backward compatibility with existing focal persons
      const [existingFocal] = await connection.query(
        `SELECT DISTINCT u.id, u.username
         FROM users u
         LEFT JOIN user_other_info o ON u.id = o.user_id
         LEFT JOIN cdc c ON u.cdc_id = c.cdc_id
         LEFT JOIN cdc_location cl ON c.location_id = cl.location_id
         WHERE u.type = 'focal' 
         AND (o.address LIKE ? OR cl.municipality = ?)`,
        [`%${municipality}%`, municipality]
      );

      if (existingFocal.length > 0) {
        throw new Error(`A focal person already exists in the municipality: ${municipality}. Only one focal person is allowed per municipality.`);
      }

      // Hash password and create user
      const hashedPassword = await bcrypt.hash(password, 10);

      const [result] = await connection.query(
        'INSERT INTO users (username, password, type) VALUES (?, ?, ?)',
        [username, hashedPassword, 'focal']
      );

      await connection.commit();

      res.status(201).json({
        success: true,
        id: result.insertId,
        username,
        type: 'focal',
        municipality,
        message: 'Focal person account created successfully'
      });
    } catch (err) {
      await connection.rollback();
      throw err;
    }
  } catch (err) {
    console.error('Error creating focal person user:', err);
    const status = err.message.includes('already exists') ? 400 : 500;
    res.status(status).json({ 
      success: false,
      error: err.message || 'Failed to create focal person user'
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;

