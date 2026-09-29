const mongoose = require("mongoose");

const SiteContentSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: [true, "Content key is required"],
      unique: true,
      trim: true,
      index: true,
    },
    content: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("SiteContent", SiteContentSchema);
