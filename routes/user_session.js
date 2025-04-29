const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');

// Helper function for database queries with promises
const queryAsync = (sql, params) => {
  return promisePool.query(sql, params)
    .then(([rows]) => rows) // Extract rows from the result
    .catch(err => {
      console.error('Database query error:', err);
      throw err;
    });
};

// Get current user's full details
router.get('/current-user/details', async (req, res) => {
  try {
    const userId = req.query.userId;

    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing userId in query' 
      });
    }

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

    const results = await queryAsync(query, [userId]);

    if (results.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
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
    ].forEach(field => delete userData[field]);

    return res.json({ 
      success: true, 
      user: userData 
    });

  } catch (err) {
    console.error('Error in current-user/details:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Update profile with validation
router.put('/update-profile', [
  body('userId').notEmpty().withMessage('User ID is required'),
  body('full_name').optional().trim().isLength({ min: 2 }).withMessage('Full name must be at least 2 characters'),
  body('email').optional().isEmail().withMessage('Invalid email format'),
  body('phone').optional().isMobilePhone().withMessage('Invalid phone number'),
  body('website').optional().isURL().withMessage('Invalid website URL'),
  body('social_media').optional().isURL().withMessage('Invalid social media URL')
], async (req, res) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed',
        errors: errors.array() 
      });
    }

    const userId = req.body.userId;
    const {
      full_name,
      email,
      phone,
      address,
      organization,
      website,
      social_media
    } = req.body;

    // Check if user exists
    const userExists = await queryAsync(
      'SELECT id FROM users WHERE id = ?', 
      [userId]
    );

    if (userExists.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // Check if user info exists
    const infoExists = await queryAsync(
      'SELECT user_id FROM user_other_info WHERE user_id = ?',
      [userId]
    );

    if (infoExists.length === 0) {
      // Create new record if doesn't exist
      await queryAsync(
        `INSERT INTO user_other_info 
        (user_id, full_name, email, phone, address, organization, website, social_media) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, full_name, email, phone, address, organization, website, social_media]
      );
    } else {
      // Update existing record
      await queryAsync(
        `UPDATE user_other_info
        SET 
          full_name = ?, 
          email = ?, 
          phone = ?, 
          address = ?, 
          organization = ?, 
          website = ?, 
          social_media = ?
        WHERE user_id = ?`,
        [full_name, email, phone, address, organization, website, social_media, userId]
      );
    }

    return res.json({ 
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
    console.error('Error in update-profile:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Change password with validation
router.put('/change-password', [
  body('userId').notEmpty().withMessage('User ID is required'),
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
    .custom((value, { req }) => value === req.body.newPassword).withMessage('Passwords do not match')
], async (req, res) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed',
        errors: errors.array() 
      });
    }

    const { userId, currentPassword, newPassword } = req.body;

    // Get user's current password
    const [user] = await queryAsync(
      'SELECT id, password FROM users WHERE id = ?', 
      [userId]
    );

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(403).json({ 
        success: false, 
        message: 'Incorrect current password',
        errors: [{
          path: 'currentPassword',
          msg: 'Incorrect current password'
        }]
      });
    }

    // Check if new password is different
    if (currentPassword === newPassword) {
      return res.status(400).json({ 
        success: false, 
        message: 'New password must be different from current password',
        errors: [{
          path: 'newPassword',
          msg: 'New password must be different from current password'
        }]
      });
    }

    // Hash and update password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await queryAsync(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, userId]
    );

    return res.json({ 
      success: true, 
      message: 'Password updated successfully',
      passwordChanged: true,
      changedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Error in change-password:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

module.exports = router;