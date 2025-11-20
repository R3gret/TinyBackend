const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const ALLOWED_AGE_FILTERS = new Set(['all', '3-4', '4-5', '5-6']);
const ALLOWED_ROLE_FILTERS = new Set(['worker', 'president', 'parent', 'focal']);

const cleanupUploadedFile = (file) => {
  if (file?.path) {
    try {
      fs.unlinkSync(file.path);
    } catch (err) {
      console.error('Failed to cleanup uploaded file:', err.message);
    }
  }
};

const sanitizeAgeFilter = (value) => {
  if (!value && value !== 0) return null;
  const trimmed = String(value).trim();
  return ALLOWED_AGE_FILTERS.has(trimmed) ? trimmed : null;
};

const normalizeRoleFilter = (value) => {
  if (!value) return [];

  const values = Array.isArray(value) ? value : String(value).split(',');

  return [...new Set(
    values
      .map((role) => role.trim().toLowerCase())
      .filter((role) => ALLOWED_ROLE_FILTERS.has(role))
  )];
};

const formatAnnouncementRecord = (row, req) => {
  const attachmentUrl = row.attachmentUrl
    ? `${req.protocol}://${req.get('host')}/uploads/announcements/${path.basename(row.attachmentUrl)}`
    : null;

  return {
    id: row.id,
    title: row.title,
    message: row.message,
    author: row.author,
    author_id: row.author_id,
    ageFilter: row.ageFilter,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    attachmentUrl,
    attachmentName: row.attachmentName,
    roleFilter: row.roleFilter || '',
    cdcId: row.cdcId
  };
};

const parseCdcIds = (rawValue) => {
  if (!rawValue) return [];

  const values = Array.isArray(rawValue) ? rawValue : [rawValue];

  return [...new Set(
    values
      .map((id) => parseInt(id, 10))
      .filter((id) => Number.isInteger(id) && id > 0)
  )];
};

// Configure multer for announcement attachments
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/announcements');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

// POST /api/announcements - Create new announcement (protected)
router.post('/', upload.single('attachment'), async (req, res) => {
  const { title, message } = req.body;
  const rawAgeFilter = sanitizeAgeFilter(req.body.ageFilter);
  const normalizedRoleFilter = normalizeRoleFilter(req.body.roleFilter);
  const file = req.file;
  const user = req.user; // User data from the standardized 'authenticate' middleware
  let connection;

  if (!title || !message || !rawAgeFilter || normalizedRoleFilter.length === 0) {
    cleanupUploadedFile(file);
    return res.status(400).json({ 
      success: false, 
      message: 'Title, message, age filter, and at least one target role are required' 
    });
  }

  try {
    connection = await db.promisePool.getConnection();
    
    if (!user || !user.id || !user.cdc_id) {
        cleanupUploadedFile(file);
        return res.status(403).json({
            success: false,
            message: 'User CDC information not found in token.'
        });
    }

    const [result] = await connection.query(
      `INSERT INTO announcements (
        title, 
        message, 
        author_id, 
        author_name, 
        age_filter, 
        attachment_path, 
        attachment_name,
        cdc_id,
        role_filter
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        message,
        user.id,
        user.username || user.name || 'Unknown',
        rawAgeFilter,
        file ? file.path : null,
        file ? file.originalname : null,
        user.cdc_id,
        normalizedRoleFilter.join(',')
      ]
    );

    // Get the newly created announcement
    const [announcementResults] = await connection.query(
      `SELECT 
        a.id,
        a.title,
        a.message,
        a.author_name as author,
        a.author_id as author_id,
        a.age_filter as ageFilter,
        a.created_at as createdAt,
        a.attachment_path as attachmentUrl,
        a.attachment_name as attachmentName,
        a.role_filter as roleFilter,
        a.cdc_id as cdcId
      FROM announcements a
      WHERE a.id = ?`,
      [result.insertId]
    );

    if (announcementResults.length === 0) {
      console.error('Failed to fetch new announcement');
      return res.json({ 
        success: true, 
        message: 'Announcement created but failed to return details' 
      });
    }

    const announcement = formatAnnouncementRecord(announcementResults[0], req);

    res.json({ 
      success: true, 
      message: 'Announcement created successfully',
      announcement 
    });
  } catch (err) {
    console.error('Database error:', err);
    cleanupUploadedFile(file);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create announcement' 
    });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/announcements - Fetch all announcements for the user's CDC
router.get('/', async (req, res) => {
  const user = req.user;
  let connection;

  if (!user || !user.cdc_id) {
    return res.status(403).json({
      success: false,
      message: 'User CDC information not found in token.'
    });
  }

  try {
    connection = await db.promisePool.getConnection();

    const [results] = await connection.query(
      `SELECT 
        a.id,
        a.title,
        a.message,
        a.author_name as author,
        a.author_id as author_id,
        a.age_filter as ageFilter,
        a.created_at as createdAt,
        a.attachment_path as attachmentUrl,
        a.attachment_name as attachmentName,
        a.role_filter as roleFilter,
        a.cdc_id as cdcId
      FROM announcements a
      WHERE a.cdc_id = ?
      ORDER BY a.created_at DESC`,
      [user.cdc_id]
    );

    const announcements = results.map((row) => formatAnnouncementRecord(row, req));

    res.json({
      success: true,
      announcements
    });

  } catch (err) {
    console.error('Database error fetching announcements:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch announcements'
    });
  } finally {
    if (connection) connection.release();
  }
});

// POST /api/announcements/multi-cdc - Create announcements for multiple CDCs
router.post('/multi-cdc', upload.single('attachment'), async (req, res) => {
  const { title, message } = req.body;
  const rawAgeFilter = sanitizeAgeFilter(req.body.ageFilter);
  const normalizedRoleFilter = normalizeRoleFilter(req.body.roleFilter);
  const cdcIds = parseCdcIds(
    req.body['cdc_ids[]'] ||
    req.body.cdc_ids ||
    req.body.cdcIds
  );
  const file = req.file;
  const user = req.user;
  let connection;

  if (!title || !message || !rawAgeFilter || normalizedRoleFilter.length === 0 || cdcIds.length === 0) {
    cleanupUploadedFile(file);
    return res.status(400).json({
      success: false,
      message: 'Title, message, age filter, target roles, and at least one CDC are required'
    });
  }

  if (!user || !user.id) {
    cleanupUploadedFile(file);
    return res.status(403).json({
      success: false,
      message: 'User information not found in token.'
    });
  }

  try {
    connection = await db.promisePool.getConnection();

    const [existingCdcs] = await connection.query(
      `SELECT cdc_id FROM cdc WHERE cdc_id IN (?)`,
      [cdcIds]
    );

    const validCdcSet = new Set(existingCdcs.map((row) => row.cdc_id));
    const created = [];
    const failures = [];

    for (const cdcId of cdcIds) {
      if (!validCdcSet.has(cdcId)) {
        failures.push({ cdcId, error: 'CDC not found' });
        continue;
      }

      try {
        const [result] = await connection.query(
          `INSERT INTO announcements (
            title, 
            message, 
            author_id, 
            author_name, 
            age_filter, 
            attachment_path, 
            attachment_name,
            cdc_id,
            role_filter
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            title,
            message,
            user.id,
            user.username || user.name || 'Unknown',
            rawAgeFilter,
            file ? file.path : null,
            file ? file.originalname : null,
            cdcId,
            normalizedRoleFilter.join(',')
          ]
        );

        created.push({ cdcId, announcementId: result.insertId });
      } catch (err) {
        console.error(`Failed to create announcement for CDC ${cdcId}:`, err);
        failures.push({ cdcId, error: 'Failed to create announcement' });
      }
    }

    if (created.length === 0) {
      cleanupUploadedFile(file);
      return res.status(500).json({
        success: false,
        created,
        failures,
        message: 'No announcements were created'
      });
    }

    res.json({
      success: failures.length === 0,
      created,
      failures
    });
  } catch (err) {
    console.error('Database error during multi-CDC announcements:', err);
    cleanupUploadedFile(file);
    res.status(500).json({
      success: false,
      message: 'Failed to create announcements'
    });
  } finally {
    if (connection) connection.release();
  }
});


module.exports = router;