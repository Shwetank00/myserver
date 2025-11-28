const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = "MY_ADMIN_PASSWORD_123"; // CHANGE THIS! Use this to generate keys.
const LICENSE_FILE = 'licenses.json';

// Optional: Discord Webhook URL to get notifications
// Go to Discord -> Server Settings -> Integrations -> Webhooks -> New Webhook -> Copy URL
const DISCORD_WEBHOOK_URL = ""; 

// Load licenses from file
let licenses = {};
if (fs.existsSync(LICENSE_FILE)) {
    try {
        licenses = JSON.parse(fs.readFileSync(LICENSE_FILE));
    } catch (e) {
        console.error("Error loading licenses", e);
    }
}

function saveLicenses() {
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenses, null, 2));
}

// Helper: Send notification to Discord
async function sendDiscordNotification(message) {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message })
        });
    } catch (e) {
        console.error("Discord Error:", e);
    }
}

// --- ENDPOINTS ---

// 1. GENERATE KEY (Only you call this)
// Usage: Open in browser: https://your-server.com/generate?secret=MY_ADMIN_PASSWORD_123
app.get('/generate', (req, res) => {
    const { secret } = req.query;

    if (secret !== ADMIN_SECRET) {
        return res.status(403).send("Unauthorized");
    }

    const key = "KEY-" + Math.random().toString(36).substring(2, 15).toUpperCase();
    const createdAt = Date.now();
    
    // Store key with creation time
    licenses[key] = { createdAt, active: true };
    saveLicenses();

    res.json({ 
        success: true, 
        key: key, 
        message: "Key generated. Valid for 24 hours.",
        expiresAt: new Date(createdAt + 24 * 60 * 60 * 1000).toLocaleString()
    });
});

// 2. VALIDATE KEY (App calls this)
app.post('/validate', async (req, res) => {
    const { key, machineId } = req.body; // machineId is optional context

    if (!key || !licenses[key]) {
        await sendDiscordNotification(`⚠️ Failed login attempt with invalid key: ${key}`);
        return res.json({ valid: false, message: "Invalid Key" });
    }

    const license = licenses[key];
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    // Check if expired (24 hours)
    if (now - license.createdAt > oneDay) {
        // Optional: Delete expired key to clean up
        // delete licenses[key]; 
        // saveLicenses();
        
        return res.json({ valid: false, message: "License Expired (24h limit reached)" });
    }

    await sendDiscordNotification(`✅ Successful login with key: ${key}`);
    
    return res.json({ valid: true });
});

app.get('/', (req, res) => {
    res.send("Interview Guide Server is Running...");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});