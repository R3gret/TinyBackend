const express = require('express');
const router = express.Router();
const db = require('../db');

// Enhanced database error handler
const handleDatabaseError = (err, res) => {
  console.error('Database Error:', {
    message: err.message,
    code: err.code,
    sqlMessage: err.sqlMessage,
    sql: err.sql,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    timestamp: new Date().toISOString()
  });

  res.status(500).json({
    success: false,
    message: 'Database operation failed',
    ...(process.env.NODE_ENV === 'development' && {
      debug: {
        error: err.message,
        code: err.code
      }
    })
  });
};

// Create CDC endpoint with improved validation
router.post('/', async (req, res) => {
  const { name, region, province, municipality, barangay } = req.body;

  // Enhanced validation
  const missingFields = [];
  if (!name) missingFields.push('name');
  if (!region) missingFields.push('region');
  if (!province) missingFields.push('province');
  if (!municipality) missingFields.push('municipality');
  if (!barangay) missingFields.push('barangay');

  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields',
      missingFields
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // Insert location with error handling
    const locationQuery = `
      INSERT INTO cdc_location 
      (Region, province, municipality, barangay) 
      VALUES (?, ?, ?, ?)
    `;
    
    const [locationResults] = await connection.query(locationQuery, [
      region, province, municipality, barangay
    ]);

    const locationId = locationResults.insertId;

    // Insert CDC reference
    const [cdcResults] = await connection.query(
      `INSERT INTO cdc (location_id) VALUES (?)`,
      [locationId]
    );

    await connection.commit();
    
    return res.json({
      success: true,
      message: 'CDC created successfully',
      data: {
        cdcId: cdcResults.insertId,
        locationId
      }
    });

  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('Rollback Error:', rollbackErr);
      }
    }
    handleDatabaseError(err, res);
  } finally {
    if (connection) {
      try {
        await connection.release();
      } catch (releaseErr) {
        console.error('Connection Release Error:', releaseErr);
      }
    }
  }
});

// Get CDCs with robust filtering
router.get('/', async (req, res) => {
  const { province, municipality, barangay, page = 1, limit = 20 } = req.query;
  
  // Validate pagination parameters
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const offset = (pageNum - 1) * limitNum;

  if (isNaN(pageNum)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid page number'
    });
  }

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
  
  // Add filters if provided
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
  
  // Add pagination
  const paginatedQuery = query + ` LIMIT ? OFFSET ?`;
  const paginationParams = [...params, limitNum, offset];

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) as total FROM (${query}) as count_query`;
    const [countResult] = await connection.query(countQuery, params);
    const total = countResult[0].total;

    // Get paginated results
    const [results] = await connection.query(paginatedQuery, paginationParams);
    
    res.json({ 
      success: true,
      data: results,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    });
    
  } catch (err) {
    handleDatabaseError(err, res);
  } finally {
    if (connection) {
      try {
        await connection.release();
      } catch (releaseErr) {
        console.error('Connection Release Error:', releaseErr);
      }
    }
  }
});

module.exports = router;