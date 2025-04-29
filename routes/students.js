// studentsRouter.js
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

module.exports = router;