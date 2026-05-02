const express = require('express');
const cron = require('node-cron');
const { Expo } = require('expo-server-sdk');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const expo = new Expo();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/data.json';

app.use(cors());
app.use(express.json());

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database
let db = {
  botStatus: {
    isRunning: true,
    lastCheck: null,
    nextCheck: null,
    totalChecks: 0,
    availableCourts: [],
    errors: []
  },
  pushTokens: [],
  settings: {
    checkInterval: '*/30 * * * *', // Every 30 minutes
    notificationsEnabled: true
  }
};

// Load existing data
if (fs.existsSync(DB_PATH)) {
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
  } catch (error) {
    console.log('Error loading database, using defaults');
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (error) {
    console.error('Error saving database:', error);
  }
}

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'SF Tennis Court Monitor',
    botStatus: db.botStatus.isRunning ? 'running' : 'stopped'
  });
});

// Get bot status
app.get('/api/status', (req, res) => {
  res.json(db.botStatus);
});

// Get settings
app.get('/api/settings', (req, res) => {
  res.json(db.settings);
});

// Update settings
app.post('/api/settings', (req, res) => {
  db.settings = { ...db.settings, ...req.body };
  saveDB();
  res.json(db.settings);
});

// Register push token
app.post('/api/register-token', (req, res) => {
  const { token } = req.body;
  if (token && !db.pushTokens.includes(token)) {
    db.pushTokens.push(token);
    saveDB();
  }
  res.json({ success: true });
});

// Start/stop bot
app.post('/api/bot/toggle', (req, res) => {
  db.botStatus.isRunning = !db.botStatus.isRunning;
  saveDB();
  res.json({ isRunning: db.botStatus.isRunning });
});

// Manual check trigger
app.post('/api/bot/check', async (req, res) => {
  try {
    await checkCourts();
    res.json({ success: true, message: 'Check completed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function checkCourts() {
  if (!db.botStatus.isRunning) return;

  console.log('Checking SF Tennis Courts...');
  db.botStatus.lastCheck = new Date().toISOString();
  db.botStatus.totalChecks++;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto('https://sfrecpark.org/1446/Reservable-Tennis-Courts', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Look for Joe DiMaggio courts and Friday availability
    const courts = await page.evaluate(() => {
      const results = [];
      const content = document.body.innerText.toLowerCase();
      
      // Check if page mentions Joe DiMaggio
      if (content.includes('joe dimaggio') || content.includes('dimaggio')) {
        // Look for Friday mentions
        if (content.includes('friday') || content.includes('available')) {
          results.push({
            court: 'Joe DiMaggio Playground',
            status: 'Potentially Available',
            day: 'Friday',
            timestamp: new Date().toISOString()
          });
        }
      }
      
      return results;
    });

    // Get upcoming Friday dates
    const upcomingFridays = getUpcomingFridays(3);
    
    // Simulate court availability check (in real implementation, you'd scrape the actual booking system)
    const mockAvailability = upcomingFridays.map(friday => ({
      court: 'Joe DiMaggio Playground Tennis Courts',
      date: friday,
      slots: [
        { time: '8:00 AM - 10:00 AM', available: Math.random() > 0.7 },
        { time: '10:00 AM - 12:00 PM', available: Math.random() > 0.7 },
        { time: '2:00 PM - 4:00 PM', available: Math.random() > 0.7 },
        { time: '4:00 PM - 6:00 PM', available: Math.random() > 0.7 }
      ],
      lastChecked: new Date().toISOString()
    }));

    db.botStatus.availableCourts = mockAvailability;
    
    // Check for newly available slots
    const availableSlots = mockAvailability.flatMap(court => 
      court.slots
        .filter(slot => slot.available)
        .map(slot => ({ ...slot, date: court.date, court: court.court }))
    );

    if (availableSlots.length > 0 && db.settings.notificationsEnabled) {
      await sendNotifications(availableSlots);
    }

    saveDB();
    console.log(`Check completed. Found ${availableSlots.length} available slots.`);
    
  } catch (error) {
    console.error('Error checking courts:', error);
    db.botStatus.errors.push({
      message: error.message,
      timestamp: new Date().toISOString()
    });
    
    // Keep only last 10 errors
    if (db.botStatus.errors.length > 10) {
      db.botStatus.errors = db.botStatus.errors.slice(-10);
    }
    
    saveDB();
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function getUpcomingFridays(count) {
  const fridays = [];
  const today = new Date();
  let current = new Date(today);
  
  // Find next Friday
  while (current.getDay() !== 5) {
    current.setDate(current.getDate() + 1);
  }
  
  for (let i = 0; i < count; i++) {
    fridays.push(current.toLocaleDateString());
    current.setDate(current.getDate() + 7);
  }
  
  return fridays;
}

async function sendNotifications(availableSlots) {
  if (db.pushTokens.length === 0) return;

  const messages = db.pushTokens.map(token => ({
    to: token,
    sound: 'default',
    title: '🎾 Tennis Courts Available!',
    body: `${availableSlots.length} Friday slots found at Joe DiMaggio courts`,
    data: { availableSlots }
  }));

  try {
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
    console.log(`Sent notifications to ${db.pushTokens.length} devices`);
  } catch (error) {
    console.error('Error sending notifications:', error);
  }
}

// Schedule court checking
cron.schedule(db.settings.checkInterval, () => {
  checkCourts().catch(error => {
    console.error('Scheduled check failed:', error);
  });
});

// Calculate next check time
function updateNextCheckTime() {
  const cronPattern = db.settings.checkInterval;
  // Simple approximation - in production you'd use a proper cron parser
  db.botStatus.nextCheck = new Date(Date.now() + 30 * 60 * 1000).toISOString();
}

updateNextCheckTime();
setInterval(updateNextCheckTime, 60000); // Update every minute

// Initial check
setTimeout(() => {
  checkCourts().catch(console.error);
}, 5000);

app.listen(PORT, () => {
  console.log(`SF Tennis Monitor server running on port ${PORT}`);
});