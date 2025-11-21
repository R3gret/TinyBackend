const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

// Rate limiting with proxy awareness
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts, please try again later',
  trustProxy: true,
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for'] || req.ip;
  }
});

const validateLogin = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required')
];

router.post('/', loginLimiter, validateLogin, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      errors: errors.array()
    });
  }

  const { username, password } = req.body;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    
    const [results] = await connection.query({
      sql: 'SELECT id, username, password, type, cdc_id FROM users WHERE username = ?',
      timeout: 5000
    }, [username]);

    if (results.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    const user = results[0];

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    // Create JWT with user object
    const payload = {
      user: {
        id: user.id,
        username: user.username,
        type: user.type,
        cdc_id: user.cdc_id
      }
    };

    // Get expiration from environment variable or default to 1h
    const expiresIn = process.env.JWT_EXPIRES || '1h';
    
    const token = jwt.sign(
      payload,
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn }
    );

    // Calculate expiresIn in seconds for response
    // Parse the expiresIn string (e.g., "7h" = 7 hours = 25200 seconds)
    let expiresInSeconds = 3600; // default 1 hour
    if (expiresIn.endsWith('h')) {
      const hours = parseInt(expiresIn);
      expiresInSeconds = hours * 3600;
    } else if (expiresIn.endsWith('m')) {
      const minutes = parseInt(expiresIn);
      expiresInSeconds = minutes * 60;
    } else if (expiresIn.endsWith('d')) {
      const days = parseInt(expiresIn);
      expiresInSeconds = days * 24 * 3600;
    } else if (!isNaN(expiresIn)) {
      // If it's just a number, assume seconds
      expiresInSeconds = parseInt(expiresIn);
    }

    res.json({
      success: true,
      token, // Send token in response body
      expiresIn: expiresInSeconds,
      user: { 
        id: user.id, 
        username: user.username, 
        type: user.type,
        cdc_id: user.cdc_id
      }
    });

  } catch (error) {
    console.error('Login error:', {
      message: error.message,
      code: error.code,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });

    const statusCode = error.code === 'ETIMEDOUT' ? 504 : 500;
    return res.status(statusCode).json({ 
      success: false,
      message: error.code === 'ETIMEDOUT' 
        ? 'Database connection timeout' 
        : 'Internal server error'
    });

  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;