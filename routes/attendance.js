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

// Add this to your attendance router file
router.get('/stats', async (req, res) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();

    // Get total attendance recordss
    const [totalResults] = await connection.query(
      `SELECT COUNT(*) as total FROM attendance`
    );

    // Get present records (count Present and Late as present)
    const [presentResults] = await connection.query(
      `SELECT COUNT(*) as present 
       FROM attendance 
       WHERE status IN ('Present', 'Late')`
    );

    // Calculate percentage
    const attendanceRate = totalResults[0].total > 0 
      ? Math.round((presentResults[0].present / totalResults[0].total) * 100)
      : 0;

    res.json({
      success: true,
      stats: {
        totalRecords: totalResults[0].total,
        presentRecords: presentResults[0].present,
        attendanceRate: attendanceRate
      }
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error' 
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/weekly', async (req, res) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();

    // Get the current date at midnight for accurate comparison
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Calculate date range (3 days before and after today)
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 3);
    
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 3);

    // Query to get distinct student count first
    const [studentCount] = await connection.query(
      'SELECT COUNT(DISTINCT student_id) as total FROM students'
    );
    const totalStudents = studentCount[0].total || 0;

    // Query attendance data for this date range
    const [results] = await connection.query(`
      SELECT 
        DATE(a.attendance_date) AS date,
        COUNT(DISTINCT a.student_id) AS total_attendance,
        SUM(CASE WHEN a.status = 'Present' THEN 1 ELSE 0 END) AS present_count,
        SUM(CASE WHEN a.status = 'Late' THEN 1 ELSE 0 END) AS late_count,
        SUM(CASE WHEN a.status = 'Absent' THEN 1 ELSE 0 END) AS absent_count,
        SUM(CASE WHEN a.status = 'Excused' THEN 1 ELSE 0 END) AS excused_count
      FROM attendance a
      WHERE DATE(a.attendance_date) BETWEEN ? AND ?
      GROUP BY DATE(a.attendance_date)
      ORDER BY date ASC
    `, [startDate, endDate]);

    // Generate all 7 days with proper data
    const finalResults = [];
    for (let i = -3; i <= 3; i++) {
      const currentDate = new Date(today);
      currentDate.setDate(today.getDate() + i);
      const dateString = currentDate.toISOString().split('T')[0];
      
      const existingData = results.find(row => 
        new Date(row.date).toISOString().split('T')[0] === dateString
      );
      
      const isWeekend = currentDate.getDay() === 0 || currentDate.getDay() === 6;
      
      // Combine present and late counts
      const presentCount = (existingData?.present_count || 0) + (existingData?.late_count || 0);
      const totalCount = existingData?.total_attendance || 0;

      finalResults.push({
        date: dateString,
        present: presentCount,
        absent: existingData?.absent_count || 0,
        excused: existingData?.excused_count || 0,
        total: totalCount > 0 ? totalCount : totalStudents, // Use totalStudents if no attendance taken
        percentage: totalCount > 0 
          ? Math.round((presentCount / totalCount) * 100)
          : isWeekend ? null : 0,
        isWeekend: isWeekend
      });
    }

    res.json({
      success: true,
      data: finalResults
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ 
      success: false, 
      message: err.message || 'Database error' 
    });
  } finally {
    if (connection) connection.release();
  }
});
module.exports = router;
