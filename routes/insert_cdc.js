const express = require('express');
const router = express.Router();
const db = require('../db');

router.post('/', async (req, res) => {
  const {
    name,
    region,
    province,
    municipality,
    barangay,
    location_details
  } = req.body;

  console.log("Received CDC data:", req.body);

  if (!name || !region || !province || !municipality || !barangay) {
    return res.status(400).json({ 
      success: false, 
      message: 'Required fields are missing. Please provide name and complete address.' 
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // Step 1: Insert into cdc_location first
    const locationQuery = `INSERT INTO cdc_location 
      (Region, province, municipality, barangay) 
      VALUES (?, ?, ?, ?)`;
    
    const [locationResults] = await connection.query(locationQuery, [
      region,
      province,
      municipality,
      barangay
    ]);

    const locationId = locationResults.insertId;
    console.log(`Inserted location ID: ${locationId}`);

    // Step 2: Insert into cdc table with reference to location
    const cdcQuery = `INSERT INTO cdc 
      (location_id) 
      VALUES (?)`;
    
    const [cdcResults] = await connection.query(cdcQuery, [
      locationId
    ]);

    const cdcId = cdcResults.insertId;
    console.log(`Inserted CDC ID: ${cdcId}`);

    await connection.commit();
    console.log('CDC created successfully with ID:', cdcId);
    return res.json({ 
      success: true, 
      message: 'CDC created successfully',
      cdcId,
      locationId
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Database error:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Database error during CDC creation',
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Add these endpoints to your existing cdcRoutes.js

// Get all CDCs with filtering
router.get('/', async (req, res) => {
  const { province, municipality, barangay } = req.query;
  
  let query = `
    SELECT 
      c.id as cdcId,
      cl.Region as region,
      cl.province as province,
      cl.municipality as municipality,
      cl.barangay as barangay,
      cl.created_at as createdAt
    FROM cdc c
    JOIN cdc_location cl ON c.location_id = cl.id
  `;
  
  const conditions = [];
  const params = [];
  
  if (province) {
    conditions.push('cl.province LIKE ?');
    params.push(`%${province}%`);
  }
  
  if (municipality) {
    conditions.push('cl.municipality LIKE ?');
    params.push(`%${municipality}%`);
  }
  
  if (barangay) {
    conditions.push('cl.barangay LIKE ?');
    params.push(`%${barangay}%`);
  }
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  query += ' ORDER BY cl.province, cl.municipality, cl.barangay';
  
  let connection;
  try {
    // Get connection from the pool
    connection = await db.promisePool.getConnection();
    
    // Execute query
    const [results] = await connection.query(query, params);
    
    res.json({ 
      success: true, 
      data: results 
    });
    
  } catch (err) {
    console.error('Database error:', {
      message: err.message,
      stack: err.stack,
      query: query,
      params: params,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({ 
      success: false, 
      message: 'Database operation failed',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
    
  } finally {
    // Always release the connection back to the pool
    if (connection) {
      try {
        await connection.release();
      } catch (releaseErr) {
        console.error('Error releasing connection:', releaseErr);
      }
    }
  }
});
module.exports = router;