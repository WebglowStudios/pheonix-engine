const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const User = require("../models/User");
const { protect } = require("../middleware/auth");

const { OAuth2Client } = require("google-auth-library");
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const crypto = require("crypto");
const { sendWelcomeEmail, sendNewUserAdminAlert, sendPasswordResetEmail } = require("../services/emailService");

const router = express.Router();

// Helper: generate JWT
const generateToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
};

// Helper: send token response
const sendTokenResponse = (user, statusCode, res, extra = {}) => {
  const token = generateToken(user._id);
  res.status(statusCode).json({
    success: true,
    token,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone || "",
      avatar: user.avatar || "",
      authProvider: user.authProvider || "local",
      role: user.role || "user",
      riskProfile: user.riskProfile,
    },
    ...extra,
  });
};

// --- POST /api/auth/register -----------------------------------------------
router.post(
  "/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
    body("phone")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required")
      .custom((value) => {
        const clean = value.replace(/[\s\-()]/g, "");
        if (!/^[+]?\d{10,15}$/.test(clean)) {
          throw new Error("Please enter a valid phone number (at least 10 digits)");
        }
        return true;
      }),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, email, password, phone, riskProfile } = req.body;

    try {
      // Check if user exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: "An account with this email already exists.",
        });
      }

      // Create user
      const user = await User.create({
        name,
        email,
        password,
        phone: (phone || "").trim(),
        riskProfile: riskProfile || "moderate",
      });

      // Fire emails async — don't block the token response
      sendWelcomeEmail(user).catch((e) => console.error("[Email] Welcome email failed:", e.message));
      sendNewUserAdminAlert(user).catch((e) => console.error("[Email] New user admin alert failed:", e.message));

      sendTokenResponse(user, 201, res);
    } catch (error) {
      console.error("Register error:", error);
      res.status(500).json({ success: false, message: "Server error. Please try again." });
    }
  }
);

// --- POST /api/auth/login --------------------------------------------------
router.post(
  "/login",
  [
    body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      // Explicitly select password (it is excluded by default)
      const user = await User.findOne({ email }).select("+password");

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password.",
        });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password.",
        });
      }

      sendTokenResponse(user, 200, res);
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ success: false, message: "Server error. Please try again." });
    }
  }
);

// --- POST /api/auth/google -------------------------------------------------
router.post("/google", async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({
      success: false,
      message: "Google credential is required.",
    });
  }

  try {
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      console.error("Google token verification failed:", verifyError.message);
      return res.status(401).json({
        success: false,
        message: "Invalid or expired Google token.",
      });
    }

    if (!payload || !payload.email) {
      return res.status(400).json({
        success: false,
        message: "Failed to extract user profile from Google token.",
      });
    }

    const { sub: googleId, email, name, picture } = payload;
    const normalizedEmail = email.toLowerCase().trim();

    // Check if user exists by googleId or email
    let user = await User.findOne({
      $or: [{ googleId }, { email: normalizedEmail }],
    });

    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = await User.create({
        name: name || "Google User",
        email: normalizedEmail,
        googleId,
        authProvider: "google",
        avatar: picture || "",
        phone: "",
        riskProfile: "moderate",
      });
    } else {
      let modified = false;
      if (!user.googleId) {
        user.googleId = googleId;
        modified = true;
      }
      if (!user.avatar && picture) {
        user.avatar = picture;
        modified = true;
      }
      if (modified) {
        await user.save();
      }
    }

    sendTokenResponse(user, isNewUser ? 201 : 200, res, {
      isNewUser,
      needsPhone: !user.phone || user.phone.trim().length === 0,
    });
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during Google authentication.",
    });
  }
});

// --- GET /api/auth/me -----------------------------------------------------
router.get("/me", protect, async (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      phone: req.user.phone || "",
      avatar: req.user.avatar || "",
      authProvider: req.user.authProvider || "local",
      role: req.user.role || "user",
      riskProfile: req.user.riskProfile,
      createdAt: req.user.createdAt,
    },
  });
});

// --- PUT /api/auth/profile ------------------------------------------------
router.put(
  "/profile",
  protect,
  [
    body("name").optional().trim().notEmpty().withMessage("Name cannot be empty"),
    body("phone")
      .optional()
      .trim()
      .custom((value) => {
        if (!value) return true;
        const clean = value.replace(/[\s\-()]/g, "");
        if (!/^[+]?\d{10,15}$/.test(clean)) {
          throw new Error("Please enter a valid phone number (at least 10 digits)");
        }
        return true;
      }),
    body("riskProfile")
      .optional()
      .isIn(["conservative", "moderate", "aggressive"])
      .withMessage("Invalid risk profile"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, phone, riskProfile } = req.body;
    const updateFields = {};
    if (name) updateFields.name = name;
    if (phone !== undefined) updateFields.phone = phone;
    if (riskProfile) updateFields.riskProfile = riskProfile;

    try {
      const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updateFields },
        { new: true, runValidators: true }
      );

      res.json({
        success: true,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone || "",
          avatar: user.avatar || "",
          authProvider: user.authProvider || "local",
          role: user.role || "user",
          riskProfile: user.riskProfile,
        },
      });
    } catch (error) {
      console.error("Profile update error:", error);
      res.status(500).json({ success: false, message: "Server error." });
    }
  }
);

// --- POST /api/auth/change-password --------------------------------------
router.post(
  "/change-password",
  protect,
  [
    body("currentPassword").notEmpty().withMessage("Current password is required"),
    body("newPassword")
      .isLength({ min: 6 })
      .withMessage("New password must be at least 6 characters"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    try {
      const user = await User.findById(req.user._id).select("+password");

      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        return res.status(400).json({
          success: false,
          message: "Current password is incorrect.",
        });
      }

      user.password = newPassword;
      await user.save();

      res.json({ success: true, message: "Password updated successfully." });
    } catch (error) {
      console.error("Change password error:", error);
      res.status(500).json({ success: false, message: "Server error." });
    }
  }
);

// --- POST /api/auth/forgot-password ----------------------------------------
// Accepts an email, generates a secure reset token, emails a reset link.
router.post(
  "/forgot-password",
  [body("email").isEmail().normalizeEmail().withMessage("Valid email required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    try {
      const user = await User.findOne({ email: req.body.email });

      // Always return success — don't reveal whether the email exists
      if (!user || !user.isActive) {
        return res.json({
          success: true,
          message: "If that email is registered, a reset link has been sent.",
        });
      }

      // Generate a cryptographically secure token (hex, 32 bytes = 64 chars)
      const rawToken   = crypto.randomBytes(32).toString("hex");
      const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

      user.resetPasswordToken   = hashedToken;
      user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await user.save({ validateBeforeSave: false });

      // Send email with the RAW (unhashed) token in the URL
      await sendPasswordResetEmail(user, rawToken);

      res.json({
        success: true,
        message: "If that email is registered, a reset link has been sent.",
      });
    } catch (error) {
      console.error("Forgot password error:", error);
      res.status(500).json({ success: false, message: "Server error. Please try again." });
    }
  }
);

// --- POST /api/auth/reset-password/:token ----------------------------------
// Validates the token from the email link and sets the new password.
router.post(
  "/reset-password/:token",
  [
    body("newPassword")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("confirmPassword")
      .notEmpty()
      .withMessage("Please confirm your new password"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { newPassword, confirmPassword } = req.body;

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: "Passwords do not match." });
    }

    try {
      // Hash the incoming token to compare with what's stored
      const hashedToken = crypto
        .createHash("sha256")
        .update(req.params.token)
        .digest("hex");

      const user = await User.findOne({
        resetPasswordToken:   hashedToken,
        resetPasswordExpires: { $gt: new Date() }, // not expired
      });

      if (!user) {
        return res.status(400).json({
          success: false,
          message: "This reset link is invalid or has expired. Please request a new one.",
        });
      }

      // Set new password — pre-save hook will hash it
      user.password             = newPassword;
      user.resetPasswordToken   = null;
      user.resetPasswordExpires = null;
      await user.save();

      res.json({
        success: true,
        message: "Password reset successfully. You can now log in with your new password.",
      });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({ success: false, message: "Server error. Please try again." });
    }
  }
);

module.exports = router;
