const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');

// Get current user's full details
// Get current user's full details
router.get('/current-user/details', async (req, res) => {
    try {
      // 1. Get user ID from query parameter
      const userId = req.query.userId;
  
      if (!userId) {
        return res.status(400).json({ success: false, message: 'Missing userId in query' });
        
      }
  
      // 2. Query database for user details
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

      
      
      db.query(query, [userId], (err, results) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ 
            success: false, 
            message: 'Database error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
          });
        }
  
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
            profile_pic: results[0].profile_pic // Ensure profile_pic is included here
          }
        };

        console.log('Constructed userData:', {
            organization: userData.other_info.organization,
            website: userData.other_info.website,
            social_media: userData.other_info.social_media
          });
  
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
      });
    } catch (err) {
      console.error('Error:', err);
      res.status(500).json({ 
        success: false, 
        message: 'Server error',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
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

    // Get user ID from body (not query parameter anymore)
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

    // Check if user exists first
    const userCheck = await new Promise((resolve, reject) => {
      db.query('SELECT id FROM users WHERE id = ?', [userId], (err, results) => {
        if (err) return reject(err);
        resolve(results);
      });
    });

    if (userCheck.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

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

    db.query(
      query,
      [full_name, email, phone, address, organization, website, social_media, userId],
      (err) => {
        if (err) {
          console.error('Database query error:', err); // Log the detailed database error
          return res.status(500).json({ 
            success: false, 
            message: 'Database error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
          });
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
      }
    );
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});


router.put('/change-password', [
    // Validate current password
    body('currentPassword')
      .notEmpty().withMessage('Current password is required')
      .isString().withMessage('Current password must be a string'),
      
    // Validate new password
    body('newPassword')
      .notEmpty().withMessage('New password is required')
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
      .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
      .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
      .matches(/[0-9]/).withMessage('Password must contain at least one number')
      .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least one special character'),
      
    // Validate confirm password
    body('confirmPassword')
      .notEmpty().withMessage('Confirm password is required')
      .custom((value, { req }) => {
        if (value !== req.body.newPassword) {
          throw new Error('Passwords do not match');
        }
        return true;
      })
  ], async (req, res) => {
    try {
      // Log incoming request for debugging
      console.log('Received password change request:', {
        body: req.body,
        query: req.query,
        userId: req.body.userId || req.query.userId
      });
  
      // Validate request against the defined rules
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.warn('Validation errors:', errors.array());
        return res.status(400).json({ 
          success: false, 
          message: 'Validation failed',
          errors: errors.array() 
        });
      }
  
      // Get user ID from either query params or request body
      const userId = req.query.userId || req.body.userId;
      if (!userId) {
        console.error('Missing userId in request');
        return res.status(400).json({ 
          success: false, 
          message: 'User ID is required' 
        });
      }
  
      const { currentPassword, newPassword, confirmPassword } = req.body;
  
      // Additional manual validation (redundant but safe)
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
  
      // Check if new password is different from current password
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
  
      // Get user's current password hash from database
      const getUserQuery = 'SELECT id, password FROM users WHERE id = ?';
      const [user] = await new Promise((resolve, reject) => {
        db.query(getUserQuery, [userId], (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
  
      if (!user) {
        console.error('User not found with ID:', userId);
        return res.status(404).json({ 
          success: false, 
          message: 'User not found' 
        });
      }
  
      // Verify current password matches
      const isMatch = await bcrypt.compare(currentPassword, user.password);
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
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
  
      // Update password in database
      const updateQuery = `
  UPDATE users 
  SET password = ?
  WHERE id = ?
`;

await new Promise((resolve, reject) => {
  db.query(updateQuery, [hashedPassword, userId], (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});
  
      console.log('Password successfully updated for user:', userId);
      
      // Return success response
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
    }
  });

module.exports = router;