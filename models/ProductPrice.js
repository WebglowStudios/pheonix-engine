const mongoose = require("mongoose");

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
  },
  { timestamps: true }
);

// Compound index for fast matching
ProductPriceSchema.index({ symbol: 1, name: 1 });

module.exports = mongoose.model("ProductPrice", ProductPriceSchema);
