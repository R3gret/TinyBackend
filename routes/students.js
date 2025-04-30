const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  const { ageFilter } = req.query;
  
  let query = 'SELECT student_id, first_name, middle_name, last_name, birthdate, gender FROM students';
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
    
    query += ' WHERE birthdate BETWEEN ? AND ?';
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
router.get('/gender-distribution', async (req, res) => {
  const { ageFilter } = req.query;
  
  let query = 'SELECT gender, COUNT(*) as count FROM students';
  const params = [];
  
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
    
    query += ' WHERE birthdate BETWEEN ? AND ?';
    params.push(minDate.toISOString().split('T')[0], maxDate.toISOString().split('T')[0]);
  }
  
  query += ' GROUP BY gender';

  let connection;
  try {
    connection = await db.promisePool.getConnection();
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
router.get('/enrollment-stats', async (req, res) => {
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
    
    // Query for current month enrollments
    const [currentMonthResults] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM students 
       WHERE MONTH(enrolled_at) = ? AND YEAR(enrolled_at) = ?`,
      [currentMonth, currentYear]
    );
    
    // Query for last month enrollments
    const [lastMonthResults] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM students 
       WHERE MONTH(enrolled_at) = ? AND YEAR(enrolled_at) = ?`,
      [lastMonth, lastYear]
    );
    
    // Query for total students (all months)
    const [totalResults] = await connection.query(
      `SELECT COUNT(*) as total FROM students`
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
module.exports = router;