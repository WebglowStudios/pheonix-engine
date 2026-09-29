const { protect } = require("./auth");

const requireAdmin = (req, res, next) => {
  protect(req, res, () => {
    if (req.user && req.user.role === "admin") {
      return next();
    }
    return res.status(403).json({
      success: false,
      message: "Access denied. Administrator privileges required.",
    });
  });
};

module.exports = { requireAdmin };
