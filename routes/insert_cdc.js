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

module.exports = router;