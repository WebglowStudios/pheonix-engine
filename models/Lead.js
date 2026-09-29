const mongoose = require("mongoose");

const LeadSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, "Phone is required"],
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      default: "",
    },
    services: {
      type: [String],
      default: [],
    },
    message: {
      type: String,
      default: "",
    },
    connect_time: {
      type: String,
      default: "",
    },
    source: {
      type: String,
      default: "home_page",
    },
    status: {
      type: String,
      enum: ["new", "read", "contacted"],
      default: "new",
    },
    notes: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Lead", LeadSchema);
