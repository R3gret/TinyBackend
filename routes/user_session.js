const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');

// Get current user's full details
router.get('/current-user/details', async (req, res) => {
  let connection;
  try {
    // 1. Get user ID from query parameter
    const userId = req.query.userId;

    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId in query' });
    }

    // 2. Get connection from pool
    connection = await db.promisePool.getConnection();

    // 3. Query database for user details
    const query = `
      SELECT 
        u.*, 
        o.full_name,
        o.email AS contact_email,
        o.phone,
        o.address,
        o.organization,
        o.website,
        o.social_media,
        u.profile_pic
      FROM users u
      LEFT JOIN user_other_info o ON u.id = o.user_id
      WHERE u.id = ?
    `;

    const [results] = await connection.query(query, [userId]);

    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userData = {
      ...results[0],
      other_info: {
        full_name: results[0].full_name,
        email: results[0].contact_email,
        phone: results[0].phone,
        address: results[0].address,
        organization: results[0].organization,
        website: results[0].website,
        social_media: results[0].social_media,
        profile_pic: results[0].profile_pic
      }
    };

    // Clean up duplicated fields
    [
      'full_name', 
      'contact_email', 
      'phone', 
      'address', 
      'organization', 
      'website', 
      'social_media',
      'profile_pic'
    ].forEach(field => {
      delete userData[field];
    });

    res.json({ success: true, user: userData });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

// Update profile with validation
router.put('/update-profile', [
  body('full_name').optional().trim().isLength({ min: 2 }).withMessage('Full name must be at least 2 characters'),
  body('email').optional().isEmail().withMessage('Invalid email format'),
  body('phone').optional().isMobilePhone().withMessage('Invalid phone number'),
  body('website').optional().isURL().withMessage('Invalid website URL'),
  body('social_media').optional().isURL().withMessage('Invalid social media URL')
], async (req, res) => {
  let connection;
  try {
    console.log('Received update data:', {
      organization: req.body.organization,
      website: req.body.website,
      social_media: req.body.social_media
    });

    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed',
        errors: errors.array() 
      });
    }

    // Get user ID from body
    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId in request body' });
    }

    const {
      full_name,
      email,
      phone,
      address,
      organization,
      website,
      social_media
    } = req.body;

    // Get connection from pool
    connection = await db.promisePool.getConnection();

    // Check if user exists first
    const [userCheck] = await connection.query('SELECT id FROM users WHERE id = ?', [userId]);

    if (userCheck.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check if user info exists
    const [infoCheck] = await connection.query('SELECT user_id FROM user_other_info WHERE user_id = ?', [userId]);

    if (infoCheck.length > 0) {
      // Update existing info
      const query = `
        UPDATE user_other_info
        SET 
          full_name = ?, 
          email = ?, 
          phone = ?, 
          address = ?, 
          organization = ?, 
          website = ?, 
          social_media = ?
        WHERE user_id = ?
      `;

      await connection.query(
        query,
        [full_name, email, phone, address, organization, website, social_media, userId]
      );
    } else {
      // Insert new info
      const insertQuery = `
        INSERT INTO user_other_info 
        (user_id, full_name, email, phone, address, organization, website, social_media) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      await connection.query(
        insertQuery,
        [userId, full_name, email, phone, address, organization, website, social_media]
      );
    }

    res.json({ 
      success: true, 
      message: 'Profile updated successfully',
      updatedFields: {
        full_name,
        email,
        phone,
        address,
        organization,
        website,
        social_media
      }
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

// Change password with validation
router.put('/change-password', [
  body('currentPassword')
    .notEmpty().withMessage('Current password is required')
    .isString().withMessage('Current password must be a string'),
  body('newPassword')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least one special character'),
  body('confirmPassword')
    .notEmpty().withMessage('Confirm password is required')
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error('Passwords do not match');
      }
      return true;
    })
], async (req, res) => {
  let connection;
  try {
    console.log('Received password change request:', {
      body: req.body,
      query: req.query,
      userId: req.body.userId || req.query.userId
    });

    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.warn('Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed',
        errors: errors.array() 
      });
    }

    // Get user ID
    const userId = req.query.userId || req.body.userId;
    if (!userId) {
      console.error('Missing userId in request');
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required' 
      });
    }

    const { currentPassword, newPassword, confirmPassword } = req.body;

    // Additional manual validation
    if (newPassword !== confirmPassword) {
      console.error('Password mismatch detected in manual validation');
      return res.status(400).json({
        success: false,
        message: 'Passwords do not match',
        errors: [{ 
          path: 'confirmPassword', 
          msg: 'Passwords do not match' 
        }]
      });
    }

    if (currentPassword === newPassword) {
      console.warn('New password matches current password');
      return res.status(400).json({ 
        success: false, 
        message: 'New password must be different from current password',
        errors: [{
          path: 'newPassword',
          msg: 'New password must be different from current password'
        }]
      });
    }

    // Get connection from pool
    connection = await db.promisePool.getConnection();

    // Get user's current password hash
    const [users] = await connection.query('SELECT id, password FROM users WHERE id = ?', [userId]);

    if (users.length === 0) {
      console.error('User not found with ID:', userId);
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, users[0].password);
    if (!isMatch) {
      console.warn('Incorrect current password provided');
      return res.status(403).json({ 
        success: false, 
        message: 'Incorrect current password',
        errors: [{
          path: 'currentPassword',
          msg: 'Incorrect current password'
        }]
      });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await connection.query(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, userId]
    );

    console.log('Password successfully updated for user:', userId);
    
    res.json({ 
      success: true, 
      message: 'Password updated successfully',
      passwordChanged: true,
      changedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error in password change endpoint:', {
      message: err.message,
      stack: err.stack
    });
    
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/current-user', async (req, res) => {
  let connection;
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id;

    connection = await db.promisePool.getConnection();
    const [user] = await connection.query(
      'SELECT id, username, type, cdc_id FROM users WHERE id = ?',
      [userId]
    );

    if (user.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ 
      success: true, 
      user: user[0] 
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;