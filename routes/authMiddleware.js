const jwt = require('jsonwebtoken');

const authenticate = (req, res, next) => {
  // Get token from header
  const authHeader = req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authorization token required (Bearer token)' 
    });
  }

  const token = authHeader.split(' ')[1];
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    
    // Ensure the decoded payload is assigned correctly
    req.user = decoded.user || decoded; // Handle nested 'user' object or direct payload

    // Verify that req.user.id exists
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token payload: User ID missing.'
      });
    }

    next();
  } catch (err) {
    // More specific error messages
    let message = 'Invalid token';
    if (err.name === 'TokenExpiredError') {
      message = 'Token expired';
    } else if (err.name === 'JsonWebTokenError') {
      message = 'Malformed token';
    }
    
    return res.status(401).json({ 
      success: false, 
      message,
      error: err.name 
    });
  }
};

module.exports = authenticate;