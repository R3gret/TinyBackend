const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('./authMiddleware');

// Helper function to calculate total age in months
function calculateAgeInMonths(dob) {
    const birthDate = new Date(dob);
    if (isNaN(birthDate.getTime())) {
        return null; // Handle invalid date
    }
    const today = new Date();
    let years = today.getFullYear() - birthDate.getFullYear();
    let months = today.getMonth() - birthDate.getMonth();
    if (months < 0 || (months === 0 && today.getDate() < birthDate.getDate())) {
        years--;
        months += 12;
    }
    return (years * 12) + months;
}

// Helper function to parse age range string (e.g., "3.1?4.0" or "5.1?5.11") into a month range
function parseAgeRangeToMonths(rangeStr) {
    const cleanRange = rangeStr.split(' ')[0];
    const [minStr, maxStr] = cleanRange.split('?');

    const [minYears, minMonths] = minStr.split('.').map(Number);
    const totalMinMonths = (minYears * 12) + (minMonths || 0);

    const [maxYears, maxMonths] = maxStr.split('.').map(Number);
    const totalMaxMonths = (maxYears * 12) + (maxMonths || 0);

    return { minMonths: totalMinMonths, maxMonths: totalMaxMonths };
}

router.get('/', authenticate, async (req, res) => {
    const parentUserId = req.user.id;
    const userType = req.user.type;

    if (userType !== 'parent') {
        return res.status(403).json({ error: 'This route is for parents only.' });
    }

    let connection;
    try {
        connection = await db.promisePool.getConnection();

        const [studentLink] = await connection.query('SELECT student_id FROM guardian_info WHERE id = ?', [parentUserId]);
        if (studentLink.length === 0 || !studentLink[0].student_id) {
            return res.status(404).json({ error: 'No student is linked to this parent account.' });
        }
        const studentId = studentLink[0].student_id;

        const [studentDetails] = await connection.query('SELECT date_of_birth, cdc_id FROM students WHERE student_id = ?', [studentId]);
        if (studentDetails.length === 0) {
            return res.status(404).json({ error: 'Linked student not found.' });
        }
        const { date_of_birth, cdc_id } = studentDetails[0];

        const studentAgeInMonths = calculateAgeInMonths(date_of_birth);
        if (studentAgeInMonths === null) {
            return res.json([]); // No activities if DOB is invalid
        }

        const [ageGroups] = await connection.query('SELECT age_group_id, age_range FROM age_groups');
        let targetAgeGroupId = null;
        for (const group of ageGroups) {
            if (group.age_range) {
                try {
                    const { minMonths, maxMonths } = parseAgeRangeToMonths(group.age_range);
                    if (studentAgeInMonths >= minMonths && studentAgeInMonths <= maxMonths) {
                        targetAgeGroupId = group.age_group_id;
                        break;
                    }
                } catch (e) {
                    console.error(`Could not parse age range: "${group.age_range}"`, e);
                }
            }
        }

        if (!targetAgeGroupId) {
            return res.json([]);
        }

        const [activities] = await connection.query(
            `SELECT tha.*, ag.age_range 
             FROM take_home_activities tha
             LEFT JOIN age_groups ag ON tha.age_group_id = ag.age_group_id
             WHERE tha.cdc_id = ? AND tha.age_group_id = ?
             ORDER BY tha.creation_date DESC`,
            [cdc_id, targetAgeGroupId]
        );

        res.json(activities);

    } catch (err) {
        console.error('Database error on /api/student/activities:', err);
        res.status(500).json({ error: 'Failed to fetch student activities.' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;