const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('./authMiddleware');
const { getAcademicYearDateRange } = require('../utils/academicYear');

router.get('/', authMiddleware, async (req, res) => {
  const { ageFilter } = req.query;
  const { cdc_id } = req.user;
  
  let query = 'SELECT student_id, first_name, middle_name, last_name, birthdate, gender FROM students WHERE cdc_id = ?';
  const params = [cdc_id];
  
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
    
    query += ' AND birthdate BETWEEN ? AND ?';
    params.push(minDate.toISOString().split('T')[0], maxDate.toISOString().split('T')[0]);
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
router.get('/gender-distribution', authMiddleware, async (req, res) => {
  const { ageFilter, academic_year } = req.query;
  const { cdc_id } = req.user;

  if (!cdc_id) {
    return res.status(400).json({
      success: false,
      message: 'User is not associated with a CDC.'
    });
  }
  
  let query = 'SELECT gender, COUNT(*) as count FROM students WHERE cdc_id = ?';
  const params = [cdc_id];
  
  // Filter by academic year if provided
  if (academic_year) {
    const dateRange = getAcademicYearDateRange(academic_year);
    if (!dateRange) {
      return res.status(400).json({
        success: false,
        message: 'Invalid academic year format. Expected format: "YYYY-YYYY+1" (e.g., "2025-2026")'
      });
    }
    query += ' AND enrolled_at >= ? AND enrolled_at <= ?';
    params.push(dateRange.startDate, dateRange.endDate);
  }
  
  if (ageFilter) {
    // Calculate date ranges based on age filter using native Date
    const today = new Date();
    let minDate, maxDate;
    
    switch(ageFilter) {
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
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid age filter' 
        });
    }
    
    query += ' AND birthdate BETWEEN ? AND ?';
    params.push(minDate.toISOString().split('T')[0], maxDate.toISOString().split('T')[0]);
  }
  
  query += ' GROUP BY gender';

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    console.log('Executing query:', query, 'with params:', params);
    const [results] = await connection.query(query, params);

    // Transform results into a more usable format
    const distribution = {};
    results.forEach(row => {
      distribution[row.gender] = row.count;
    });

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


// Add this new route to your students router
router.get('/enrollment-stats', authMiddleware, async (req, res) => {
  let connection;
  try {
    const { academic_year } = req.query;
    const { cdc_id } = req.user;

    if (!cdc_id) {
      return res.status(400).json({
        success: false,
        message: 'User is not associated with a CDC.'
      });
    }
    connection = await db.promisePool.getConnection();
    
    // Get academic year date range if provided
    let academicYearDateRange = null;
    if (academic_year) {
      academicYearDateRange = getAcademicYearDateRange(academic_year);
      if (!academicYearDateRange) {
        return res.status(400).json({
          success: false,
          message: 'Invalid academic year format. Expected format: "YYYY-YYYY+1" (e.g., "2025-2026")'
        });
      }
    }
    
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
    
    // Query for current month enrollments
    let currentMonthQuery = `SELECT COUNT(*) as count 
       FROM students 
       WHERE MONTH(enrolled_at) = ? AND YEAR(enrolled_at) = ? AND cdc_id = ?`;
    const currentMonthParams = [currentMonth, currentYear, cdc_id];
    if (academicYearDateRange) {
      currentMonthQuery += ' AND enrolled_at >= ? AND enrolled_at <= ?';
      currentMonthParams.push(academicYearDateRange.startDate, academicYearDateRange.endDate);
    }
    console.log('Executing query:', currentMonthQuery, 'with params:', currentMonthParams);
    const [currentMonthResults] = await connection.query(currentMonthQuery, currentMonthParams);
    
    // Query for last month enrollments
    let lastMonthQuery = `SELECT COUNT(*) as count 
       FROM students 
       WHERE MONTH(enrolled_at) = ? AND YEAR(enrolled_at) = ? AND cdc_id = ?`;
    const lastMonthParams = [lastMonth, lastYear, cdc_id];
    if (academicYearDateRange) {
      lastMonthQuery += ' AND enrolled_at >= ? AND enrolled_at <= ?';
      lastMonthParams.push(academicYearDateRange.startDate, academicYearDateRange.endDate);
    }
    console.log('Executing query:', lastMonthQuery, 'with params:', lastMonthParams);
    const [lastMonthResults] = await connection.query(lastMonthQuery, lastMonthParams);
    
    // Query for total students (filtered by academic year if provided)
    let totalQuery = `SELECT COUNT(*) as total FROM students WHERE cdc_id = ?`;
    const totalParams = [cdc_id];
    if (academicYearDateRange) {
      totalQuery += ' AND enrolled_at >= ? AND enrolled_at <= ?';
      totalParams.push(academicYearDateRange.startDate, academicYearDateRange.endDate);
    }
    console.log('Executing query:', totalQuery, 'with params:', totalParams);
    const [totalResults] = await connection.query(totalQuery, totalParams);
    
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
router.get('/age-distribution', authMiddleware, async (req, res) => {
    let connection;
    try {
      const { academic_year } = req.query;
      const { cdc_id } = req.user;

      if (!cdc_id) {
        return res.status(400).json({
          success: false,
          message: 'User is not associated with a CDC.'
        });
      }
      connection = await db.promisePool.getConnection();
      
      // Get academic year date range if provided
      let academicYearDateRange = null;
      if (academic_year) {
        academicYearDateRange = getAcademicYearDateRange(academic_year);
        if (!academicYearDateRange) {
          return res.status(400).json({
            success: false,
            message: 'Invalid academic year format. Expected format: "YYYY-YYYY+1" (e.g., "2025-2026")'
          });
        }
      }
      
      // Get current date for age calculations
      const today = new Date();
      const currentYear = today.getFullYear();
      const currentMonth = today.getMonth();
      const currentDay = today.getDate();
      
      // Calculate date ranges for each age group
      const ageGroups = {
        '0-3': {
          minDate: new Date(currentYear - 3, currentMonth, currentDay),
          maxDate: today
        },
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
      
      for (const [group, dates] of Object.entries(ageGroups)) {
        let query = `SELECT COUNT(*) as count 
           FROM students 
           WHERE birthdate BETWEEN ? AND ? AND cdc_id = ?`;
        const params = [dates.minDate.toISOString().split('T')[0], dates.maxDate.toISOString().split('T')[0], cdc_id];
        
        // Add academic year filter if provided
        if (academicYearDateRange) {
          query += ' AND enrolled_at >= ? AND enrolled_at <= ?';
          params.push(academicYearDateRange.startDate, academicYearDateRange.endDate);
        }
        
        console.log('Executing query for group', group, ':', query, 'with params:', params);
        const [results] = await connection.query(query, params);
        
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