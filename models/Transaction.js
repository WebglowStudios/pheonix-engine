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
    buyPrice: {
      type: Number,
      default: 0,
    },
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
