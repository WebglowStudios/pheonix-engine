const express = require("express");
const { protect } = require("../middleware/auth");
const {
  updatePricesForUser,
  lookupStockPrice,
  lookupMFNav,
  fetchCryptoPrice,
  fetchGoldPriceINR,
} = require("../services/priceService");

const router = express.Router();

// Simple in-memory cooldown: userId -> last refresh timestamp
const refreshCooldown = new Map();
const COOLDOWN_SECONDS = 60;

// All routes require auth
router.use(protect);

// -- POST /api/prices/refresh ---------------------------------------------
// Refresh live prices for the logged-in user's portfolio
router.post("/refresh", async (req, res) => {
  try {
    const result = await updatePricesForUser(req.user._id);
    res.json({
      success: true,
      message: `Refreshed ${result.updated.length} of ${result.total} investments.`,
      updated: result.updated.length,
      failed: result.failed.length,
      details: result,
    });
  } catch (err) {
    console.error("Price refresh error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// -- GET /api/prices/stock/:symbol?exchange=NSE ----------------------------
// Live price lookup for a stock (used in Add Investment form)
router.get("/stock/:symbol", async (req, res) => {
  const { symbol } = req.params;
  const { exchange = "NSE" } = req.query;
  try {
    const price = await lookupStockPrice(symbol, exchange);
    if (!price) return res.status(404).json({ success: false, message: "Price not found. Check ticker symbol." });
    res.json({ success: true, symbol, exchange, price });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -- GET /api/prices/mf/:amfiCode -----------------------------------------
// Latest NAV for a mutual fund / SIP (used in Add Investment form)
router.get("/mf/:amfiCode", async (req, res) => {
  const { amfiCode } = req.params;
  try {
    const nav = await lookupMFNav(amfiCode);
    if (!nav) return res.status(404).json({ success: false, message: "NAV not found. Check AMFI scheme code." });
    res.json({ success: true, amfiCode, nav });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -- GET /api/prices/gold --------------------------------------------------
// Current gold price in INR per gram
router.get("/gold", async (req, res) => {
  try {
    const pricePerGram = await fetchGoldPriceINR();
    if (!pricePerGram) return res.status(404).json({ success: false, message: "Gold price unavailable." });
    res.json({ success: true, pricePerGram, unit: "INR/gram" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -- GET /api/prices/crypto/:symbol ---------------------------------------
// Crypto price in INR via CoinGecko
router.get("/crypto/:symbol", async (req, res) => {
  const { symbol } = req.params;
  try {
    const price = await fetchCryptoPrice(symbol);
    if (!price) return res.status(404).json({ success: false, message: "Crypto price not found." });
    res.json({ success: true, symbol, price, currency: "INR" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

