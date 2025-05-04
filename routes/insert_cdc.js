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
        code: err.code,
        sql: err.sql
      }
    })
  });
};

// Helper function to validate CDC data
const validateCDCData = (data) => {
  const { name, region, province, municipality, barangay } = data;
  const missingFields = [];
  
  if (!name) missingFields.push('name');
  if (!region) missingFields.push('region');
  if (!province) missingFields.push('province');
  if (!municipality) missingFields.push('municipality');
  if (!barangay) missingFields.push('barangay');

  return missingFields;
};

// Create CDC endpoint
router.post('/', async (req, res) => {
  const missingFields = validateCDCData(req.body);
  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields',
      missingFields
    });
  }

  const { name, region, province, municipality, barangay } = req.body;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // Insert location
    const [locationResults] = await connection.query(
      `INSERT INTO cdc_location 
       (Region, province, municipality, barangay) 
       VALUES (?, ?, ?, ?)`,
      [region, province, municipality, barangay]
    );

    const locationId = locationResults.insertId;

    // Insert CDC with name
    const [cdcResults] = await connection.query(
      `INSERT INTO cdc (location_id, name) VALUES (?, ?)`,
      [locationId, name]
    );

    await connection.commit();
    
    // Get the full created CDC data
    const [newCDC] = await connection.query(
      `SELECT c.cdc_id as cdcId, c.name, cl.Region as region, 
              cl.province, cl.municipality, cl.barangay
       FROM cdc c
       JOIN cdc_location cl ON c.location_id = cl.location_id
       WHERE c.cdc_id = ?`,
      [cdcResults.insertId]
    );

    return res.status(201).json({
      success: true,
      message: 'CDC created successfully',
      data: newCDC[0]
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

// Get all CDCs with filtering and pagination
router.get('/', async (req, res) => {
  const { province, municipality, barangay, page = 1, limit = 20 } = req.query;
  
  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    if (isNaN(pageNum) || isNaN(limitNum) || pageNum < 1 || limitNum < 1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pagination parameters'
      });
    }

    let connection;
    try {
      connection = await db.promisePool.getConnection();

      // Base query with all fields
      let query = `
        SELECT 
          c.cdc_id as cdcId,
          c.name,
          cl.Region as region,
          cl.province,
          cl.municipality,
          cl.barangay
        FROM cdc c
        JOIN cdc_location cl ON c.location_id = cl.location_id
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
      
      // Get total count (optimized version)
      const countQuery = `
        SELECT COUNT(*) as total 
        FROM cdc c
        JOIN cdc_location cl ON c.location_id = cl.location_id
        ${conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''}
      `;
      
      const [countResult] = await connection.query(countQuery, params);
      const total = countResult[0].total;

      // Get paginated results
      const [results] = await connection.query(
        query + ` LIMIT ? OFFSET ?`,
        [...params, limitNum, offset]
      );
      
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
      console.error('Database error:', {
        query: err.sql,
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      });
      res.status(500).json({
        success: false,
        message: 'Failed to fetch CDC data',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    } finally {
      if (connection) await connection.release();
    }
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get single CDC by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    const [results] = await connection.query(
      `SELECT c.cdc_id as cdcId, c.name, cl.Region as region, 
              cl.province, cl.municipality, cl.barangay
       FROM cdc c
       JOIN cdc_location cl ON c.location_id = cl.location_id
       WHERE c.cdc_id = ?`,
      [id]
    );
    
    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'CDC not found'
      });
    }
    
    res.json({
      success: true,
      data: results[0]
    });
    
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch CDC',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) await connection.release();
  }
});

// Update CDC endpoint
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const missingFields = validateCDCData(req.body);
  
  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields',
      missingFields
    });
  }

  const { name, region, province, municipality, barangay } = req.body;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // Get the location_id for this CDC
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
    
    // Get the updated CDC data
    const [updatedCDC] = await connection.query(
      `SELECT c.cdc_id as cdcId, c.name, cl.Region as region, 
              cl.province, cl.municipality, cl.barangay
       FROM cdc c
       JOIN cdc_location cl ON c.location_id = cl.location_id
       WHERE c.cdc_id = ?`,
      [id]
    );
    
    res.json({
      success: true,
      message: 'CDC updated successfully',
      data: updatedCDC[0]
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

    // Get the location_id for this CDC
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
    
    res.json({
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