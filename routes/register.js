const express = require('express');
const router = express.Router();
const db = require('../db');

router.post('/register', async (req, res) => {
  const {
    childFirstName, childLastName, childMiddleName, childGender, childAddress, childBirthday,
    childFirstLanguage, childSecondLanguage,
    guardianName, guardianRelationship, guardianEmail,
    motherName, motherOccupation, motherAddress, motherContactHome, motherContactWork,
    fatherName, fatherOccupation, fatherAddress, fatherContactHome, fatherContactWork,
    emergencyName, emergencyRelationship, emergencyContactHome, emergencyContactWork
  } = req.body;

  console.log("Received data:", req.body);

  if (!childFirstName || !childLastName || !guardianName || !motherName || !fatherName) {
    return res.status(400).json({ success: false, message: 'Required fields are missing.' });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // Step 1: Insert into students
    const studentQuery = `INSERT INTO students 
      (first_name, middle_name, last_name, birthdate, gender) 
      VALUES (?, ?, ?, ?, ?)`;
    
    const [studentResults] = await connection.query(studentQuery, [
      childFirstName, 
      childMiddleName, 
      childLastName, 
      childBirthday, 
      childGender
    ]);

    const studentId = studentResults.insertId;
    console.log(`Inserted student ID: ${studentId}`);

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
      (student_id, guardian_name, relationship, email_address) 
      VALUES (?, ?, ?, ?)`;
    
    await connection.query(guardianQuery, [
      studentId, 
      guardianName, 
      guardianRelationship, 
      guardianEmail
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
    return res.json({ success: true, message: 'Registration successful', studentId });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Database error:', err);
    return res.status(500).json({ success: false, message: 'Database error during registration' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;