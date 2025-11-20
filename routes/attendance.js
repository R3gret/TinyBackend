const express = require('express');
const router = express.Router();
const db = require('../db');
const { body, validationResult } = require('express-validator');
const authMiddleware = require('./authMiddleware');
const PDFDocument = require('pdfkit');
const { getAcademicYearDateRange } = require('../utils/academicYear');

// Insert attendance record with status
// Protect all attendance routes with auth
router.use(authMiddleware);
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

  const attendanceRecords = req.body;
  let connection;

  try {
    connection = await db.promisePool.getConnection();

    const studentIds = attendanceRecords.map(r => r.student_id);
    if (studentIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No attendance records provided'
      });
    }
    
    const [students] = await connection.query(
      'SELECT student_id FROM students WHERE student_id IN (?)',
      [studentIds]
    );

    const foundStudentIds = new Set(students.map(s => s.student_id));
    const allStudentsFound = studentIds.every(id => foundStudentIds.has(id));

    if (!allStudentsFound) {
      return res.status(404).json({
        success: false,
        message: 'One or more students not found'
      });
    }

    const values = attendanceRecords.map(r => [
      r.student_id,
      r.attendance_date,
      r.status
    ]);

    // Use ON DUPLICATE KEY UPDATE to either insert or update records
    const [result] = await connection.query(
      `INSERT INTO attendance (student_id, attendance_date, status) VALUES ?
       ON DUPLICATE KEY UPDATE status = VALUES(status)`,
      [values]
    );

    res.status(201).json({
      success: true,
      affectedRows: result.affectedRows,
      message: 'Attendance records created or updated successfully'
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
    // cdc_id filtering is required for /stats (provided as query param)
    const { cdc_id } = req.query;
    if (cdc_id === undefined) {
      return res.status(400).json({ success: false, message: 'cdc_id query parameter is required' });
    }
    const cdcIdNum = parseInt(cdc_id, 10);
    if (Number.isNaN(cdcIdNum)) {
      return res.status(400).json({ success: false, message: 'Invalid cdc_id' });
    }

    const params = [cdcIdNum];

    // Get total attendance records filtered by cdc_id
    const totalSql = 'SELECT COUNT(*) as total FROM attendance a JOIN students s ON a.student_id = s.student_id WHERE s.cdc_id = ?';
    const [totalResults] = await connection.query(totalSql, params);

    // Get present records (count Present and Late as present) filtered by cdc_id
    const presentSql = "SELECT COUNT(*) as present FROM attendance a JOIN students s ON a.student_id = s.student_id WHERE s.cdc_id = ? AND a.status IN ('Present', 'Late')";
    const [presentResults] = await connection.query(presentSql, params);

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

    const { academic_year } = req.query;

    // Get the current date at midnight for accurate comparison
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Calculate date range (3 days before and after today)
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 3);
    
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 3);

    // Query to get distinct student count - filter by academic year if provided
    let studentCountQuery = 'SELECT COUNT(DISTINCT s.student_id) as total FROM students s';
    const studentCountParams = [];
    
    if (academic_year) {
      const { getAcademicYearDateRange } = require('../utils/academicYear');
      const dateRange = getAcademicYearDateRange(academic_year);
      if (!dateRange) {
        return res.status(400).json({
          success: false,
          message: 'Invalid academic year format. Expected format: "YYYY-YYYY+1" (e.g., "2025-2026")'
        });
      }
      studentCountQuery += ' WHERE s.enrolled_at >= ? AND s.enrolled_at <= ?';
      studentCountParams.push(dateRange.startDate, dateRange.endDate);
    }
    
    const [studentCount] = await connection.query(studentCountQuery, studentCountParams);
    const totalStudents = studentCount[0].total || 0;

    // Query attendance data for this date range - filter by academic year if provided
    let attendanceQuery = `
      SELECT 
        DATE(a.attendance_date) AS date,
        COUNT(DISTINCT a.student_id) AS total_attendance,
        SUM(CASE WHEN a.status = 'Present' THEN 1 ELSE 0 END) AS present_count,
        SUM(CASE WHEN a.status = 'Late' THEN 1 ELSE 0 END) AS late_count,
        SUM(CASE WHEN a.status = 'Absent' THEN 1 ELSE 0 END) AS absent_count,
        SUM(CASE WHEN a.status = 'Excused' THEN 1 ELSE 0 END) AS excused_count
      FROM attendance a
      JOIN students s ON a.student_id = s.student_id
      WHERE DATE(a.attendance_date) BETWEEN ? AND ?
    `;
    const attendanceParams = [startDate, endDate];
    
    if (academic_year) {
      const { getAcademicYearDateRange } = require('../utils/academicYear');
      const dateRange = getAcademicYearDateRange(academic_year);
      if (dateRange) {
        attendanceQuery += ' AND s.enrolled_at >= ? AND s.enrolled_at <= ?';
        attendanceParams.push(dateRange.startDate, dateRange.endDate);
      }
    }
    
    attendanceQuery += ' GROUP BY DATE(a.attendance_date) ORDER BY date ASC';
    
    const [results] = await connection.query(attendanceQuery, attendanceParams);

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

// GET today's attendance for a CDC (required cdc_id)
router.get('/today', async (req, res) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();

    const { cdc_id } = req.query;
    if (cdc_id === undefined) {
      return res.status(400).json({ success: false, message: 'cdc_id query parameter is required' });
    }
    const cdcIdNum = parseInt(cdc_id, 10);
    if (Number.isNaN(cdcIdNum)) {
      return res.status(400).json({ success: false, message: 'Invalid cdc_id' });
    }

    // Return aggregated stats for today for this CDC (same shape as /stats)
    const params = [cdcIdNum];

    const [totalResults] = await connection.query(
      `SELECT COUNT(*) as total
       FROM attendance a
       JOIN students s ON a.student_id = s.student_id
       WHERE s.cdc_id = ? AND DATE(a.attendance_date) = CURDATE()`,
      params
    );

    const [presentResults] = await connection.query(
      `SELECT COUNT(*) as present
       FROM attendance a
       JOIN students s ON a.student_id = s.student_id
       WHERE s.cdc_id = ? AND DATE(a.attendance_date) = CURDATE() AND a.status IN ('Present', 'Late')`,
      params
    );

    const total = totalResults[0].total || 0;
    const present = presentResults[0].present || 0;
    const attendanceRate = total > 0 ? Math.round((present / total) * 100) : 0;

    res.json({
      success: true,
      stats: {
        totalRecords: total,
        presentRecords: present,
        attendanceRate: attendanceRate
      }
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ success: false, message: err.message || 'Database error' });
  } finally {
    if (connection) connection.release();
  }
});

// Export attendance table as PDF
router.get('/export/pdf', authMiddleware, async (req, res) => {
  let connection;
  try {
    const cdcId = req.user?.cdc_id;
    if (!cdcId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User is not associated with a CDC.'
      });
    }

    const { start_date, num_weeks = 1, academic_year } = req.query;

    if (!start_date) {
      return res.status(400).json({
        success: false,
        message: 'start_date query parameter is required (format: YYYY-MM-DD)'
      });
    }

    const numWeeks = parseInt(num_weeks, 10) || 1;
    if (numWeeks < 1 || numWeeks > 12) {
      return res.status(400).json({
        success: false,
        message: 'num_weeks must be between 1 and 12'
      });
    }

    connection = await db.promisePool.getConnection();

    // Validate academic year if provided
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

    // Parse start date and calculate date range
    const startDate = new Date(start_date);
    if (isNaN(startDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid start_date format. Expected format: YYYY-MM-DD'
      });
    }

    // Calculate end date (num_weeks * 7 days)
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + (numWeeks * 7) - 1);

    // Get all students for this CDC
    let studentsQuery = `
      SELECT 
        s.student_id,
        s.first_name,
        s.middle_name,
        s.last_name
      FROM students s
      WHERE s.cdc_id = ?
    `;
    const studentsParams = [cdcId];

    if (academicYearDateRange) {
      studentsQuery += ' AND s.enrolled_at >= ? AND s.enrolled_at <= ?';
      studentsParams.push(academicYearDateRange.startDate, academicYearDateRange.endDate);
    }

    studentsQuery += ' ORDER BY s.last_name, s.first_name';

    const [students] = await connection.query(studentsQuery, studentsParams);

    // Get all attendance records for the date range
    let attendanceQuery = `
      SELECT 
        a.student_id,
        DATE(a.attendance_date) AS date,
        a.status
      FROM attendance a
      JOIN students s ON a.student_id = s.student_id
      WHERE s.cdc_id = ?
        AND DATE(a.attendance_date) >= ?
        AND DATE(a.attendance_date) <= ?
    `;
    const attendanceParams = [cdcId, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]];

    if (academicYearDateRange) {
      attendanceQuery += ' AND s.enrolled_at >= ? AND s.enrolled_at <= ?';
      attendanceParams.push(academicYearDateRange.startDate, academicYearDateRange.endDate);
    }

    const [attendanceRecords] = await connection.query(attendanceQuery, attendanceParams);

    // Create a map of attendance: { student_id: { date: status } }
    const attendanceMap = {};
    attendanceRecords.forEach(record => {
      if (!attendanceMap[record.student_id]) {
        attendanceMap[record.student_id] = {};
      }
      attendanceMap[record.student_id][record.date] = record.status;
    });

    // Generate all dates in the range
    const allDates = [];
    for (let i = 0; i < numWeeks * 7; i++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + i);
      if (currentDate <= endDate) {
        allDates.push(currentDate.toISOString().split('T')[0]);
      }
    }

    // Generate PDF
    return generateAttendancePDF(res, {
      students,
      allDates,
      attendanceMap,
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      numWeeks
    });

  } catch (err) {
    console.error('Attendance PDF export error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to export attendance PDF.'
    });
  } finally {
    if (connection) connection.release();
  }
});

// Helper function to generate attendance PDF
function generateAttendancePDF(res, data) {
  const { students, allDates, attendanceMap, startDate, endDate, numWeeks } = data;

  // Landscape: 11 x 8.5 inches (792 x 612 points)
  const doc = new PDFDocument({ 
    size: [792, 612], // Landscape
    margins: { top: 30, bottom: 30, left: 20, right: 20 }
  });

  const timestamp = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="attendance-${startDate}-to-${endDate}.pdf"`
  );
  doc.pipe(res);

  const pageWidth = 792;
  const pageHeight = 612;
  const margin = 20;
  const topMargin = 30;
  const bottomMargin = 30;
  const usableWidth = pageWidth - (margin * 2);
  const usableHeight = pageHeight - topMargin - bottomMargin;

  const studentsPerPage = 20;
  const totalStudentPages = Math.ceil(students.length / studentsPerPage);

  // Calculate column widths - fit all dates on one page
  const studentNameWidth = 140;
  const dateColumnWidth = Math.min(25, (usableWidth - studentNameWidth) / allDates.length); // Max 25 points per column
  const totalTableWidth = studentNameWidth + (allDates.length * dateColumnWidth);
  
  // Calculate starting X position to center the table
  const tableStartX = (pageWidth - totalTableWidth) / 2;
  
  const fontSize = 7;
  const rowHeight = 14;

  // Generate pages - one page per 20 students, all dates shown
  for (let studentPage = 0; studentPage < totalStudentPages; studentPage++) {
    if (studentPage > 0) {
      doc.addPage();
    }

    const startIdx = studentPage * studentsPerPage;
    const endIdx = Math.min(startIdx + studentsPerPage, students.length);
    const pageStudents = students.slice(startIdx, endIdx);

    let yPos = topMargin;

    // Title
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .text('ATTENDANCE RECORD', pageWidth / 2, yPos, { align: 'center' });
    yPos += 18;

    // Date range
    doc.fontSize(9)
       .font('Helvetica')
       .text(`Period: ${startDate} to ${endDate} (${numWeeks} week${numWeeks > 1 ? 's' : ''})`, pageWidth / 2, yPos, { align: 'center' });
    yPos += 12;

    // Page info
    doc.fontSize(7)
       .text(`Page ${studentPage + 1} of ${totalStudentPages}`, pageWidth - margin - 50, yPos, { align: 'right' });
    yPos += 8;

    // Table header - centered
    let xPos = tableStartX;

    // Student Name header
    doc.fontSize(fontSize)
       .font('Helvetica-Bold')
       .rect(xPos, yPos, studentNameWidth, rowHeight)
       .stroke()
       .text('Student Name', xPos + 2, yPos + 3, { width: studentNameWidth - 4 });
    xPos += studentNameWidth;

    // Date headers - show all dates
    allDates.forEach(date => {
      const dateObj = new Date(date);
      const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'short' }).substring(0, 3);
      const day = dateObj.getDate();
      const month = dateObj.toLocaleDateString('en-US', { month: 'short' }).substring(0, 3);
      const dateStr = `${dayOfWeek}\n${month} ${day}`;
      
      doc.rect(xPos, yPos, dateColumnWidth, rowHeight)
         .stroke();
      
      // Split date into two lines
      doc.fontSize(fontSize - 1)
         .text(dayOfWeek, xPos + 1, yPos + 2, { width: dateColumnWidth - 2, align: 'center' });
      doc.text(`${month} ${day}`, xPos + 1, yPos + 8, { width: dateColumnWidth - 2, align: 'center' });
      
      xPos += dateColumnWidth;
    });

    yPos += rowHeight;

    // Student rows - centered
    pageStudents.forEach((student) => {
      xPos = tableStartX;
      const studentName = `${student.last_name || ''}, ${student.first_name || ''} ${student.middle_name ? student.middle_name.charAt(0) + '.' : ''}`.trim();

      // Student name cell
      doc.font('Helvetica')
         .fontSize(fontSize - 1)
         .rect(xPos, yPos, studentNameWidth, rowHeight)
         .stroke()
         .text(studentName, xPos + 2, yPos + 3, { 
           width: studentNameWidth - 4,
           ellipsis: true
         });
      xPos += studentNameWidth;

      // Attendance cells for all dates
      allDates.forEach(date => {
        const status = attendanceMap[student.student_id]?.[date] || '-';
        let statusSymbol = '-';
        if (status === 'Present') statusSymbol = 'P';
        else if (status === 'Late') statusSymbol = 'L';
        else if (status === 'Absent') statusSymbol = 'A';
        else if (status === 'Excused') statusSymbol = 'E';

        doc.rect(xPos, yPos, dateColumnWidth, rowHeight)
           .stroke()
           .text(statusSymbol, xPos + 1, yPos + 4, { 
             width: dateColumnWidth - 2, 
             align: 'center' 
           });
        xPos += dateColumnWidth;
      });

      yPos += rowHeight;
    });

    // Legend at bottom of each page - centered
    const legendY = pageHeight - bottomMargin - 25;
    doc.fontSize(6)
       .font('Helvetica')
       .text('Legend: P = Present, L = Late, A = Absent, E = Excused, - = No Record', 
             pageWidth / 2, legendY, { align: 'center', width: usableWidth });
  }

  doc.end();
}

module.exports = router;
