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
    req.user = decoded;
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