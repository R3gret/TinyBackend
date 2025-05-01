const express = require('express');
const router = express.Router();
const db = require('../db');

// Helper function to group domains
function groupDomains(domains, evaluations) {
  return domains.reduce((acc, item) => {
    const category = item.domain_category.toLowerCase().includes('self-help') 
      ? 'Self-Help' 
      : item.domain_category;

    if (!acc[category]) {
      acc[category] = [];
    }

    const evalData = evaluations[item.domain_id] || null;

    acc[category].push({
      id: item.domain_id,
      skill: item.item,
      evaluation: evalData ? {
        value: evalData.value,
        notes: evalData.item_notes
      } : null,
      evaluation_meta: evalData ? {
        evaluator_id: evalData.evaluator_id,
        general_notes: evalData.eval_notes
      } : null
    });

    return acc;
  }, {});
}

// Get domain structure
router.get('/structure', async (req, res) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [domainResults] = await connection.query(`
      SELECT domain_id, item, domain_category 
      FROM domains
      ORDER BY domain_category, domain_id
    `);
    
    res.json({ 
      success: true, 
      data: groupDomains(domainResults, {}) 
    });
  } catch (err) {
    console.error('Error fetching domains:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch domain structure', 
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Check if evaluation exists
router.get('/evaluations/check', async (req, res) => {
  const { student_id, period } = req.query;

  if (!student_id || !period) {
    return res.status(400).json({
      success: false,
      message: 'Missing student_id or period parameter'
    });
  }

  let connection;
  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query(
      `SELECT evaluation_id FROM evaluations 
       WHERE student_id = ? AND evaluation_period = ?`,
      [student_id, period]
    );
    
    res.json({ 
      success: true,
      exists: results.length > 0,
      data: results.length > 0 ? results[0] : null
    });
  } catch (err) {
    console.error('Error checking evaluation:', err);
    res.status(500).json({ 
      success: false,
      exists: false,
      message: 'Error checking evaluation'
    });
  } finally {
    if (connection) connection.release();
  }
});

// Get domains with evaluation status
router.get('/', async (req, res) => {
  const { student_id, period } = req.query;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    const [domainResults] = await connection.query(`
      SELECT domain_id, item, domain_category 
      FROM domains
      ORDER BY domain_category, domain_id
    `);

    if (student_id && period) {
      const [evalResults] = await connection.query(`
        SELECT ei.domain_id, ei.evaluation_value, ei.notes as item_notes,
               e.notes as eval_notes, e.evaluator_id
        FROM evaluation_items ei
        JOIN evaluations e ON ei.evaluation_id = e.evaluation_id
        WHERE e.student_id = ? AND e.evaluation_period = ?
      `, [student_id, period]);

      const evaluations = {};
      evalResults.forEach(item => {
        evaluations[item.domain_id] = {
          value: item.evaluation_value,
          item_notes: item.item_notes,
          eval_notes: item.eval_notes,
          evaluator_id: item.evaluator_id
        };
      });

      res.json({ success: true, data: groupDomains(domainResults, evaluations) });
    } else {
      res.json({ success: true, data: groupDomains(domainResults, {}) });
    }
  } catch (err) {
    console.error('Error fetching domains:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch data', 
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Get evaluation dates for a student
router.get('/evaluations/dates/:student_id', async (req, res) => {
  const { student_id } = req.params;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query(`
      SELECT evaluation_period, evaluation_date 
      FROM evaluations 
      WHERE student_id = ?
      ORDER BY evaluation_date ASC
      LIMIT 3
    `, [student_id]);

    const response = {
      firstEvaluation: results[0] || null,
      secondEvaluation: results[1] || null,
      thirdEvaluation: results[2] || null
    };

    res.json({ success: true, data: response });
  } catch (err) {
    console.error('Error fetching evaluation dates:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch evaluation dates', 
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Get evaluation scores for a student
router.get('/evaluations/scores/:student_id', async (req, res) => {
  const { student_id } = req.params;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    const [results] = await connection.query(`
      SELECT 
        d.domain_category,
        e.evaluation_period,
        COUNT(CASE WHEN ei.evaluation_value = 'yes' THEN 1 END) as yes_count,
        COUNT(ei.evaluation_item_id) as total_items
      FROM evaluations e
      JOIN evaluation_items ei ON e.evaluation_id = ei.evaluation_id
      JOIN domains d ON ei.domain_id = d.domain_id
      WHERE e.student_id = ?
      GROUP BY d.domain_category, e.evaluation_period
      ORDER BY e.evaluation_period, d.domain_category
    `, [student_id]);

    const scoresByCategory = results.reduce((acc, row) => {
      if (!acc[row.domain_category]) {
        acc[row.domain_category] = {
          first: { yes: 0, total: 0 },
          second: { yes: 0, total: 0 },
          third: { yes: 0, total: 0 }
        };
      }
      
      if (row.evaluation_period === '1st') {
        acc[row.domain_category].first = { 
          yes: row.yes_count, 
          total: row.total_items 
        };
      } else if (row.evaluation_period === '2nd') {
        acc[row.domain_category].second = { 
          yes: row.yes_count, 
          total: row.total_items 
        };
      } else if (row.evaluation_period === '3rd') {
        acc[row.domain_category].third = { 
          yes: row.yes_count, 
          total: row.total_items 
        };
      }
      
      return acc;
    }, {});

    res.json({ success: true, data: scoresByCategory });
  } catch (err) {
    console.error('Error fetching evaluation scores:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch evaluation scores', 
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Create new evaluation
router.post('/evaluations', async (req, res) => {
  const { student_id, evaluation_period, evaluator_id, notes, items } = req.body;
  let connection;

  if (!student_id || !evaluation_period) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields (student_id or evaluation_period)' 
    });
  }

  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // Check for existing evaluation
    const [existing] = await connection.query(
      `SELECT evaluation_id FROM evaluations 
       WHERE student_id = ? AND evaluation_period = ?`,
      [student_id, evaluation_period]
    );

    if (existing.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Evaluation already exists for this student and period',
        existingEvaluationId: existing[0].evaluation_id
      });
    }

    // Insert evaluation header
    const [evalResult] = await connection.query(
      `INSERT INTO evaluations 
      (student_id, evaluation_period, evaluator_id, notes) 
      VALUES (?, ?, ?, ?)`,
      [student_id, evaluation_period, evaluator_id, notes || null]
    );

    const evaluation_id = evalResult.insertId;
    
    // Insert items if they exist
    if (items && items.length > 0) {
      const insertItems = items
        .filter(item => (
          item.domain_id && 
          item.evaluation_value !== undefined && 
          item.evaluation_value !== null
        ))
        .map(item => [
          evaluation_id, 
          item.domain_id, 
          item.evaluation_value, 
          item.notes || null
        ]);

      if (insertItems.length > 0) {
        await connection.query(
          `INSERT INTO evaluation_items 
          (evaluation_id, domain_id, evaluation_value, notes) 
          VALUES ?`,
          [insertItems]
        );
      }
    }

    await connection.commit();
    res.json({ 
      success: true, 
      evaluation_id, 
      message: 'Evaluation saved successfully' 
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Error saving evaluation:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to save evaluation',
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Get evaluations for a student
router.get('/evaluations/:student_id', async (req, res) => {
  const { student_id } = req.params;
  const { period } = req.query;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    
    let query = `
      SELECT 
        e.evaluation_id, 
        e.evaluation_period, 
        e.evaluation_date,
        e.evaluator_id,
        e.notes as evaluation_notes,
        ei.evaluation_item_id, 
        ei.domain_id, 
        ei.evaluation_value,
        ei.notes as item_notes,
        d.item, 
        d.domain_category
      FROM evaluations e
      JOIN evaluation_items ei ON e.evaluation_id = ei.evaluation_id
      JOIN domains d ON ei.domain_id = d.domain_id
      WHERE e.student_id = ?
    `;
    const params = [student_id];

    if (period) {
      query += ' AND e.evaluation_period = ?';
      params.push(period);
    }

    query += ' ORDER BY e.evaluation_date DESC, d.domain_category';

    const [results] = await connection.query(query, params);

    const grouped = results.reduce((acc, row) => {
      const evalPeriod = row.evaluation_period;
      if (!acc[evalPeriod]) {
        acc[evalPeriod] = {
          evaluation_id: row.evaluation_id,
          evaluation_date: row.evaluation_date,
          evaluator_id: row.evaluator_id,
          evaluation_notes: row.evaluation_notes,
          items: []
        };
      }

      acc[evalPeriod].items.push({
        domain_id: row.domain_id,
        item: row.item,
        domain_category: row.domain_category,
        evaluation_value: row.evaluation_value,
        item_notes: row.item_notes
      });

      return acc;
    }, {});

    res.json({ success: true, data: grouped });
  } catch (err) {
    console.error('Error fetching evaluations:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch evaluations', 
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Get single evaluation by ID
router.get('/evaluations/single/:evaluation_id', async (req, res) => {
  const { evaluation_id } = req.params;
  let connection;

  try {
    connection = await db.promisePool.getConnection();
    
    const [evalResults] = await connection.query(
      `SELECT * FROM evaluations WHERE evaluation_id = ?`, 
      [evaluation_id]
    );

    if (evalResults.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Evaluation not found' 
      });
    }

    const [itemResults] = await connection.query(`
      SELECT ei.*, d.item, d.domain_category
      FROM evaluation_items ei
      JOIN domains d ON ei.domain_id = d.domain_id
      WHERE ei.evaluation_id = ?
    `, [evaluation_id]);

    res.json({
      success: true,
      data: {
        ...evalResults[0],
        items: itemResults
      }
    });
  } catch (err) {
    console.error('Error fetching evaluation:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch evaluation', 
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

// Add this to your domains router file
router.get('/evaluations/average-progress', async (req, res) => {
  let connection;
  try {
    connection = await db.promisePool.getConnection();
    
    const [domainResults] = await connection.query(`
      WITH LatestEvaluations AS (
        SELECT 
          e.student_id,
          e.evaluation_id,
          ROW_NUMBER() OVER (PARTITION BY e.student_id ORDER BY e.evaluation_date DESC) as rn
        FROM evaluations e
      ),
      DomainResults AS (
        SELECT
          d.domain_category as domain,
          COUNT(CASE WHEN ei.evaluation_value = 'yes' THEN 1 END) as mastered,
          COUNT(ei.evaluation_item_id) as total
        FROM LatestEvaluations le
        JOIN evaluation_items ei ON le.evaluation_id = ei.evaluation_id
        JOIN domains d ON ei.domain_id = d.domain_id
        WHERE le.rn = 1
        GROUP BY d.domain_category
      )
      SELECT
        domain,
        ROUND((mastered * 100.0 / NULLIF(total, 0)), 0) as progress,
        mastered,
        total
      FROM DomainResults
      ORDER BY domain;
    `);

    // Calculate totals from actual data
    const totals = domainResults.reduce((acc, row) => ({
      totalMastered: acc.totalMastered + row.mastered,
      totalItems: acc.totalItems + row.total
    }), { totalMastered: 0, totalItems: 0 });

    const averageProgress = totals.totalItems > 0 
      ? Math.round((totals.totalMastered / totals.totalItems) * 100)
      : 0;

    res.json({
      success: true,
      stats: {
        averageProgress,
        totalMastered: totals.totalMastered,
        totalItems: totals.totalItems,
        domains: domainResults.map(row => ({
          domain: row.domain.split(' / ')[0].trim(), // Use English part only
          progress: row.progress,
          mastered: row.mastered,
          total: row.total
        }))
      }
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch progress data',
      error: err.message 
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;