const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

// Middleware to get student info (age and CDC) for parent users
const getStudentInfo = async (req) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new Error('Unauthorized');

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const loggedInUserId = decoded.id;

  const connection = await db.promisePool.getConnection();
  try {
    // Verify user is a parent
    const [currentUser] = await connection.query(
      'SELECT id FROM users WHERE id = ? AND type = ?', 
      [loggedInUserId, 'parent']
    );
    if (!currentUser.length) throw new Error('Parent not found');

    // Get student details with CDC info
    const [studentInfo] = await connection.query(
      `SELECT g.student_id, s.birthdate, s.cdc_id 
       FROM guardian_info g
       JOIN students s ON g.student_id = s.student_id
       WHERE g.id = ?`,
      [loggedInUserId]
    );
    
    if (!studentInfo.length) throw new Error('Student not found for this parent');
    
    // Calculate age (same method as your example)
    const birthDate = new Date(studentInfo[0].birthdate);
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
    const age = parseFloat(ageDecimal.toFixed(1));
    
    return {
      student_id: studentInfo[0].student_id,
      age,
      cdc_id: studentInfo[0].cdc_id
    };
  } finally {
    connection.release();
  }
};

// Endpoint to get filtered announcements
router.get('/announcements', async (req, res) => {
  let connection;
  
  try {
    // Get student info
    const { student_id, age, cdc_id } = await getStudentInfo(req);
    connection = await db.promisePool.getConnection();

    // Determine age group
    let ageGroup;
    if (age >= 3 && age < 4) {
      ageGroup = '3-4';
    } else if (age >= 4 && age < 5) {
      ageGroup = '4-5';
    } else if (age >= 5 && age <= 6) {
      ageGroup = '5-6';
    } else {
      ageGroup = 'other';
    }

    // Query announcements that match:
    // 1. The student's age group OR 'all' age filter
    // AND
    // 2. Either:
    //    - No specific CDC (cdc_id IS NULL) - applies to all CDCs
    //    - OR matches the student's CDC (cdc_id = student's cdc_id)
    const [announcements] = await connection.query(
      `SELECT * FROM announcements 
       WHERE (age_filter = ? OR age_filter = 'all')
       AND (cdc_id IS NULL OR cdc_id = ?)
       ORDER BY created_at DESC`,
      [ageGroup, cdc_id]
    );

    return res.json({
      success: true,
      student_id,
      age,
      ageGroup,
      cdc_id,
      announcements
    });
  } catch (err) {
    console.error('Error:', err);
    if (err.message === 'Unauthorized') {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (err.message === 'Parent not found') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    if (err.message === 'Student not found for this parent') {
      return res.status(404).json({ success: false, message: 'No associated student found' });
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