/**
 * priceService.js
 * Fetches live prices from:
 *   - Yahoo Finance  (stocks, gold, ETFs)
 *   - mfapi.in      (mutual fund / SIP NAV - free AMFI mirror)
 *   - CoinGecko     (crypto, no API key needed)
 */

const axios = require("axios");
const yahooFinance = require("yahoo-finance2").default;
const Investment = require("../models/Investment");

// Helper
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// -- Yahoo Finance (via yahoo-finance2) -------------------------------------
async function fetchYahooPrice(symbol) {
  try {
    // Use the scraper-free quote API through yahoo-finance2
    const yf = require("yahoo-finance2").default;
    const quote = await yf.quote(symbol, {}, { validateResult: false });
    const price = quote?.regularMarketPrice ?? quote?.price?.regularMarketPrice;
    return typeof price === "number" ? price : null;
  } catch (err) {
    console.warn(`[Yahoo] ${symbol}: ${err.message}`);
    return null;
  }
}

// -- AMFI NAV via mfapi.in ---------------------------------------------------
async function fetchMFNav(amfiCode) {
  try {
    const res = await axios.get(`https://api.mfapi.in/mf/${amfiCode}`, {
      timeout: 8000,
    });
    const latest = res.data?.data?.[0];
    if (!latest) return null;
    return parseFloat(latest.nav);
  } catch (err) {
    console.warn(`[AMFI] ${amfiCode}: ${err.message}`);
    return null;
  }
}

// -- CoinGecko (free, no API key) --------------------------------------------
const COINGECKO_MAP = {
  BTC: "bitcoin", ETH: "ethereum", BNB: "binancecoin",
  MATIC: "matic-network", POLYGON: "matic-network",
  SOL: "solana", XRP: "ripple", ADA: "cardano",
  DOGE: "dogecoin", DOT: "polkadot", AVAX: "avalanche-2",
  LINK: "chainlink", UNI: "uniswap", ATOM: "cosmos",
  LTC: "litecoin", TRX: "tron", SHIB: "shiba-inu",
};

function coinGeckoId(symbol) {
  if (!symbol) return null;
  return COINGECKO_MAP[symbol.toUpperCase()] || symbol.toLowerCase();
}

async function fetchCryptoPrice(symbol) {
  const id = coinGeckoId(symbol);
  if (!id) return null;
  try {
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=inr`,
      { timeout: 8000 }
    );
    return res.data?.[id]?.inr ?? null;
  } catch (err) {
    console.warn(`[CoinGecko] ${symbol}: ${err.message}`);
    return null;
  }
}

// -- Gold price in INR/gram via Yahoo Finance --------------------------------
async function fetchGoldPriceINR() {
  try {
    const [goldUSD, usdInr] = await Promise.all([
      fetchYahooPrice("GC=F"),   // Gold futures USD/troy-oz
      fetchYahooPrice("INR=X"),  // USD ? INR exchange rate
    ]);
    if (!goldUSD || !usdInr) return null;
    // 1 troy oz = 31.1035 grams
    return (goldUSD * usdInr) / 31.1035;
  } catch (err) {
    console.warn(`[Gold] ${err.message}`);
    return null;
  }
}

// -- Build Yahoo Finance symbol ----------------------------------------------
function yahooSymbol(symbol, exchange) {
  if (!symbol) return null;
  const s = symbol.toUpperCase().trim();
  if (s.includes(".")) return s; // already qualified (e.g. RELIANCE.NS)
  const suffix = exchange === "BSE" ? ".BO" : ".NS"; // NSE default
  return s + suffix;
}

// -- Core: update prices for one user (or all users when userId = null) ------
async function updatePricesForUser(userId) {
  const filter = {
    type: { $in: ["stock", "mutual_fund", "sip", "gold", "crypto"] },
  };
  if (userId) filter.userId = userId;

  const investments = await Investment.find(filter);
  const updated = [];
  const failed = [];

  // Cache gold price (only fetch once per run)
  let goldPriceINR = null;
  const needsGold = investments.some((i) => i.type === "gold" && !i.symbol?.includes("."));
  if (needsGold) {
    goldPriceINR = await fetchGoldPriceINR();
    await delay(300);
  }

  for (const inv of investments) {
    let price = null;

    try {
      if (inv.type === "stock") {
        const ys = yahooSymbol(inv.symbol, inv.exchange);
        if (ys) price = await fetchYahooPrice(ys);
      } else if (inv.type === "mutual_fund" || inv.type === "sip") {
        if (inv.symbol) price = await fetchMFNav(inv.symbol);
      } else if (inv.type === "gold") {
        if (inv.symbol && inv.symbol !== "GOLD" && inv.symbol !== "GC=F") {
          // e.g. GOLDBEES.NS or custom ETF
          price = await fetchYahooPrice(
            inv.symbol.includes(".") ? inv.symbol : inv.symbol + ".NS"
          );
        } else {
          price = goldPriceINR; // already fetched above
        }
      } else if (inv.type === "crypto") {
        price = await fetchCryptoPrice(inv.symbol);
      }

      if (price !== null && price > 0) {
        inv.currentPrice = price;
        inv.lastPriceUpdate = new Date();
        await inv.save();
        updated.push({ id: inv._id, name: inv.name, type: inv.type, price });
      } else {
        failed.push({ id: inv._id, name: inv.name, reason: "No price returned" });
      }
    } catch (err) {
      failed.push({ id: inv._id, name: inv.name, reason: err.message });
    }

    await delay(400); // rate-limit requests
  }

  return { updated, failed, total: investments.length };
}

// -- Quick single-symbol lookups (used by price route for UI helpers) ---------
async function lookupStockPrice(symbol, exchange) {
  const ys = yahooSymbol(symbol, exchange);
  if (!ys) return null;
  return await fetchYahooPrice(ys);
}

async function lookupMFNav(amfiCode) {
  return await fetchMFNav(amfiCode);
}

module.exports = {
  updatePricesForUser,
  lookupStockPrice,
  lookupMFNav,
  fetchCryptoPrice,
  fetchGoldPriceINR,
};

