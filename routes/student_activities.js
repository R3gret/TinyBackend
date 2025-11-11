const express = require('express');
const router = express.Router();
const db = require('../db');

// Helper function to calculate age in years.months format
function calculateAge(dob) {
    const birthDate = new Date(dob);
    const today = new Date();
    let years = today.getFullYear() - birthDate.getFullYear();
    let months = today.getMonth() - birthDate.getMonth();
    if (months < 0 || (months === 0 && today.getDate() < birthDate.getDate())) {
        years--;
        months += 12;
    }
    // Return age as a numeric value like 3.11 for 3 years and 11 months
    return years + (months / 100);
}

// Helper function to parse age range string like "3.1-4.0"
function parseAgeRange(rangeStr) {
    // Assuming format is "min-max years" e.g., "3.1-4.0 years" or "5.1-5.11 years"
    const [minStr, maxStr] = rangeStr.split('?')[0].split('-');
    const minAge = parseFloat(minStr.replace('?', '.'));
    const maxAge = parseFloat(maxStr.replace('?', '.'));
    return { minAge, maxAge };
}


router.get('/', async (req, res) => {
    const parentUserId = req.user.id;
    const userType = req.user.type;

    if (userType !== 'parent') {
        return res.status(403).json({ error: 'This route is for parents only.' });
    }

    let connection;
    try {
        connection = await db.promisePool.getConnection();

        // 1. Find the student linked to the parent
        const [studentLink] = await connection.query(
            'SELECT student_id FROM guardian_info WHERE id = ?',
            [parentUserId]
        );

        if (studentLink.length === 0 || !studentLink[0].student_id) {
            return res.status(404).json({ error: 'No student is linked to this parent account.' });
        }
        const studentId = studentLink[0].student_id;

        // 2. Get the student's details (DOB and CDC)
        const [studentDetails] = await connection.query(
            'SELECT date_of_birth, cdc_id FROM students WHERE student_id = ?',
            [studentId]
        );

        if (studentDetails.length === 0) {
            return res.status(404).json({ error: 'Linked student not found.' });
        }
        const { date_of_birth, cdc_id } = studentDetails[0];

        // 3. Calculate student's age
        const studentAge = calculateAge(date_of_birth);

        // 4. Get all age groups
        const [ageGroups] = await connection.query('SELECT age_group_id, age_range FROM age_groups');

        // 5. Determine the correct age group
        let targetAgeGroupId = null;
        for (const group of ageGroups) {
            if (group.age_range) {
                const { minAge, maxAge } = parseAgeRange(group.age_range);
                if (studentAge >= minAge && studentAge <= maxAge) {
                    targetAgeGroupId = group.age_group_id;
                    break;
                }
            }
        }

        if (!targetAgeGroupId) {
            return res.json([]); // Return empty array if no matching age group is found
        }

        // 6. Fetch activities for that age group and CDC
        const [activities] = await connection.query(
            `SELECT tha.*, ag.age_range 
             FROM take_home_activities tha
             LEFT JOIN age_groups ag ON tha.age_group_id = ag.age_group_id
             WHERE tha.cdc_id = ? AND tha.age_group_id = ?
             ORDER BY tha.creation_date DESC`,
            [cdc_id, targetAgeGroupId]
        );

        // 7. Return the filtered list
        res.json(activities);

    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to fetch student activities.' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;
