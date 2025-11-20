const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const csvParser = require('csv-parser');
const { Parser } = require('json2csv');
const { Readable } = require('stream');
const moment = require('moment');

// Middleware to get CDC ID from JWT
const authenticate = require('./authMiddleware');

const csvFields = [
  { label: 'No.', value: 'rowNumber' },
  { label: 'Name of Child', value: 'nameOfChild' },
  { label: 'Sex', value: 'sex' },
  { label: '4Ps ID Number', value: 'fourPsIdNumber' },
  { label: 'Disability (Y/N)', value: 'disability' },
  { label: 'Birthdate (M-D-Y)', value: 'birthdate' },
  { label: 'Age in Months', value: 'ageInMonths' },
  { label: 'Height (cm)', value: 'heightCm' },
  { label: 'Weight (kg)', value: 'weightKg' },
  { label: 'Birthplace', value: 'birthplace' },
  { label: 'Address', value: 'address' },
  { label: 'Parent/Guardian Name', value: 'guardianName' },
  { label: 'Contact No.', value: 'contactNo' }
];

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

router.get('/export', async (req, res) => {
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

    const csvRows = students.map((student, index) => ({
      rowNumber: index + 1,
      nameOfChild: formatChildName(student),
      sex: student.gender || '',
      fourPsIdNumber: student.four_ps_id || '',
      disability: normalizeYesNo(student.disability, ''),
      birthdate: formatDateForCsv(student.birthdate),
      ageInMonths: calculateAgeInMonths(student.birthdate),
      heightCm: student.height_cm ?? '',
      weightKg: student.weight_kg ?? '',
      birthplace: student.birthplace ?? '',
      address: student.child_address ?? '',
      guardianName: student.guardian_name ?? '',
      contactNo: student.phone_num ?? ''
    }));

    const parser = new Parser({
      fields: csvFields,
      excelStrings: true,
      withBOM: true
    });
    const csv = parser.parse(csvRows);

    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="cdc-students-${timestamp}.csv"`
    );
    return res.status(200).send(csv);
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

router.post('/import', handleCsvUpload, async (req, res) => {
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

  let rows;
  try {
    rows = await parseCsvBuffer(req.file.buffer);
  } catch (err) {
    console.error('CSV parse error:', err);
    return res.status(400).json({
      success: false,
      message: 'Unable to read CSV file.'
    });
  }

  if (!rows.length) {
    return res.status(400).json({
      success: false,
      message: 'CSV file is empty.'
    });
  }

  const summary = { inserted: 0, skipped: 0 };
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    for (const row of rows) {
      const nameValue = row['Name of Child'] || row['nameOfChild'];
      const { firstName, middleName, lastName } = splitChildName(nameValue || '');
      const gender = parseGender(row['Sex'] || row['sex']);
      const birthdate = parseBirthdateFromCsv(row['Birthdate (M-D-Y)'] || row['birthdate']);
      const guardianName = (row['Parent/Guardian Name'] || row['guardianName'] || '').trim() || 'Unknown';
      const address = (row['Address'] || row['address'] || '').trim() || null;
      const contactNo = (row['Contact No.'] || row['contactNo'] || '').trim() || null;
      const fourPsId = (row['4Ps ID Number'] || row['fourPsIdNumber'] || '').trim() || null;
      const disability = normalizeYesNo(row['Disability (Y/N)'] || row['disability'], null);
      const height = toNullableNumber(row['Height (cm)'] || row['heightCm']);
      const weight = toNullableNumber(row['Weight (kg)'] || row['weightKg']);
      const birthplace = (row['Birthplace'] || row['birthplace'] || '').trim() || null;

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