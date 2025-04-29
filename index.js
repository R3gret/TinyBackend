require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const db = require('./db'); // Import database connection
const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy when behind reverse proxy (Railway, Nginx, etc.)
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : 0);

// Security middlewares
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  optionsSuccessStatus: 200 // For legacy browser support
}));

// Enhanced rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests, please try again later',
  keyGenerator: (req) => {
    // Use X-Forwarded-For if behind proxy, otherwise use remoteAddress
    return req.ip;
  },
  validate: { trustProxy: false } // Explicitly set based on your proxy setup
});

app.use(limiter);

// Enhanced logging
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));

// Body parsing with enhanced security
app.use(express.json({ 
  limit: '10kb',
  type: 'application/json' // Only accept JSON content-type
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '10kb',
  parameterLimit: 10 // Limit number of form fields
}));

// Static files with cache control
app.use('/uploads/announcements', express.static(path.join(__dirname, 'uploads/announcements'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0
}));

// API routes
const apiRoutes = express.Router();

// Import routes with error handling
const loadRoute = (routePath) => {
  try {
    return require(routePath);
  } catch (err) {
    console.error(`Failed to load route ${routePath}:`, err);
    const router = express.Router();
    router.use((req, res) => res.status(503).json({ error: 'Service temporarily unavailable' }));
    return router;
  }
};

const routes = [
  './routes/login',
  './routes/students',
  './routes/register',
  './routes/add_activity',
  './routes/get_activities',
  './routes/get_scheduled_dates',
  './routes/attendance',
  './routes/users',
  './routes/account',
  './routes/user_session',
  './routes/domains',
  './routes/fileRoutes',
  './routes/announcement'
].map(loadRoute);

// Mount all routes under /api with versioning
routes.forEach(route => {
  apiRoutes.use('/v1', route); // Versioned API
});

app.use('/api', apiRoutes);

// Enhanced health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    const conn = await db.getConnection();
    await conn.ping();
    conn.release();
    
    res.status(200).json({ 
      status: 'healthy',
      database: 'connected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({ 
      status: 'unhealthy',
      database: 'disconnected',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({ 
    error: 'Not found',
    path: req.path,
    method: req.method
  });
});

// Enhanced error handler
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  console.error(`[${new Date().toISOString()}] Error:`, {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    ip: req.ip
  });

  res.status(statusCode).json({
    error: statusCode === 500 ? 'Internal server error' : err.message,
    ...(process.env.NODE_ENV === 'development' && {
      details: err.message,
      stack: err.stack
    })
  });
});

// Database connection events
db.on('error', (err) => {
  console.error('Database error:', err);
});

db.on('acquire', (connection) => {
  console.log('Database connection acquired');
});

// Start server with error handling
let server;
try {
  server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Trust proxy: ${app.get('trust proxy')}`);
  });
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}

// Process event handlers
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  if (server) server.close(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if (server) server.close(() => process.exit(1));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server?.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server }; // For testing