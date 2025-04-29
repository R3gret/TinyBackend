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
  trustProxy: true, // Add this for proxy support
  keyGenerator: (req) => {
    // Use x-forwarded-for header if present
    return req.headers['x-forwarded-for'] || req.ip;
  }
});

const validateLogin = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required')
];

router.post('/login', loginLimiter, validateLogin, async (req, res) => {
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
    // Get connection with timeout handling
    connection = await db.promisePool.getConnection();
    
    // Query with timeout
    const [results] = await connection.query({
      sql: 'SELECT id, username, password, type FROM users WHERE username = ?',
      timeout: 5000 // 5 second timeout
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

    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET not configured');
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, type: user.type },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h', algorithm: 'HS256' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 3600000
    });

    return res.json({
      success: true,
      user: { id: user.id, username: user.username, type: user.type }
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