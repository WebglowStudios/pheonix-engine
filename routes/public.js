const express = require("express");
const { body, validationResult } = require("express-validator");
const Lead = require("../models/Lead");
const SiteContent = require("../models/SiteContent");
const Service = require("../models/Service");
const Faq = require("../models/Faq");

const router = express.Router();

// --- GET /api/public/content/:key -------------------------------------------
router.get("/content/:key", async (req, res) => {
  try {
    const doc = await SiteContent.findOne({ key: req.params.key }).lean();
    const content = doc ? doc.content : null;
    res.json({
      success: true,
      key: req.params.key,
      content,
      data: { key: req.params.key, content },
    });
  } catch (error) {
    console.error("Public get content error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch content." });
  }
});

// --- GET /api/public/services -----------------------------------------------
router.get("/services", async (req, res) => {
  try {
    const services = await Service.find({ isActive: true })
      .sort({ sort_order: 1 })
      .lean();

    const list = services.map((s) => ({ ...s, id: s._id.toString() }));
    res.json({
      success: true,
      services: list,
      data: { services: list },
    });
  } catch (error) {
    console.error("Public get services error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch services." });
  }
});

// --- GET /api/public/faqs ---------------------------------------------------
router.get("/faqs", async (req, res) => {
  try {
    const faqs = await Faq.find({ isActive: true })
      .sort({ sort_order: 1 })
      .lean();

    const list = faqs.map((f) => ({ ...f, id: f._id.toString() }));
    res.json({
      success: true,
      faqs: list,
      data: { faqs: list },
    });
  } catch (error) {
    console.error("Public get faqs error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch faqs." });
  }
});

// --- POST /api/public/contact -----------------------------------------------
router.post(
  "/contact",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("phone").trim().notEmpty().withMessage("Phone is required"),
    body("email").optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { name, phone, email, services, message, connect_time, source } =
        req.body;

      const lead = await Lead.create({
        name: name.trim(),
        phone: phone.trim(),
        email: (email || "").trim(),
        services: Array.isArray(services) ? services : [],
        message: (message || "").trim(),
        connect_time: (connect_time || "").trim(),
        source: (source || "contact_page").trim(),
        status: "new",
      });

      res.status(201).json({
        success: true,
        message: "Your inquiry has been submitted successfully.",
        leadId: lead._id.toString(),
      });
    } catch (error) {
      console.error("Public contact submit error:", error);
      res.status(500).json({ success: false, message: "Failed to submit inquiry." });
    }
  }
);

module.exports = router;
