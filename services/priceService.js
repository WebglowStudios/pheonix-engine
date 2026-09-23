/**
 * priceService.js
 * Fetches live prices from:
 *   - Yahoo Finance  (stocks, gold, ETFs)
 *   - mfapi.in      (mutual fund / SIP NAV - free AMFI mirror)
 *   - CoinGecko     (crypto, no API key needed)
 */

const axios = require("axios");
const YahooFinanceClass = require("yahoo-finance2").default;
const yf = typeof YahooFinanceClass === "function" ? new YahooFinanceClass() : YahooFinanceClass;
const Investment = require("../models/Investment");

// Helper
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Simple in-memory cache for search queries (10 minute TTL)
const searchCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCached(key) {
  const item = searchCache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data) {
  if (searchCache.size > 500) searchCache.clear();
  searchCache.set(key, { time: Date.now(), data });
}

// -- Yahoo Finance (via yahoo-finance2) -------------------------------------
async function fetchYahooPrice(symbol) {
  try {
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

// -- Search Stocks / Equities via Yahoo Finance ----------------------------
async function searchStocks(query) {
  if (!query || query.trim().length < 2) return [];
  const q = query.trim();
  const cacheKey = `stock:${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await yf.search(q, { newsCount: 0 });
    const quotes = (res.quotes || []).filter(
      (item) => item.quoteType === "EQUITY" || item.quoteType === "ETF"
    );

    // Prefer Indian symbols (.NS or .BO) or keep others if not available
    const indianQuotes = quotes.filter(
      (item) => item.symbol && (item.symbol.endsWith(".NS") || item.symbol.endsWith(".BO"))
    );
    const candidateList = indianQuotes.length > 0 ? indianQuotes : quotes;

    const results = candidateList.slice(0, 8).map((item) => {
      let exchange = "NSE";
      let cleanSymbol = item.symbol || "";
      if (cleanSymbol.endsWith(".NS")) {
        exchange = "NSE";
        cleanSymbol = cleanSymbol.replace(".NS", "");
      } else if (cleanSymbol.endsWith(".BO")) {
        exchange = "BSE";
        cleanSymbol = cleanSymbol.replace(".BO", "");
      } else if (item.exchange === "BSE") {
        exchange = "BSE";
      }

      return {
        name: item.longname || item.shortname || cleanSymbol,
        symbol: cleanSymbol,
        fullSymbol: item.symbol,
        exchange,
        type: "stock",
      };
    });

    setCached(cacheKey, results);
    return results;
  } catch (err) {
    console.warn(`[Yahoo Search] "${q}": ${err.message}`);
    return [];
  }
}

// -- Search Mutual Funds / SIP via mfapi.in ---------------------------------
async function searchMutualFunds(query) {
  if (!query || query.trim().length < 2) return [];
  const q = query.trim();
  const cacheKey = `mf:${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await axios.get(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`, {
      timeout: 9000,
    });
    const items = Array.isArray(res.data) ? res.data : [];
    const results = items.slice(0, 10).map((item) => ({
      name: item.schemeName,
      symbol: String(item.schemeCode),
      code: String(item.schemeCode),
      type: "mutual_fund",
    }));

    setCached(cacheKey, results);
    return results;
  } catch (err) {
    console.warn(`[AMFI Search] "${q}": ${err.message}`);
    return [];
  }
}

// -- Search Crypto via CoinGecko --------------------------------------------
async function searchCrypto(query) {
  if (!query || query.trim().length < 2) return [];
  const q = query.trim();
  const cacheKey = `crypto:${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await axios.get(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`, {
      timeout: 8000,
    });
    const coins = Array.isArray(res.data?.coins) ? res.data.coins : [];
    const results = coins.slice(0, 8).map((c) => ({
      name: c.name,
      symbol: (c.symbol || "").toUpperCase(),
      id: c.id,
      type: "crypto",
    }));

    setCached(cacheKey, results);
    return results;
  } catch (err) {
    console.warn(`[CoinGecko Search] "${q}": ${err.message}`);
    return [];
  }
}

module.exports = {
  updatePricesForUser,
  lookupStockPrice,
  lookupMFNav,
  fetchCryptoPrice,
  fetchGoldPriceINR,
  searchStocks,
  searchMutualFunds,
  searchCrypto,
};

