const express = require('express');
const router = express.Router();
const db = require('../db');

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

// New route to get age group distribution
router.get('/age-distribution', async (req, res) => {
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
    
    for (const [group, dates] of Object.entries(ageGroups)) {
      const [results] = await connection.query(
        `SELECT COUNT(*) as count 
         FROM students 
         WHERE birthdate BETWEEN ? AND ?`,
        [dates.minDate.toISOString().split('T')[0], dates.maxDate.toISOString().split('T')[0]]
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