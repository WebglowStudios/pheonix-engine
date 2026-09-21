require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const app = express();

// --- Connect to MongoDB Atlas ----------------------------------------------
connectDB();

// --- Start cron jobs (price updater) --------------------------------------
const { startPriceUpdateCron } = require("./jobs/priceUpdater");
startPriceUpdateCron();

// --- Middleware ------------------------------------------------------------
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL || "http://localhost:3000",
      "https://phoenixfiserv.co.in",
    ],
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Routes ---------------------------------------------------------------
app.use("/api/auth", require("./routes/auth"));
app.use("/api/portfolio", require("./routes/portfolio"));
app.use("/api/prices", require("./routes/prices"));

// --- Health check ---------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    message: "Phoenix Engine API is running",
    version: "1.0.0",
    status: "ok",
    cronActive: true,
  });
});

// --- 404 handler ----------------------------------------------------------
app.use("*", (req, res) => {
  res.status(404).json({ success: false, message: "Route not found." });
});

// --- Global error handler -------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error.",
  });
});

// --- Start server ---------------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Phoenix Engine running on http://localhost:${PORT}`);
});
