const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

// Middleware to get CDC ID from JWT (same as working endpoint)
const getPresidentCdcId = async (req) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new Error('Unauthorized');

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const loggedInUserId = decoded.id;

  const connection = await db.promisePool.getConnection();
  try {
    const [currentUser] = await connection.query(
      'SELECT cdc_id FROM users WHERE id = ? AND type = ?', 
      [loggedInUserId, 'president']
    );
    if (!currentUser.length) throw new Error('President not found');
    return currentUser[0].cdc_id;
  } finally {
    connection.release();
  }
};

// Updated endpoint at /api/att
router.get('/att', async (req, res) => {
  const { ageFilter } = req.query;
  let connection;
  
  try {
    const cdcId = await getPresidentCdcId(req);
    connection = await db.promisePool.getConnection();

    let query = `
      SELECT student_id, first_name, middle_name, last_name, birthdate, gender 
      FROM students
      WHERE cdc_id = ?
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
      
      query += ' AND birthdate BETWEEN ? AND ?';
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
    if (err.message === 'Unauthorized' || err.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (err.message === 'President not found') {
      return res.status(403).json({ success: false, message: 'Access denied' });
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