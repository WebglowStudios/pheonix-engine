const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const { requireAdmin } = require("../middleware/admin");
const User = require("../models/User");
const { sendAdminCreatedAccountEmail } = require("../services/emailService");
const Investment = require("../models/Investment");
const Transaction = require("../models/Transaction");
const Lead = require("../models/Lead");
const SiteContent = require("../models/SiteContent");
const Service = require("../models/Service");
const Faq = require("../models/Faq");
const ProductPrice = require("../models/ProductPrice");
const {
  calcCurrentValue,
  calcTaxInfo,
  consolidateInvestments,
} = require("../services/portfolioHelpers");

const router = express.Router();

// Apply requireAdmin to all routes in this file
router.use(requireAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// 1. STATS & OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const [
      totalUsers,
      totalClients,
      totalLeads,
      newLeads,
      totalServices,
      totalFaqs,
      assetAgg,
      riskAgg,
      totalInvestmentAgg,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: { $ne: "admin" } }),
      Lead.countDocuments(),
      Lead.countDocuments({ status: "new" }),
      Service.countDocuments(),
      Faq.countDocuments(),
      Investment.aggregate([
        {
          $group: {
            _id: "$type",
            invested: { $sum: "$investedAmount" },
            count: { $sum: 1 },
          },
        },
      ]),
      User.aggregate([
        {
          $group: {
            _id: "$riskProfile",
            count: { $sum: 1 },
          },
        },
      ]),
      Investment.aggregate([
        {
          $group: {
            _id: null,
            totalInvested: { $sum: "$investedAmount" },
            totalCurrent: {
              $sum: { $ifNull: ["$currentValue", "$investedAmount"] },
            },
            totalCount: { $sum: 1 },
          },
        },
      ]),
    ]);

    const byType = {};
    assetAgg.forEach((a) => {
      if (a._id) {
        byType[a._id] = { invested: a.invested || 0, count: a.count || 0 };
      }
    });

    const riskProfiles = { conservative: 0, moderate: 0, aggressive: 0 };
    riskAgg.forEach((r) => {
      if (r._id && riskProfiles[r._id] !== undefined) {
        riskProfiles[r._id] = r.count;
      }
    });

    const recentLeads = await Lead.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const recentUsersRaw = await User.find()
      .select("name email phone role authProvider avatar riskProfile createdAt")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // Get investment counts for recent users
    const recentUserIds = recentUsersRaw.map((u) => u._id);
    const userInvAgg = await Investment.aggregate([
      { $match: { userId: { $in: recentUserIds } } },
      {
        $group: {
          _id: "$userId",
          count: { $sum: 1 },
          totalInvested: { $sum: "$investedAmount" },
        },
      },
    ]);
    const userInvMap = {};
    userInvAgg.forEach((u) => {
      userInvMap[u._id.toString()] = {
        investmentCount: u.count,
        totalInvested: u.totalInvested || 0,
      };
    });

    const recentUsers = recentUsersRaw.map((u) => ({
      ...u,
      id: u._id.toString(),
      stats: userInvMap[u._id.toString()] || {
        investmentCount: 0,
        totalInvested: 0,
      },
    }));

    const totalInvested = totalInvestmentAgg[0]?.totalInvested || 0;
    const totalCurrent = totalInvestmentAgg[0]?.totalCurrent || 0;
    const totalHoldings = totalInvestmentAgg[0]?.totalCount || 0;

    const statsPayload = {
      totalUsers,
      totalClients,
      totalLeads,
      newLeads,
      totalServices,
      totalFaqs,
      totalInvested,
      totalCurrent,
      totalHoldings,
      byType,
      riskProfiles,
    };

    const formattedLeads = recentLeads.map((l) => ({ ...l, id: l._id.toString() }));

    res.json({
      success: true,
      stats: statsPayload,
      recentLeads: formattedLeads,
      recentUsers,
      data: {
        stats: statsPayload,
        recentLeads: formattedLeads,
        recentUsers,
      },
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch admin stats." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. USER / CLIENT MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
router.get("/users", async (req, res) => {
  try {
    const { search, role, page = 1, limit = 50 } = req.query;
    const query = {};

    if (role && ["user", "admin"].includes(role)) {
      if (role === "admin") {
        query.role = "admin";
      } else {
        query.role = { $ne: "admin" };
      }
    }

    if (search) {
      const term = search.trim();
      query.$or = [
        { name: { $regex: term, $options: "i" } },
        { email: { $regex: term, $options: "i" } },
        { phone: { $regex: term, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .select("name email phone role authProvider avatar riskProfile isActive createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Aggregate investment count and total value per user
    const userIds = users.map((u) => u._id);
    const investmentAgg = await Investment.aggregate([
      { $match: { userId: { $in: userIds } } },
      {
        $group: {
          _id: "$userId",
          count: { $sum: 1 },
          totalInvested: { $sum: "$investedAmount" },
          totalCurrent: {
            $sum: { $ifNull: ["$currentValue", "$investedAmount"] },
          },
        },
      },
    ]);

    const statsMap = {};
    investmentAgg.forEach((agg) => {
      statsMap[agg._id.toString()] = {
        investmentCount: agg.count,
        totalInvested: agg.totalInvested || 0,
        totalCurrent: agg.totalCurrent || 0,
      };
    });

    const enrichedUsers = users.map((u) => ({
      ...u,
      id: u._id,
      stats: statsMap[u._id.toString()] || {
        investmentCount: 0,
        totalInvested: 0,
        totalCurrent: 0,
      },
    }));

    const usersPayload = {
      users: enrichedUsers,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    };

    res.json({
      success: true,
      ...usersPayload,
      data: usersPayload,
    });
  } catch (error) {
    console.error("Admin fetch users error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch users." });
  }
});

router.get("/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select("name email phone role authProvider avatar riskProfile isActive createdAt")
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const rawInvestments = await Investment.find({ userId: user._id })
      .sort({ createdAt: -1 });

    const consolidated = consolidateInvestments(rawInvestments);

    let totalInvested = 0;
    let totalCurrent = 0;
    const byType = {};

    consolidated.forEach((inv) => {
      const invested = inv.investedAmount || 0;
      const cv = inv.currentValue || 0;
      totalInvested += invested;
      totalCurrent += cv;

      if (!byType[inv.type]) {
        byType[inv.type] = { count: 0, invested: 0, currentValue: 0 };
      }
      byType[inv.type].count += 1;
      byType[inv.type].invested += invested;
      byType[inv.type].currentValue += cv;
    });

    const totalGain = totalCurrent - totalInvested;
    const totalGainPercent = totalInvested > 0 ? (totalGain / totalInvested) * 100 : 0;

    const summary = {
      totalInvested: Math.round(totalInvested * 100) / 100,
      currentValue: Math.round(totalCurrent * 100) / 100,
      totalGain: Math.round(totalGain * 100) / 100,
      totalGainPercent: Math.round(totalGainPercent * 100) / 100,
      holdings: consolidated.length,
      byType,
      pricesLastUpdated: rawInvestments
        .filter((i) => i.lastPriceUpdate)
        .sort((a, b) => new Date(b.lastPriceUpdate) - new Date(a.lastPriceUpdate))[0]
        ?.lastPriceUpdate ?? null,
    };

    const userObj = { ...user, id: user._id };
    res.json({
      success: true,
      user: userObj,
      investments: consolidated,
      summary,
      data: { user: userObj, investments: consolidated, summary },
    });
  } catch (error) {
    console.error("Admin get user error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch user details." });
  }
});

router.post(
  "/users",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("phone")
      .optional({ checkFalsy: true })
      .trim()
      .custom((value) => {
        if (!value) return true;
        const clean = value.replace(/[\s\-()]/g, "");
        if (!/^[+]?\d{10,15}$/.test(clean)) {
          throw new Error("Please enter a valid phone number (at least 10 digits)");
        }
        return true;
      }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        errors: errors.array(),
      });
    }

    try {
      const { name, email, password, phone, role, riskProfile } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      const existing = await User.findOne({ email: normalizedEmail });
      if (existing) {
        return res.status(400).json({
          success: false,
          message: "An account with this email address already exists.",
        });
      }

      const user = await User.create({
        name: name.trim(),
        email: normalizedEmail,
        password,
        phone: (phone || "").trim(),
        role: role && ["user", "admin"].includes(role) ? role : "user",
        riskProfile:
          riskProfile && ["conservative", "moderate", "aggressive"].includes(riskProfile)
            ? riskProfile
            : "moderate",
        authProvider: "local",
        isActive: true,
      });

      // Email user their login credentials (fire async, don't block response)
      sendAdminCreatedAccountEmail(user, password).catch((e) =>
        console.error("[Email] Admin-created account email failed:", e.message)
      );

      const userObj = {
        id: user._id.toString(),
        _id: user._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        role: user.role || "user",
        riskProfile: user.riskProfile || "moderate",
        authProvider: user.authProvider || "local",
        isActive: user.isActive,
        createdAt: user.createdAt,
        stats: {
          investmentCount: 0,
          totalInvested: 0,
          totalCurrent: 0,
        },
      };

      res.status(201).json({
        success: true,
        message: `Account for ${user.name} created successfully.`,
        user: userObj,
        data: { user: userObj },
      });
    } catch (error) {
      console.error("Admin create user error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to create user account.",
      });
    }
  }
);

router.post("/users/:id/impersonate", async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const token = jwt.sign({ id: targetUser._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    const userObj = {
      id: targetUser._id.toString(),
      _id: targetUser._id.toString(),
      name: targetUser.name,
      email: targetUser.email,
      phone: targetUser.phone || "",
      avatar: targetUser.avatar || "",
      authProvider: targetUser.authProvider || "local",
      role: targetUser.role || "user",
      riskProfile: targetUser.riskProfile || "moderate",
    };

    res.json({
      success: true,
      message: `Impersonation session created for ${targetUser.name}`,
      token,
      user: userObj,
      data: { token, user: userObj },
    });
  } catch (error) {
    console.error("Admin impersonate error:", error);
    res.status(500).json({ success: false, message: "Failed to generate client session." });
  }
});

router.put("/users/:id", async (req, res) => {
  try {
    const { role, isActive, phone, name, riskProfile, password } = req.body;
    const update = {};
    if (role && ["user", "admin"].includes(role)) update.role = role;
    if (typeof isActive === "boolean") update.isActive = isActive;
    if (phone !== undefined) update.phone = phone.trim();
    if (name) update.name = name.trim();
    if (riskProfile) update.riskProfile = riskProfile;

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    ).select("name email phone role authProvider avatar riskProfile isActive createdAt");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // If admin also updated password, hash via user save hook
    if (password && password.trim().length >= 6) {
      const u = await User.findById(req.params.id);
      if (u) {
        u.password = password.trim();
        await u.save();
      }
    }

    const updatedUser = { ...user.toObject(), id: user._id };
    res.json({
      success: true,
      user: updatedUser,
      data: { user: updatedUser },
    });
  } catch (error) {
    console.error("Admin update user error:", error);
    res.status(500).json({ success: false, message: "Failed to update user." });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    // Prevent admin from deleting themselves
    if (req.user._id.toString() === req.params.id) {
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own admin account.",
      });
    }

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // Delete user's investments
    await Investment.deleteMany({ userId: req.params.id });

    res.json({ success: true, message: "User and associated portfolio deleted." });
  } catch (error) {
    console.error("Admin delete user error:", error);
    res.status(500).json({ success: false, message: "Failed to delete user." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. LEADS MANAGEMENT (Replaces contact_submissions)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/leads", async (req, res) => {
  try {
    const { status, search, page = 1, limit = 100 } = req.query;
    const query = {};

    if (status && status !== "all") {
      query.status = status;
    }

    if (search) {
      const term = search.trim();
      query.$or = [
        { name: { $regex: term, $options: "i" } },
        { email: { $regex: term, $options: "i" } },
        { phone: { $regex: term, $options: "i" } },
      ];
    }

    const total = await Lead.countDocuments(query);
    const leads = await Lead.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();

    const formatted = leads.map((l) => ({
      ...l,
      id: l._id.toString(),
      created_at: l.createdAt,
    }));

    const leadsPayload = {
      leads: formatted,
      total,
      newCount: await Lead.countDocuments({ status: "new" }),
    };

    res.json({
      success: true,
      ...leadsPayload,
      data: leadsPayload,
    });
  } catch (error) {
    console.error("Admin fetch leads error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch leads." });
  }
});

router.put("/leads/:id", async (req, res) => {
  try {
    const { status, notes } = req.body;
    const update = {};
    if (status && ["new", "read", "contacted"].includes(status)) {
      update.status = status;
    }
    if (notes !== undefined) {
      update.notes = notes;
    }

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    ).lean();

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    const leadObj = { ...lead, id: lead._id.toString(), created_at: lead.createdAt };
    res.json({
      success: true,
      lead: leadObj,
      data: { lead: leadObj },
    });
  } catch (error) {
    console.error("Admin update lead error:", error);
    res.status(500).json({ success: false, message: "Failed to update lead." });
  }
});

router.delete("/leads/:id", async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }
    res.json({ success: true, message: "Lead deleted successfully." });
  } catch (error) {
    console.error("Admin delete lead error:", error);
    res.status(500).json({ success: false, message: "Failed to delete lead." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SITE CONTENT / CMS (Replaces site_content)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/content/:key", async (req, res) => {
  try {
    const doc = await SiteContent.findOne({ key: req.params.key }).lean();
    const content = doc ? doc.content : null;
    res.json({
      success: true,
      key: req.params.key,
      content,
      data: { key: req.params.key, content },
    });
  } catch (error) {
    console.error("Admin get content error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch content." });
  }
});

router.put("/content/:key", async (req, res) => {
  try {
    const { content } = req.body;
    if (content === undefined) {
      return res.status(400).json({ success: false, message: "Content is required." });
    }

    const doc = await SiteContent.findOneAndUpdate(
      { key: req.params.key },
      { $set: { content } },
      { upsert: true, new: true }
    ).lean();

    res.json({
      success: true,
      key: doc.key,
      content: doc.content,
      data: { key: doc.key, content: doc.content },
    });
  } catch (error) {
    console.error("Admin update content error:", error);
    res.status(500).json({ success: false, message: "Failed to save content." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. SERVICES (Replaces services table)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/services", async (req, res) => {
  try {
    const services = await Service.find().sort({ sort_order: 1 }).lean();
    const list = services.map((s) => ({ ...s, id: s._id.toString() }));
    res.json({
      success: true,
      services: list,
      data: { services: list },
    });
  } catch (error) {
    console.error("Admin get services error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch services." });
  }
});

router.post("/services", async (req, res) => {
  try {
    const { title, description, icon_name, icon_img, category, features, sort_order } =
      req.body;
    const max = await Service.findOne().sort({ sort_order: -1 });
    const nextOrder = sort_order ?? (max ? max.sort_order + 1 : 0);

    const service = await Service.create({
      title,
      description: description || "",
      icon_name: icon_name || "",
      icon_img: icon_img || "",
      category: category || "growth",
      features: features || [],
      sort_order: nextOrder,
    });

    res.status(201).json({
      success: true,
      service: { ...service.toObject(), id: service._id.toString() },
    });
  } catch (error) {
    console.error("Admin create service error:", error);
    res.status(500).json({ success: false, message: "Failed to create service." });
  }
});

router.put("/services/:id", async (req, res) => {
  try {
    const service = await Service.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    ).lean();

    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found." });
    }

    res.json({
      success: true,
      service: { ...service, id: service._id.toString() },
    });
  } catch (error) {
    console.error("Admin update service error:", error);
    res.status(500).json({ success: false, message: "Failed to update service." });
  }
});

router.delete("/services/:id", async (req, res) => {
  try {
    const service = await Service.findByIdAndDelete(req.params.id);
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found." });
    }
    res.json({ success: true, message: "Service deleted successfully." });
  } catch (error) {
    console.error("Admin delete service error:", error);
    res.status(500).json({ success: false, message: "Failed to delete service." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. FAQS (Replaces faqs table)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/faqs", async (req, res) => {
  try {
    const faqs = await Faq.find().sort({ sort_order: 1 }).lean();
    const list = faqs.map((f) => ({ ...f, id: f._id.toString() }));
    res.json({
      success: true,
      faqs: list,
      data: { faqs: list },
    });
  } catch (error) {
    console.error("Admin get faqs error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch faqs." });
  }
});

router.post("/faqs", async (req, res) => {
  try {
    const { question, answer, category, sort_order } = req.body;
    const max = await Faq.findOne().sort({ sort_order: -1 });
    const nextOrder = sort_order ?? (max ? max.sort_order + 1 : 0);

    const faq = await Faq.create({
      question,
      answer,
      category: category || "general",
      sort_order: nextOrder,
    });

    res.status(201).json({
      success: true,
      faq: { ...faq.toObject(), id: faq._id.toString() },
    });
  } catch (error) {
    console.error("Admin create faq error:", error);
    res.status(500).json({ success: false, message: "Failed to create faq." });
  }
});

router.put("/faqs/:id", async (req, res) => {
  try {
    const faq = await Faq.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    ).lean();

    if (!faq) {
      return res.status(404).json({ success: false, message: "FAQ not found." });
    }

    res.json({
      success: true,
      faq: { ...faq, id: faq._id.toString() },
    });
  } catch (error) {
    console.error("Admin update faq error:", error);
    res.status(500).json({ success: false, message: "Failed to update faq." });
  }
});

router.delete("/faqs/:id", async (req, res) => {
  try {
    const faq = await Faq.findByIdAndDelete(req.params.id);
    if (!faq) {
      return res.status(404).json({ success: false, message: "FAQ not found." });
    }
    res.json({ success: true, message: "FAQ deleted successfully." });
  } catch (error) {
    console.error("Admin delete faq error:", error);
    res.status(500).json({ success: false, message: "Failed to delete faq." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. INVESTMENT CATEGORIZATION (Admin only EDEOH categorization)
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/investments/:id/category", async (req, res) => {
  try {
    const { category } = req.body;
    const allowed = ["equity", "debt", "elss", "others", "hybrid", ""];
    const normalized = (category || "").toLowerCase().trim();

    if (!allowed.includes(normalized)) {
      return res.status(400).json({
        success: false,
        message: `Invalid category. Must be one of: ${allowed.filter(Boolean).join(", ")} or empty string.`,
      });
    }

    const investment = await Investment.findByIdAndUpdate(
      req.params.id,
      { $set: { category: normalized } },
      { new: true }
    );

    if (!investment) {
      return res.status(404).json({ success: false, message: "Investment not found." });
    }

    res.json({
      success: true,
      data: investment,
      message: "Investment category updated successfully.",
    });
  } catch (error) {
    console.error("Admin update investment category error:", error);
    res.status(500).json({ success: false, message: "Failed to update investment category." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7b. BULK INVESTMENT IMPORT — POST /api/admin/users/:id/investments/bulk-import
// Admin uploads a parsed Excel/CSV (as JSON array) to add multiple holdings
// for a specific user in one shot.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/users/:id/investments/bulk-import", async (req, res) => {
  try {
    const { id: userId } = req.params;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const { rows } = req.body; // array of investment objects
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, message: "No rows provided. Send { rows: [...] }" });
    }

    const VALID_TYPES = ["stock", "mutual_fund", "sip", "ppf", "epf", "fd", "nps", "bond", "gold", "crypto", "aif", "reit_invit"];
    const VALID_CATEGORIES = ["equity", "debt", "elss", "others", "hybrid", ""];

    const created = [];
    const skipped = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // 1-indexed, +1 for header

      // ── Validate required fields ──────────────────────────────────
      const type = (row.type || "").toLowerCase().trim();
      if (!VALID_TYPES.includes(type)) {
        skipped.push({ row: rowNum, name: row.name, reason: `Invalid type "${row.type}". Must be one of: ${VALID_TYPES.join(", ")}` });
        continue;
      }

      const name = (row.name || "").trim();
      if (!name) {
        skipped.push({ row: rowNum, name: "-", reason: "Name is required" });
        continue;
      }

      const investedAmount = parseFloat(row.investedAmount || row.invested_amount || 0);
      if (isNaN(investedAmount) || investedAmount < 0) {
        skipped.push({ row: rowNum, name, reason: "investedAmount must be a positive number" });
        continue;
      }

      // ── Build the investment document ─────────────────────────────
      const doc = {
        userId,
        type,
        name,
        symbol:        (row.symbol        || "").trim().toUpperCase() || undefined,
        exchange:      (row.exchange       || "").trim().toUpperCase() || undefined,
        folioNumber:   (row.folioNumber    || row.folio_number || "").trim() || undefined,
        units:         parseFloat(row.units)         || 0,
        buyPrice:      parseFloat(row.buyPrice       || row.buy_price) || 0,
        buyDate:       row.buyDate || row.buy_date   ? new Date(row.buyDate || row.buy_date) : undefined,
        investedAmount,
        currentPrice:  parseFloat(row.currentPrice   || row.current_price) || 0,
        // SIP
        sipAmount:     parseFloat(row.sipAmount      || row.sip_amount) || 0,
        sipStartDate:  row.sipStartDate || row.sip_start_date ? new Date(row.sipStartDate || row.sip_start_date) : undefined,
        instalments:   parseInt(row.instalments)     || 0,
        avgNav:        parseFloat(row.avgNav         || row.avg_nav) || 0,
        // Fixed income
        principal:     parseFloat(row.principal)     || 0,
        interestRate:  parseFloat(row.interestRate   || row.interest_rate) || 0,
        maturityDate:  row.maturityDate || row.maturity_date ? new Date(row.maturityDate || row.maturity_date) : undefined,
        tenureMonths:  parseInt(row.tenureMonths     || row.tenure_months) || 0,
        institution:   (row.institution  || "").trim() || undefined,
        // Meta
        category:      VALID_CATEGORIES.includes((row.category || "").toLowerCase().trim())
                         ? (row.category || "").toLowerCase().trim()
                         : "",
        notes:         (row.notes || "").trim() || undefined,
        status:        "active",
      };

      // Remove undefined keys so Mongoose defaults apply cleanly
      Object.keys(doc).forEach((k) => doc[k] === undefined && delete doc[k]);

      try {
        const inv = await Investment.create(doc);
        created.push({ row: rowNum, name, type, investedAmount, id: inv._id });
      } catch (createErr) {
        skipped.push({ row: rowNum, name, reason: createErr.message });
      }
    }

    res.status(201).json({
      success: true,
      message: `Import complete. ${created.length} holdings added, ${skipped.length} skipped.`,
      importedCount:  created.length,
      skippedCount:   skipped.length,
      created,
      skipped,
    });
  } catch (err) {
    console.error("Admin bulk import investments error:", err);
    res.status(500).json({ success: false, message: "Server error during bulk import." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. ADMIN SELL / CAPITAL FREEING OPERATION
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/investments/:id/sell",
  [
    body("units").isFloat({ gt: 0 }).withMessage("Units to sell must be greater than 0"),
    body("sellPrice").isFloat({ gt: 0 }).withMessage("Sell price must be greater than 0"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const investment = await Investment.findById(req.params.id);
      if (!investment) {
        return res.status(404).json({ success: false, message: "Investment not found." });
      }

      const unitsToSell = Number(req.body.units);
      const sellPrice = Number(req.body.sellPrice);
      const sellDate = req.body.sellDate ? new Date(req.body.sellDate) : new Date();
      const notes = (req.body.notes || "").trim();

      const availableUnits = investment.units || 0;
      if (unitsToSell > availableUnits) {
        return res.status(400).json({
          success: false,
          message: `Cannot sell ${unitsToSell} units. Holding only has ${availableUnits} units available.`,
        });
      }

      if (!investment.originalInvestedAmount || investment.originalInvestedAmount === 0) {
        investment.originalInvestedAmount = investment.investedAmount || 0;
      }

      const buyPrice =
        investment.buyPrice ||
        (investment.investedAmount > 0 && availableUnits > 0
          ? investment.investedAmount / availableUnits
          : 0);

      const totalProceeds = Math.round(unitsToSell * sellPrice * 100) / 100;
      const costOfSoldUnits = Math.round(unitsToSell * buyPrice * 100) / 100;
      const realizedGain = Math.round((totalProceeds - costOfSoldUnits) * 100) / 100;
      const realizedGainPercent =
        costOfSoldUnits > 0 ? Math.round((realizedGain / costOfSoldUnits) * 10000) / 100 : 0;

      const cumulativeProceeds = (investment.totalProceeds || 0) + totalProceeds;
      const originalCapital = investment.originalInvestedAmount || investment.investedAmount;
      const isFreeShares = cumulativeProceeds >= originalCapital && originalCapital > 0;

      const remainingUnits = Math.round((availableUnits - unitsToSell) * 1000) / 1000;
      const remainingInvested = Math.round(remainingUnits * buyPrice * 100) / 100;
      const remainingValue = Math.round(remainingUnits * sellPrice * 100) / 100;

      const transaction = await Transaction.create({
        userId: investment.userId,
        investmentId: investment._id,
        investmentName: investment.name,
        type: "sell",
        units: unitsToSell,
        price: sellPrice,
        buyPrice,
        totalProceeds,
        realizedGain,
        realizedGainPercent,
        capitalRecovered: Math.min(cumulativeProceeds, originalCapital),
        isFreeShares,
        remainingUnits,
        remainingValue,
        sellDate,
        notes: notes ? `Admin Executed: ${notes}` : "Admin Executed Sale",
      });

      investment.totalProceeds = cumulativeProceeds;
      investment.realizedGain = (investment.realizedGain || 0) + realizedGain;
      investment.units = remainingUnits;
      investment.investedAmount = remainingInvested;
      investment.isFreeShare = isFreeShares && remainingUnits > 0;

      if (remainingUnits === 0) {
        investment.status = "closed";
      }

      await investment.save();

      const obj = investment.toObject();
      const cv = calcCurrentValue(investment);
      obj.currentValue = cv;
      obj.gain = cv - investment.investedAmount;
      obj.gainPercent =
        investment.investedAmount > 0 ? (obj.gain / investment.investedAmount) * 100 : 0;

      res.json({
        success: true,
        message:
          isFreeShares && remainingUnits > 0
            ? `Sold ${unitsToSell} units. Remaining ${remainingUnits} units are now 100% FREE SHARES!`
            : `Successfully sold ${unitsToSell} units. Realized profit: ₹${realizedGain.toLocaleString("en-IN")}.`,
        data: {
          investment: obj,
          transaction,
          summary: {
            unitsSold: unitsToSell,
            sellPrice,
            totalProceeds,
            realizedGain,
            realizedGainPercent,
            remainingUnits,
            isFreeShares,
            capitalRecoveredPercent:
              originalCapital > 0
                ? Math.round((cumulativeProceeds / originalCapital) * 100)
                : 100,
          },
        },
      });
    } catch (err) {
      console.error("Admin sell investment error:", err);
      res.status(500).json({ success: false, message: "Server error during sell operation." });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 9. USER ACTIVITY & EXIT P&L HISTORY (Exit Report)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/users/:id/transactions", async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.params.id })
      .sort({ sellDate: -1, createdAt: -1 });

    const totalRealizedProfit = transactions.reduce((acc, t) => acc + (t.realizedGain || 0), 0);
    const totalProceeds = transactions.reduce((acc, t) => acc + (t.totalProceeds || 0), 0);
    const totalCostBasis = transactions.reduce((acc, t) => acc + (t.units * (t.buyPrice || 0)), 0);
    const profitableCount = transactions.filter((t) => (t.realizedGain || 0) > 0).length;
    const lossCount = transactions.filter((t) => (t.realizedGain || 0) < 0).length;
    const freeSharesCount = transactions.filter((t) => t.isFreeShares).length;

    const summary = {
      totalTrades: transactions.length,
      totalRealizedProfit: Math.round(totalRealizedProfit * 100) / 100,
      totalProceeds: Math.round(totalProceeds * 100) / 100,
      totalCostBasis: Math.round(totalCostBasis * 100) / 100,
      overallReturnPercent:
        totalCostBasis > 0 ? Math.round((totalRealizedProfit / totalCostBasis) * 10000) / 100 : 0,
      profitableCount,
      lossCount,
      winRate:
        transactions.length > 0 ? Math.round((profitableCount / transactions.length) * 100) : 0,
      freeSharesCount,
    };

    res.json({
      success: true,
      transactions,
      summary,
      data: {
        transactions,
        summary,
      },
    });
  } catch (err) {
    console.error("Admin fetch user transactions error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch user transaction history." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. MASTER PRODUCT PRICES & BULK PRICING OVERRIDE
// ─────────────────────────────────────────────────────────────────────────────
function escapeRegex(text) {
  return (text || "").replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

async function applyProductPrice(item, adminUserId) {
  const name  = (item.name   || "").trim();
  const symbol = (item.symbol || "").trim();
  const type   = (item.type   || "").trim();
  const price  = parseFloat(item.price);
  const notes  = (item.notes  || "").trim();
  const staleAfterDays = item.staleAfterDays ? parseInt(item.staleAfterDays, 10) : undefined;

  if (isNaN(price) || price <= 0) {
    return { name, symbol, updated: false, reason: "Price must be a positive number greater than 0" };
  }
  if (!name && !symbol) {
    return { name, symbol, updated: false, reason: "Product Name or Symbol is required" };
  }

  // Build match query for Investments
  const orConditions = [];
  if (symbol) orConditions.push({ symbol: { $regex: `^${escapeRegex(symbol)}$`, $options: "i" } });
  if (name)   orConditions.push({ name:   { $regex: `^${escapeRegex(name)}$`,   $options: "i" } });

  const query = { $or: orConditions };
  if (type && type !== "all") {
    if (type === "mutual_fund" || type === "sip") {
      query.type = { $in: ["mutual_fund", "sip"] };
    } else {
      query.type = type;
    }
  }

  // 1. Bulk-update all matching investments across all users
  const updateResult = await Investment.updateMany(query, {
    $set: { currentPrice: price, lastPriceUpdate: new Date() },
  });

  // 2. Upsert into ProductPrice master catalog + append to priceHistory
  const ppFilter = symbol
    ? { symbol: symbol.toUpperCase() }
    : { name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } };

  const existingPP = await ProductPrice.findOne(ppFilter);

  const historyEntry = {
    price,
    updatedBy: adminUserId || null,
    source: item.source || "manual_admin",
    notes: notes || "Price update",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const setFields = {
    name:          name || (existingPP ? existingPP.name : symbol),
    symbol:        symbol.toUpperCase(),
    type:          type || (existingPP ? existingPP.type : "stock"),
    price,
    previousPrice: existingPP ? existingPP.price : price,
    source:        item.source || "manual_admin",
    notes:         notes || (existingPP ? existingPP.notes : ""),
    updatedBy:     adminUserId || null,
    lastUpdated:   new Date(),
  };
  if (staleAfterDays) setFields.staleAfterDays = staleAfterDays;

  await ProductPrice.findOneAndUpdate(
    ppFilter,
    {
      $set:  setFields,
      $push: { priceHistory: { $each: [historyEntry], $slice: -120 } }, // keep last 120 entries
    },
    { upsert: true, new: true }
  );

  return {
    name:          name || (existingPP ? existingPP.name : symbol),
    symbol:        symbol.toUpperCase(),
    type:          type || "stock",
    price,
    modifiedCount: updateResult.modifiedCount,
    updated:       true,
  };
}

// GET /api/admin/prices — List all distinct products held across clients + manual overrides
router.get("/prices", async (req, res) => {
  try {
    const { search, type, status } = req.query;

    // 1. Fetch all manual price overrides from ProductPrice
    const overrides = await ProductPrice.find().lean();
    const overrideMap = new Map();
    overrides.forEach((o) => {
      if (o.symbol) overrideMap.set(o.symbol.toUpperCase(), o);
      if (o.name) overrideMap.set(o.name.toLowerCase().trim(), o);
    });

    // 2. Aggregate unique products from Investment collection
    const pipeline = [
      {
        $group: {
          _id: {
            name: { $trim: { input: "$name" } },
            symbol: { $toUpper: { $trim: { input: "$symbol" } } },
            type: "$type",
          },
          exchange: { $first: "$exchange" },
          sampleCurrentPrice: { $max: "$currentPrice" },
          lastPriceUpdate: { $max: "$lastPriceUpdate" },
          clients: { $addToSet: "$userId" },
          totalUnits: { $sum: "$units" },
          totalInvested: { $sum: "$investedAmount" },
          holdingsCount: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          name: "$_id.name",
          symbol: "$_id.symbol",
          type: "$_id.type",
          exchange: "$exchange",
          currentPrice: "$sampleCurrentPrice",
          lastPriceUpdate: "$lastPriceUpdate",
          clientsCount: { $size: "$clients" },
          totalUnits: "$totalUnits",
          totalInvested: "$totalInvested",
          holdingsCount: "$holdingsCount",
        },
      },
      { $sort: { holdingsCount: -1, totalInvested: -1 } },
    ];

    let products = await Investment.aggregate(pipeline);

    // Also include any ProductPrice overrides that may not currently be in any client holdings
    const existingKeys = new Set(
      products.map((p) => (p.symbol ? p.symbol.toUpperCase() : p.name.toLowerCase().trim()))
    );

    overrides.forEach((o) => {
      const key = o.symbol ? o.symbol.toUpperCase() : o.name.toLowerCase().trim();
      if (!existingKeys.has(key)) {
        products.push({
          name: o.name,
          symbol: o.symbol,
          type: o.type,
          exchange: o.exchange || "",
          currentPrice: o.price,
          lastPriceUpdate: o.lastUpdated,
          clientsCount: 0,
          totalUnits: 0,
          totalInvested: 0,
          holdingsCount: 0,
          isManual: true,
          manualNotes: o.notes,
        });
      }
    });

    // Enhance each product with override status, live status, and staleness
    products = products.map((p) => {
      const override =
        (p.symbol && overrideMap.get(p.symbol.toUpperCase())) ||
        (p.name   && overrideMap.get(p.name.toLowerCase().trim()));
      const isManual      = !!override;
      const effectivePrice = override ? override.price : (p.currentPrice || 0);
      const isMissingPrice = effectivePrice <= 0;

      // Staleness calculation
      const lastUpdated    = override?.lastUpdated || p.lastPriceUpdate || null;
      const staleAfterDays = override?.staleAfterDays || 30;
      const daysSinceUpdate = lastUpdated
        ? Math.floor((Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const isStale = daysSinceUpdate !== null && daysSinceUpdate >= staleAfterDays;

      return {
        ...p,
        currentPrice:  effectivePrice,
        previousPrice: override ? override.previousPrice : effectivePrice,
        isManual,
        isMissingPrice,
        manualNotes:    override?.notes || "",
        lastUpdated,
        source:         override ? override.source : (effectivePrice > 0 ? "api_sync" : "missing"),
        // ─ staleness fields (new) ─
        staleAfterDays,
        daysSinceUpdate,
        isStale,
        priceHistory:   override?.priceHistory
          ? override.priceHistory.slice(-12).reverse()  // last 12 entries, newest first
          : [],
      };
    });

    // High level stats calculated across all unfiltered products
    const totalProducts       = products.length;
    const unpricedCount       = products.filter((p) => p.isMissingPrice).length;
    const manualCount         = products.filter((p) => p.isManual).length;
    const staleCount          = products.filter((p) => p.isStale && p.isManual).length;
    const liveCount           = totalProducts - unpricedCount - manualCount;
    const totalHoldingsCount  = products.reduce((acc, p) => acc + (p.holdingsCount || 0), 0);
    const totalInvestedSum    = products.reduce((acc, p) => acc + (p.totalInvested  || 0), 0);

    // Filter by search, type, and status
    if (search && search.trim()) {
      const s = search.trim().toLowerCase();
      products = products.filter(
        (p) =>
          (p.name && p.name.toLowerCase().includes(s)) ||
          (p.symbol && p.symbol.toLowerCase().includes(s))
      );
    }

    if (type && type !== "all") {
      products = products.filter((p) => p.type === type);
    }

    if (status === "missing") {
      products = products.filter((p) => p.isMissingPrice);
    } else if (status === "manual") {
      products = products.filter((p) => p.isManual);
    } else if (status === "live") {
      products = products.filter((p) => !p.isMissingPrice && !p.isManual);
    }

    res.json({
      success: true,
      data: {
        products,
        stats: {
          totalProducts,
          unpricedCount,
          manualCount,
          staleCount,
          liveCount,
          totalHoldingsCount,
          totalInvestedSum,
        },
      },
    });
  } catch (err) {
    console.error("Admin get prices error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch product prices." });
  }
});

// PUT /api/admin/prices — Update single product price across all client holdings
router.put(
  "/prices",
  [
    body("price").isFloat({ gt: 0 }).withMessage("Price must be a positive number greater than 0"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const result = await applyProductPrice(
        {
          name: req.body.name,
          symbol: req.body.symbol,
          type: req.body.type,
          price: req.body.price,
          notes: req.body.notes,
          source: "manual_admin",
        },
        req.user?._id
      );

      if (!result.updated) {
        return res.status(400).json({ success: false, message: result.reason });
      }

      res.json({
        success: true,
        data: result,
        message: `Successfully updated price to ₹${result.price.toLocaleString("en-IN")} across ${result.modifiedCount} client holdings.`,
      });
    } catch (err) {
      console.error("Admin update price error:", err);
      res.status(500).json({ success: false, message: "Failed to update product price." });
    }
  }
);

// POST /api/admin/prices/bulk — Bulk update product prices from Excel upload / batch edit
router.post("/prices/bulk", async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No product price items provided. Expected an array of price updates.",
      });
    }

    const results = [];
    let updatedProductsCount = 0;
    let totalHoldingsUpdated = 0;

    for (const item of items) {
      if (!item || !item.price || isNaN(parseFloat(item.price)) || parseFloat(item.price) <= 0) {
        continue;
      }
      const resItem = await applyProductPrice(
        { ...item, source: item.source || "excel_upload" },
        req.user?._id
      );

      if (resItem.updated) {
        updatedProductsCount++;
        totalHoldingsUpdated += resItem.modifiedCount || 0;
        results.push(resItem);
      }
    }

    res.json({
      success: true,
      message: `Bulk update complete. Updated ${updatedProductsCount} products affecting ${totalHoldingsUpdated} client holdings.`,
      updatedProductsCount,
      totalHoldingsUpdated,
      details: results,
    });
  } catch (err) {
    console.error("Admin bulk update prices error:", err);
    res.status(500).json({ success: false, message: "Failed to execute bulk price updates." });
  }
});

// POST /api/admin/prices/sync-overrides — Re-apply ALL ProductPrice overrides to client holdings
// Use this for regular price refresh without re-uploading Excel.
// Propagates every record in ProductPrice catalog to all matching Investment documents.
router.post("/prices/sync-overrides", async (req, res) => {
  try {
    const overrides = await ProductPrice.find({ price: { $gt: 0 } }).lean();
    if (overrides.length === 0) {
      return res.json({
        success: true,
        message: "No manual price overrides found in catalog.",
        updatedProductsCount: 0,
        totalHoldingsUpdated: 0,
      });
    }

    let updatedProductsCount = 0;
    let totalHoldingsUpdated = 0;
    const results = [];

    for (const override of overrides) {
      const orConditions = [];
      if (override.symbol) orConditions.push({ symbol: { $regex: `^${escapeRegex(override.symbol)}$`, $options: "i" } });
      if (override.name)   orConditions.push({ name:   { $regex: `^${escapeRegex(override.name)}$`,   $options: "i" } });
      if (orConditions.length === 0) continue;

      const updateResult = await Investment.updateMany(
        { $or: orConditions },
        { $set: { currentPrice: override.price, lastPriceUpdate: new Date() } }
      );

      if (updateResult.modifiedCount > 0) {
        updatedProductsCount++;
        totalHoldingsUpdated += updateResult.modifiedCount;
        results.push({
          name:          override.name,
          symbol:        override.symbol,
          price:         override.price,
          modifiedCount: updateResult.modifiedCount,
        });
      }
    }

    res.json({
      success: true,
      message: `Re-sync complete. Applied ${updatedProductsCount} price overrides to ${totalHoldingsUpdated} client holdings.`,
      updatedProductsCount,
      totalHoldingsUpdated,
      details: results,
    });
  } catch (err) {
    console.error("Admin sync overrides error:", err);
    res.status(500).json({ success: false, message: "Failed to sync price overrides." });
  }
});

module.exports = router;

