const express = require("express");
const { body, validationResult } = require("express-validator");
const Investment = require("../models/Investment");
const User = require("../models/User");
const { protect } = require("../middleware/auth");

const router = express.Router();

// All routes require authentication
router.use(protect);

// -- Helper: compute investedAmount from payload ---------------------------
function calcInvestedAmount(data) {
  switch (data.type) {
    case "stock":
    case "reit_invit":
    case "mutual_fund":
    case "gold":
    case "crypto":
      return (Number(data.units) || 0) * (Number(data.buyPrice) || 0);
    case "sip":
      return (Number(data.sipAmount) || 0) * (Number(data.instalments) || 0);
    case "ppf":
    case "epf":
    case "fd":
    case "nps":
    case "bond":
      return Number(data.principal) || 0;
    case "aif":
      return Number(data.investedAmount || data.principal || 0);
    default:
      return Number(data.investedAmount) || 0;
  }
}

// -- Helper: compute current value for one investment ---------------------
function calcCurrentValue(inv) {
  const fixedTypes = ["fd", "ppf", "epf", "nps"];

  if (fixedTypes.includes(inv.type)) {
    return inv.estimatedValue();
  }

  if (inv.type === "aif") {
    // If current valuation is entered, use it; otherwise fallback to investedAmount
    return inv.currentPrice > 0 ? inv.currentPrice : (inv.investedAmount || 0);
  }

  // Market assets with live price
  if (inv.currentPrice > 0) {
    if (["stock", "reit_invit", "mutual_fund", "gold", "crypto", "bond"].includes(inv.type)) {
      return (inv.units || 0) * inv.currentPrice;
    }
    if (inv.type === "sip" && inv.avgNav > 0) {
      // Estimate total units accumulated via SIP
      const totalUnits = ((inv.sipAmount || 0) * (inv.instalments || 0)) / inv.avgNav;
      return totalUnits * inv.currentPrice;
    }
  }

  // Fallback to invested amount
  return inv.investedAmount || 0;
}

// -- GET /api/portfolio/summary --------------------------------------------
router.get("/summary", async (req, res) => {
  try {
    const investments = await Investment.find({ userId: req.user._id });

    if (investments.length === 0) {
      return res.json({
        success: true,
        data: {
          totalInvested: 0, currentValue: 0, totalGain: 0,
          totalGainPercent: 0, holdings: 0, byType: {},
          recentInvestments: [], pricesLastUpdated: null,
        },
      });
    }

    const totalInvested = investments.reduce((s, i) => s + (i.investedAmount || 0), 0);
    const currentValue = investments.reduce((s, i) => s + calcCurrentValue(i), 0);
    const totalGain = currentValue - totalInvested;
    const totalGainPercent = totalInvested > 0 ? (totalGain / totalInvested) * 100 : 0;

    // Allocation by type
    const byType = {};
    investments.forEach((inv) => {
      if (!byType[inv.type]) byType[inv.type] = { count: 0, invested: 0, currentValue: 0 };
      byType[inv.type].count += 1;
      byType[inv.type].invested += inv.investedAmount || 0;
      byType[inv.type].currentValue += calcCurrentValue(inv);
    });

    // Latest price update timestamp
    const pricesLastUpdated = investments
      .filter((i) => i.lastPriceUpdate)
      .sort((a, b) => new Date(b.lastPriceUpdate) - new Date(a.lastPriceUpdate))[0]
      ?.lastPriceUpdate ?? null;

    // Recent investments (last 6)
    const recentInvestments = [...investments]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 6)
      .map((inv) => {
        const cv = calcCurrentValue(inv);
        return {
          _id: inv._id, name: inv.name, type: inv.type,
          investedAmount: inv.investedAmount,
          currentValue: cv,
          gain: cv - inv.investedAmount,
          gainPercent: inv.investedAmount > 0 ? ((cv - inv.investedAmount) / inv.investedAmount) * 100 : 0,
          symbol: inv.symbol,
          buyDate: inv.buyDate || inv.sipStartDate,
          createdAt: inv.createdAt,
        };
      });

    res.json({
      success: true,
      data: {
        totalInvested, currentValue, totalGain,
        totalGainPercent, holdings: investments.length,
        byType, recentInvestments, pricesLastUpdated,
      },
    });
  } catch (err) {
    console.error("Summary error:", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// -- GET /api/portfolio ----------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { type, sort = "createdAt", order = "desc", search } = req.query;
    const filter = { userId: req.user._id };
    if (type && type !== "all") {
      if (type === "ppf_epf") {
        filter.type = { $in: ["ppf", "epf"] };
      } else {
        filter.type = type;
      }
    }
    if (search) filter.name = { $regex: search, $options: "i" };

    const sortDir = order === "asc" ? 1 : -1;
    const investments = await Investment.find(filter).sort({ [sort]: sortDir });

    // Attach computed fields to each investment
    const result = investments.map((inv) => {
      const obj = inv.toObject();
      const cv = calcCurrentValue(inv);
      obj.currentValue = cv;
      obj.gain = cv - (inv.investedAmount || 0);
      obj.gainPercent = (inv.investedAmount || 0) > 0
        ? (obj.gain / inv.investedAmount) * 100 : 0;
      return obj;
    });

    res.json({ success: true, data: result, count: result.length });
  } catch (err) {
    console.error("Get portfolio error:", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// -- POST /api/portfolio ---------------------------------------------------
router.post(
  "/",
  [body("type").notEmpty(), body("name").trim().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const payload = { ...req.body, userId: req.user._id };
      payload.investedAmount = calcInvestedAmount(payload);
      const investment = await Investment.create(payload);
      res.status(201).json({ success: true, data: investment });
    } catch (err) {
      console.error("Add investment error:", err);
      res.status(500).json({ success: false, message: "Server error." });
    }
  }
);

// ─── FAMILY PORTFOLIO & CUMULATIVE DATA ROUTES ──────────────────────────────

// GET /api/portfolio/family — List linked family members with their high-level stats
router.get("/family", async (req, res) => {
  try {
    const currentUser = await User.findById(req.user._id)
      .populate("familyMembers.userId", "name email phone avatar riskProfile")
      .lean();

    if (!currentUser) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // Compute stats for primary user
    const primaryInvestments = await Investment.find({ userId: currentUser._id });
    const primaryInv = primaryInvestments.reduce((sum, i) => sum + (i.investedAmount || 0), 0);
    const primaryCur = primaryInvestments.reduce((sum, i) => sum + calcCurrentValue(i), 0);
    const primaryGain = primaryCur - primaryInv;

    const primaryUser = {
      id: currentUser._id,
      name: currentUser.name,
      email: currentUser.email,
      phone: currentUser.phone,
      avatar: currentUser.avatar,
      riskProfile: currentUser.riskProfile,
      relationship: "Self (Primary)",
      stats: {
        totalInvested: primaryInv,
        currentValue: primaryCur,
        totalGain: primaryGain,
        totalGainPercent: primaryInv > 0 ? (primaryGain / primaryInv) * 100 : 0,
        holdingsCount: primaryInvestments.length,
      },
    };

    // Compute stats for each family member
    const members = [];
    if (currentUser.familyMembers && currentUser.familyMembers.length > 0) {
      for (const m of currentUser.familyMembers) {
        if (!m.userId) continue;
        const memberInvestments = await Investment.find({ userId: m.userId._id });
        const memberInv = memberInvestments.reduce((sum, i) => sum + (i.investedAmount || 0), 0);
        const memberCur = memberInvestments.reduce((sum, i) => sum + calcCurrentValue(i), 0);
        const memberGain = memberCur - memberInv;

        members.push({
          userId: m.userId._id,
          name: m.userId.name,
          email: m.userId.email,
          phone: m.userId.phone,
          avatar: m.userId.avatar,
          riskProfile: m.userId.riskProfile,
          relationship: m.relationship || "Family Member",
          addedAt: m.addedAt,
          stats: {
            totalInvested: memberInv,
            currentValue: memberCur,
            totalGain: memberGain,
            totalGainPercent: memberInv > 0 ? (memberGain / memberInv) * 100 : 0,
            holdingsCount: memberInvestments.length,
          },
        });
      }
    }

    res.json({
      success: true,
      primaryUser,
      members,
      data: { primaryUser, members },
    });
  } catch (err) {
    console.error("Get family members error:", err);
    res.status(500).json({ success: false, message: "Failed to retrieve family accounts." });
  }
});

// POST /api/portfolio/family/link — Add family member account by verifying credentials
router.post("/family/link", async (req, res) => {
  try {
    const { email, password, relationship } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Family member email and password are required.",
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanRel = (relationship || "Family Member").trim();

    // Find the target family member account
    const memberUser = await User.findOne({ email: cleanEmail }).select("+password");
    if (!memberUser) {
      return res.status(404).json({
        success: false,
        message: "Account with this email does not exist on Phoenix Financial Services.",
      });
    }

    // Verify password
    const isMatch = await memberUser.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid password for this family member account.",
      });
    }

    // Prevent self-linking
    if (memberUser._id.equals(req.user._id)) {
      return res.status(400).json({
        success: false,
        message: "You cannot link your own account as a family member.",
      });
    }

    // Load current user
    const currentUser = await User.findById(req.user._id);
    if (!currentUser.familyMembers) {
      currentUser.familyMembers = [];
    }

    // Check if already linked
    const alreadyLinked = currentUser.familyMembers.some((m) =>
      m.userId.equals(memberUser._id)
    );
    if (alreadyLinked) {
      return res.status(400).json({
        success: false,
        message: `${memberUser.name}'s account is already linked to your family portfolio.`,
      });
    }

    // Add to familyMembers
    currentUser.familyMembers.push({
      userId: memberUser._id,
      relationship: cleanRel,
      addedAt: new Date(),
    });

    await currentUser.save();

    res.json({
      success: true,
      message: `Successfully linked ${memberUser.name}'s account (${cleanRel}) to your family portfolio.`,
      member: {
        userId: memberUser._id,
        name: memberUser.name,
        email: memberUser.email,
        phone: memberUser.phone,
        avatar: memberUser.avatar,
        relationship: cleanRel,
      },
    });
  } catch (err) {
    console.error("Link family member error:", err);
    res.status(500).json({ success: false, message: "Failed to link family member account." });
  }
});

// DELETE /api/portfolio/family/:memberId — Unlink family member
router.delete("/family/:memberId", async (req, res) => {
  try {
    const currentUser = await User.findById(req.user._id);
    if (!currentUser || !currentUser.familyMembers) {
      return res.status(404).json({ success: false, message: "No family accounts found." });
    }

    const initialLen = currentUser.familyMembers.length;
    currentUser.familyMembers = currentUser.familyMembers.filter(
      (m) => m.userId.toString() !== req.params.memberId && m._id?.toString() !== req.params.memberId
    );

    if (currentUser.familyMembers.length === initialLen) {
      return res.status(404).json({ success: false, message: "Family member link not found." });
    }

    await currentUser.save();
    res.json({ success: true, message: "Family member unlinked successfully." });
  } catch (err) {
    console.error("Unlink family member error:", err);
    res.status(500).json({ success: false, message: "Failed to unlink family member." });
  }
});

// GET /api/portfolio/family/cumulative — Get aggregated family portfolio data
router.get("/family/cumulative", async (req, res) => {
  try {
    const currentUser = await User.findById(req.user._id)
      .populate("familyMembers.userId", "name email phone avatar riskProfile")
      .lean();

    if (!currentUser) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // Build user mapping
    const memberMap = new Map();
    memberMap.set(currentUser._id.toString(), {
      id: currentUser._id.toString(),
      name: currentUser.name,
      email: currentUser.email,
      phone: currentUser.phone,
      avatar: currentUser.avatar,
      riskProfile: currentUser.riskProfile,
      relationship: "Self (Primary)",
      isSelf: true,
    });

    const userIds = [currentUser._id];

    if (currentUser.familyMembers && currentUser.familyMembers.length > 0) {
      currentUser.familyMembers.forEach((m) => {
        if (m.userId) {
          userIds.push(m.userId._id);
          memberMap.set(m.userId._id.toString(), {
            id: m.userId._id.toString(),
            name: m.userId.name,
            email: m.userId.email,
            phone: m.userId.phone,
            avatar: m.userId.avatar,
            riskProfile: m.userId.riskProfile,
            relationship: m.relationship || "Family Member",
            isSelf: false,
          });
        }
      });
    }

    // Retrieve all investments across family members
    const investments = await Investment.find({ userId: { $in: userIds } }).sort({
      createdAt: -1,
    });

    let totalInvested = 0;
    let totalCurrent = 0;
    const byType = {};
    const byMember = {};

    // Initialize member tracking
    for (const [id, mInfo] of memberMap.entries()) {
      byMember[id] = {
        id,
        name: mInfo.name,
        relationship: mInfo.relationship,
        isSelf: mInfo.isSelf,
        invested: 0,
        currentValue: 0,
        gain: 0,
        holdings: 0,
      };
    }

    const enriched = investments.map((inv) => {
      const cv = calcCurrentValue(inv);
      const invested = inv.investedAmount || 0;
      const gain = cv - invested;
      const gainPercent = invested > 0 ? (gain / invested) * 100 : 0;

      totalInvested += invested;
      totalCurrent += cv;

      // Group by asset type
      if (!byType[inv.type]) {
        byType[inv.type] = { count: 0, invested: 0, currentValue: 0 };
      }
      byType[inv.type].count += 1;
      byType[inv.type].invested += invested;
      byType[inv.type].currentValue += cv;

      // Group by family member
      const ownerIdStr = inv.userId.toString();
      if (byMember[ownerIdStr]) {
        byMember[ownerIdStr].invested += invested;
        byMember[ownerIdStr].currentValue += cv;
        byMember[ownerIdStr].gain += gain;
        byMember[ownerIdStr].holdings += 1;
      }

      const owner = memberMap.get(ownerIdStr) || {
        name: "Unknown",
        email: "",
        relationship: "Family Member",
        isSelf: false,
      };

      const obj = inv.toObject();
      return {
        ...obj,
        currentValue: Math.round(cv * 100) / 100,
        gain: Math.round(gain * 100) / 100,
        gainPercent: Math.round(gainPercent * 100) / 100,
        ownerId: ownerIdStr,
        ownerName: owner.name,
        ownerEmail: owner.email,
        relationship: owner.relationship,
        isSelf: owner.isSelf,
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
      byMember,
      pricesLastUpdated: investments
        .filter((i) => i.lastPriceUpdate)
        .sort((a, b) => new Date(b.lastPriceUpdate) - new Date(a.lastPriceUpdate))[0]
        ?.lastPriceUpdate ?? null,
    };

    const membersList = Array.from(memberMap.values());

    res.json({
      success: true,
      investments: enriched,
      summary,
      members: membersList,
      data: { investments: enriched, summary, members: membersList },
    });
  } catch (err) {
    console.error("Cumulative portfolio error:", err);
    res.status(500).json({ success: false, message: "Failed to generate cumulative portfolio." });
  }
});

// -- PUT /api/portfolio/:id ------------------------------------------------
router.put("/:id", async (req, res) => {
  try {
    const investment = await Investment.findOne({ _id: req.params.id, userId: req.user._id });
    if (!investment)
      return res.status(404).json({ success: false, message: "Investment not found." });

    const payload = { ...req.body };
    payload.investedAmount = calcInvestedAmount({ ...investment.toObject(), ...payload });
    Object.assign(investment, payload);
    await investment.save();

    const obj = investment.toObject();
    const cv = calcCurrentValue(investment);
    obj.currentValue = cv;
    obj.gain = cv - investment.investedAmount;
    obj.gainPercent = investment.investedAmount > 0 ? (obj.gain / investment.investedAmount) * 100 : 0;

    res.json({ success: true, data: obj });
  } catch (err) {
    console.error("Update investment error:", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// -- DELETE /api/portfolio/:id ---------------------------------------------
router.delete("/:id", async (req, res) => {
  try {
    const investment = await Investment.findOneAndDelete({
      _id: req.params.id, userId: req.user._id,
    });
    if (!investment)
      return res.status(404).json({ success: false, message: "Investment not found." });
    res.json({ success: true, message: "Investment deleted." });
  } catch (err) {
    console.error("Delete investment error:", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;

