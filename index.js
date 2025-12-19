require("dotenv").config(); // Load environment variables
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "MY_ADMIN_PASSWORD_123";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const MONGO_URI = process.env.MONGO_URI; // You must set this in Render!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // ADD THIS to your Render environment variables

// --- MONGODB CONNECTION ---
if (!MONGO_URI) {
  console.error(
    "❌ Fatal Error: MONGO_URI is missing in environment variables."
  );
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error(
    "❌ Fatal Error: GEMINI_API_KEY is missing in environment variables."
  );
  process.exit(1);
}

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// --- MONGODB SCHEMA ---
const licenseSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400, // 86400 seconds = 24 Hours
  },
  // Optional: Track usage
  lastUsed: { type: Date },
  usageCount: { type: Number, default: 0 },
});

const License = mongoose.model("License", licenseSchema);

// --- HELPER FUNCTIONS ---
async function sendDiscordNotification(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch (e) {
    console.error("Discord Error:", e);
  }
}

// --- ENDPOINTS ---

// 1. GENERATE KEY
app.get("/generate", async (req, res) => {
  const { secret } = req.query;

  if (secret !== ADMIN_SECRET) {
    return res.status(403).send("Unauthorized");
  }

  const key =
    "KEY-" + Math.random().toString(36).substring(2, 15).toUpperCase();

  try {
    // Save to MongoDB
    const newLicense = new License({ key: key });
    await newLicense.save();

    await sendDiscordNotification(`🔑 New license generated: ${key}`);

    res.json({
      success: true,
      key: key,
      message: "Key generated. It will automatically expire in 24 hours.",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Database Error" });
  }
});

// 2. VALIDATE KEY (Updated to return Gemini API Key)
app.post("/validate", async (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.json({ valid: false, message: "No key provided" });
  }

  try {
    // Find key in MongoDB
    const license = await License.findOne({ key: key });

    // If license is null, it either never existed OR MongoDB already auto-deleted it
    if (!license) {
      await sendDiscordNotification(`⚠️ Failed login attempt: ${key}`);
      return res.json({ valid: false, message: "Invalid or Expired Key" });
    }

    // Update usage tracking (optional)
    license.lastUsed = new Date();
    license.usageCount += 1;
    await license.save();

    // Calculate expiry time
    const expiresAt = new Date(license.createdAt.getTime() + 86400 * 1000);
    const hoursRemaining = Math.max(
      0,
      Math.floor((expiresAt - new Date()) / (1000 * 60 * 60))
    );

    await sendDiscordNotification(
      `✅ Successful login with key: ${key} (${hoursRemaining}h remaining, ${license.usageCount} total uses)`
    );

    // IMPORTANT: Return the Gemini API key to the client
    return res.json({
      valid: true,
      geminiApiKey: GEMINI_API_KEY, // Send API key after validation
      expiresAt: expiresAt.toISOString(),
      hoursRemaining: hoursRemaining,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ valid: false, message: "Server Error" });
  }
});

// 3. LIST ALL ACTIVE KEYS (Admin only)
app.get("/list", async (req, res) => {
  const { secret } = req.query;

  if (secret !== ADMIN_SECRET) {
    return res.status(403).send("Unauthorized");
  }

  try {
    const licenses = await License.find({}).sort({ createdAt: -1 });
    const now = new Date();

    const licensesWithExpiry = licenses.map((lic) => {
      const expiresAt = new Date(lic.createdAt.getTime() + 86400 * 1000);
      const hoursRemaining = Math.max(
        0,
        Math.floor((expiresAt - now) / (1000 * 60 * 60))
      );

      return {
        key: lic.key,
        createdAt: lic.createdAt,
        expiresAt: expiresAt,
        hoursRemaining: hoursRemaining,
        usageCount: lic.usageCount || 0,
        lastUsed: lic.lastUsed || null,
      };
    });

    res.json({
      success: true,
      count: licensesWithExpiry.length,
      licenses: licensesWithExpiry,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Database Error" });
  }
});

// 4. DELETE KEY (Admin only - manual deletion)
app.delete("/delete", async (req, res) => {
  const { secret, key } = req.body;

  if (secret !== ADMIN_SECRET) {
    return res.status(403).send("Unauthorized");
  }

  if (!key) {
    return res.status(400).json({ success: false, message: "No key provided" });
  }

  try {
    const result = await License.deleteOne({ key: key });

    if (result.deletedCount === 0) {
      return res.json({ success: false, message: "Key not found" });
    }

    await sendDiscordNotification(`🗑️ License manually deleted: ${key}`);
    res.json({ success: true, message: "Key deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Database Error" });
  }
});

app.get("/", (req, res) => {
  res.send("Interview Guide Server is Running with MongoDB ✅");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(
    `🔑 Gemini API Key: ${GEMINI_API_KEY ? "Configured ✅" : "Missing ❌"}`
  );
  console.log(`📊 MongoDB: ${MONGO_URI ? "Configured ✅" : "Missing ❌"}`);
  console.log(
    `💬 Discord Webhook: ${
      DISCORD_WEBHOOK_URL ? "Configured ✅" : "Not configured"
    }`
  );
});
