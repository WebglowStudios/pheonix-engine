const mongoose = require("mongoose");

const ServiceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    icon_name: {
      type: String,
      default: "",
    },
    icon_img: {
      type: String,
      default: "",
    },
    category: {
      type: String,
      default: "growth",
    },
    features: {
      type: [String],
      default: [],
    },
    sort_order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Service", ServiceSchema);
