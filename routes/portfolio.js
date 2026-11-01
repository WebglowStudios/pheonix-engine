const express = require("express");
const { body, validationResult } = require("express-validator");
const Investment = require("../models/Investment");
const Transaction = require("../models/Transaction");
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
          notes: inv.notes || "",
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
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { symbol: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }

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
    const selfIdStr = currentUser._id.toString();
    memberMap.set(selfIdStr, {
      id: selfIdStr,
      userId: selfIdStr,         // alias so frontend unlink works
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
          const midStr = m.userId._id.toString();
          userIds.push(m.userId._id);
          memberMap.set(midStr, {
            id: midStr,
            userId: midStr,       // alias so frontend unlink works
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

    // Attach computed stats to every member entry so individual cards show real numbers
    const membersList = Array.from(memberMap.values()).map((m) => {
      const ms = byMember[m.id] || { invested: 0, currentValue: 0, gain: 0, holdings: 0 };
      return {
        ...m,
        stats: {
          totalInvested: ms.invested,
          currentValue: ms.currentValue,
          totalGain: ms.gain,
          totalGainPercent: ms.invested > 0 ? (ms.gain / ms.invested) * 100 : 0,
          holdingsCount: ms.holdings,
        },
      };
    });

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

// -- POST /api/portfolio/:id/sell (Position-aware Average Cost Sell) ----------
//
// Logic (per client directive):
//  1. Find ALL active Investment lots for this user with the same symbol+exchange.
//  2. Compute the weighted avg cost across ALL those open lots.
//  3. Realized gain = unitsSold × (sellPrice − avgCost)   ← the correct formula
//  4. Reduce units on the target lot document (FIFO: oldest lot first if partial).
//  5. Store openQtyAfter = total remaining qty across all lots after the sell.
//
router.post(
  "/:id/sell",
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
      const investment = await Investment.findOne({ _id: req.params.id, userId: req.user._id });
      if (!investment) {
        return res.status(404).json({ success: false, message: "Investment not found." });
      }

      const unitsToSell = Number(req.body.units);
      const sellPrice   = Number(req.body.sellPrice);
      const sellDate    = req.body.sellDate ? new Date(req.body.sellDate) : new Date();
      const notes       = (req.body.notes || "").trim();

      const availableUnits = investment.units || 0;
      if (unitsToSell > availableUnits) {
        return res.status(400).json({
          success: false,
          message: `Cannot sell ${unitsToSell} units. Only ${availableUnits} units available in this lot.`,
        });
      }

      // ───────────────────────────────────────────────────────────
      // STEP 1: Find ALL active lots for this symbol+exchange to compute
      // the position-level weighted average cost.
      // If the investment has no symbol (FD, PPF, etc.) fall back to single-lot buyPrice.
      // ───────────────────────────────────────────────────────────
      let avgCost = investment.buyPrice || (availableUnits > 0 ? investment.investedAmount / availableUnits : 0);
      let totalOpenQtyBefore = availableUnits; // default: only this lot

      if (investment.symbol) {
        // Fetch all active lots for the same symbol+exchange
        const positionFilter = {
          userId:   req.user._id,
          symbol:   investment.symbol,
          status:   "active",
          units:    { $gt: 0 },
        };
        if (investment.exchange) positionFilter.exchange = investment.exchange;

        const allLots = await Investment.find(positionFilter);

        if (allLots.length > 0) {
          // Weighted avg: sum(units_i * buyPrice_i) / sum(units_i)
          let totalUnits    = 0;
          let totalCostBasis = 0;
          allLots.forEach((lot) => {
            const lotUnits = lot.units || 0;
            const lotBuy   = lot.buyPrice || (lot.investedAmount > 0 && lotUnits > 0 ? lot.investedAmount / lotUnits : 0);
            totalUnits    += lotUnits;
            totalCostBasis += lotUnits * lotBuy;
          });
          avgCost             = totalUnits > 0 ? totalCostBasis / totalUnits : avgCost;
          totalOpenQtyBefore  = totalUnits;
        }
      }

      // ───────────────────────────────────────────────────────────
      // STEP 2: Calculate realized P&L using position avg cost
      // ───────────────────────────────────────────────────────────
      const totalProceeds      = Math.round(unitsToSell * sellPrice * 100) / 100;
      const costOfSoldUnits    = Math.round(unitsToSell * avgCost * 100) / 100;
      const realizedGain       = Math.round((totalProceeds - costOfSoldUnits) * 100) / 100;
      const realizedGainPercent =
        costOfSoldUnits > 0 ? Math.round((realizedGain / costOfSoldUnits) * 10000) / 100 : 0;

      // Open qty after this sell (across ALL lots)
      const openQtyAfter   = Math.round((totalOpenQtyBefore - unitsToSell) * 1000) / 1000;
      // Avg cost of remaining open position is unchanged by a sell
      const avgCostAfter   = openQtyAfter > 0 ? avgCost : 0;

      // Free Shares tracking (capital recovery against this specific lot)
      if (!investment.originalInvestedAmount || investment.originalInvestedAmount === 0) {
        investment.originalInvestedAmount = investment.investedAmount || 0;
      }
      const cumulativeProceeds = (investment.totalProceeds || 0) + totalProceeds;
      const originalCapital    = investment.originalInvestedAmount || investment.investedAmount;
      const isFreeShares       = cumulativeProceeds >= originalCapital && originalCapital > 0;

      // Remaining units on THIS specific lot document
      const remainingUnits   = Math.round((availableUnits - unitsToSell) * 1000) / 1000;
      const remainingValue   = Math.round(remainingUnits * sellPrice * 100) / 100;

      // ───────────────────────────────────────────────────────────
      // STEP 3: Persist transaction record with full position context
      // ───────────────────────────────────────────────────────────
      const transaction = await Transaction.create({
        userId:              req.user._id,
        investmentId:        investment._id,
        investmentName:      investment.name,
        symbol:              investment.symbol  || "",
        exchange:            investment.exchange || "",
        type:                "sell",
        units:               unitsToSell,
        price:               sellPrice,
        buyPrice:            investment.buyPrice || 0,   // original lot buy price (for reference)
        avgCostBefore:       Math.round(avgCost * 100) / 100,  // ← position avg cost
        totalProceeds,
        realizedGain,
        realizedGainPercent,
        capitalRecovered:    Math.min(cumulativeProceeds, originalCapital),
        isFreeShares,
        openQtyAfter,        // ← total open qty across all lots after this sell
        avgCostAfter:        Math.round(avgCostAfter * 100) / 100,
        remainingUnits,      // legacy: units left in this specific lot
        remainingValue,
        sellDate,
        notes,
      });

      // ───────────────────────────────────────────────────────────
      // STEP 4: Update the sold lot document
      // ───────────────────────────────────────────────────────────
      investment.totalProceeds  = cumulativeProceeds;
      investment.realizedGain   = (investment.realizedGain || 0) + realizedGain;
      investment.units          = remainingUnits;
      investment.investedAmount = Math.round(remainingUnits * avgCost * 100) / 100; // use avg cost
      investment.isFreeShare    = isFreeShares && remainingUnits > 0;

      if (remainingUnits === 0) {
        investment.status = "closed";
      }

      await investment.save();

      const obj = investment.toObject();
      const cv  = calcCurrentValue(investment);
      obj.currentValue = cv;
      obj.gain         = cv - investment.investedAmount;
      obj.gainPercent  = investment.investedAmount > 0 ? (obj.gain / investment.investedAmount) * 100 : 0;

      res.json({
        success: true,
        message:
          isFreeShares && remainingUnits > 0
            ? `Sold ${unitsToSell} units at ₹${sellPrice.toLocaleString("en-IN")}. Remaining ${remainingUnits} units are now FREE SHARES!`
            : `Sold ${unitsToSell} units at avg cost ₹${Math.round(avgCost).toLocaleString("en-IN")}. Realized P&L: ₹${realizedGain.toLocaleString("en-IN")}. Open position: ${openQtyAfter} units.`,
        data: {
          investment: obj,
          transaction,
          summary: {
            unitsSold:           unitsToSell,
            sellPrice,
            avgCostUsed:         Math.round(avgCost * 100) / 100,
            totalProceeds,
            realizedGain,
            realizedGainPercent,
            openQtyAfter,
            avgCostAfter:        Math.round(avgCostAfter * 100) / 100,
            isFreeShares,
            capitalRecoveredPercent:
              originalCapital > 0
                ? Math.round((cumulativeProceeds / originalCapital) * 100)
                : 100,
          },
        },
      });
    } catch (err) {
      console.error("Sell investment error:", err);
      res.status(500).json({ success: false, message: "Server error during sell operation." });
    }
  }
);

// -- GET /api/portfolio/positions ------------------------------------------
// Aggregates all active lots into "open positions" grouped by symbol+exchange.
// This is the position-level view the client described:
//   Buy 1000 AMBUJACEM @ 440 + Buy 870 AMBUJACEM @ 350 = one position, 1870 units @ ₹379.77 avg
//
router.get("/positions", async (req, res) => {
  try {
    // Only active lots with units > 0 and a symbol (market assets)
    const lots = await Investment.find({
      userId: req.user._id,
      status: "active",
      units: { $gt: 0 },
      symbol: { $exists: true, $ne: "" },
    });

    // Group by symbol+exchange key
    const posMap = {};
    lots.forEach((lot) => {
      const key = `${lot.symbol}__${lot.exchange || ""}`.toUpperCase();
      if (!posMap[key]) {
        posMap[key] = {
          symbol:       lot.symbol,
          exchange:     lot.exchange || "",
          name:         lot.name,
          type:         lot.type,
          lots:         [],
          totalUnits:   0,
          totalCostBasis: 0,
        };
      }
      const pos = posMap[key];
      const lotUnits = lot.units || 0;
      const lotBuy   = lot.buyPrice || (lot.investedAmount > 0 && lotUnits > 0 ? lot.investedAmount / lotUnits : 0);
      pos.lots.push({
        _id:          lot._id,
        buyDate:      lot.buyDate,
        units:        lotUnits,
        buyPrice:     lotBuy,
        investedAmount: lot.investedAmount || 0,
        currentPrice: lot.currentPrice || 0,
      });
      pos.totalUnits    += lotUnits;
      pos.totalCostBasis += lotUnits * lotBuy;
    });

    // Compute derived position fields
    const positions = Object.values(posMap).map((pos) => {
      const avgCost     = pos.totalUnits > 0 ? pos.totalCostBasis / pos.totalUnits : 0;
      // Use the current price from the most recently updated lot
      const latestLot   = pos.lots.slice().sort((a, b) => (b.buyDate || 0) > (a.buyDate || 0) ? 1 : -1)[0];
      const currentPrice = latestLot?.currentPrice || 0;
      const currentValue = pos.totalUnits * currentPrice;
      const totalInvested = pos.totalCostBasis;
      const unrealisedGain = currentPrice > 0 ? currentValue - totalInvested : 0;
      const returnPct    = totalInvested > 0 && currentPrice > 0
        ? ((currentValue - totalInvested) / totalInvested) * 100 : 0;

      return {
        symbol:         pos.symbol,
        exchange:       pos.exchange,
        name:           pos.name,
        type:           pos.type,
        lotCount:       pos.lots.length,
        totalUnits:     Math.round(pos.totalUnits * 1000) / 1000,
        avgCost:        Math.round(avgCost * 100) / 100,
        totalInvested:  Math.round(totalInvested * 100) / 100,
        currentPrice,
        currentValue:   Math.round(currentValue * 100) / 100,
        unrealisedGain: Math.round(unrealisedGain * 100) / 100,
        returnPct:      Math.round(returnPct * 100) / 100,
        lots:           pos.lots,
      };
    }).sort((a, b) => Math.abs(b.unrealisedGain) - Math.abs(a.unrealisedGain));

    const totalInvested   = positions.reduce((s, p) => s + p.totalInvested, 0);
    const totalCurrentVal = positions.reduce((s, p) => s + p.currentValue, 0);

    res.json({
      success: true,
      data: positions,
      count: positions.length,
      summary: {
        totalPositions: positions.length,
        totalUnderlyingLots: lots.length,
        totalInvested:   Math.round(totalInvested * 100) / 100,
        totalCurrentValue: Math.round(totalCurrentVal * 100) / 100,
        totalUnrealisedGain: Math.round((totalCurrentVal - totalInvested) * 100) / 100,
      },
    });
  } catch (err) {
    console.error("Get positions error:", err);
    res.status(500).json({ success: false, message: "Server error fetching positions." });
  }
});

// -- GET /api/portfolio/transactions ---------------------------------------
router.get("/transactions", async (req, res) => {
  try {
    const { investmentId, limit = 100 } = req.query;
    const filter = { userId: req.user._id };
    if (investmentId) filter.investmentId = investmentId;

    const transactions = await Transaction.find(filter)
      .sort({ sellDate: -1, createdAt: -1 })
      .limit(Number(limit));

    const totalRealizedProfit = transactions.reduce((acc, t) => acc + (t.realizedGain || 0), 0);
    const totalProceeds = transactions.reduce((acc, t) => acc + (t.totalProceeds || 0), 0);
    const totalCostBasis = transactions.reduce((acc, t) => acc + (t.units * (t.avgCostBefore || t.buyPrice || 0)), 0);
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
      data: transactions,
      transactions,
      summary,
      count: transactions.length,
    });
  } catch (err) {
    console.error("Get transactions error:", err);
    res.status(500).json({ success: false, message: "Server error fetching transactions." });
  }
});

module.exports = router;


