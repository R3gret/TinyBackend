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

router.get('/', async (req, res) => {
  const { province, municipality, barangay, page = 1, limit = 20 } = req.query;
  
  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    let connection;
    try {
      connection = await db.promisePool.getConnection();

      // Updated query with correct column names
      let query = `
        SELECT 
          c.cdc_id as cdcId,
          cl.Region as region,
          cl.province as province,
          cl.municipality as municipality,
          cl.barangay as barangay
        FROM cdc c
        JOIN cdc_location cl ON c.location_id = cl.location_id
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
      
      // Get total count
      const countQuery = `SELECT COUNT(*) as total FROM (${query}) as count_query`;
      const [countResult] = await connection.query(countQuery, params);
      const total = countResult[0].total;

      // Get paginated results
      const paginatedQuery = query + ` LIMIT ? OFFSET ?`;
      const [results] = await connection.query(paginatedQuery, [...params, limitNum, offset]);
      
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
      console.error('Database error:', err);
      res.status(500).json({
        success: false,
        message: 'Database operation failed',
        error: err.message
      });
    } finally {
      if (connection) await connection.release();
    }
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Update CDC endpoint
router.put('/:id', async (req, res) => {
  const { id } = req.params;
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

    // First get the location_id for this CDC
    const [cdcResults] = await connection.query(
      'SELECT location_id FROM cdc WHERE cdc_id = ?',
      [id]
    );

    if (cdcResults.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'CDC not found'
      });
    }

    const locationId = cdcResults[0].location_id;

    // Update CDC name
    await connection.query(
      'UPDATE cdc SET name = ? WHERE cdc_id = ?',
      [name, id]
    );

    // Update location
    await connection.query(
      `UPDATE cdc_location SET 
        Region = ?,
        province = ?,
        municipality = ?,
        barangay = ?
      WHERE location_id = ?`,
      [region, province, municipality, barangay, locationId]
    );

    await connection.commit();
    
    return res.json({
      success: true,
      message: 'CDC updated successfully'
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

// Delete CDC endpoint
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // First get the location_id for this CDC
    const [cdcResults] = await connection.query(
      'SELECT location_id FROM cdc WHERE cdc_id = ?',
      [id]
    );

    if (cdcResults.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'CDC not found'
      });
    }

    const locationId = cdcResults[0].location_id;

    // Delete CDC record
    await connection.query(
      'DELETE FROM cdc WHERE cdc_id = ?',
      [id]
    );

    // Delete location record
    await connection.query(
      'DELETE FROM cdc_location WHERE location_id = ?',
      [locationId]
    );

    await connection.commit();
    
    return res.json({
      success: true,
      message: 'CDC deleted successfully'
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

module.exports = router;