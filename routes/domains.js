const express = require('express');
const router = express.Router();
const db = require('../db'); // db should be created with mysql2.createConnection


router.get('/structure', (req, res) => {
  db.query(`
    SELECT domain_id, item, domain_category 
    FROM domains
    ORDER BY domain_category, domain_id
  `, (err, domainResults) => {
    if (err) {
      console.error('Error fetching domains:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch domain structure', 
        error: err.message 
      });
    }
    
    res.json({ 
      success: true, 
      data: groupDomains(domainResults, {}) 
    });
  });
});


router.get('/evaluations/check', (req, res) => {
  console.log('Checking evaluation for:', req.query);
  const { student_id, period } = req.query;

  if (!student_id || !period) {
    return res.status(400).json({
      success: false,
      message: 'Missing student_id or period parameter'
    });
  }

  // Debug: Log the exact query being executed
  const sql = `SELECT evaluation_id FROM evaluations WHERE student_id = ? AND evaluation_period = ?`;
  console.log('Executing SQL:', sql, 'with params:', [student_id, period]);

  db.query(sql, [student_id, period], (err, results) => {
    console.log('Database returned:', { err, results }); // Debug database response
    
    if (err) {
      console.error('Error checking evaluation:', err);
      return res.status(500).json({ 
        success: false,
        exists: false,
        message: 'Error checking evaluation'
      });
    }

    // Debug: Verify results structure
    console.log('Results length:', results.length);
    console.log('First result:', results[0]);

    res.json({ 
      success: true,
      exists: results.length > 0,
      data: results.length > 0 ? results[0] : null // Return first result if exists
    });
  });
});

// GET all domains and items with their evaluation status for a specific student/period
router.get('/', (req, res) => {
  const { student_id, period } = req.query;

  db.query(`
    SELECT domain_id, item, domain_category 
    FROM domains
    ORDER BY domain_category, domain_id
  `, (err, domainResults) => {
    if (err) {
      console.error('Error fetching domains:', err);
      return res.status(500).json({ success: false, message: 'Failed to fetch domains', error: err.message });
    }

    if (student_id && period) {
      db.query(`
        SELECT ei.domain_id, ei.evaluation_value, ei.notes as item_notes,
               e.notes as eval_notes, e.evaluator_id
        FROM evaluation_items ei
        JOIN evaluations e ON ei.evaluation_id = e.evaluation_id
        WHERE e.student_id = ? AND e.evaluation_period = ?
      `, [student_id, period], (err, evalResults) => {
        if (err) {
          console.error('Error fetching evaluations:', err);
          return res.status(500).json({ success: false, message: 'Failed to fetch evaluations', error: err.message });
        }

        const evaluations = {};
        evalResults.forEach(item => {
          evaluations[item.domain_id] = {
            value: item.evaluation_value,
            item_notes: item.item_notes,
            eval_notes: item.eval_notes,
            evaluator_id: item.evaluator_id
          };
        });

        return res.json({ success: true, data: groupDomains(domainResults, evaluations) });
      });
    } else {
      return res.json({ success: true, data: groupDomains(domainResults, {}) });
    }
  });
});

function groupDomains(domains, evaluations) {
  return domains.reduce((acc, item) => {
    // Combine all "Self-Help" variations into one category
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



// Add this new route to your backend
router.get('/evaluations/dates/:student_id', (req, res) => {
  const { student_id } = req.params;

  db.query(`
    SELECT evaluation_period, evaluation_date 
    FROM evaluations 
    WHERE student_id = ?
    ORDER BY evaluation_date ASC
    LIMIT 3
  `, [student_id], (err, results) => {
    if (err) {
      console.error('Error fetching evaluation dates:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch evaluation dates', 
        error: err.message 
      });
    }

    const response = {
      firstEvaluation: results[0] || null,
      secondEvaluation: results[1] || null,
      thirdEvaluation: results[2] || null
    };

    res.json({ success: true, data: response });
  });
});

router.get('/evaluations/scores/:student_id', (req, res) => {
  const { student_id } = req.params;

  db.query(`
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
  `, [student_id], (err, results) => {
    if (err) {
      console.error('Error fetching evaluation scores:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch evaluation scores', 
        error: err.message 
      });
    }

    // Organize the data by domain category and evaluation period
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

    console.log('Organized scores by category:', scoresByCategory);

    res.json({ success: true, data: scoresByCategory });
  });
});


// POST new evaluation results
router.post('/evaluations', (req, res) => {
  const { student_id, evaluation_period, evaluator_id, notes, items } = req.body;

  // Validate required fields
  if (!student_id || !evaluation_period) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields (student_id or evaluation_period)' 
    });
  }

  console.log('Received items count:', items?.length || 0);
  console.log('Sample items:', items?.slice(0, 3));

  // First check if evaluation already exists for this student and period
  db.query(
    `SELECT evaluation_id FROM evaluations 
     WHERE student_id = ? AND evaluation_period = ?`,
    [student_id, evaluation_period],
    (err, results) => {
      if (err) {
        console.error('Error checking for existing evaluation:', err);
        return res.status(500).json({ 
          success: false, 
          message: 'Failed to check for existing evaluation',
          error: err.message 
        });
      }

      if (results.length > 0) {
        return res.status(400).json({ 
          success: false, 
          message: 'Evaluation already exists for this student and period',
          existingEvaluationId: results[0].evaluation_id
        });
      }

      // Proceed with transaction if no duplicate found
      db.beginTransaction(err => {
        if (err) {
          console.error('Error starting transaction:', err);
          return res.status(500).json({ 
            success: false, 
            message: 'Failed to start transaction',
            error: err.message 
          });
        }

        // Insert evaluation header
        db.query(
          `INSERT INTO evaluations 
          (student_id, evaluation_period, evaluator_id, notes) 
          VALUES (?, ?, ?, ?)`,
          [student_id, evaluation_period, evaluator_id, notes || null],
          (err, evalResult) => {
            if (err) {
              return db.rollback(() => {
                console.error('Error inserting evaluation:', err);
                res.status(500).json({ 
                  success: false, 
                  message: 'Failed to save evaluation',
                  error: err.message 
                });
              });
            }

            const evaluation_id = evalResult.insertId;
            
            // Check if there are items to insert
            if (!items || items.length === 0) {
              console.log('No items to insert');
              return db.commit(err => {
                if (err) {
                  return db.rollback(() => {
                    console.error('Error committing transaction:', err);
                    res.status(500).json({ 
                      success: false, 
                      message: 'Transaction commit failed',
                      error: err.message 
                    });
                  });
                }
                res.json({ 
                  success: true, 
                  evaluation_id, 
                  message: 'Evaluation saved successfully (no items)' 
                });
              });
            }

            // Prepare items for batch insert with strict validation
            const insertItems = items
              .filter(item => {
                const isValid = (
                  item.domain_id && 
                  item.evaluation_value !== undefined && 
                  item.evaluation_value !== null
                );
                if (!isValid) {
                  console.warn('Invalid item filtered out:', item);
                }
                return isValid;
              })
              .map(item => [
                evaluation_id, 
                item.domain_id, 
                item.evaluation_value, 
                item.notes || null
              ]);

            console.log('Valid items to insert:', insertItems.length);

            // Skip if no valid items after filtering
            if (insertItems.length === 0) {
              console.log('No valid items after filtering');
              return db.commit(err => {
                if (err) {
                  return db.rollback(() => {
                    console.error('Error committing transaction:', err);
                    res.status(500).json({ 
                      success: false, 
                      message: 'Transaction commit failed',
                      error: err.message 
                    });
                  });
                }
                res.json({ 
                  success: true, 
                  evaluation_id, 
                  message: 'Evaluation saved successfully (no valid items)' 
                });
              });
            }

            // Insert evaluation items
            const query = `
              INSERT INTO evaluation_items 
              (evaluation_id, domain_id, evaluation_value, notes) 
              VALUES ?
            `;

            db.query(query, [insertItems], (err, result) => {
              if (err) {
                return db.rollback(() => {
                  console.error('Error inserting evaluation items:', err);
                  res.status(500).json({ 
                    success: false, 
                    message: 'Failed to save evaluation items',
                    error: err.message 
                  });
                });
              }

              console.log('Items successfully inserted:', result.affectedRows);

              db.commit(err => {
                if (err) {
                  return db.rollback(() => {
                    console.error('Error committing transaction:', err);
                    res.status(500).json({ 
                      success: false, 
                      message: 'Transaction commit failed',
                      error: err.message 
                    });
                  });
                }

                res.json({ 
                  success: true, 
                  evaluation_id, 
                  itemsInserted: insertItems.length,
                  message: 'Evaluation saved successfully' 
                });
              });
            });
          }
        );
      });
    }
  );
});

// GET evaluations for a student
router.get('/evaluations/:student_id', (req, res) => {
  const { student_id } = req.params;
  const { period } = req.query;

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

  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Error fetching evaluations:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch evaluations', 
        error: err.message 
      });
    }

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
  });
});

// GET single evaluation by ID
router.get('/evaluations/single/:evaluation_id', (req, res) => {
  const { evaluation_id } = req.params;

  db.query(
    `SELECT * FROM evaluations WHERE evaluation_id = ?`, 
    [evaluation_id], 
    (err, evalResult) => {
      if (err) {
        console.error('Error fetching evaluation:', err);
        return res.status(500).json({ 
          success: false, 
          message: 'Failed to fetch evaluation', 
          error: err.message 
        });
      }

      if (!evalResult.length) {
        return res.status(404).json({ 
          success: false, 
          message: 'Evaluation not found' 
        });
      }

      db.query(`
        SELECT ei.*, d.item, d.domain_category
        FROM evaluation_items ei
        JOIN domains d ON ei.domain_id = d.domain_id
        WHERE ei.evaluation_id = ?
      `, [evaluation_id], (err, itemResults) => {
        if (err) {
          console.error('Error fetching evaluation items:', err);
          return res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch evaluation items', 
            error: err.message 
          });
        }

        res.json({
          success: true,
          data: {
            ...evalResult[0],
            items: itemResults
          }
        });
      });
    }
  );
});

module.exports = router;