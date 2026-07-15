require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path'); 
const { randomUUID } = require('crypto');
const { Server } = require('socket.io');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json()); 
app.use(express.static('public'));

const API_KEY = process.env.GOOGLE_API_KEY;
const sheets = google.sheets({ version: 'v4', auth: API_KEY });
const MASTER_SHEET_ID = '1yUkt9j49mT9xGHS0BnaIO488segTr1q0B8TXbS5m7UM';

let cachedData = {
    totalStock: '0%',
    trailerList: [],
    lastUpdated: 'Waiting for sync...'
};

async function syncWithGoogle() {
    try {
        console.log('Fetching fresh data from Google Sheets...');
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            // Expanded range to include Column I
            range: 'Sheet1!A2:I100'
        });

        const rows = response.data.values || [];
        // Total Stock shifted to Column I (index 8)
        const globalStock = rows.length > 0 && rows[0][8] ? rows[0][8] : '0%';
        
        const trailers = rows
            .map(row => ({
                id: row[0] || '',
                type: row[1] || '',
                date: row[2] || '',
                receiveProgress: row[3] || '0%',
                installProgress: row[4] || '0%',
                cuttingProgress: row[5] || '0%',     // NEW: Column F
                bendingProgress: row[6] || '0%',     // NEW: Column G
                completionProgress: row[7] || '0%'   // SHIFTED: Column H
            }))
            .filter(trailer => trailer.id !== '');
            
        cachedData = {
            totalStock: globalStock,
            trailerList: trailers,
            lastUpdated: new Date().toLocaleTimeString('en-ZA', {
                timeZone: 'Africa/Johannesburg'
            })
        };
        console.log('Sync complete!');
    } catch (error) {
        console.error('Error fetching data:', error.message);
    }
}

syncWithGoogle();
setInterval(syncWithGoogle, 120000);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) {
            res.sendFile(path.join(__dirname, 'index.html'), (err2) => {
                if (err2) {
                    res.status(404).send("Could not find index.html. Ensure index.html is uploaded in your GitHub repository!");
                }
            });
        }
    });
});

app.get('/api/trailers', (req, res) => {
    res.json(cachedData);
});

app.post('/api/qa-report', async (req, res) => {
    const { trailerId, issue } = req.body;
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: MASTER_SHEET_ID,
            range: "'QA Issues'!A:C", 
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[new Date().toLocaleString('en-ZA'), trailerId, issue]] }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Error writing to sheet:', error);
        res.status(500).json({ success: false });
    }
});

// ---------------------------------------------------------------------------
// Live team chat
// ---------------------------------------------------------------------------

const CHAT_HISTORY_LIMIT = 100;
const chatHistory = [];

function cleanName(value) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 30); }
function cleanMessage(value) { return String(value || '').trim().slice(0, 500); }
function getOnlineUsers() {
    return [...io.sockets.sockets.values()]
        .map(socket => socket.data.username)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}
function broadcastOnlineUsers() { io.emit('online-users', getOnlineUsers()); }
function nameIsInUse(username, currentSocketId) {
    const wantedName = username.toLowerCase();
    return [...io.sockets.sockets.values()].some(socket => (
        socket.id !== currentSocketId &&
        socket.data.username &&
        socket.data.username.toLowerCase() === wantedName
    ));
}

io.on('connection', socket => {
    socket.on('join-chat', (rawName, reply) => {
        const username = cleanName(rawName);
        const respond = typeof reply === 'function' ? reply : () => {};

        if (username.length < 2) { respond({ ok: false, error: 'Enter a name with at least 2 characters.' }); return; }
        if (nameIsInUse(username, socket.id)) { respond({ ok: false, error: 'That name is already being used. Add your surname or initial.' }); return; }

        const isFirstJoin = !socket.data.username;
        socket.data.username = username;
        socket.data.lastMessageAt = 0;

        socket.emit('chat-history', chatHistory);
        respond({ ok: true, username });

        if (isFirstJoin) {
            socket.broadcast.emit('system-message', {
                text: `${username} joined the chat`,
                timestamp: new Date().toISOString()
            });
        }
        broadcastOnlineUsers();
    });

    socket.on('chat-message', (rawText, reply) => {
        const respond = typeof reply === 'function' ? reply : () => {};

        if (!socket.data.username) { respond({ ok: false, error: 'Please log in first.' }); return; }
        const now = Date.now();
        if (now - socket.data.lastMessageAt < 400) { respond({ ok: false, error: 'Please wait a moment before sending again.' }); return; }

        const text = cleanMessage(rawText);
        if (!text) { respond({ ok: false, error: 'Type a message before sending.' }); return; }

        const message = { id: randomUUID(), username: socket.data.username, text, timestamp: new Date().toISOString() };
        
        socket.data.lastMessageAt = now;
        chatHistory.push(message);
        if (chatHistory.length > CHAT_HISTORY_LIMIT) { chatHistory.shift(); }

        io.emit('chat-message', message);
        respond({ ok: true });
    });

    socket.on('disconnect', () => {
        if (socket.data.username) {
            socket.broadcast.emit('system-message', {
                text: `${socket.data.username} left the chat`,
                timestamp: new Date().toISOString()
            });
        }
        broadcastOnlineUsers();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
