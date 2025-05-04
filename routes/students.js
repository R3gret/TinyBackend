const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

// Middleware to get CDC ID from JWT
const getPresidentCdcId = async (req) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new Error('Unauthorized');

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const loggedInUserId = decoded.id;

  const connection = await db.promisePool.getConnection();
  try {
    const [currentUser] = await connection.query(
      'SELECT cdc_id FROM users WHERE id = ? AND type = ?', 
      [loggedInUserId, 'president']  // Using parameterized query
    );
    if (!currentUser.length) throw new Error('President not found');
    return currentUser[0].cdc_id;
  } finally {
    connection.release();
  }
};

// Base student query with CDC filtering
router.get('/', async (req, res) => {
  const { ageFilter } = req.query;
  let connection;
  
  try {
    const cdcId = await getPresidentCdcId(req);
    connection = await db.promisePool.getConnection();

    let query = `
      SELECT s.student_id, s.first_name, s.middle_name, s.last_name, s.birthdate, s.gender 
      FROM students s
      JOIN student_cdc sc ON s.student_id = sc.student_id
      WHERE sc.cdc_id = ?
    `;
    const params = [cdcId];
    
    if (ageFilter) {
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
      
      query += ' AND s.birthdate BETWEEN ? AND ?';
      params.push(minDate.toISOString().split('T')[0], maxDate.toISOString().split('T')[0]);
    }

    const [results] = await connection.query(query, params);

    const studentsWithAge = results.map(student => {
      const birthDate = new Date(student.birthdate);
      const today = new Date();
      
      let years = today.getFullYear() - birthDate.getFullYear();
      let months = today.getMonth() - birthDate.getMonth();
      
      if (months < 0 || (months === 0 && today.getDate() < birthDate.getDate())) {
        years--;
        months += 12;
      }
      
      if (today.getDate() < birthDate.getDate()) {
        months--;
        if (months < 0) months += 12;
      }
      
      const ageDecimal = years + (months / 12);
      
      return {
        ...student,
        age: ageDecimal.toFixed(1)
      };
    });

    return res.json({
      success: true,
      students: studentsWithAge
    });
  } catch (err) {
    console.error('Error:', err);
    if (err.message === 'Unauthorized') {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return res.status(500).json({ 
      success: false, 
      message: 'Database error' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Gender distribution with CDC filtering
router.get('/gender-distribution', async (req, res) => {
  const { ageFilter } = req.query;
  let connection;
  
  try {
    const cdcId = await getPresidentCdcId(req);
    connection = await db.promisePool.getConnection();

    let query = `
      SELECT s.gender, COUNT(*) as count 
      FROM students s
      JOIN student_cdc sc ON s.student_id = sc.student_id
      WHERE sc.cdc_id = ?
    `;
    const params = [cdcId];
    
    if (ageFilter) {
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
      
      query += ' AND s.birthdate BETWEEN ? AND ?';
      params.push(minDate.toISOString().split('T')[0], maxDate.toISOString().split('T')[0]);
    }
    
    query += ' GROUP BY s.gender';

    const [results] = await connection.query(query, params);
    const distribution = {};
    results.forEach(row => {
      distribution[row.gender] = row.count;
    });

    return res.json({
      success: true,
      distribution
    });
  } catch (err) {
    console.error('Error:', err);
    if (err.message === 'Unauthorized') {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return res.status(500).json({ 
      success: false, 
      message: 'Database error' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Enrollment stats with CDC filtering
router.get('/enrollment-stats', async (req, res) => {
  let connection;
  try {
    const cdcId = await getPresidentCdcId(req);
    connection = await db.promisePool.getConnection();
    
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    
    let lastMonth = currentMonth - 1;
    let lastYear = currentYear;
    if (lastMonth === 0) {
      lastMonth = 12;
      lastYear = currentYear - 1;
    }
    
    // All queries now include CDC filtering
    const [currentMonthResults] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM students s
       JOIN student_cdc sc ON s.student_id = sc.student_id
       WHERE MONTH(s.enrolled_at) = ? 
       AND YEAR(s.enrolled_at) = ?
       AND sc.cdc_id = ?`,
      [currentMonth, currentYear, cdcId]
    );
    
    const [lastMonthResults] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM students s
       JOIN student_cdc sc ON s.student_id = sc.student_id
       WHERE MONTH(s.enrolled_at) = ? 
       AND YEAR(s.enrolled_at) = ?
       AND sc.cdc_id = ?`,
      [lastMonth, lastYear, cdcId]
    );
    
    const [totalResults] = await connection.query(
      `SELECT COUNT(*) as total 
       FROM students s
       JOIN student_cdc sc ON s.student_id = sc.student_id
       WHERE sc.cdc_id = ?`,
      [cdcId]
    );
    
    return res.json({
      success: true,
      stats: {
        total: totalResults[0].total,
        currentMonthEnrollments: currentMonthResults[0].count,
        lastMonthEnrollments: lastMonthResults[0].count,
        difference: currentMonthResults[0].count - lastMonthResults[0].count
      }
    });
    
  } catch (err) {
    console.error('Error:', err);
    if (err.message === 'Unauthorized') {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return res.status(500).json({ 
      success: false, 
      message: 'Database error' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Age distribution with CDC filtering
router.get('/age-distribution', async (req, res) => {
  let connection;
  try {
    const cdcId = await getPresidentCdcId(req);
    connection = await db.promisePool.getConnection();
    
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();
    const currentDay = today.getDate();
    
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
    
    const distribution = {};
    
    for (const [group, dates] of Object.entries(ageGroups)) {
      const [results] = await connection.query(
        `SELECT COUNT(*) as count 
         FROM students s
         JOIN student_cdc sc ON s.student_id = sc.student_id
         WHERE s.birthdate BETWEEN ? AND ?
         AND sc.cdc_id = ?`,
        [dates.minDate.toISOString().split('T')[0], dates.maxDate.toISOString().split('T')[0], cdcId]
      );
      
      distribution[group] = results[0].count;
    }
    
    return res.json({
      success: true,
      distribution
    });
    
  } catch (err) {
    console.error('Error:', err);
    if (err.message === 'Unauthorized') {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return res.status(500).json({ 
      success: false, 
      message: 'Database error' 
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;