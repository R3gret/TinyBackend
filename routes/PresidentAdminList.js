const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');

// Get admins for the president's CDC
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    
    // Get the logged-in user's information from the token
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const loggedInUserId = decoded.id;

    const users = await withConnection(async (connection) => {
      // First, get the logged-in user's details including cdc_id
      const [currentUser] = await connection.query(
        'SELECT id, username, type, cdc_id FROM users WHERE id = ?', 
        [loggedInUserId]
      );

      if (!currentUser.length) {
        throw new Error('User not found');
      }

      const loggedInUser = currentUser[0];
      
      // Verify the logged-in user is a president
      if (loggedInUser.type !== 'president') {
        throw new Error('Only presidents can view this list');
      }

      // Only show admins with the same cdc_id as the president
      let query = `
        SELECT id, username, type, profile_pic 
        FROM users 
        WHERE type = 'admin' 
        AND cdc_id = ?
      `;
      const params = [loggedInUser.cdc_id];
      
      // Add search filter if provided
      if (search) {
        query += ' AND username LIKE ?';
        params.push(`%${search}%`);
      }
      
      const [results] = await connection.query(query, params);
      return results;
    });

    res.json({ success: true, users });
  } catch (err) {
    console.error('Error in PresidentAdminList:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch administrators',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Make sure to export the router
module.exports = router;