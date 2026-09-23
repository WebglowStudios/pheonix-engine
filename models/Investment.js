const mongoose = require("mongoose");

const InvestmentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // -- Core -------------------------------------------------------------
    type: {
      type: String,
      required: [true, "Investment type is required"],
      enum: ["stock", "mutual_fund", "sip", "ppf", "epf", "fd", "nps", "bond", "gold", "crypto", "reit_invit", "aif"],
    },
    transactionType: {
      type: String,
      enum: ["buy", "sell", "sip", "swp", "stp", "switch"],
      default: "buy",
    },
    folioNumber: {
      type: String,
      default: "",
      trim: true,
    },
    name: {
      type: String,
      required: [true, "Investment name is required"],
      trim: true,
    },

    // -- Market assets (stock, mutual_fund, gold, crypto, reit_invit) -----
    symbol: { type: String, default: "", trim: true },   // e.g. RELIANCE, GC=F
    exchange: { type: String, default: "", trim: true }, // NSE / BSE
    units: { type: Number, default: 0 },
    buyPrice: { type: Number, default: 0 },  // per-unit price / NAV at purchase
    buyDate: { type: Date },

    // -- SIP specific -----------------------------------------------------
    sipAmount: { type: Number, default: 0 },   // monthly ? amount
    sipStartDate: { type: Date },
    instalments: { type: Number, default: 0 }, // no. of SIP instalments done
    avgNav: { type: Number, default: 0 },       // average NAV for SIP

    // -- Fixed income (FD, PPF, EPF, NPS, Bond) ---------------------------
    principal: { type: Number, default: 0 },
    interestRate: { type: Number, default: 0 }, // % p.a.
    maturityDate: { type: Date },
    tenureMonths: { type: Number, default: 0 },
    institution: { type: String, default: "", trim: true },

    // -- Computed / cached -------------------------------------------------
    // investedAmount is ALWAYS stored explicitly on save
    investedAmount: { type: Number, required: true, default: 0 },
    // currentPrice is populated in Stage 3 (live API)
    currentPrice: { type: Number, default: 0 },
    lastPriceUpdate: { type: Date },

    // -- Meta --------------------------------------------------------------
    notes: { type: String, default: "", trim: true },
    tags: [{ type: String, trim: true }],
  },
  { timestamps: true }
);

// Helper: compute estimated current value for fixed-income assets
InvestmentSchema.methods.estimatedValue = function () {
  const fixedTypes = ["fd", "ppf", "epf", "nps", "bond"];
  if (!fixedTypes.includes(this.type)) return this.investedAmount;
  const refDate = this.buyDate || this.sipStartDate || this.createdAt;
  if (!refDate || !this.interestRate) return this.principal || this.investedAmount;
  const years = (Date.now() - new Date(refDate).getTime()) / (365.25 * 24 * 3600 * 1000);
  return (this.principal || this.investedAmount) * (1 + (this.interestRate / 100) * years);
};

module.exports = mongoose.model("Investment", InvestmentSchema);
