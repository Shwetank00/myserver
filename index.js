require("dotenv").config(); // Load environment variables
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "MY_ADMIN_PASSWORD_123";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const MONGO_URI = process.env.MONGO_URI; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

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

  // Generate cryptographically secure random 16 character key
  const randomPart = crypto.randomBytes(8).toString("hex").toUpperCase();
  const key = `KEY-${randomPart}`;

  try {
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

// 2. VALIDATE KEY (Client check)
// Secure version: No longer returns raw GEMINI_API_KEY to client
app.post("/validate", async (req, res) => {
  const { key } = req.body;

  if (!key) return res.json({ valid: false, message: "No key provided" });

  try {
    const license = await License.findOne({ key: key });
    const now = new Date();

    if (!license) {
      await sendDiscordNotification(`⚠️ Failed login attempt: ${key}`);
      return res.json({ valid: false, message: "Invalid or Expired Key" });
    }

    const expiresAt = new Date(license.createdAt.getTime() + 86400 * 1000);
    
    // Strict gap check (MongoDB TTL can take 60s+ to trigger)
    if (now > expiresAt) {
      return res.json({ valid: false, message: "Invalid or Expired Key" });
    }

    license.lastUsed = now;
    license.usageCount += 1;
    await license.save();

    const hoursRemaining = Math.max(0, Math.floor((expiresAt - now) / (1000 * 60 * 60)));

    await sendDiscordNotification(
      `✅ Successful login with key: ${key} (${hoursRemaining}h remaining, ${license.usageCount} total uses)`
    );

    return res.json({
      valid: true,
      expiresAt: expiresAt.toISOString(),
      hoursRemaining: hoursRemaining,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ valid: false, message: "Server Error" });
  }
});

// 2.5. GEMINI API PROXY
// Protects your real API Key. Forward all /v1 and /v1beta traffic to Google safely.
app.use(['/v1', '/v1beta'], async (req, res) => {
  // Client passes their LICENSE KEY as the api key via header or query
  const providedKey = req.query.key || req.headers["x-goog-api-key"];

  if (!providedKey) {
    return res.status(401).json({ error: { message: "API key not valid. Please pass a valid API key." } });
  }

  try {
    const license = await License.findOne({ key: providedKey });
    const now = new Date();

    if (!license) {
      return res.status(403).json({ error: { message: "Invalid or expired license key." } });
    }
    
    const expiresAt = new Date(license.createdAt.getTime() + 86400 * 1000);
    if (now > expiresAt) {
      return res.status(403).json({ error: { message: "License key has expired." } });
    }

    // Unblocking usage update
    license.lastUsed = now;
    license.usageCount += 1;
    license.save().catch(err => console.error("Proxy usage update error:", err));

    // Construct Google API URL using req.originalUrl to keep exact path and queries
    const urlObj = new URL(`https://generativelanguage.googleapis.com${req.originalUrl}`);
    
    // SECURITY: Replace the client's license key with the server's real GEMINI_API_KEY
    urlObj.searchParams.set("key", GEMINI_API_KEY);

    const fetchOptions = {
      method: req.method,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/json",
      },
      // Include body for POST/PUT/PATCH
      ...(req.method !== "GET" && req.method !== "HEAD" && { body: JSON.stringify(req.body) })
    };

    const response = await fetch(urlObj.toString(), fetchOptions);
    
    // Pass Google's identical headers and status back to the client
    res.status(response.status);
    response.headers.forEach((value, header) => {
      // Exclude problematic headers
      if (header.toLowerCase() !== 'content-encoding') {
         res.setHeader(header, value);
      }
    });

    // Stream response chunks for native SSE compatibility (streamGenerateContent)
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      res.end();
    }
  } catch (error) {
    console.error("Proxy error:", error);
    res.status(500).json({ error: { message: "Internal server proxy error" } });
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
  // Refactored to req.query since DELETE body is frequently stripped by HTTP clients
  const { secret, key } = req.query;

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
  res.send("Interview Guide Server is Running with Proxy & MongoDB ✅");
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
