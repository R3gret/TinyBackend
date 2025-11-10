require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const app = express();
const PORT = process.env.PORT || 3001;

// Security middlewares
app.use(helmet());
app.use(cors({
  origin: [process.env.FRONTEND_URL || 'http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  trustProxy: true,
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for'] || req.ip;
  }
});
app.use(limiter);

// Logging
app.use(morgan('combined'));

// Body parsing
app.use(express.json({ limit: '10kb' }));

app.use(express.urlencoded({ extended: true, limit: '10kb' }));

const authenticate = require('./routes/authMiddleware');

// API routes - Explicit mounting (recommended approach)
app.use('/api/login', require('./routes/login'));
app.use('/api/students', authenticate, require('./routes/students'));
app.use('/api/register', require('./routes/register'));
app.use('/api/add_activity', authenticate, require('./routes/add_activity'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/users', require('./routes/users'));
app.use('/api/account', require('./routes/account')); // This will properly mount account routes
app.use('/api/user_session', require('./routes/user_session'));
app.use('/api/domains', require('./routes/domains'));
app.use('/api/files', authenticate, require('./routes/fileRoutes'));
app.use('/api/announcements', authenticate, require('./routes/announcement'));
app.use('/api/cdc', require('./routes/insert_cdc'));
app.use('/api/parent', require('./routes/parent'));
app.use('/api/admin-parent-list', require('./routes/adminparentlist'));
app.use('/api/dash', require('./routes/studentsdash'));
app.use('/api/att', require('./routes/studattendance'));
app.use('/api/dom', require('./routes/domainstud'));
app.use('/api/submissions', authenticate, require('./routes/submissions'));
app.use('/api/parent-announcements', require('./routes/parentannouncements'));
app.use('/api/workers', authenticate, require('./routes/workers')); // Use the new worker routes
app.use('/api/student-plans', require('./routes/student_weekly_plans'));
app.use('/api/get_activities', authenticate, require('./routes/get_activities'));
app.use('/api/get_scheduled_dates', authenticate, require('./routes/get_scheduled_dates'));
app.use('/api/student-profile', require('./routes/student_profile'));
app.use('/api/activities', authenticate, require('./routes/activities'));

// Static files
app.use('/uploads/announcements', express.static(path.join(__dirname, 'uploads/announcements')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Debug route registration (remove in production)
if (process.env.NODE_ENV !== 'production') {
  console.log('\nRegistered routes:');
  app._router.stack.forEach(middleware => {
    if (middleware.route) {
      console.log(`${Object.keys(middleware.route.methods)[0].toUpperCase()} ${middleware.route.path}`);
    } else if (middleware.name === 'router') {
      middleware.handle.stack.forEach(handler => {
        if (handler.route) {
          const basePath = middleware.regexp.toString()
            .replace('/^', '')
            .replace('\\/', '')
            .replace('(?=\\/|$)/i', '');
          console.log(`${Object.keys(handler.route.methods)[0].toUpperCase()} /${basePath}${handler.route.path}`);
        }
      });
    }
  });
  console.log('\n');
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString()
  });
  
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    timestamp: new Date().toISOString()
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS allowed origin: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', {
    error: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString()
  });
  server.close(() => process.exit(1));
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', {
    error: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString()
  });
  server.close(() => process.exit(1));
});

module.exports = server;