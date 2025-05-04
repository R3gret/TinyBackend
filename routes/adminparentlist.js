const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

// Get parents for the admin's CDC
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

    connection = await db.promisePool.getConnection();

    // Get logged-in admin's details
    const [admin] = await connection.query(
      'SELECT id, username, type, cdc_id FROM users WHERE id = ? AND type = ?', 
      [loggedInUserId, 'admin']
    );

    if (!admin.length) {
      return res.status(403).json({ 
        success: false, 
        message: 'Only administrators can access this resource' 
      });
    }

    const adminCDC = admin[0].cdc_id;

    // Get parents from the same CDC
    let query = `
      SELECT id, username, type, cdc_id, profile_pic 
      FROM users 
      WHERE type = 'parent' 
      AND cdc_id = ?
    `;
    const params = [adminCDC];
    
    if (search) {
      query += ' AND username LIKE ?';
      params.push(`%${search}%`);
    }
    
    const [parents] = await connection.query(query, params);
    
    res.json({ 
      success: true, 
      parents: parents.map(p => ({
        ...p,
        profile_pic: p.profile_pic || null // Ensure profile_pic is always defined
      }))
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;