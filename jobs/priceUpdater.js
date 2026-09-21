/**
 * priceUpdater.js
 * Cron job: runs every weekday at 4:00 PM IST (after NSE market close)
 * and refreshes prices for ALL users' market investments.
 */

const cron = require("node-cron");
const { updatePricesForUser } = require("../services/priceService");

function startPriceUpdateCron() {
  // 4:00 PM IST = 10:30 AM UTC (IST is UTC+5:30)
  // Cron: minute hour day month weekday
  cron.schedule(
    "30 10 * * 1-5",
    async () => {
      const ts = new Date().toISOString();
      console.log(`[${ts}] [Cron] Starting daily price update for all users...`);
      try {
        // Pass null to update ALL users
        const result = await updatePricesForUser(null);
        console.log(
          `[Cron] Done — Updated: ${result.updated.length}, Failed: ${result.failed.length}, Total: ${result.total}`
        );
        if (result.failed.length > 0) {
          console.warn("[Cron] Failed investments:", result.failed.map((f) => `${f.name} (${f.reason})`).join(", "));
        }
      } catch (err) {
        console.error("[Cron] Price update error:", err.message);
      }
    },
    { timezone: "Asia/Kolkata" }
  );

  console.log("[Cron] Daily price update scheduled ? 4:00 PM IST, Mon–Fri");
}

module.exports = { startPriceUpdateCron };
