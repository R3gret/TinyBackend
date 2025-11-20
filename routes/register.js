const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('./authMiddleware');

router.post('/', authenticate, async (req, res) => {
  const {
    childFirstName, childLastName, childMiddleName, childGender, childAddress, childBirthday,
    childFirstLanguage, childSecondLanguage,
    childFourPsId, childDisability, childHeightCm, childWeightKg, childBirthplace,
    guardianName, guardianRelationship, guardianEmail, guardianPhone, guardianAddress,
    motherName, motherOccupation, motherAddress, motherContactHome, motherContactWork,
    fatherName, fatherOccupation, fatherAddress, fatherContactHome, fatherContactWork,
    emergencyName, emergencyRelationship, emergencyContactHome, emergencyContactWork,
    studentId  // Manual student ID provided by user (format: YYYY-MM-DD)
  } = req.body;

  if (!childFirstName || !childLastName || !guardianName || !motherName || !fatherName) {
    return res.status(400).json({ success: false, message: 'Required fields are missing.' });
  }

  // Validate manual student ID
  if (!studentId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Student ID is required. Format: YYYY-MM-DD (e.g., 2025-01-01)' 
    });
  }

  // Validate format: YYYY-MM-DD
  const idPattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!idPattern.test(studentId)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid student ID format. Expected format: YYYY-MM-DD (e.g., 2025-01-01)' 
    });
  }

  // Validate date parts
  const [year, month, day] = studentId.split('-').map(Number);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid student ID. Year must be 2000-2100, month 01-12, day 01-31' 
    });
  }

  let connection;
  try {
    const { cdc_id } = req.user;
    const enrolled_at = new Date();
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // Check if student ID already exists
    const [existing] = await connection.query(
      `SELECT student_id FROM students WHERE student_id = ? LIMIT 1`,
      [studentId]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: `Student ID "${studentId}" already exists. Please use a different ID.` 
      });
    }

    // Step 1: Insert into students with manual student_id
    const studentQuery = `INSERT INTO students 
      (student_id, first_name, middle_name, last_name, birthdate, gender, cdc_id, enrolled_at, four_ps_id, disability, height_cm, weight_kg, birthplace) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    await connection.query(studentQuery, [
      studentId,  // Manual student ID
      childFirstName, 
      childMiddleName, 
      childLastName, 
      childBirthday, 
      childGender,
      cdc_id,
      enrolled_at,
      childFourPsId || null,
      childDisability ? childDisability.toUpperCase() === 'Y' ? 'Y' : 'N' : 'N',
      childHeightCm || null,
      childWeightKg || null,
      childBirthplace || null
    ]);
    

    // Step 2: Insert into child_other_info
    const childInfoQuery = `INSERT INTO child_other_info 
      (student_id, child_address, first_language, second_language) 
      VALUES (?, ?, ?, ?)`;
    
    await connection.query(childInfoQuery, [
      studentId, 
      childAddress, 
      childFirstLanguage, 
      childSecondLanguage
    ]);

    // Step 3: Guardian info
    const guardianQuery = `INSERT INTO guardian_info 
      (student_id, guardian_name, relationship, email_address, phone_num, address) 
      VALUES (?, ?, ?, ?, ?, ?)`;
    
    await connection.query(guardianQuery, [
      studentId, 
      guardianName, 
      guardianRelationship, 
      guardianEmail,
      guardianPhone,
      guardianAddress
    ]);

    // Step 4: Mother info
    const motherQuery = `INSERT INTO mother_info 
      (student_id, mother_name, mother_occupation, mother_address, mother_home_contact, mother_work_contact) 
      VALUES (?, ?, ?, ?, ?, ?)`;
    
    await connection.query(motherQuery, [
      studentId, 
      motherName, 
      motherOccupation, 
      motherAddress, 
      motherContactHome, 
      motherContactWork
    ]);

    // Step 5: Father info
    const fatherQuery = `INSERT INTO father_info 
      (student_id, father_name, father_occupation, father_address, father_home_contact, father_work_contact) 
      VALUES (?, ?, ?, ?, ?, ?)`;
    
    await connection.query(fatherQuery, [
      studentId, 
      fatherName, 
      fatherOccupation, 
      fatherAddress, 
      fatherContactHome, 
      fatherContactWork
    ]);

    // Step 6: Emergency info
    const emergencyQuery = `INSERT INTO emergency_info 
      (student_id, emergency_name, emergency_relationship, emergency_home_contact, emergency_work_contact) 
      VALUES (?, ?, ?, ?, ?)`;
    
    await connection.query(emergencyQuery, [
      studentId, 
      emergencyName, 
      emergencyRelationship, 
      emergencyContactHome, 
      emergencyContactWork
    ]);

    await connection.commit();
    console.log('All data inserted for student ID:', studentId);
    return res.json({ 
      success: true, 
      message: 'Registration successful', 
      studentId: studentId
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Database error:', err);
    return res.status(500).json({ success: false, message: 'Database error during registration' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;