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
  if (!parsed.isValid()) return '';
  // Format as M-D-Y (single digits, no leading zeros)
  const month = parsed.month() + 1; // moment months are 0-indexed
  const day = parsed.date();
  const year = parsed.year();
  return `${month}-${day}-${year}`;
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
    
    // Define border style for all cells
    const borderStyle = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    
    // Helper function to add a row with optional formatting
    const addRow = (values, rowOptions = {}) => {
      const row = worksheet.addRow(values);
      if (rowOptions.border) {
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.border = borderStyle;
        });
      }
      if (rowOptions.font) {
        row.font = rowOptions.font;
      }
      if (rowOptions.height) {
        row.height = rowOptions.height;
      }
      if (rowOptions.alignment) {
        row.alignment = rowOptions.alignment;
      }
      // Apply cell-specific formatting
      if (rowOptions.cellFormats) {
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const cellFormat = rowOptions.cellFormats[colNumber - 1];
          if (cellFormat) {
            if (cellFormat.font) cell.font = cellFormat.font;
            if (cellFormat.alignment) cell.alignment = cellFormat.alignment;
            if (cellFormat.border) cell.border = borderStyle;
          }
        });
      }
      return row;
    };
    
    // Set column widths for logo area (A-C) - keep narrow for logos
    worksheet.getColumn('A').width = 12;
    worksheet.getColumn('B').width = 12;
    worksheet.getColumn('C').width = 12;
    
    // Header rows (1-5) - with merged cells and centered text
    // Row 1: Republic of the Philippines
    const row1 = worksheet.addRow(['', '', '', '', '', '', 'Republic of the Philippines', '', '', '', '', '', '', '', '']);
    worksheet.mergeCells('G1:O1');
    row1.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };
    row1.getCell(7).font = { size: 14 };
    
    // Row 2: Province
    const row2 = worksheet.addRow(['', '', '', '', '', '', `Province of ${province}`, '', '', '', '', '', '', '', '']);
    worksheet.mergeCells('G2:O2');
    row2.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };
    row2.getCell(7).font = { size: 14 };
    
    // Row 3: Municipality - centered and bold
    const row3 = worksheet.addRow(['', '', '', '', '', '', `Municipality of ${municipality}`, '', '', '', '', '', '', '', '']);
    worksheet.mergeCells('G3:O3');
    row3.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };
    row3.getCell(7).font = { size: 14, bold: true };
    
    // Row 4: Email Address - centered
    const row4 = worksheet.addRow(['', '', '', '', '', '', `Email Address: ${loggedInEmail}`, '', '', '', '', '', '', '', '']);
    worksheet.mergeCells('G4:O4');
    row4.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };
    row4.getCell(7).font = { size: 14 };
    
    // Row 5: Telephone number - centered and bold
    const row5 = worksheet.addRow(['', '', '', '', '', '', `Telephone number: ${loggedInPhone}`, '', '', '', '', '', '', '', '']);
    worksheet.mergeCells('G5:O5');
    row5.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };
    row5.getCell(7).font = { size: 14, bold: true };
    
    // Rows 6-8: Empty rows
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    
    // Row 9: Name of CDC - make CDC name bold
    const row9 = worksheet.addRow([`Name of CDC :  ${cdcName}`, '', '', '', '', '', '', '', '', `Male - ${maleCount}`, '', '', '', '', '']);
    // Make the CDC name part bold (split the text)
    const cdcText = `Name of CDC :  ${cdcName}`;
    row9.getCell(1).value = { richText: [
      { text: 'Name of CDC :  ', font: { size: 14 } },
      { text: cdcName, font: { size: 14, bold: true } }
    ]};
    row9.getCell(10).font = { bold: true, size: 14 }; // Male - bold
    
    // Row 10: Name of CDW - make CDW name bold
    const row10 = worksheet.addRow([`Name of CDW : ${cdwDisplayName}`, '', '', '', '', '', '', '', '', `Female - ${femaleCount}`, '', '', '', '', '']);
    const cdwText = `Name of CDW : ${cdwDisplayName}`;
    row10.getCell(1).value = { richText: [
      { text: 'Name of CDW : ', font: { size: 14 } },
      { text: cdwDisplayName, font: { size: 14, bold: true } }
    ]};
    row10.getCell(10).font = { bold: true, size: 14 }; // Female - bold
    
    // Row 11: Barangay - make barangay name bold, and TOTAL bold
    const row11 = worksheet.addRow([`Barangay :  ${barangay}`, '', '', '', '', '', '', '', '', `TOTAL - ${totalCount}`, '', '', '', '', '']);
    row11.getCell(1).value = { richText: [
      { text: 'Barangay :  ', font: { size: 14 } },
      { text: barangay, font: { size: 14, bold: true } }
    ]};
    row11.getCell(10).value = { richText: [
      { text: 'TOTAL - ', font: { size: 14, bold: true } },
      { text: totalCount.toString(), font: { size: 14, bold: true } }
    ]};
    
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    
    // Title row (14) - MASTERLIST OF DAYCARE CHILDREN - merge A14:O14, size 21, Arial Black Bold, centered
    const titleRow = worksheet.addRow(['MASTERLIST OF DAYCARE CHILDREN', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    worksheet.mergeCells('A14:O14');
    titleRow.getCell(1).font = { name: 'Arial Black', size: 21, bold: true };
    titleRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    titleRow.getCell(1).border = borderStyle;
    
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    
    // Column headers (16-17) - with borders and bold
    const headerRow1 = worksheet.addRow(['No. ', 'NAME OF CHILD ', 'SEX', '4ps ID Number ', 'DISABILITY', 'BIRTHDATE (M-D-Y)', 'AGE IN MONTHS ', 'HEIGHT', 'WEIGHT ', 'BIRTHPLACE ', 'ADDRESS', 'NAME OF PARENTS/GUARDIAN', 'CONTACT NO. ', '', '']);
    headerRow1.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = borderStyle;
      cell.font = { bold: true, size: 14 };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    
    const headerRow2 = worksheet.addRow(['', '"(Last Name, First Name, Middle Initial)"', '', '', '', '', '', 'IN CM', 'IN KLS. ', '', '', '', '', '', '']);
    headerRow2.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = borderStyle;
      cell.font = { size: 14 };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    
    // Data rows (18-42) - up to 25 rows - with borders, size 14, and auto-fit
    const dataStartRow = worksheet.rowCount + 1;
    for (let i = 0; i < 25; i++) {
      let rowData;
      if (i < students.length) {
        const student = students[i];
        const middleInitial = student.middle_name ? `${student.middle_name.charAt(0).toUpperCase()}.` : '';
        const fullName = `${student.last_name || ''}, ${student.first_name || ''} ${middleInitial}`.trim();
        const ageInMonths = calculateAgeInMonths(student.birthdate);
        
        rowData = [
          (i + 1).toString(),
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
          student.phone_num || '',
          '',
          ''
        ];
      } else {
        // Empty rows for template
        rowData = [(i + 1).toString(), '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
      }
      
      const dataRow = worksheet.addRow(rowData);
      dataRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = borderStyle;
        cell.font = { size: 14 };
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        // Make SEX column (column 3) values bold if they are "Male" or "Female"
        if (colNumber === 3 && (cell.value === 'Male' || cell.value === 'Female')) {
          cell.font = { size: 14, bold: true };
        }
        // Format birthdate column (column 6) as text to prevent ####### display
        if (colNumber === 6) {
          cell.numFmt = '@'; // Text format
        }
      });
    }
    
    // Footer rows
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    
    // Footer with "Prepared by:", "Validated by:", "Approved by:" - make bold
    const footerRow1 = worksheet.addRow(['', 'Prepared by: ', '', '', 'Validated by: ', '', '', '', 'Approved by: ', '', '', '', '', '', '']);
    footerRow1.getCell(2).font = { bold: true, size: 14 };
    footerRow1.getCell(5).font = { bold: true, size: 14 };
    footerRow1.getCell(9).font = { bold: true, size: 14 };
    
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    addRow(['', loggedInName, '', '', focalName, '', '', '', mswName, '', '', '', '', '', ''], {
      font: { size: 14 }
    });
    addRow(['', 'Child Development Worker', '', '', 'ECCD Focal Person', '', '', '', 'MSWDO', '', '', '', '', '', ''], {
      font: { size: 14 }
    });
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    
    // Add images - based on the screenshot, image1.png contains the header with both logos
    // We'll place it to cover the left side (A1:C11) and image.png (BAGONG PILIPINAS) in the header
    try {
      // Image 1: Header section with both logos (PAMAHALAANG BAYAN NG LIAN and MSWDO)
      // This covers A1 to C11 based on the screenshot
      const image1Path = path.join(__dirname, '..', 'image1.png');
      if (fs.existsSync(image1Path)) {
        const image1 = workbook.addImage({
          filename: image1Path,
          extension: 'png',
        });
        // Position: A1 to C11 (rows 1-11, columns A-C)
        // Calculate approximate dimensions based on column widths
        const colAWidth = worksheet.getColumn('A').width || 12;
        const colBWidth = worksheet.getColumn('B').width || 12;
        const colCWidth = worksheet.getColumn('C').width || 12;
        const totalWidth = (colAWidth + colBWidth + colCWidth) * 7; // Excel units
        const totalHeight = 11 * 20; // Approximate row height * 11 rows
        
        worksheet.addImage(image1, {
          tl: { col: 0, row: 0 }, // Top-left: column A (0), row 1 (0)
          ext: { width: totalWidth, height: totalHeight }
        });
      }
      
      // Image 2: BAGONG PILIPINAS logo - typically placed in header area
      // Based on government document standards, it might go above or integrated with header
      const image2Path = path.join(__dirname, '..', 'image.png');
      if (fs.existsSync(image2Path)) {
        const image2 = workbook.addImage({
          filename: image2Path,
          extension: 'png',
        });
        // Position it in the header area - adjust based on exact requirements
        // Placing it in the merged header area (G1:O1 region)
        worksheet.addImage(image2, {
          tl: { col: 6, row: 0 }, // Starting at column G (6), row 1 (0)
          ext: { width: 200, height: 80 } // Adjust size as needed
        });
      }
    } catch (err) {
      console.error('Error adding images:', err);
      // Continue without images if there's an error
    }
    
    // Set row heights for logo rows to accommodate images
    worksheet.getRow(1).height = 30;
    worksheet.getRow(2).height = 30;
    worksheet.getRow(3).height = 30;
    worksheet.getRow(4).height = 30;
    worksheet.getRow(5).height = 30;
    worksheet.getRow(6).height = 30;
    worksheet.getRow(7).height = 30;
    worksheet.getRow(8).height = 30;
    worksheet.getRow(9).height = 30;
    worksheet.getRow(10).height = 30;
    worksheet.getRow(11).height = 30;
    
    // Apply borders to all cells in the data area (from header rows through data rows)
    // Headers are at rows 16-17, data starts at row 18
    const headerStartRow = 16;
    const dataEndRow = headerStartRow + 1 + 25; // header rows + 25 data rows
    for (let rowNum = headerStartRow; rowNum <= dataEndRow; rowNum++) {
      const row = worksheet.getRow(rowNum);
      if (row) {
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.border = borderStyle;
        });
      }
    }
    
    // Set fixed width for SEX column (column C, index 2) BEFORE auto-fitting others
    // This ensures MASTERLIST title doesn't affect SEX column width
    worksheet.getColumn('C').width = 8; // SEX column - fixed width
    
    // Auto-fit columns, but preserve logo column widths and SEX column
    worksheet.columns.forEach((column, index) => {
      // Skip auto-fit for logo columns (A-C, indices 0-2) - already set
      if (index < 3) {
        // Column C (index 2) is SEX - already set to fixed width above
        return;
      }
      
      let maxLength = 0;
      column.eachCell({ includeEmpty: true }, (cell) => {
        const cellValue = cell.value ? cell.value.toString() : '';
        // Handle rich text
        if (typeof cellValue === 'object' && cellValue.richText) {
          const text = cellValue.richText.map(rt => rt.text).join('');
          if (text.length > maxLength) {
            maxLength = text.length;
          }
        } else if (cellValue.length > maxLength) {
          maxLength = cellValue.length;
        }
      });
      // Set column width with some padding, but cap at reasonable max
      column.width = Math.min(Math.max(maxLength + 2, 10), 50);
    });
    
    // Generate Excel file buffer
    const buffer = await workbook.xlsx.writeBuffer();
    
    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="cdc-students-${timestamp}.xlsx"`
    );
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('CSV export error:', err);
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