const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('./authMiddleware');

router.get('/', authenticate, async (req, res) => {
  const { ageFilter } = req.query;
  
    let query = 'SELECT student_id, first_name, middle_name, last_name, birthdate, gender, cdc_id FROM students';
    const userCdcId = req.user.cdc_id;
  const params = [];
  
  if (ageFilter) {
    // Calculate date ranges based on age filter using native Date
    const today = new Date();
    let minDate, maxDate;
    
    switch(ageFilter) {
      case '3-4':
        // For 3.0-4.0 years (36-48 months)
        maxDate = new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
        minDate = new Date(today.getFullYear() - 4, today.getMonth(), today.getDate());
        break;
      case '4-5':
        // For 4.1-5.0 years (49-60 months)
        maxDate = new Date(today.getFullYear() - 4, today.getMonth(), today.getDate());
        minDate = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
        break;
      case '5-6':
        // For 5.1-5.11 years (61-71 months)
        maxDate = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
        minDate = new Date(today.getFullYear() - 6, today.getMonth(), today.getDate());
        break;
      default:
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid age filter' 
        });
    }
    
      let whereClauses = [];
      whereClauses.push('birthdate BETWEEN ? AND ?');
      params.push(minDate.toISOString().split('T')[0], maxDate.toISOString().split('T')[0]);
  }
    // Always filter by CDC
    whereClauses.push('cdc_id = ?');
    params.push(userCdcId);
    if (whereClauses.length) {
      query += ' WHERE ' + whereClauses.join(' AND ');
    }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query(query, params);

    // Calculate ages using the same method as frontend
    const studentsWithAge = results.map(student => {
      const birthDate = new Date(student.birthdate);
      const today = new Date();
      
      let years = today.getFullYear() - birthDate.getFullYear();
      let months = today.getMonth() - birthDate.getMonth();
      
      // Adjust for month and day differences
      if (months < 0 || (months === 0 && today.getDate() < birthDate.getDate())) {
        years--;
        months += 12;
      }
      
      if (today.getDate() < birthDate.getDate()) {
        months--;
        if (months < 0) {
          months += 12;
        }
      }
      
      // Convert to decimal age (e.g., 3.5 for 3 years 6 months)
      const ageDecimal = years + (months / 12);
      
      return {
        ...student,
        age: ageDecimal.toFixed(1) // Format to 1 decimal place
      };
    });

    return res.json({
      success: true,
      students: studentsWithAge
    });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Database error' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// New route to get gender distribution
router.get('/gender-distribution', authenticate, async (req, res) => {
  const { ageFilter } = req.query;

  // Build base query and params, apply CDC filter and optional age filter
  let query = 'SELECT gender, COUNT(*) as count FROM students';
  const params = [];
  const userCdcId = req.user.cdc_id;
  const whereClauses = [];

  if (ageFilter) {
    const today = new Date();
    let minDate, maxDate;
    switch (ageFilter) {
      case '3-4':
        maxDate = new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
        minDate = new Date(today.getFullYear() - 4, today.getMonth(), today.getDate());
        break;
      case '4-5':
        maxDate = new Date(today.getFullYear() - 4, today.getMonth(), today.getDate());
        minDate = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
        break;
      case '5-6':
        maxDate = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
        minDate = new Date(today.getFullYear() - 6, today.getMonth(), today.getDate());
        break;
      default:
        return res.status(400).json({ success: false, message: 'Invalid age filter' });
    }

    whereClauses.push('birthdate BETWEEN ? AND ?');
    params.push(minDate.toISOString().split('T')[0], maxDate.toISOString().split('T')[0]);
  }

  // Always filter by CDC
  whereClauses.push('cdc_id = ?');
  params.push(userCdcId);

  if (whereClauses.length) {
    query += ' WHERE ' + whereClauses.join(' AND ');
  }

  query += ' GROUP BY gender';

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query(query, params);

    const distribution = {};
    results.forEach(row => {
      distribution[row.gender] = row.count;
    });

    return res.json({ success: true, distribution });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ success: false, message: 'Database error' });
  } finally {
    if (connection) connection.release();
  }
});


// Add this new route to your students router
router.get('/enrollment-stats', authenticate, async (req, res) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();

    // Get current month stats
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    // Get last month stats (handle year transition)
    let lastMonth = currentMonth - 1;
    let lastYear = currentYear;
    if (lastMonth === 0) {
      lastMonth = 12;
      lastYear = currentYear - 1;
    }

    // CDC filter
    const userCdcId = req.user.cdc_id;

    // Query for current month enrollments
    const [currentMonthResults] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM students 
       WHERE MONTH(enrolled_at) = ? AND YEAR(enrolled_at) = ? AND cdc_id = ?`,
      [currentMonth, currentYear, userCdcId]
    );

    // Query for last month enrollments
    const [lastMonthResults] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM students 
       WHERE MONTH(enrolled_at) = ? AND YEAR(enrolled_at) = ? AND cdc_id = ?`,
      [lastMonth, lastYear, userCdcId]
    );

    // Query for total students (all months)
    const [totalResults] = await connection.query(
      `SELECT COUNT(*) as total FROM students WHERE cdc_id = ?`,
      [userCdcId]
    );
    
    return res.json({
      success: true,
      stats: {
        total: totalResults[0].total, // All students
        currentMonthEnrollments: currentMonthResults[0].count, // Just this month's new students
        lastMonthEnrollments: lastMonthResults[0].count, // Just last month's new students
        difference: currentMonthResults[0].count - lastMonthResults[0].count // Comparison
      }
    });
    
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Database error' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// New route to get age group distribution
router.get('/age-distribution', authenticate, async (req, res) => {
    let connection;
    try {
      connection = await db.promisePool.getConnection();
      
      // Get current date for age calculations
      const today = new Date();
      const currentYear = today.getFullYear();
      const currentMonth = today.getMonth();
      const currentDay = today.getDate();
      
      // Calculate date ranges for each age group
      const ageGroups = {
        '3-4': {
          minDate: new Date(currentYear - 4, currentMonth, currentDay),
          maxDate: new Date(currentYear - 3, currentMonth, currentDay)
        },
        '4-5': {
          minDate: new Date(currentYear - 5, currentMonth, currentDay),
          maxDate: new Date(currentYear - 4, currentMonth, currentDay)
        },
        '5-6': {
          minDate: new Date(currentYear - 6, currentMonth, currentDay),
          maxDate: new Date(currentYear - 5, currentMonth, currentDay)
        }
      };
      
      // Query to count students in each age group
      const distribution = {};
      
      const userCdcId = req.user.cdc_id;
      for (const [group, dates] of Object.entries(ageGroups)) {
        const [results] = await connection.query(
          `SELECT COUNT(*) as count 
           FROM students 
           WHERE birthdate BETWEEN ? AND ? AND cdc_id = ?`,
          [dates.minDate.toISOString().split('T')[0], dates.maxDate.toISOString().split('T')[0], userCdcId]
        );

        distribution[group] = results[0].count;
      }
      
      return res.json({
        success: true,
        distribution
      });
      
    } catch (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Database error' 
      });
    } finally {
      if (connection) connection.release();
    }
  });

  
module.exports = router;