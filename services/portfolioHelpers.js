/**
 * portfolioHelpers.js
 * 
 * Shared valuation, tax classification, and position consolidation logic.
 * Group multiple purchase lots/tranches of the same product into unified positions
 * while preserving full tranche history (dates, units, buy price, holding days, tax).
 */

// ── 1. Current Value Calculator ──────────────────────────────────────────────
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

// ── 2. Tax Classification & Estimated Tax Calculator (FY 2024-25) ─────────────
function calcTaxInfo(inv, currentValue) {
  const buyDate  = inv.buyDate || inv.sipStartDate || inv.createdAt;
  const today    = new Date();
  const holdingDays = buyDate
    ? Math.floor((today - new Date(buyDate)) / (1000 * 60 * 60 * 24))
    : null;

  const gain     = currentValue - (inv.investedAmount || 0);
  const type     = inv.type || "";

  // Determine LTCG threshold in days per asset class
  let ltcgThresholdDays = 365; // default: equity
  let taxRegime = "equity";    // equity | debt | flat30

  if (["mutual_fund", "sip"].includes(type)) {
    const cat = (inv.category || "").toLowerCase();
    if (cat === "debt") {
      taxRegime = "debt";
      ltcgThresholdDays = Infinity; // always slab
    } else {
      taxRegime = "equity"; // equity MF
      ltcgThresholdDays = 365;
    }
  } else if (["stock", "reit_invit"].includes(type)) {
    taxRegime = "equity";
    ltcgThresholdDays = 365;
  } else if (["fd", "ppf", "epf", "bond", "nps"].includes(type)) {
    taxRegime = "debt";
    ltcgThresholdDays = Infinity;
  } else if (["gold", "aif"].includes(type)) {
    taxRegime = "other";
    ltcgThresholdDays = 730; // 2 years post-Budget 2024
  } else if (type === "crypto") {
    taxRegime = "flat30";
    ltcgThresholdDays = Infinity;
  }

  let taxLabel   = "STCG";
  let taxRate    = null;
  let estimatedTax = 0;

  if (taxRegime === "flat30") {
    taxLabel = "Flat 30%";
    taxRate  = 30;
    estimatedTax = gain > 0 ? Math.round(gain * 0.30) : 0;
  } else if (taxRegime === "debt") {
    taxLabel = "Slab Rate";
    taxRate  = null;
    estimatedTax = null;
  } else {
    // equity / other
    const isLTCG = holdingDays !== null && holdingDays >= ltcgThresholdDays;
    if (isLTCG) {
      taxLabel = "LTCG";
      taxRate  = 12.5;
      estimatedTax = gain > 0 ? Math.round(gain * 0.125) : 0;
    } else {
      taxLabel = "STCG";
      taxRate  = 20; // post-Budget 2024
      estimatedTax = gain > 0 ? Math.round(gain * 0.20) : 0;
    }
  }

  return {
    holdingDays,
    taxLabel,     // "STCG" | "LTCG" | "Slab Rate" | "Flat 30%"
    taxRate,      // number or null
    estimatedTax, // ₹ or null
  };
}

// ── 3. Position Key Generator ────────────────────────────────────────────────
// Determines whether two investment records represent the exact same product/scheme
function getPositionKey(inv) {
  const type     = (inv.type || "").trim().toLowerCase();
  const symbol   = (inv.symbol || "").trim().toUpperCase();
  const exchange = (inv.exchange || "").trim().toUpperCase();
  const name     = (inv.name || "").trim().toLowerCase().replace(/\s+/g, " ");

  // Stocks, REITs, Gold, Crypto with a symbol
  if (symbol && ["stock", "reit_invit", "gold", "crypto"].includes(type)) {
    return `${type}__sym__${symbol}__${exchange}`;
  }

  // Mutual funds, SIPs, fixed income, or unlisted where name identifies the scheme/asset
  return `${type}__name__${name}`;
}

// ── 4. Position Consolidator ─────────────────────────────────────────────────
// Consolidates an array of investment records into unified positions with underlying lots
function consolidateInvestments(rawInvestments) {
  if (!Array.isArray(rawInvestments) || rawInvestments.length === 0) {
    return [];
  }

  const map = new Map();

  for (const raw of rawInvestments) {
    const inv = typeof raw.toObject === "function" ? raw.toObject() : { ...raw };
    const cv  = inv.currentValue !== undefined ? inv.currentValue : calcCurrentValue(inv);
    const tax = inv.taxLabel !== undefined && inv.holdingDays !== undefined
      ? { holdingDays: inv.holdingDays, taxLabel: inv.taxLabel, taxRate: inv.taxRate, estimatedTax: inv.estimatedTax }
      : calcTaxInfo(inv, cv);

    inv.currentValue = cv;
    inv.gain = cv - (inv.investedAmount || 0);
    inv.gainPercent = (inv.investedAmount || 0) > 0 ? (inv.gain / inv.investedAmount) * 100 : 0;
    inv.holdingDays = tax.holdingDays;
    inv.taxLabel = tax.taxLabel;
    inv.taxRate = tax.taxRate;
    inv.estimatedTax = tax.estimatedTax;

    const key = getPositionKey(inv);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(inv);
  }

  const consolidated = [];

  for (const [key, lots] of map.entries()) {
    // Sort lots newest first (by buyDate or sipStartDate or createdAt)
    lots.sort((a, b) => {
      const dateA = new Date(a.buyDate || a.sipStartDate || a.createdAt || 0).getTime();
      const dateB = new Date(b.buyDate || b.sipStartDate || b.createdAt || 0).getTime();
      return dateB - dateA;
    });

    const latestLot = lots[0];
    const oldestLot = lots[lots.length - 1];

    const totalInvested = lots.reduce((sum, l) => sum + (l.investedAmount || 0), 0);
    const totalUnits = lots.reduce((sum, l) => sum + (l.units || 0), 0);
    const totalCurrentValue = lots.reduce((sum, l) => sum + (l.currentValue || 0), 0);
    const totalGain = totalCurrentValue - totalInvested;
    const totalGainPercent = totalInvested > 0 ? (totalGain / totalInvested) * 100 : 0;

    // Position-level weighted average buy cost
    const avgCost = totalUnits > 0 ? totalInvested / totalUnits : (latestLot.buyPrice || 0);

    // Latest price update timestamp
    const lastPriceUpdate = lots.reduce((latest, l) => {
      if (!l.lastPriceUpdate) return latest;
      return !latest || new Date(l.lastPriceUpdate) > new Date(latest) ? l.lastPriceUpdate : latest;
    }, null);

    // Amount-weighted average holding days: sum(holdingDays * investedAmount) / totalInvested
    let totalInvestedWithDays = 0;
    let weightedDaysSum = 0;
    lots.forEach((l) => {
      if (typeof l.holdingDays === "number") {
        const amt = l.investedAmount || 0;
        totalInvestedWithDays += amt;
        weightedDaysSum += l.holdingDays * amt;
      }
    });
    const weightedAvgHoldingDays = totalInvestedWithDays > 0
      ? Math.round(weightedDaysSum / totalInvestedWithDays)
      : (latestLot.holdingDays ?? null);

    // Estimated tax sum across lots
    let totalEstimatedTax = 0;
    let hasEstimatedTax = false;
    lots.forEach((l) => {
      if (typeof l.estimatedTax === "number") {
        totalEstimatedTax += l.estimatedTax;
        hasEstimatedTax = true;
      }
    });

    // Tax label: if all match, use that; if mixed LTCG/STCG, label as Mixed
    const taxLabels = [...new Set(lots.map((l) => l.taxLabel).filter(Boolean))];
    let consolidatedTaxLabel = latestLot.taxLabel || "STCG";
    if (taxLabels.length === 1) {
      consolidatedTaxLabel = taxLabels[0];
    } else if (taxLabels.length > 1) {
      if (taxLabels.includes("LTCG") && taxLabels.includes("STCG")) {
        consolidatedTaxLabel = "Mixed (LTCG/STCG)";
      } else {
        consolidatedTaxLabel = taxLabels.join(" / ");
      }
    }

    const firstBuyDate = oldestLot.buyDate || oldestLot.sipStartDate || oldestLot.createdAt;
    const latestBuyDate = latestLot.buyDate || latestLot.sipStartDate || latestLot.createdAt;

    consolidated.push({
      ...latestLot,
      _id: latestLot._id,
      name: latestLot.name,
      type: latestLot.type,
      symbol: latestLot.symbol || "",
      exchange: latestLot.exchange || "",
      category: latestLot.category || lots.find((l) => l.category)?.category || "",
      folioNumber: latestLot.folioNumber || lots.find((l) => l.folioNumber)?.folioNumber || "",
      institution: latestLot.institution || lots.find((l) => l.institution)?.institution || "",
      notes: latestLot.notes || "",
      units: Math.round(totalUnits * 1000) / 1000,
      buyPrice: Math.round(avgCost * 100) / 100,
      currentPrice: latestLot.currentPrice || 0,
      investedAmount: Math.round(totalInvested * 100) / 100,
      currentValue: Math.round(totalCurrentValue * 100) / 100,
      gain: Math.round(totalGain * 100) / 100,
      gainPercent: Math.round(totalGainPercent * 100) / 100,
      buyDate: latestBuyDate || firstBuyDate,
      firstBuyDate,
      latestBuyDate,
      lastPriceUpdate,
      holdingDays: weightedAvgHoldingDays,
      taxLabel: consolidatedTaxLabel,
      taxRate: latestLot.taxRate,
      estimatedTax: hasEstimatedTax ? Math.round(totalEstimatedTax) : null,
      lotCount: lots.length,
      lots: lots.map((l) => ({
        _id: l._id,
        buyDate: l.buyDate || l.sipStartDate || l.createdAt,
        units: l.units || 0,
        buyPrice: l.buyPrice || 0,
        investedAmount: l.investedAmount || 0,
        currentPrice: l.currentPrice || 0,
        currentValue: l.currentValue,
        gain: l.gain,
        gainPercent: l.gainPercent,
        holdingDays: l.holdingDays,
        taxLabel: l.taxLabel,
        taxRate: l.taxRate,
        estimatedTax: l.estimatedTax,
        notes: l.notes || "",
        folioNumber: l.folioNumber || "",
        createdAt: l.createdAt,
      })),
    });
  }

  return consolidated;
}

module.exports = {
  calcCurrentValue,
  calcTaxInfo,
  getPositionKey,
  consolidateInvestments,
};
