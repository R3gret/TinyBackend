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
const fs = require('fs');
const path = require('path');

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
  const { ageFilter } = req.query;
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

router.get('/export', authenticate, async (req, res) => {
  const cdcId = req.user?.cdc_id;
  if (!cdcId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. User is not associated with a CDC.'
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
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
    const [students] = await connection.query(
      `
        SELECT 
          s.student_id,
          s.first_name,
          s.middle_name,
          s.last_name,
          s.gender,
          s.birthdate,
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
        ORDER BY s.last_name, s.first_name
      `,
      [cdcId]
    );

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

    // Helper function to set cell with border
    const setCell = (row, col, value, style = {}) => {
      const cell = worksheet.getCell(row, col);
      cell.value = value;
      cell.border = borderStyle;
      if (style.font) cell.font = style.font;
      if (style.alignment) cell.alignment = style.alignment;
      if (style.fill) cell.fill = style.fill;
      return cell;
    };

    // Helper function to merge cells with border
    const mergeCells = (startRow, startCol, endRow, endCol, value, style = {}) => {
      worksheet.mergeCells(startRow, startCol, endRow, endCol);
      const cell = worksheet.getCell(startRow, startCol);
      cell.value = value;
      cell.border = borderStyle;
      if (style.font) cell.font = style.font;
      if (style.alignment) cell.alignment = style.alignment;
      if (style.fill) cell.fill = style.fill;
      return cell;
    };

    // Add borders to all cells in the used range first
    // We'll add borders as we create cells, but also ensure empty cells in header area have borders
    
    // Add images (logos) - Row 5-8, Columns C and E (cells C5-C8 and E5-E8)
    try {
      const image1Path = path.join(__dirname, '..', 'image.png');
      const image2Path = path.join(__dirname, '..', 'image1.png');
      
      if (fs.existsSync(image1Path)) {
        const image1 = workbook.addImage({
          filename: image1Path,
          extension: 'png',
        });
        // C5-C8: col 2 (C), rows 4-7 (5-8 in 1-indexed, but 0-indexed for ExcelJS)
        worksheet.addImage(image1, {
          tl: { col: 2, row: 4 }, // Top-left: C5
          ext: { width: 120, height: 80 } // Spanning 4 rows
        });
      }
      
      if (fs.existsSync(image2Path)) {
        const image2 = workbook.addImage({
          filename: image2Path,
          extension: 'png',
        });
        // E5-E8: col 4 (E), rows 4-7
        worksheet.addImage(image2, {
          tl: { col: 4, row: 4 }, // Top-left: E5
          ext: { width: 120, height: 80 } // Spanning 4 rows
        });
      }
    } catch (err) {
      console.error('Error adding images:', err);
    }
    
    // Add borders to header area cells (rows 1-4) that might be empty
    for (let row = 1; row <= 4; row++) {
      for (let col = 1; col <= 15; col++) {
        const cell = worksheet.getCell(row, col);
        if (!cell.border) {
          cell.border = borderStyle;
        }
      }
    }
    
    // Ensure cells with images (C5-C8 and E5-E8) have borders
    for (let row = 5; row <= 8; row++) {
      setCell(row, 3, ''); // Column C
      setCell(row, 5, ''); // Column E
    }

    // Header rows (starting from row 5, Excel is 1-indexed)
    setCell(5, 7, 'Republic of the Philippines', { font: { size: 14 } });
    setCell(6, 7, `Province of ${province}`, { font: { size: 14 } });
    setCell(7, 7, `Municipality of ${municipality}`, { font: { size: 14, bold: true } });
    setCell(8, 7, `Email Address: ${loggedInEmail}`, { font: { size: 14, color: { argb: 'FF0000FF' }, underline: true } });
    setCell(9, 7, `Telephone number: ${loggedInPhone}`, { font: { size: 14 } });
    
    // Empty rows
    for (let row = 10; row <= 12; row++) {
      for (let col = 1; col <= 15; col++) {
        setCell(row, col, '');
      }
    }
    
    // Row 13: Name of CDC and Male count
    setCell(13, 1, `Name of CDC :  ${cdcName}`, { font: { size: 14 } });
    setCell(13, 10, `Male - ${maleCount}`, { font: { size: 14, bold: true } });
    
    // Row 14: Name of CDW and Female count
    setCell(14, 1, `Name of CDW : ${cdwDisplayName}`, { font: { size: 14 } });
    setCell(14, 10, `Female - ${femaleCount}`, { font: { size: 14, bold: true } });
    
    // Row 15: Barangay and TOTAL
    setCell(15, 1, `Barangay :  ${barangay}`, { font: { size: 14 } });
    setCell(15, 10, `TOTAL - ${totalCount}`, { font: { size: 14, bold: true } });
    
    // Empty rows
    for (let row = 16; row <= 17; row++) {
      for (let col = 1; col <= 15; col++) {
        setCell(row, col, '');
      }
    }
    
    // Title row (18): MASTERLIST OF DAYCARE CHILDREN
    mergeCells(18, 1, 18, 15, 'MASTERLIST OF DAYCARE CHILDREN', {
      font: { name: 'Arial Black', size: 21, bold: true },
      alignment: { horizontal: 'center', vertical: 'middle' }
    });
    
    // Empty row
    for (let col = 1; col <= 15; col++) {
      setCell(19, col, '');
    }
    
    // Column headers (20-21)
    const headerRow1 = 20;
    setCell(headerRow1, 1, 'No.', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    mergeCells(headerRow1, 2, headerRow1 + 1, 3, 'NAME OF CHILD', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow1, 4, 'SEX', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow1, 5, '4ps ID Number', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow1, 6, 'DISABILITY', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow1, 7, 'BIRTHDATE (M-D-Y)', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow1, 8, 'AGE IN MONTHS', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF90EE90' } } });
    setCell(headerRow1, 9, 'HEIGHT', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow1, 10, 'WEIGHT', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow1, 11, 'BIRTHPLACE', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow1, 12, 'ADDRESS', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    mergeCells(headerRow1, 13, headerRow1 + 1, 14, 'NAME OF PARENTS/GUARDIAN', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow1, 15, 'CONTACT NO.', { font: { size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    
    // Sub-header row (21)
    const headerRow2 = 21;
    setCell(headerRow2, 1, '', { font: { size: 14, bold: true } });
    // NAME OF CHILD sub-header - merge cells 2-3
    mergeCells(headerRow2, 2, headerRow2, 3, '(Last Name, First Name, Middle Initial)', { font: { size: 14 }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow2, 4, '', { font: { size: 14, bold: true } });
    setCell(headerRow2, 5, '', { font: { size: 14, bold: true } });
    setCell(headerRow2, 6, '', { font: { size: 14, bold: true } });
    setCell(headerRow2, 7, '', { font: { size: 14, bold: true } });
    setCell(headerRow2, 8, 'IN CM', { font: { size: 14 }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow2, 9, 'IN KLS.', { font: { size: 14 }, alignment: { horizontal: 'center', vertical: 'middle' } });
    setCell(headerRow2, 10, '', { font: { size: 14, bold: true } });
    setCell(headerRow2, 11, '', { font: { size: 14, bold: true } });
    setCell(headerRow2, 12, '', { font: { size: 14, bold: true } });
    // NAME OF PARENTS/GUARDIAN sub-header - already merged in row 20, so cells 13-14 are empty in row 21
    setCell(headerRow2, 13, '', { font: { size: 14, bold: true } });
    setCell(headerRow2, 14, '', { font: { size: 14, bold: true } });
    setCell(headerRow2, 15, '', { font: { size: 14, bold: true } });
    
    // Data rows (22-46) - up to 25 rows
    for (let i = 0; i < 25; i++) {
      const rowNum = 22 + i;
      if (i < students.length) {
        const student = students[i];
        const middleInitial = student.middle_name ? `${student.middle_name.charAt(0).toUpperCase()}.` : '';
        const fullName = `${student.last_name || ''}, ${student.first_name || ''} ${middleInitial}`.trim();
        const ageInMonths = calculateAgeInMonths(student.birthdate);
        
        // Column 1: No.
        setCell(rowNum, 1, (i + 1).toString(), { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
        
        // Columns 2-3: NAME OF CHILD (merged)
        mergeCells(rowNum, 2, rowNum, 3, fullName, { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
        
        // Column 4: SEX
        setCell(rowNum, 4, student.gender || '', { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
        
        // Column 5: 4ps ID Number
        setCell(rowNum, 5, student.four_ps_id || '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
        
        // Column 6: DISABILITY
        setCell(rowNum, 6, normalizeYesNo(student.disability, ''), { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
        
        // Column 7: BIRTHDATE
        setCell(rowNum, 7, formatDateForCsv(student.birthdate), { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
        
        // Column 8: AGE IN MONTHS
        setCell(rowNum, 8, ageInMonths === '' ? '' : ageInMonths.toString(), { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
        
        // Column 9: HEIGHT
        setCell(rowNum, 9, student.height_cm ? student.height_cm.toString() : '', { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
        
        // Column 10: WEIGHT
        setCell(rowNum, 10, student.weight_kg ? student.weight_kg.toString() : '', { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
        
        // Column 11: BIRTHPLACE
        setCell(rowNum, 11, student.birthplace || '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
        
        // Column 12: ADDRESS
        setCell(rowNum, 12, student.child_address || '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
        
        // Columns 13-14: NAME OF PARENTS/GUARDIAN (merged)
        mergeCells(rowNum, 13, rowNum, 14, student.guardian_name || '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
        
        // Column 15: CONTACT NO.
        setCell(rowNum, 15, student.phone_num || '', { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
      } else {
        // Empty rows for template
        setCell(rowNum, 1, (i + 1).toString(), { font: { size: 14 }, alignment: { vertical: 'middle', horizontal: 'center' } });
        mergeCells(rowNum, 2, rowNum, 3, '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
        for (let col = 4; col <= 12; col++) {
          setCell(rowNum, col, '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
        }
        mergeCells(rowNum, 13, rowNum, 14, '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
        setCell(rowNum, 15, '', { font: { size: 14 }, alignment: { vertical: 'middle', wrapText: true } });
      }
    }
    
    // Footer rows
    for (let row = 47; row <= 48; row++) {
      for (let col = 1; col <= 15; col++) {
        setCell(row, col, '', { font: { size: 14 } });
      }
    }
    
    setCell(49, 2, 'Prepared by: ', { font: { size: 14 } });
    setCell(49, 5, 'Validated by: ', { font: { size: 14 } });
    setCell(49, 9, 'Approved by: ', { font: { size: 14 } });
    
    for (let col = 1; col <= 15; col++) {
      setCell(50, col, '', { font: { size: 14 } });
    }
    
    setCell(51, 2, loggedInName, { font: { size: 14 } });
    setCell(51, 5, focalName, { font: { size: 14 } });
    setCell(51, 9, mswName, { font: { size: 14 } });
    
    setCell(52, 2, 'Child Development Worker', { font: { size: 14 } });
    setCell(52, 5, 'ECCD Focal Person', { font: { size: 14 } });
    setCell(52, 9, 'MSWDO', { font: { size: 14 } });
    
    // Empty footer rows
    for (let row = 53; row <= 58; row++) {
      for (let col = 1; col <= 15; col++) {
        setCell(row, col, '', { font: { size: 14 } });
      }
    }

    // Auto-fit columns
    worksheet.columns.forEach((column, index) => {
      let maxLength = 0;
      column.eachCell({ includeEmpty: true }, (cell) => {
        const cellValue = cell.value ? cell.value.toString() : '';
        const cellLength = cellValue.length;
        if (cellLength > maxLength) {
          maxLength = cellLength;
        }
      });
      column.width = Math.min(Math.max(maxLength + 2, 10), 50);
    });

    // Set row heights
    for (let row = 1; row <= 58; row++) {
      const rowObj = worksheet.getRow(row);
      rowObj.height = row === 18 ? 30 : 20; // Title row is taller
    }

    // Generate buffer and send
    const buffer = await workbook.xlsx.writeBuffer();
    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="cdc-students-${timestamp}.xlsx"`
    );
    return res.status(200).send(buffer);
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