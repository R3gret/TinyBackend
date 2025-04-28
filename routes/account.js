const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all users with filtering
router.get('/', (req, res) => {
  const { type, search } = req.query;
  
  let query = 'SELECT id, username, type, profile_pic FROM users WHERE 1=1';
  const params = [];
  
  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }
  
  if (search) {
    query += ' AND username LIKE ?';
    params.push(`%${search}%`);
  }
  
  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    
    return res.json({
      success: true,
      users: results
    });
  });
});

// Get user by ID
router.get('/:id', (req, res) => {
  const query = 'SELECT id, username, type, profile_pic FROM users WHERE id = ?';
  
  db.query(query, [req.params.id], (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    return res.json({
      success: true,
      user: results[0]
    });
  });
});

// Create a new user
router.post('/', (req, res) => {
  const { username, type, password } = req.body;
  
  // First check if username exists
  db.query('SELECT id FROM users WHERE username = ?', [username], (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    
    if (results.length > 0) {
      return res.status(400).json({ success: false, message: 'Username already in use' });
    }
    
    // Insert new user
    const insertQuery = `
      INSERT INTO users (username, type, password, profile_pic)
      VALUES (?, ?, ?, ?)
    `;
    
    // Default profile picture if not provided
    const profilePic = req.body.profile_pic || 'default-profile.png';
    
    db.query(insertQuery, [username, type, password, profilePic], (err, results) => {
      if (err) {
        console.error('Database insert error:', err);
        return res.status(500).json({ success: false, message: 'Database error' });
      }
      
      return res.status(201).json({
        success: true,
        userId: results.insertId
      });
    });
  });
});

// Update a user
router.put('/:id', (req, res) => {
  const { username, type, profile_pic } = req.body;
  const userId = req.params.id;
  
  const query = `
    UPDATE users 
    SET username = ?, type = ?, profile_pic = ?
    WHERE id = ?
  `;
  
  db.query(query, [username, type, profile_pic, userId], (err, results) => {
    if (err) {
      console.error('Database update error:', err);
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    
    if (results.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    return res.json({
      success: true,
      message: 'User updated successfully'
    });
  });
});

// Delete a user
router.delete('/:id', (req, res) => {
  const query = 'DELETE FROM users WHERE id = ?';
  
  db.query(query, [req.params.id], (err, results) => {
    if (err) {
      console.error('Database delete error:', err);
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    
    if (results.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    return res.json({
      success: true,
      message: 'User deleted successfully'
    });
  });
});

// Get all user types (distinct values from the type column)
router.get('/types/all', (req, res) => {
  const query = 'SELECT DISTINCT type FROM users';
  
  db.query(query, (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    
    const types = results.map(row => row.type);
    
    return res.json({
      success: true,
      types
    });
  });
});


// Get user by ID with additional info
router.get('/:id/details', (req, res) => {
    const query = `
      SELECT 
        u.*,
        o.full_name,
        o.email AS contact_email,
        o.phone,
        o.address,
        o.organization,
        o.website,
        o.social_media
      FROM users u
      LEFT JOIN user_other_info o ON u.id = o.user_id
      WHERE u.id = ?
    `;
    
    db.query(query, [req.params.id], (err, results) => {
      if (err) {
        console.error('Database query error:', err);
        return res.status(500).json({ success: false, message: 'Database error' });
      }
      
      if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      
      // Combine the data into a single user object
      const userData = {
        ...results[0],
        other_info: {
          full_name: results[0].full_name,
          email: results[0].contact_email,
          phone: results[0].phone,
          address: results[0].address,
          organization: results[0].organization,
          website: results[0].website,
          social_media: results[0].social_media
        }
      };
      
      // Remove the duplicated fields from the main object
      delete userData.full_name;
      delete userData.contact_email;
      delete userData.phone;
      delete userData.address;
      delete userData.organization;
      delete userData.website;
      delete userData.social_media;
      
      return res.json({
        success: true,
        user: userData
      });
    });
  });

module.exports = router;