const express = require("express");
const { requireAdmin } = require("../middleware/admin");
const User = require("../models/User");
const Investment = require("../models/Investment");
const Lead = require("../models/Lead");
const SiteContent = require("../models/SiteContent");
const Service = require("../models/Service");
const Faq = require("../models/Faq");

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

function calcCurrentValue(inv) {
  const fixedTypes = ["fd", "ppf", "epf", "nps", "bond"];

  if (fixedTypes.includes(inv.type)) {
    return typeof inv.estimatedValue === "function"
      ? inv.estimatedValue()
      : (inv.principal || inv.investedAmount || 0);
  }

  if (inv.type === "aif") {
    return inv.currentPrice > 0 ? inv.currentPrice : (inv.investedAmount || 0);
  }

  // Market assets with live price
  if (inv.currentPrice > 0) {
    if (["stock", "reit_invit", "mutual_fund", "gold", "crypto", "bond"].includes(inv.type)) {
      return (inv.units || 0) * inv.currentPrice;
    }
    if (inv.type === "sip" && inv.avgNav > 0) {
      const totalUnits = ((inv.sipAmount || 0) * (inv.instalments || 0)) / inv.avgNav;
      return totalUnits * inv.currentPrice;
    }
  }

  return inv.investedAmount || 0;
}

router.get("/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select("name email phone role authProvider avatar riskProfile isActive createdAt")
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const investments = await Investment.find({ userId: user._id })
      .sort({ createdAt: -1 });

    let totalInvested = 0;
    let totalCurrent = 0;
    const byType = {};

    const enrichedInvestments = investments.map((inv) => {
      const cv = calcCurrentValue(inv);
      const invested = inv.investedAmount || 0;
      const gain = cv - invested;
      const gainPercent = invested > 0 ? (gain / invested) * 100 : 0;

      totalInvested += invested;
      totalCurrent += cv;

      if (!byType[inv.type]) {
        byType[inv.type] = { count: 0, invested: 0, currentValue: 0 };
      }
      byType[inv.type].count += 1;
      byType[inv.type].invested += invested;
      byType[inv.type].currentValue += cv;

      const obj = inv.toObject();
      return {
        ...obj,
        currentValue: Math.round(cv * 100) / 100,
        gain: Math.round(gain * 100) / 100,
        gainPercent: Math.round(gainPercent * 100) / 100,
      };
    });

    const totalGain = totalCurrent - totalInvested;
    const totalGainPercent = totalInvested > 0 ? (totalGain / totalInvested) * 100 : 0;

    const summary = {
      totalInvested: Math.round(totalInvested * 100) / 100,
      currentValue: Math.round(totalCurrent * 100) / 100,
      totalGain: Math.round(totalGain * 100) / 100,
      totalGainPercent: Math.round(totalGainPercent * 100) / 100,
      holdings: investments.length,
      byType,
      pricesLastUpdated: investments
        .filter((i) => i.lastPriceUpdate)
        .sort((a, b) => new Date(b.lastPriceUpdate) - new Date(a.lastPriceUpdate))[0]
        ?.lastPriceUpdate ?? null,
    };

    const userObj = { ...user, id: user._id };
    res.json({
      success: true,
      user: userObj,
      investments: enrichedInvestments,
      summary,
      data: { user: userObj, investments: enrichedInvestments, summary },
    });
  } catch (error) {
    console.error("Admin get user error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch user details." });
  }
});

router.put("/users/:id", async (req, res) => {
  try {
    const { role, isActive, phone, name, riskProfile } = req.body;
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

module.exports = router;
