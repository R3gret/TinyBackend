const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('./authMiddleware');

// GET student profile
router.get('/:student_id', authenticate, async (req, res) => {
    const { student_id } = req.params;
    let connection;

    try {
        connection = await db.promisePool.getConnection();
        const [student] = await connection.query('SELECT * FROM students WHERE student_id = ?', [student_id]);
        if (student.length === 0) {
            return res.status(404).json({ success: false, message: 'Student not found' });
        }

        const [child_other_info] = await connection.query('SELECT * FROM child_other_info WHERE student_id = ?', [student_id]);
        const [guardian_info] = await connection.query('SELECT * FROM guardian_info WHERE student_id = ?', [student_id]);
        const [mother_info] = await connection.query('SELECT * FROM mother_info WHERE student_id = ?', [student_id]);
        const [father_info] = await connection.query('SELECT * FROM father_info WHERE student_id = ?', [student_id]);
        const [emergency_info] = await connection.query('SELECT * FROM emergency_info WHERE student_id = ?', [student_id]);

        const profile = {
            ...student[0],
            ...child_other_info[0],
            ...guardian_info[0],
            ...mother_info[0],
            ...father_info[0],
            ...emergency_info[0]
        };

        res.json({ success: true, profile });
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    } finally {
        if (connection) connection.release();
    }
});

// UPDATE student profile
router.put('/:student_id', authenticate, async (req, res) => {
    const { student_id } = req.params;
    const {
        first_name, middle_name, last_name, birthdate, gender,
        child_address, first_language, second_language,
        guardian_name, relationship, email_address,
        mother_name, mother_occupation, mother_address, mother_home_contact, mother_work_contact,
        father_name, father_occupation, father_address, father_home_contact, father_work_contact,
        emergency_name, emergency_relationship, emergency_home_contact, emergency_work_contact
    } = req.body;

    let connection;
    try {
        connection = await db.promisePool.getConnection();
        await connection.beginTransaction();

        // Update students table
        await connection.query(
            'UPDATE students SET first_name = ?, middle_name = ?, last_name = ?, birthdate = ?, gender = ? WHERE student_id = ?',
            [first_name, middle_name, last_name, birthdate, gender, student_id]
        );

        // Update child_other_info table
        await connection.query(
            'UPDATE child_other_info SET child_address = ?, first_language = ?, second_language = ? WHERE student_id = ?',
            [child_address, first_language, second_language, student_id]
        );

        // Update guardian_info table
        await connection.query(
            'UPDATE guardian_info SET guardian_name = ?, relationship = ?, email_address = ? WHERE student_id = ?',
            [guardian_name, relationship, email_address, student_id]
        );

        // Update mother_info table
        await connection.query(
            'UPDATE mother_info SET mother_name = ?, mother_occupation = ?, mother_address = ?, mother_home_contact = ?, mother_work_contact = ? WHERE student_id = ?',
            [mother_name, mother_occupation, mother_address, mother_home_contact, mother_work_contact, student_id]
        );

        // Update father_info table
        await connection.query(
            'UPDATE father_info SET father_name = ?, father_occupation = ?, father_address = ?, father_home_contact = ?, father_work_contact = ? WHERE student_id = ?',
            [father_name, father_occupation, father_address, father_home_contact, father_work_contact, student_id]
        );

        // Update emergency_info table
        await connection.query(
            'UPDATE emergency_info SET emergency_name = ?, emergency_relationship = ?, emergency_home_contact = ?, emergency_work_contact = ? WHERE student_id = ?',
            [emergency_name, emergency_relationship, emergency_home_contact, emergency_work_contact, student_id]
        );

        await connection.commit();
        res.json({ success: true, message: 'Student profile updated successfully' });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Database error:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;