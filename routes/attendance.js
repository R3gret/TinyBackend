const express = require('express');
const router = express.Router();
const db = require('../db');
const { body, validationResult } = require('express-validator');

// Insert attendance record with status
router.post('/', [
  body('student_id').isInt().withMessage('Student ID must be an integer'),
  body('attendance_date').isISO8601().withMessage('Invalid date format (YYYY-MM-DD)'),
  body('status').isIn(['Present', 'Absent', 'Late', 'Excused']).withMessage('Invalid status')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { student_id, attendance_date, status } = req.body;
  let connection;

  try {
    connection = await db.promisePool.getConnection();

    // Check if student exists
    const [student] = await connection.query(
      'SELECT student_id FROM students WHERE student_id = ?',
      [student_id]
    );

    if (student.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    // Check if attendance record already exists
    const [existing] = await connection.query(
      'SELECT attendance_id FROM attendance WHERE student_id = ? AND attendance_date = ?',
      [student_id, attendance_date]
    );

    if (existing.length > 0) {
      await connection.query(
        'UPDATE attendance SET status = ? WHERE attendance_id = ?',
        [status, existing[0].attendance_id]
      );

      return res.status(200).json({ 
        success: true,
        message: 'Attendance record updated successfully'
      });
    }

    // Insert new record
    const [result] = await connection.query(
      'INSERT INTO attendance (student_id, attendance_date, status) VALUES (?, ?, ?)',
      [student_id, attendance_date, status]
    );

    res.status(201).json({
      success: true,
      attendance_id: result.insertId,
      message: 'Attendance record created successfully'
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error',
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Bulk insert attendance records
// In your backend attendance route file
router.post('/bulk', [
  body().isArray(),
  body('*.student_id').isInt(),
  body('*.attendance_date').isISO8601(),
  body('*.status').isIn(['Present', 'Absent', 'Late', 'Excused'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const attendanceRecords = req.body; // Directly use the array
  let connection;

  try {
    connection = await db.promisePool.getConnection();

    // Validate students exist
    const studentIds = attendanceRecords.map(r => r.student_id);
    const [students] = await connection.query(
      'SELECT student_id FROM students WHERE student_id IN (?)',
      [studentIds]
    );

    if (students.length !== new Set(studentIds).size) {
      return res.status(404).json({
        success: false,
        message: 'One or more students not found'
      });
    }

    // Insert records
    const values = attendanceRecords.map(r => [
      r.student_id,
      r.attendance_date,
      r.status
    ]);

    const [result] = await connection.query(
      'INSERT INTO attendance (student_id, attendance_date, status) VALUES ?',
      [values]
    );

    res.status(201).json({
      success: true,
      insertedCount: result.affectedRows,
      message: 'Attendance records created successfully'
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error',
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Get attendance records
router.get('/', async (req, res) => {
  let connection;

  try {
    connection = await db.promisePool.getConnection();

    const [results] = await connection.query(
      `SELECT 
        a.*, 
        s.first_name, 
        s.last_name,
        DATE_FORMAT(a.attendance_date, '%Y-%m-%d') AS formatted_date
       FROM attendance a 
       JOIN students s ON a.student_id = s.student_id`
    );

    res.json({
      success: true,
      attendance: results
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error',
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
