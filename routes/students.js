const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const csvParser = require('csv-parser');
const { Parser } = require('json2csv');
const { Readable } = require('stream');
const moment = require('moment');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { getAcademicYearDateRange } = require('../utils/academicYear');

// Middleware to get CDC ID from JWT
const authenticate = require('./authMiddleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (
      (file.mimetype && file.mimetype.includes('csv')) ||
      file.originalname.toLowerCase().endsWith('.csv')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed.'));
    }
  }
});

const handleCsvUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.message || 'Invalid CSV upload.'
      });
    }
    next();
  });
};

const formatChildName = (student) => {
  const parts = [
    student.last_name?.trim(),
    [student.first_name, student.middle_name].filter(Boolean).join(' ').trim()
  ];
  return parts.filter(Boolean).join(', ');
};

const formatDateForCsv = (date) => {
  if (!date) return '';
  const parsed = moment(date);
  return parsed.isValid() ? parsed.format('MM-DD-YYYY') : '';
};

const calculateAgeInMonths = (date) => {
  if (!date) return '';
  const birth = moment(date);
  if (!birth.isValid()) return '';
  return moment().diff(birth, 'months');
};

const normalizeYesNo = (value, defaultValue = 'N') => {
  if (!value) return defaultValue;
  const upper = value.toString().trim().toUpperCase();
  if (upper === 'Y') return 'Y';
  if (upper === 'N') return 'N';
  return defaultValue;
};

const parseCsvBuffer = (buffer) =>
  new Promise((resolve, reject) => {
    const rows = [];
    Readable.from(buffer.toString('utf8'))
      .pipe(csvParser({
        mapHeaders: ({ header }) => header.trim()
      }))
      .on('data', (data) => {
        const hasValues = Object.values(data).some(
          (value) => value && value.toString().trim().length > 0
        );
        if (hasValues) rows.push(data);
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });

const splitChildName = (value = '') => {
  const [lastNamePart, rest] = value.split(',');
  const lastName = (lastNamePart || '').trim();
  const remaining = (rest || '').trim();
  const segments = remaining.split(/\s+/).filter(Boolean);
  const firstName = segments.shift() || '';
  const middleName = segments.length ? segments.join(' ') : null;
  return { firstName, middleName, lastName };
};

const parseGender = (value) => {
  if (!value) return null;
  const normalized = value.toString().trim().toLowerCase();
  if (normalized.startsWith('m')) return 'Male';
  if (normalized.startsWith('f')) return 'Female';
  return null;
};

const parseBirthdateFromCsv = (value) => {
  if (!value) return null;
  const normalized = value.toString().trim();
  const formats = [
    'MM-DD-YYYY',
    'M-D-YYYY',
    'MM/DD/YYYY',
    'M/D/YYYY',
    'YYYY-MM-DD',
    'YYYY/M/D'
  ];
  for (const format of formats) {
    const parsed = moment(normalized, format, true);
    if (parsed.isValid()) {
      return parsed.format('YYYY-MM-DD');
    }
  }
  const fallback = moment(new Date(normalized));
  return fallback.isValid() ? fallback.format('YYYY-MM-DD') : null;
};

const toNullableNumber = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = value.toString().replace(',', '.').trim();
  if (normalized.length === 0) return null;
  const parsed = parseFloat(normalized);
  return Number.isNaN(parsed) ? null : parsed;
};


// Base student query with CDC filtering
router.get('/', authenticate, async (req, res) => {
  const { ageFilter, academic_year } = req.query;
  let connection;
  
  try {
    // Use the cdc_id from the authenticated user
    const cdcId = req.user.cdc_id;
    if (!cdcId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User is not associated with a CDC.',
      });
    }

    connection = await db.promisePool.getConnection();

    let query = `
      SELECT student_id, first_name, middle_name, last_name, birthdate, gender, enrolled_at
      FROM students
      WHERE cdc_id = ?
    `;
    const params = [cdcId];
    
    // Filter by academic year if provided
    if (academic_year) {
      const dateRange = getAcademicYearDateRange(academic_year);
      if (!dateRange) {
        return res.status(400).json({
          success: false,
          message: 'Invalid academic year format. Expected format: "YYYY-YYYY+1" (e.g., "2025-2026")'
        });
      }
      
      // Filter by enrolled_at date within the academic year range
      query += ' AND enrolled_at >= ? AND enrolled_at <= ?';
      params.push(dateRange.startDate, dateRange.endDate);
    }
    
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

// Helper function to generate PDF
function generatePDF(res, data) {
  const {
    students,
    cdcName,
    cdwDisplayName,
    barangay,
    province,
    municipality,
    loggedInEmail,
    loggedInPhone,
    loggedInName,
    focalName,
    mswName,
    maleCount,
    femaleCount,
    totalCount,
    timestamp
  } = data;

  // Landscape: 11 x 8.5 inches (792 x 612 points)
  const doc = new PDFDocument({ 
    size: [792, 612], // Landscape: width x height in points
    margins: { top: 20, bottom: 20, left: 20, right: 20 }
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="cdc-students-${timestamp}.pdf"`
  );
  doc.pipe(res);

  const pageWidth = 792;
  const pageHeight = 612;
  const margin = 20;
  const usableWidth = pageWidth - (margin * 2);
  const usableHeight = pageHeight - (margin * 2);
  
  // Scale factor to fit content on one page - adjusted for better fit
  const scaleX = usableWidth / 750;
  const scaleY = usableHeight / 600;
  const scale = Math.min(scaleX, scaleY, 0.75); // Cap scale to prevent too small text

  let yPos = margin;
  const lineHeight = 11;
  const fontSize = 11;
  const smallFontSize = 9;

  // Helper to format date
  const formatDateForCsv = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    return `${month}-${day}-${year}`;
  };

  // Helper to calculate age in months
  const calculateAgeInMonths = (birthdate) => {
    if (!birthdate) return '';
    const birth = new Date(birthdate);
    const today = new Date();
    const months = (today.getFullYear() - birth.getFullYear()) * 12 + (today.getMonth() - birth.getMonth());
    return months >= 0 ? months : '';
  };

  // Helper to normalize yes/no
  const normalizeYesNo = (value, defaultValue = '') => {
    if (!value) return defaultValue;
    const upper = String(value).toUpperCase();
    return upper === 'Y' || upper === 'YES' ? 'Y' : upper === 'N' || upper === 'NO' ? 'N' : defaultValue;
  };

  // Images - positioned to align with header text
  const image1Path = path.join(__dirname, '..', 'image.png');
  const image2Path = path.join(__dirname, '..', 'image1.png');
  const image1Height = 50 * scale; // image.png height
  const image2Height = 75 * scale; // image1.png height (larger)
  const imageY = yPos + 5; // Start images slightly higher
  const image1Y = imageY; // image.png Y position
  const image2Y = imageY - 8; // image1.png moved upwards

  if (fs.existsSync(image1Path)) {
    doc.image(image1Path, margin + 50, image1Y, { width: 70 * scale, height: image1Height });
  }
  if (fs.existsSync(image2Path)) {
    doc.image(image2Path, margin + 200, image2Y, { width: 100 * scale, height: image2Height });
  }

  // Header text (centered) - align with images
  yPos += 20 * scale;
  doc.fontSize(fontSize)
     .text('Republic of the Philippines', pageWidth / 2, yPos, { align: 'center' });
  yPos += lineHeight;
  doc.text(`Province of ${province}`, pageWidth / 2, yPos, { align: 'center' });
  yPos += lineHeight;
  doc.font('Helvetica-Bold')
     .text(`Municipality of ${municipality}`, pageWidth / 2, yPos, { align: 'center' });
  yPos += lineHeight;
  doc.font('Helvetica')
     .fillColor('blue')
     .text(`Email Address: ${loggedInEmail}`, pageWidth / 2, yPos, { align: 'center' });
  yPos += lineHeight;
  doc.fillColor('black')
     .text(`Telephone number: ${loggedInPhone}`, pageWidth / 2, yPos, { align: 'center' });

  yPos += lineHeight * 2;

  // CDC info and counts
  doc.fontSize(smallFontSize)
     .text(`Name of CDC: ${cdcName}`, margin, yPos)
     .text(`Male - ${maleCount}`, pageWidth - margin - 100, yPos, { align: 'right' });
  yPos += lineHeight;
  doc.text(`Name of CDW: ${cdwDisplayName}`, margin, yPos)
     .text(`Female - ${femaleCount}`, pageWidth - margin - 100, yPos, { align: 'right' });
  yPos += lineHeight;
  doc.text(`Barangay: ${barangay}`, margin, yPos)
     .font('Helvetica-Bold')
     .text(`TOTAL - ${totalCount}`, pageWidth - margin - 100, yPos, { align: 'right' });

  yPos += lineHeight * 2;

  // Title
  doc.font('Helvetica-Bold')
     .fontSize(18)
     .text('MASTERLIST OF DAYCARE CHILDREN', pageWidth / 2, yPos, { align: 'center' });

  yPos += lineHeight * 1.5;

  // Calculate pagination - 25 students per page
  const studentsPerPage = 25;
  const totalPages = Math.ceil(students.length / studentsPerPage);

  // Generate pages - one page per 25 students
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
    if (pageIndex > 0) {
      doc.addPage();
    }

    const startIdx = pageIndex * studentsPerPage;
    const endIdx = Math.min(startIdx + studentsPerPage, students.length);
    const pageStudents = students.slice(startIdx, endIdx);

    // Reset Y position for new page
    yPos = margin;

    // Images - positioned to align with header text
    const image1Path = path.join(__dirname, '..', 'image.png');
    const image2Path = path.join(__dirname, '..', 'image1.png');
    const image1Height = 50 * scale;
    const image2Height = 75 * scale;
    const imageY = yPos + 5;
    const image1Y = imageY;
    const image2Y = imageY - 8; // image1.png moved upwards

    if (fs.existsSync(image1Path)) {
      doc.image(image1Path, margin + 50, image1Y, { width: 70 * scale, height: image1Height });
    }
    if (fs.existsSync(image2Path)) {
      doc.image(image2Path, margin + 200, image2Y, { width: 100 * scale, height: image2Height });
    }

    // Header text (centered) - align with images
    yPos += 20 * scale;
    doc.fontSize(fontSize)
       .text('Republic of the Philippines', pageWidth / 2, yPos, { align: 'center' });
    yPos += lineHeight;
    doc.text(`Province of ${province}`, pageWidth / 2, yPos, { align: 'center' });
    yPos += lineHeight;
    doc.font('Helvetica-Bold')
       .text(`Municipality of ${municipality}`, pageWidth / 2, yPos, { align: 'center' });
    yPos += lineHeight;
    doc.font('Helvetica')
       .fillColor('blue')
       .text(`Email Address: ${loggedInEmail}`, pageWidth / 2, yPos, { align: 'center' });
    yPos += lineHeight;
    doc.fillColor('black')
       .text(`Telephone number: ${loggedInPhone}`, pageWidth / 2, yPos, { align: 'center' });

    yPos += lineHeight * 2;

    // CDC info and counts
    doc.fontSize(smallFontSize)
       .text(`Name of CDC: ${cdcName}`, margin, yPos)
       .text(`Male - ${maleCount}`, pageWidth - margin - 100, yPos, { align: 'right' });
    yPos += lineHeight;
    doc.text(`Name of CDW: ${cdwDisplayName}`, margin, yPos)
       .text(`Female - ${femaleCount}`, pageWidth - margin - 100, yPos, { align: 'right' });
    yPos += lineHeight;
    doc.text(`Barangay: ${barangay}`, margin, yPos)
       .font('Helvetica-Bold')
       .text(`TOTAL - ${totalCount}`, pageWidth - margin - 100, yPos, { align: 'right' });

    yPos += lineHeight * 2;

    // Title
    doc.font('Helvetica-Bold')
       .fontSize(18)
       .text('MASTERLIST OF DAYCARE CHILDREN', pageWidth / 2, yPos, { align: 'center' });

    yPos += lineHeight * 1.5;

    // Table headers - calculate auto-fit widths based on content
    const headers = ['No.', 'NAME OF CHILD', 'SEX', '4ps ID', 'DISABILITY', 'BIRTHDATE', 'AGE', 'HEIGHT', 'WEIGHT', 'BIRTHPLACE', 'ADDRESS', 'GUARDIAN', 'CONTACT'];
    
    // Calculate column widths based on header text and sample data
    const calculateColWidth = (headerText, sampleData = []) => {
      const headerWidth = doc.widthOfString(headerText, { fontSize: smallFontSize });
      const dataWidths = sampleData.map(data => {
        const text = data ? String(data) : '';
        return doc.widthOfString(text, { fontSize: smallFontSize * 0.85 });
      });
      const maxDataWidth = dataWidths.length > 0 ? Math.max(...dataWidths) : 0;
      return Math.max(headerWidth, maxDataWidth) + 8; // Add padding
    };

    // Get sample data from current page students for width calculation
    const colWidths = headers.map((header, idx) => {
      const sampleData = pageStudents.map(s => {
        const middleInitial = s.middle_name ? `${s.middle_name.charAt(0).toUpperCase()}.` : '';
        const fullName = `${s.last_name || ''}, ${s.first_name || ''} ${middleInitial}`.trim();
        const ageInMonths = calculateAgeInMonths(s.birthdate);
        const rowData = [
          (startIdx + 1).toString(),
          fullName,
          s.gender || '',
          s.four_ps_id || '',
          normalizeYesNo(s.disability, ''),
          formatDateForCsv(s.birthdate),
          ageInMonths === '' ? '' : ageInMonths.toString(),
          s.height_cm ? s.height_cm.toString() : '',
          s.weight_kg ? s.weight_kg.toString() : '',
          s.birthplace || '',
          s.child_address || '',
          s.guardian_name || '',
          s.phone_num || ''
        ];
        return rowData[idx];
      });
      return calculateColWidth(header, sampleData);
    });

    // Calculate total table width and center it
    const totalTableWidth = colWidths.reduce((sum, width) => sum + width, 0);
    const tableStartX = (pageWidth - totalTableWidth) / 2;
    xPos = tableStartX;

    doc.fontSize(smallFontSize)
       .font('Helvetica-Bold')
       .fillColor('black');

    // Draw header row with borders
    const headerY = yPos;
    headers.forEach((header, i) => {
      doc.rect(xPos, headerY, colWidths[i], lineHeight * 1.2)
         .stroke();
      doc.text(header, xPos + 2, headerY + 3, { width: colWidths[i] - 4, align: 'center' });
      xPos += colWidths[i];
    });

    yPos += lineHeight * 1.2;

    // Draw table borders for data rows
    const tableStartY = headerY;
    const tableEndY = yPos + (pageStudents.length * lineHeight * 0.9);
    
    // Draw vertical lines for all columns - centered
    xPos = tableStartX;
    doc.moveTo(xPos, tableStartY).lineTo(xPos, tableEndY).stroke();
    headers.forEach((_, i) => {
      xPos += colWidths[i];
      doc.moveTo(xPos, tableStartY).lineTo(xPos, tableEndY).stroke();
    });
    
    // Draw bottom border - centered
    doc.moveTo(tableStartX, tableEndY).lineTo(tableStartX + totalTableWidth, tableEndY).stroke();

    // Student data with cell borders
    doc.font('Helvetica')
       .fontSize(smallFontSize * 0.85);
    
    for (let i = 0; i < pageStudents.length; i++) {
      const student = pageStudents[i];
      xPos = tableStartX; // Use centered starting position
      const globalIndex = startIdx + i;

      const middleInitial = student.middle_name ? `${student.middle_name.charAt(0).toUpperCase()}.` : '';
      const fullName = `${student.last_name || ''}, ${student.first_name || ''} ${middleInitial}`.trim();
      const ageInMonths = calculateAgeInMonths(student.birthdate);

      const rowData = [
        (globalIndex + 1).toString(),
        fullName,
        student.gender || '',
        student.four_ps_id || '',
        normalizeYesNo(student.disability, ''),
        formatDateForCsv(student.birthdate),
        ageInMonths === '' ? '' : ageInMonths.toString(),
        student.height_cm ? student.height_cm.toString() : '',
        student.weight_kg ? student.weight_kg.toString() : '',
        student.birthplace || '',
        student.child_address || '',
        student.guardian_name || '',
        student.phone_num || ''
      ];

      // Draw row with borders
      rowData.forEach((text, colIdx) => {
        doc.rect(xPos, yPos, colWidths[colIdx], lineHeight * 0.9)
           .stroke();
        doc.text(text || '', xPos + 2, yPos + 2, { 
          width: colWidths[colIdx] - 4, 
          align: colIdx === 0 ? 'center' : 'left',
          ellipsis: true
        });
        xPos += colWidths[colIdx];
      });

      yPos += lineHeight * 0.9;
    }

    // Footer
    yPos = tableEndY + lineHeight * 2;
    doc.fontSize(smallFontSize)
       .font('Helvetica')
       .text('Prepared by:', margin + 50, yPos)
       .text('Validated by:', margin + 200, yPos)
       .text('Approved by:', margin + 350, yPos);

    yPos += lineHeight * 1.5;
    doc.text(loggedInName, margin + 50, yPos)
       .text(focalName, margin + 200, yPos)
       .text(mswName, margin + 350, yPos);

    yPos += lineHeight;
    doc.fontSize(smallFontSize * 0.9)
       .text('Child Development Worker', margin + 50, yPos)
       .text('ECCD Focal Person', margin + 200, yPos)
       .text('MSWDO', margin + 350, yPos);
  }

  doc.end();
}

router.get('/export', authenticate, async (req, res) => {
  const cdcId = req.user?.cdc_id;
  const { academic_year, format = 'excel' } = req.query; // format: 'excel' or 'pdf'
  
  if (!cdcId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. User is not associated with a CDC.'
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    // Validate and get academic year date range if provided
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
    
    // Get CDC and location information
    const [cdcInfo] = await connection.query(
      `
        SELECT 
          c.name as cdc_name,
          cl.Region as region,
          cl.province,
          cl.municipality,
          cl.barangay
        FROM cdc c
        LEFT JOIN cdc_location cl ON c.location_id = cl.location_id
        WHERE c.cdc_id = ?
      `,
      [cdcId]
    );

    const cdc = cdcInfo[0] || {};
    const region = cdc.region || '';
    const province = cdc.province || '';
    const municipality = cdc.municipality || '';
    const barangay = cdc.barangay || '';
    const cdcName = cdc.cdc_name || '';

    // Get CDW name (Child Development Worker) - get first active worker for this CDC
    const [cdwInfo] = await connection.query(
      `
        SELECT uoi.full_name
        FROM users u
        LEFT JOIN user_other_info uoi ON u.id = uoi.user_id
        WHERE u.cdc_id = ? AND u.type = 'worker' AND uoi.full_name IS NOT NULL
        LIMIT 1
      `,
      [cdcId]
    );
    const cdwName = cdwInfo[0]?.full_name || '';

    // Logged-in user info for contact details/signatures
    const [userInfoRows] = await connection.query(
      `
        SELECT 
          u.username,
          o.full_name,
          o.phone,
          o.email
        FROM users u
        LEFT JOIN user_other_info o ON o.user_id = u.id
        WHERE u.id = ?
        LIMIT 1
      `,
      [req.user.id]
    );
    const userInfo = userInfoRows[0] || {};
    const loggedInName = userInfo.full_name || userInfo.username || '';
    const loggedInPhone = userInfo.phone || '';
    const loggedInEmail = userInfo.email || '';
    const cdwDisplayName = cdwName || loggedInName || '_______________________';
    const preparedByName = loggedInName || '_______________________';

    // Get all students with their data
    let studentsQuery = `
      SELECT 
        s.student_id,
        s.first_name,
        s.middle_name,
        s.last_name,
        s.gender,
        s.birthdate,
        s.enrolled_at,
        s.four_ps_id,
        s.disability,
        s.height_cm,
        s.weight_kg,
        s.birthplace,
        coi.child_address,
        g.guardian_name,
        g.phone_num
      FROM students s
      LEFT JOIN child_other_info coi ON coi.student_id = s.student_id
      LEFT JOIN guardian_info g ON g.student_id = s.student_id
      WHERE s.cdc_id = ?
    `;
    const studentsParams = [cdcId];
    
    // Add academic year filter if provided
    if (academicYearDateRange) {
      studentsQuery += ' AND s.enrolled_at >= ? AND s.enrolled_at <= ?';
      studentsParams.push(academicYearDateRange.startDate, academicYearDateRange.endDate);
    }
    
    studentsQuery += ' ORDER BY s.last_name, s.first_name';
    
    const [students] = await connection.query(studentsQuery, studentsParams);

    // Count male and female
    const maleCount = students.filter(s => s.gender === 'Male').length;
    const femaleCount = students.filter(s => s.gender === 'Female').length;
    const totalCount = students.length;

    // Get focal person based on municipality
    const [focalRows] = await connection.query(
      `
        SELECT COALESCE(o.full_name, u.username) AS focal_name
        FROM users u
        LEFT JOIN user_other_info o ON o.user_id = u.id
        LEFT JOIN cdc c2 ON u.cdc_id = c2.cdc_id
        LEFT JOIN cdc_location cl2 ON c2.location_id = cl2.location_id
        WHERE u.type = 'focal'
          AND (
            (o.address IS NOT NULL AND o.address LIKE ?)
            OR (cl2.municipality = ? AND (cl2.province = ? OR ? IS NULL))
          )
        LIMIT 1
      `,
      [`%${municipality}%`, municipality, province, province]
    );
    const focalName = focalRows[0]?.focal_name || '_______________________';

    // Get MSW user (first available)
    const [mswRows] = await connection.query(
      `
        SELECT COALESCE(o.full_name, u.username) AS msw_name
        FROM users u
        LEFT JOIN user_other_info o ON o.user_id = u.id
        WHERE u.type = 'msw'
        ORDER BY u.id ASC
        LIMIT 1
      `
    );
    const mswName = mswRows[0]?.msw_name || '_______________________';

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Masterlist');

    // Define border style
    const borderStyle = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };

    // Helper function to set cell with border (accepts worksheet parameter)
    const setCell = (ws, row, col, value, style = {}) => {
      const cell = ws.getCell(row, col);
      cell.value = value;
      cell.border = borderStyle;
      if (style.font) cell.font = style.font;
      if (style.alignment) cell.alignment = style.alignment;
      if (style.fill) cell.fill = style.fill;
      return cell;
    };

    // Helper function to merge cells with border (accepts worksheet parameter)
    const mergeCells = (ws, startRow, startCol, endRow, endCol, value, style = {}) => {
      ws.mergeCells(startRow, startCol, endRow, endCol);
      const cell = ws.getCell(startRow, startCol);
      cell.value = value;
      cell.border = borderStyle;
      if (style.font) cell.font = style.font;
      if (style.alignment) cell.alignment = style.alignment;
      if (style.fill) cell.fill = style.fill;
      return cell;
    };

    // Calculate pagination - 25 students per page/sheet
    const studentsPerPage = 25;
    const totalPages = Math.ceil(students.length / studentsPerPage);
    
    // Helper function to create a complete page/sheet with header, data, and footer
    const createExcelPage = (ws, pageStudents, startStudentIndex, pageNum) => {
      // Data rows (22-46) - up to 25 rows per page
      for (let i = 0; i < studentsPerPage; i++) {
        const rowNum = 22 + i;
        const globalIndex = startStudentIndex + i;
        
        if (i < pageStudents.length) {
          const student = pageStudents[i];
          const middleInitial = student.middle_name ? `${student.middle_name.charAt(0).toUpperCase()}.` : '';
          const fullName = `${student.last_name || ''}, ${student.first_name || ''} ${middleInitial}`.trim();
          const ageInMonths = calculateAgeInMonths(student.birthdate);
          
          // Column 1: No. (use global index + 1)
          setCell(ws, rowNum, 1, (globalIndex + 1).toString(), { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
          
          // Columns 2-3: NAME OF CHILD (merged)
          mergeCells(ws, rowNum, 2, rowNum, 3, fullName, { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
          
          // Column 4: SEX
          setCell(ws, rowNum, 4, student.gender || '', { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
          
          // Column 5: 4ps ID Number
          setCell(ws, rowNum, 5, student.four_ps_id || '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
          
          // Column 6: DISABILITY
          setCell(ws, rowNum, 6, normalizeYesNo(student.disability, ''), { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
          
          // Column 7: BIRTHDATE
          setCell(ws, rowNum, 7, formatDateForCsv(student.birthdate), { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
          
          // Column 8: AGE IN MONTHS
          setCell(ws, rowNum, 8, ageInMonths === '' ? '' : ageInMonths.toString(), { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
          
          // Column 9: HEIGHT
          setCell(ws, rowNum, 9, student.height_cm ? student.height_cm.toString() : '', { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
          
          // Column 10: WEIGHT
          setCell(ws, rowNum, 10, student.weight_kg ? student.weight_kg.toString() : '', { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
          
          // Column 11: BIRTHPLACE
          setCell(ws, rowNum, 11, student.birthplace || '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
          
          // Column 12: ADDRESS
          setCell(ws, rowNum, 12, student.child_address || '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
          
          // Columns 13-14: NAME OF PARENTS/GUARDIAN (merged)
          mergeCells(ws, rowNum, 13, rowNum, 14, student.guardian_name || '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
          
          // Column 15: CONTACT NO.
          setCell(ws, rowNum, 15, student.phone_num || '', { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
        } else {
          // Empty rows for template
          setCell(ws, rowNum, 1, (globalIndex + 1).toString(), { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
          mergeCells(ws, rowNum, 2, rowNum, 3, '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
          for (let col = 4; col <= 12; col++) {
            setCell(ws, rowNum, col, '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
          }
          mergeCells(ws, rowNum, 13, rowNum, 14, '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
          setCell(ws, rowNum, 15, '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
        }
      }
      
      // Footer rows
      for (let row = 47; row <= 48; row++) {
        for (let col = 1; col <= 15; col++) {
          setCell(ws, row, col, '', { font: { size: 14 } });
        }
      }
      
      setCell(ws, 49, 2, 'Prepared by: ', { font: { size: 14 } });
      setCell(ws, 49, 5, 'Validated by: ', { font: { size: 14 } });
      setCell(ws, 49, 9, 'Approved by: ', { font: { size: 14 } });
      
      for (let col = 1; col <= 15; col++) {
        setCell(ws, 50, col, '', { font: { size: 14 } });
      }
      
      setCell(ws, 51, 2, loggedInName, { font: { size: 14 } });
      setCell(ws, 51, 5, focalName, { font: { size: 14 } });
      setCell(ws, 51, 9, mswName, { font: { size: 14 } });
      
      setCell(ws, 52, 2, 'Child Development Worker', { font: { size: 14 } });
      setCell(ws, 52, 5, 'ECCD Focal Person', { font: { size: 14 } });
      setCell(ws, 52, 9, 'MSWDO', { font: { size: 14 } });
      
      // Empty footer rows
      for (let row = 53; row <= 58; row++) {
        for (let col = 1; col <= 15; col++) {
          setCell(ws, row, col, '', { font: { size: 14 } });
        }
      }

      // Auto-fit columns - calculate widths based on content for better fit
      ws.columns.forEach((column, index) => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, (cell) => {
          const cellValue = cell.value ? cell.value.toString() : '';
          // For merged cells, count the full text length
          const cellLength = cellValue.length;
          if (cellLength > maxLength) {
            maxLength = cellLength;
          }
        });
        // Auto-fit with minimum width of 10 and maximum of 60 for better readability
        // Adjust based on column index for better spacing
        const baseWidth = Math.min(Math.max(maxLength + 2, 10), 60);
        // Slightly adjust widths for better visual balance
        if (index === 0) column.width = Math.max(baseWidth, 8); // No. column
        else if (index === 1 || index === 2) column.width = Math.max(baseWidth, 25); // NAME OF CHILD (merged)
        else if (index === 11 || index === 12) column.width = Math.max(baseWidth, 20); // GUARDIAN (merged)
        else column.width = baseWidth;
      });

      // Set row heights
      for (let row = 1; row <= 58; row++) {
        const rowObj = ws.getRow(row);
        if (row >= 5 && row <= 8) {
          rowObj.height = 30; // Image rows
        } else {
          rowObj.height = row === 18 ? 30 : 20; // Title row is taller
        }
      }
    };

    // Helper function to create header section (rows 1-21) for a worksheet
    const createExcelHeader = (ws) => {
      // Set row heights for image rows (5-8) to ensure vertical centering
      for (let row = 5; row <= 8; row++) {
        ws.getRow(row).height = 40; // Taller rows for images
      }
      
      // Add images (logos) - Row 5-8, Columns C and E (cells C5-C8 and E5-E8)
      try {
        const image1Path = path.join(__dirname, '..', 'image.png');
        const image2Path = path.join(__dirname, '..', 'image1.png');
        
        if (fs.existsSync(image1Path)) {
          const image1 = workbook.addImage({
            filename: image1Path,
            extension: 'png',
          });
          ws.addImage(image1, {
            tl: { col: 2, row: 5 },
            ext: { width: 240, height: 160 }
          });
        }
        
        if (fs.existsSync(image2Path)) {
          const image2 = workbook.addImage({
            filename: image2Path,
            extension: 'png',
          });
          ws.addImage(image2, {
            tl: { col: 4, row: 5 },
            ext: { width: 360, height: 240 }
          });
        }
      } catch (err) {
        console.error('Error adding images:', err);
      }
      
      // Add borders to header area cells (rows 1-4)
      for (let row = 1; row <= 4; row++) {
        for (let col = 1; col <= 15; col++) {
          const cell = ws.getCell(row, col);
          if (!cell.border) {
            cell.border = borderStyle;
          }
        }
      }
      
      // Ensure cells with images (C5-C8 and E5-E8) have borders
      for (let row = 5; row <= 8; row++) {
        setCell(ws, row, 3, ''); // Column C
        setCell(ws, row, 5, ''); // Column E
      }

      // Header rows (starting from row 5) - centered
      setCell(ws, 5, 7, 'Republic of the Philippines', { 
        font: { size: 14 }, 
        alignment: { horizontal: 'center', vertical: 'middle' } 
      });
      setCell(ws, 6, 7, `Province of ${province}`, { 
        font: { size: 14 }, 
        alignment: { horizontal: 'center', vertical: 'middle' } 
      });
      setCell(ws, 7, 7, `Municipality of ${municipality}`, { 
        font: { size: 14, bold: true }, 
        alignment: { horizontal: 'center', vertical: 'middle' } 
      });
      setCell(ws, 8, 7, `Email Address: ${loggedInEmail}`, { 
        font: { size: 14, color: { argb: 'FF0000FF' }, underline: true }, 
        alignment: { horizontal: 'center', vertical: 'middle' } 
      });
      setCell(ws, 9, 7, `Telephone number: ${loggedInPhone}`, { 
        font: { size: 14 }, 
        alignment: { horizontal: 'center', vertical: 'middle' } 
      });
      
      // Empty rows
      for (let row = 10; row <= 12; row++) {
        for (let col = 1; col <= 15; col++) {
          setCell(ws, row, col, '');
        }
      }
      
      // Row 13: Name of CDC and Male count
      setCell(ws, 13, 1, `Name of CDC :  ${cdcName}`, { font: { size: 14 } });
      setCell(ws, 13, 10, `Male - ${maleCount}`, { font: { size: 14, bold: true } });
      
      // Row 14: Name of CDW and Female count
      setCell(ws, 14, 1, `Name of CDW : ${cdwDisplayName}`, { font: { size: 14 } });
      setCell(ws, 14, 10, `Female - ${femaleCount}`, { font: { size: 14, bold: true } });
      
      // Row 15: Barangay and TOTAL
      setCell(ws, 15, 1, `Barangay :  ${barangay}`, { font: { size: 14 } });
      setCell(ws, 15, 10, `TOTAL - ${totalCount}`, { font: { size: 14, bold: true } });
      
      // Empty rows
      for (let row = 16; row <= 17; row++) {
        for (let col = 1; col <= 15; col++) {
          setCell(ws, row, col, '');
        }
      }
      
      // Title row (18): MASTERLIST OF DAYCARE CHILDREN
      mergeCells(ws, 18, 1, 18, 15, 'MASTERLIST OF DAYCARE CHILDREN', {
        font: { name: 'Arial Black', size: 21, bold: true },
        alignment: { horizontal: 'center', vertical: 'middle' }
      });
      
      // Empty row
      for (let col = 1; col <= 15; col++) {
        setCell(ws, 19, col, '');
      }
      
      // Column headers (20-21)
      const headerRow1 = 20;
      setCell(ws, headerRow1, 1, 'No.', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      mergeCells(ws, headerRow1, 2, headerRow1, 3, 'NAME OF CHILD', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow1, 4, 'SEX', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow1, 5, '4ps ID Number', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow1, 6, 'DISABILITY', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow1, 7, 'BIRTHDATE (M-D-Y)', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow1, 8, 'AGE IN MONTHS', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF90EE90' } } });
      setCell(ws, headerRow1, 9, 'HEIGHT', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow1, 10, 'WEIGHT', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow1, 11, 'BIRTHPLACE', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow1, 12, 'ADDRESS', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      mergeCells(ws, headerRow1, 13, headerRow1, 14, 'NAME OF PARENTS/GUARDIAN', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow1, 15, 'CONTACT NO.', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
      
      // Sub-header row (21)
      const headerRow2 = 21;
      setCell(ws, headerRow2, 1, '', { font: { size: 14, bold: true } });
      mergeCells(ws, headerRow2, 2, headerRow2, 3, '(Last Name, First Name, Middle Initial)', { font: { size: 14 }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow2, 4, '', { font: { size: 14, bold: true } });
      setCell(ws, headerRow2, 5, '', { font: { size: 14, bold: true } });
      setCell(ws, headerRow2, 6, '', { font: { size: 14, bold: true } });
      setCell(ws, headerRow2, 7, '', { font: { size: 14, bold: true } });
      setCell(ws, headerRow2, 8, '', { font: { size: 14, bold: true } });
      setCell(ws, headerRow2, 9, 'IN CM', { font: { size: 14 }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow2, 10, 'IN KLS.', { font: { size: 14 }, alignment: { horizontal: 'center', vertical: 'middle' } });
      setCell(ws, headerRow2, 11, '', { font: { size: 14, bold: true } });
      setCell(ws, headerRow2, 12, '', { font: { size: 14, bold: true } });
      mergeCells(ws, headerRow2, 13, headerRow2, 14, '', { font: { size: 14, bold: true } });
      setCell(ws, headerRow2, 15, '', { font: { size: 14, bold: true } });
    };

    // Create pages/sheets - loop through students in chunks of 25
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      const startIdx = pageIndex * studentsPerPage;
      const endIdx = Math.min(startIdx + studentsPerPage, students.length);
      const pageStudents = students.slice(startIdx, endIdx);
      
      let currentWorksheet;
      if (pageIndex === 0) {
        // Use the first worksheet
        currentWorksheet = worksheet;
      } else {
        // Create a new worksheet for additional pages
        currentWorksheet = workbook.addWorksheet(`Masterlist (Page ${pageIndex + 1})`);
      }
      
      // Create header for this page/sheet
      createExcelHeader(currentWorksheet);
      
      // Create data and footer for this page/sheet
      createExcelPage(currentWorksheet, pageStudents, startIdx, pageIndex);
    }

    // Generate buffer and send based on format
    const timestamp = new Date().toISOString().split('T')[0];
    
    if (format === 'pdf') {
      // Generate PDF
      return generatePDF(res, {
        students,
        cdcName,
        cdwDisplayName,
        barangay,
        province,
        municipality,
        loggedInEmail,
        loggedInPhone,
        loggedInName,
        focalName,
        mswName,
        maleCount,
        femaleCount,
        totalCount,
        timestamp
      });
    } else {
      // Generate Excel
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="cdc-students-${timestamp}.xlsx"`
      );
      return res.status(200).send(buffer);
    }
  } catch (err) {
    console.error('Excel export error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to export students.'
    });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/import', authenticate, handleCsvUpload, async (req, res) => {
  const cdcId = req.user?.cdc_id;
  if (!cdcId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. User is not associated with a CDC.'
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'No CSV file uploaded.'
    });
  }

  // Parse CSV as raw rows (handling the template format)
  let rawRows;
  try {
    const csvText = req.file.buffer.toString('utf-8').replace(/^\ufeff/, ''); // Remove BOM if present
    rawRows = csvText.split('\n').map(line => {
      const result = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++; // Skip next quote
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    });
  } catch (err) {
    console.error('CSV parse error:', err);
    return res.status(400).json({
      success: false,
      message: 'Unable to read CSV file.'
    });
  }

  if (!rawRows.length || rawRows.length < 18) {
    return res.status(400).json({
      success: false,
      message: 'CSV file is empty or invalid format.'
    });
  }

  // Find data section - skip header rows (1-17), start from row 18 (index 17)
  // Row 16 (index 15) has headers, row 17 (index 16) has sub-headers, row 18 (index 17) starts data
  const dataRows = [];
  for (let i = 17; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row || row.length === 0) continue;
    
    // Stop at footer section (look for "Prepared by:" or empty rows after data)
    if (row[1] && row[1].includes('Prepared by:')) break;
    
    // Check if this is a data row - should have a number in first column and name in second
    const rowNum = row[0] ? row[0].trim() : '';
    const nameValue = row[1] ? row[1].trim() : '';
    
    // Skip if no row number or no name (empty template rows)
    if (!rowNum || !nameValue || !/^\d+$/.test(rowNum)) continue;
    
    // This is a valid data row
    dataRows.push({
      no: row[0]?.trim() || '',
      nameOfChild: row[1]?.trim() || '',
      sex: row[2]?.trim() || '',
      fourPsIdNumber: row[3]?.trim() || '',
      disability: row[4]?.trim() || '',
      birthdate: row[5]?.trim() || '',
      ageInMonths: row[6]?.trim() || '',
      height: row[7]?.trim() || '',
      weight: row[8]?.trim() || '',
      birthplace: row[9]?.trim() || '',
      address: row[10]?.trim() || '',
      guardianName: row[11]?.trim() || '',
      contactNo: row[12]?.trim() || ''
    });
  }

  if (!dataRows.length) {
    return res.status(400).json({
      success: false,
      message: 'No valid student data found in CSV file.'
    });
  }

  const summary = { inserted: 0, skipped: 0 };
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    for (const row of dataRows) {
      const { firstName, middleName, lastName } = splitChildName(row.nameOfChild || '');
      const gender = parseGender(row.sex);
      const birthdate = parseBirthdateFromCsv(row.birthdate);
      const guardianName = (row.guardianName || '').trim() || 'Unknown';
      const address = (row.address || '').trim() || null;
      const contactNo = (row.contactNo || '').trim() || null;
      const fourPsId = (row.fourPsIdNumber || '').trim() || null;
      const disability = normalizeYesNo(row.disability, null);
      const height = toNullableNumber(row.height);
      const weight = toNullableNumber(row.weight);
      const birthplace = (row.birthplace || '').trim() || null;

      if (!firstName || !lastName || !gender || !birthdate) {
        summary.skipped += 1;
        continue;
      }

      const [existing] = await connection.query(
        `SELECT student_id 
         FROM students 
         WHERE first_name = ? 
           AND last_name = ?
           AND birthdate = ?
           AND cdc_id = ?
         LIMIT 1`,
        [firstName, lastName, birthdate, cdcId]
      );

      if (existing.length) {
        summary.skipped += 1;
        continue;
      }

      const [studentInsert] = await connection.query(
        `INSERT INTO students 
          (first_name, middle_name, last_name, birthdate, gender, cdc_id, enrolled_at, four_ps_id, disability, height_cm, weight_kg, birthplace)
         VALUES (?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?)`,
        [
          firstName,
          middleName,
          lastName,
          birthdate,
          gender,
          cdcId,
          fourPsId,
          disability,
          height,
          weight,
          birthplace
        ]
      );

      const studentId = studentInsert.insertId;

      await connection.query(
        `INSERT INTO child_other_info 
          (student_id, child_address, first_language, second_language)
         VALUES (?, ?, NULL, NULL)`,
        [studentId, address]
      );

      await connection.query(
        `INSERT INTO guardian_info 
          (student_id, guardian_name, relationship, email_address, phone_num, address)
         VALUES (?, ?, 'Parent/Guardian', NULL, ?, ?)`,
        [studentId, guardianName, contactNo, address]
      );

      summary.inserted += 1;
    }

    await connection.commit();
    return res.json({
      success: true,
      message: 'CSV import completed.',
      summary
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error('CSV import error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to import students.'
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
      SELECT gender, COUNT(*) as count 
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
    
    query += ' GROUP BY gender';

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
    
    const [currentMonthResults] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM students
       WHERE MONTH(enrolled_at) = ? 
       AND YEAR(enrolled_at) = ?
       AND cdc_id = ?`,
      [currentMonth, currentYear, cdcId]
    );
    
    const [lastMonthResults] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM students
       WHERE MONTH(enrolled_at) = ? 
       AND YEAR(enrolled_at) = ?
       AND cdc_id = ?`,
      [lastMonth, lastYear, cdcId]
    );
    
    const [totalResults] = await connection.query(
      `SELECT COUNT(*) as total 
       FROM students
       WHERE cdc_id = ?`,
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
         FROM students
         WHERE birthdate BETWEEN ? AND ?
         AND cdc_id = ?`,
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