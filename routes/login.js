const express = require('express');
const router = express.Router();
const db = require('../db'); // Updated to use mysql2/promise
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
  let connection;

  try {
    // Get connection from pool
    connection = await db.getConnection();
    console.log('Database connection established for login attempt');

    // Query user from database using parameterized query
    const query = 'SELECT id, username, password, type FROM users WHERE username = ?';
    const [results] = await connection.query(query, [username]);

    if (results.length === 0) {
      console.log('Login attempt failed - user not found:', username);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    const user = results[0];
    console.log('User found for login:', user.id);

    // Compare passwords securely
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.log('Login attempt failed - password mismatch for user:', user.id);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    // Verify JWT_SECRET exists
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET environment variable not set');
    }

    // Generate JWT token with secure settings
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        type: user.type 
      },
      process.env.JWT_SECRET,
      { 
        expiresIn: process.env.JWT_EXPIRES_IN || '1h',
        algorithm: 'HS256' 
      }
    );

    console.log('Login successful for user:', user.id);

    // Set secure HTTP-only cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 3600000 // 1 hour
    });

    // Successful login response
    return res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        type: user.type
      }
    });

  } catch (error) {
    console.error('Login error:', {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });

    return res.status(500).json({ 
      success: false,
      message: 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && {
        error: error.message,
        stack: error.stack
      })
    });

  } finally {
    // Always release the connection back to the pool
    if (connection) {
      connection.release();
      console.log('Database connection released');
    }
  }
});

module.exports = router;