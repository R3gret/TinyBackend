const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all users with filtering
router.get('/', async (req, res) => {
  const { type, search } = req.query;
  let connection;
  
  try {
    connection = await db.promisePool.getConnection();
    
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
    
    const [results] = await connection.query(query, params);
    
    return res.json({
      success: true,
      users: results
    });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ success: false, message: 'Database error' });
  } finally {
    if (connection) connection.release();
  }
});

// Get user by ID
router.get('/:id', async (req, res) => {
  let connection;
  
  try {
    connection = await db.promisePool.getConnection();
    const query = 'SELECT id, username, type, profile_pic FROM users WHERE id = ?';
    const [results] = await connection.query(query, [req.params.id]);
    
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    return res.json({
      success: true,
      user: results[0]
    });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ success: false, message: 'Database error' });
  } finally {
    if (connection) connection.release();
  }
});

// Create a new user
router.post('/', async (req, res) => {
  const { username, type, password } = req.body;
  let connection;
  
  try {
    connection = await db.promisePool.getConnection();
    
    // First check if username exists
    const [checkResults] = await connection.query(
      'SELECT id FROM users WHERE username = ?', 
      [username]
    );
    
    if (checkResults.length > 0) {
      return res.status(400).json({ success: false, message: 'Username already in use' });
    }
    
    // Insert new user
    const insertQuery = `
      INSERT INTO users (username, type, password, profile_pic)
      VALUES (?, ?, ?, ?)
    `;
    
    // Default profile picture if not provided
    const profilePic = req.body.profile_pic || 'default-profile.png';
    
    const [insertResults] = await connection.query(
      insertQuery, 
      [username, type, password, profilePic]
    );
    
    return res.status(201).json({
      success: true,
      userId: insertResults.insertId
    });
  } catch (err) {
    console.error('Database error:', err);
    return res.status(500).json({ success: false, message: 'Database error' });
  } finally {
    if (connection) connection.release();
  }
});

// Update a user
router.put('/:id', async (req, res) => {
  const { username, type, profile_pic } = req.body;
  const userId = req.params.id;
  let connection;
  
  try {
    connection = await db.promisePool.getConnection();
    
    const query = `
      UPDATE users 
      SET username = ?, type = ?, profile_pic = ?
      WHERE id = ?
    `;
    
    const [results] = await connection.query(
      query, 
      [username, type, profile_pic, userId]
    );
    
    if (results.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    return res.json({
      success: true,
      message: 'User updated successfully'
    });
  } catch (err) {
    console.error('Database update error:', err);
    return res.status(500).json({ success: false, message: 'Database error' });
  } finally {
    if (connection) connection.release();
  }
});

// Delete a user
router.delete('/:id', async (req, res) => {
  let connection;
  
  try {
    connection = await db.promisePool.getConnection();
    const query = 'DELETE FROM users WHERE id = ?';
    const [results] = await connection.query(query, [req.params.id]);
    
    if (results.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    return res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (err) {
    console.error('Database delete error:', err);
    return res.status(500).json({ success: false, message: 'Database error' });
  } finally {
    if (connection) connection.release();
  }
});

// Get all user types (distinct values from the type column)
router.get('/types/all', async (req, res) => {
  let connection;
  
  try {
    connection = await db.promisePool.getConnection();
    const query = 'SELECT DISTINCT type FROM users';
    const [results] = await connection.query(query);
    
    const types = results.map(row => row.type);
    
    return res.json({
      success: true,
      types
    });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ success: false, message: 'Database error' });
  } finally {
    if (connection) connection.release();
  }
});

// Get user by ID with additional info
router.get('/:id/details', async (req, res) => {
  let connection;
  
  try {
    connection = await db.promisePool.getConnection();
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
    
    const [results] = await connection.query(query, [req.params.id]);
    
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
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ success: false, message: 'Database error' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;