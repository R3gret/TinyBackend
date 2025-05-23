const express = require('express');
const router = express.Router();
const db = require('../db'); // Make sure this points to your db connection files
const jwt = require('jsonwebtoken');

// Get admins for the president's CDC
router.get('/', async (req, res) => {
  let connection;
  try {
    const { search } = req.query;
    
    // Get the logged-in user's information from the token
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const loggedInUserId = decoded.id;

    // Get connection from pool
    connection = await db.promisePool.getConnection();

    // First, get the logged-in user's details
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

    // Only show admins with the same cdc_id
    let query = `
      SELECT id, username, type, profile_pic 
      FROM users 
      WHERE type = 'admin' 
      AND cdc_id = ?
    `;
    const params = [loggedInUser.cdc_id];
    
    if (search) {
      query += ' AND username LIKE ?';
      params.push(`%${search}%`);
    }
    
    const [results] = await connection.query(query, params);
    
    res.json({ success: true, users: results });
  } catch (err) {
    console.error('Error in PresidentAdminList:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch administrators',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;