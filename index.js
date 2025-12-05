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

// --- MONGODB CONNECTION ---
if (!MONGO_URI) {
  console.error(
    "❌ Fatal Error: MONGO_URI is missing in environment variables."
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
    expires: 86400, // IMPORTANT: 86400 seconds = 24 Hours.
    // MongoDB will auto-delete this document after 24h.
  },
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

// 2. VALIDATE KEY
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

    await sendDiscordNotification(`✅ Successful login with key: ${key}`);
    return res.json({ valid: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ valid: false, message: "Server Error" });
  }
});

app.get("/", (req, res) => {
  res.send("Interview Guide Server is Running with MongoDB...");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
