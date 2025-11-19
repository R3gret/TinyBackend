const express = require('express');
const router = express.Router();
const db = require('../db');

// Helper function to calculate academic year from enrollment date
// Academic year runs for 10 months: June to March (e.g., June 2024 - March 2025 = AY 2024-2025)
const getAcademicYear = (date) => {
  if (!date) return null;
  const enrollmentDate = new Date(date);
  const year = enrollmentDate.getFullYear();
  const month = enrollmentDate.getMonth() + 1; // 1-12
  
  // If enrolled between June (6) and December (12), AY is year-year+1
  // If enrolled between January (1) and March (3), AY is year-1-year
  // April and May are not part of academic year (break period)
  if (month >= 6) {
    return `${year}-${year + 1}`;
  } else if (month >= 1 && month <= 3) {
    return `${year - 1}-${year}`;
  } else {
    // April (4) and May (5) - return null or handle as break period
    return null;
  }
};

// Helper function to build location filter conditions
const buildLocationFilters = (query, params, province, municipality, barangay, cdcName) => {
  const conditions = [];
  
  if (province) {
    conditions.push('cl.province = ?');
    params.push(province);
  }
  
  if (municipality) {
    conditions.push('cl.municipality = ?');
    params.push(municipality);
  }
  
  if (barangay) {
    conditions.push('cl.barangay = ?');
    params.push(barangay);
  }
  
  if (cdcName) {
    conditions.push('c.name = ?');
    params.push(cdcName);
  }
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  return query;
};

// 1. CDC Distribution by Barangay (Bar Graph)
router.get('/cdc-distribution', async (req, res) => {
  const { province, municipality, barangay } = req.query;
  let connection;

  try {
    connection = await db.promisePool.getConnection();

    let query = `
      SELECT 
        cl.barangay,
        COUNT(DISTINCT c.cdc_id) as cdc_count
      FROM cdc c
      JOIN cdc_location cl ON c.location_id = cl.location_id
    `;
    
    const params = [];
    const conditions = [];
    
    if (province) {
      conditions.push('cl.province = ?');
      params.push(province);
    }
    
    if (municipality) {
      conditions.push('cl.municipality = ?');
      params.push(municipality);
    }
    
    if (barangay) {
      conditions.push('cl.barangay = ?');
      params.push(barangay);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' GROUP BY cl.barangay ORDER BY cl.barangay';

    const [results] = await connection.query(query, params);

    res.json({
      success: true,
      data: results.map(row => ({
        barangay: row.barangay,
        cdcCount: row.cdc_count
      }))
    });
  } catch (err) {
    console.error('Error fetching CDC distribution:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch CDC distribution',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

// 2. Gender Distribution Pie Chart (filterable by academic year, barangay, CDC name)
router.get('/gender-distribution', async (req, res) => {
  const { academicYear, barangay, cdcName } = req.query;
  let connection;

  try {
    connection = await db.promisePool.getConnection();

    let query = `
      SELECT 
        s.gender,
        COUNT(*) as count
      FROM students s
      JOIN cdc c ON s.cdc_id = c.cdc_id
      JOIN cdc_location cl ON c.location_id = cl.location_id
    `;
    
    const params = [];
    const conditions = [];
    
    if (barangay) {
      conditions.push('cl.barangay = ?');
      params.push(barangay);
    }
    
    if (cdcName) {
      conditions.push('c.name = ?');
      params.push(cdcName);
    }
    
    if (academicYear) {
      // Parse academic year (e.g., "2024-2025")
      const [startYear, endYear] = academicYear.split('-').map(Number);
      if (startYear && endYear) {
        // Academic year runs for 10 months: June of startYear to March of endYear
        conditions.push('((YEAR(s.enrolled_at) = ? AND MONTH(s.enrolled_at) >= 6) OR (YEAR(s.enrolled_at) = ? AND MONTH(s.enrolled_at) <= 3))');
        params.push(startYear, endYear);
      }
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' GROUP BY s.gender';

    const [results] = await connection.query(query, params);

    // Calculate total
    const total = results.reduce((sum, row) => sum + row.count, 0);

    res.json({
      success: true,
      data: results.map(row => ({
        gender: row.gender,
        count: row.count,
        percentage: total > 0 ? ((row.count / total) * 100).toFixed(2) : 0
      })),
      total
    });
  } catch (err) {
    console.error('Error fetching gender distribution:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch gender distribution',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

// 3. Age Distribution Bar Graph (filterable by barangay, CDC name)
router.get('/age-distribution', async (req, res) => {
  const { barangay, cdcName } = req.query;
  let connection;

  try {
    connection = await db.promisePool.getConnection();

    let query = `
      SELECT 
        CASE
          WHEN TIMESTAMPDIFF(YEAR, s.birthdate, CURDATE()) BETWEEN 3 AND 4 THEN '3-4 years'
          WHEN TIMESTAMPDIFF(YEAR, s.birthdate, CURDATE()) BETWEEN 4 AND 5 THEN '4-5 years'
          WHEN TIMESTAMPDIFF(YEAR, s.birthdate, CURDATE()) BETWEEN 5 AND 6 THEN '5-6 years'
          WHEN TIMESTAMPDIFF(YEAR, s.birthdate, CURDATE()) < 3 THEN 'Under 3 years'
          ELSE 'Over 6 years'
        END as age_group,
        COUNT(*) as count
      FROM students s
      JOIN cdc c ON s.cdc_id = c.cdc_id
      JOIN cdc_location cl ON c.location_id = cl.location_id
    `;
    
    const params = [];
    const conditions = [];
    
    if (barangay) {
      conditions.push('cl.barangay = ?');
      params.push(barangay);
    }
    
    if (cdcName) {
      conditions.push('c.name = ?');
      params.push(cdcName);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' GROUP BY age_group ORDER BY age_group';

    const [results] = await connection.query(query, params);

    res.json({
      success: true,
      data: results.map(row => ({
        ageGroup: row.age_group,
        count: row.count
      }))
    });
  } catch (err) {
    console.error('Error fetching age distribution:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch age distribution',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

// 4. Enrollment per Academic Year Line Graph (filterable by barangay, CDC name)
router.get('/enrollment-trend', async (req, res) => {
  const { barangay, cdcName } = req.query;
  let connection;

  try {
    connection = await db.promisePool.getConnection();

    let query = `
      SELECT 
        CASE
          WHEN MONTH(s.enrolled_at) >= 6 THEN CONCAT(YEAR(s.enrolled_at), '-', YEAR(s.enrolled_at) + 1)
          WHEN MONTH(s.enrolled_at) >= 1 AND MONTH(s.enrolled_at) <= 3 THEN CONCAT(YEAR(s.enrolled_at) - 1, '-', YEAR(s.enrolled_at))
          ELSE NULL
        END as academic_year,
        COUNT(*) as enrollment_count
      FROM students s
      JOIN cdc c ON s.cdc_id = c.cdc_id
      JOIN cdc_location cl ON c.location_id = cl.location_id
    `;
    
    const params = [];
    const conditions = [];
    
    if (barangay) {
      conditions.push('cl.barangay = ?');
      params.push(barangay);
    }
    
    if (cdcName) {
      conditions.push('c.name = ?');
      params.push(cdcName);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' GROUP BY academic_year HAVING academic_year IS NOT NULL ORDER BY academic_year';

    const [results] = await connection.query(query, params);

    res.json({
      success: true,
      data: results.map(row => ({
        academicYear: row.academic_year,
        enrollmentCount: row.enrollment_count
      }))
    });
  } catch (err) {
    console.error('Error fetching enrollment trend:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch enrollment trend',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

// 5. Number of CDW Workers (filterable by barangay, CDC name)
router.get('/cdw-workers', async (req, res) => {
  const { barangay, cdcName } = req.query;
  let connection;

  try {
    connection = await db.promisePool.getConnection();

    let query = `
      SELECT 
        COUNT(DISTINCT u.id) as worker_count
      FROM users u
      JOIN cdc c ON u.cdc_id = c.cdc_id
      JOIN cdc_location cl ON c.location_id = cl.location_id
      WHERE u.type = 'worker'
    `;
    
    const params = [];
    const conditions = [];
    
    if (barangay) {
      conditions.push('cl.barangay = ?');
      params.push(barangay);
    }
    
    if (cdcName) {
      conditions.push('c.name = ?');
      params.push(cdcName);
    }
    
    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }

    const [results] = await connection.query(query, params);

    res.json({
      success: true,
      data: {
        workerCount: results[0]?.worker_count || 0
      }
    });
  } catch (err) {
    console.error('Error fetching CDW workers:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch CDW workers',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;

