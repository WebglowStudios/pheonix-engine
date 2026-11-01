const mongoose = require("mongoose");

const TransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    investmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Investment",
      required: true,
      index: true,
    },
    investmentName: {
      type: String,
      required: true,
      trim: true,
    },
    // ── Position identity ──────────────────────────────────────────────────
    // symbol + exchange identify which position this sell belongs to.
    // Allows grouping multiple lots into a single open position.
    symbol: { type: String, default: "", trim: true },
    exchange: { type: String, default: "", trim: true },

    type: {
      type: String,
      enum: ["sell", "buy", "sip", "dividend"],
      default: "sell",
    },
    units: {
      type: Number,
      required: true,
    },
    price: {
      type: Number,
      required: true,
    },
    // buyPrice on the specific lot that was sold
    buyPrice: {
      type: Number,
      default: 0,
    },
    // ── Position-level cost basis ──────────────────────────────────────────
    // Weighted average cost across ALL open lots for this symbol at sell time.
    // This is what the client's logic requires:
    //   realizedGain = unitsSold × (sellPrice − avgCostBefore)
    avgCostBefore: { type: Number, default: 0 },

    totalProceeds: {
      type: Number,
      required: true,
    },
    realizedGain: {
      type: Number,
      default: 0,
    },
    realizedGainPercent: {
      type: Number,
      default: 0,
    },
    capitalRecovered: {
      type: Number,
      default: 0,
    },
    isFreeShares: {
      type: Boolean,
      default: false,
    },
    // ── Open position AFTER this sell ─────────────────────────────────────
    // Total remaining qty across ALL active lots for this symbol after the sell.
    openQtyAfter: { type: Number, default: 0 },
    // Average cost of the remaining open position (unchanged by a sell).
    avgCostAfter: { type: Number, default: 0 },

    // Legacy single-lot remaining fields (kept for backward compat)
    remainingUnits: {
      type: Number,
      default: 0,
    },
    remainingValue: {
      type: Number,
      default: 0,
    },
    sellDate: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Transaction", TransactionSchema);
