const mongoose = require("mongoose");

const PriceHistoryEntrySchema = new mongoose.Schema(
  {
    price:     { type: Number, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    source:    { type: String, default: "manual_admin" },
    notes:     { type: String, default: "", trim: true },
  },
  { timestamps: true, _id: true }
);

const ProductPriceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
      index: true,
    },
    symbol: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      index: true,
    },
    type: {
      type: String,
      default: "stock",
      trim: true,
    },
    exchange: {
      type: String,
      default: "",
      trim: true,
    },
    price: {
      type: Number,
      required: [true, "Price is required"],
      min: [0, "Price must be positive"],
    },
    previousPrice: {
      type: Number,
      default: 0,
    },
    source: {
      type: String,
      enum: ["manual_admin", "excel_upload", "api_sync"],
      default: "manual_admin",
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
    // ── Regular Update Tracking ──────────────────────────────────────────
    // How many days before this price is considered stale (default 30).
    // Admin can override per product (e.g. 7 for weekly-priced AIFs,
    // 90 for quarterly-valued private equity).
    staleAfterDays: {
      type: Number,
      default: 30,
      min: 1,
    },
    // Full chronological price history — every update logged here.
    // Used to show sparklines and audit trails on the admin prices page.
    priceHistory: [PriceHistoryEntrySchema],
  },
  { timestamps: true }
);

// Compound index for fast matching
ProductPriceSchema.index({ symbol: 1, name: 1 });

// Virtual: how many days since this price was last updated
ProductPriceSchema.virtual("daysSinceUpdate").get(function () {
  if (!this.lastUpdated) return null;
  return Math.floor((Date.now() - new Date(this.lastUpdated).getTime()) / (1000 * 60 * 60 * 24));
});

// Virtual: is this price considered stale?
ProductPriceSchema.virtual("isStale").get(function () {
  const days = this.daysSinceUpdate;
  if (days === null) return false;
  return days >= (this.staleAfterDays || 30);
});

module.exports = mongoose.model("ProductPrice", ProductPriceSchema);
