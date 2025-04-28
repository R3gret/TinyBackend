const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

// Rate limiting for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 login attempts per windowMs
  message: 'Too many login attempts, please try again later'
});

// Input validation and sanitization
const validateLogin = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required')
];

// Login route with rate limiting and validation
router.post('/login', loginLimiter, validateLogin, async (req, res) => {
  try {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array(),
        message: 'Validation failed' 
      });
    }

    const { username, password } = req.body;

    // Query user from database using parameterized query
    const query = 'SELECT id, username, password, type FROM users WHERE username = ?';
    const [results] = await db.promise().query(query, [username]);

    if (results.length === 0) {
      // Generic message to prevent username enumeration
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    const user = results[0];

    // Compare passwords securely
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    // Generate JWT token with secure settings
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        type: user.type 
      },
      process.env.JWT_SECRET, // Always use environment variable
      { 
        expiresIn: process.env.JWT_EXPIRES_IN || '1h',
        algorithm: 'HS256' 
      }
    );

    // Set secure HTTP-only cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 3600000 // 1 hour
    });

    // Successful login response (remove sensitive data)
    return res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        type: user.type
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

module.exports = router;