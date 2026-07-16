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

// Robot Editor Authentication
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

const MASTER_SHEET_ID = '1yUkt9j49mT9xGHS0BnaIO488segTr1q0B8TXbS5m7UM';
const ASSEMBLY_SHEET_ID = '1SgB5QG9jeCtJeD2UaaKsyrtwPCtd4qfcTyKgFf5az3Y';

let cachedData = { totalStock: '0%', trailerList: [], lastUpdated: 'Waiting for sync...' };

async function syncWithGoogle() {
    try {
        // Fetch Master Sheet (Dashboard Data)
        const masterRes = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: 'Sheet1!A2:I100'
        });
        
        // Fetch Matrix Sheet (Live Tracking Data)
        const matrixRes = await sheets.spreadsheets.values.get({
            spreadsheetId: ASSEMBLY_SHEET_ID,
            range: "'Matrix Data'!A2:O1000"
        });

        const masterRows = masterRes.data.values || [];
        const matrixRows = matrixRes.data.values || [];
        
        const globalStock = masterRows.length > 0 && masterRows[0][8] ? masterRows[0][8] : '0%';
        
        const trailers = masterRows.map(row => {
            const id = row[0] || '';
            
            // Find matrix data specifically for this trailer
            const matrixRow = matrixRows.find(mRow => mRow[0] === id) || [];
            const matrixState = { box: Array(7).fill(false), attachments: Array(7).fill(false) };
            
            if (matrixRow.length > 0) {
                for(let i = 0; i < 7; i++) {
                    matrixState.box[i] = (matrixRow[i+1] === 'TRUE' || matrixRow[i+1] === true);
                    matrixState.attachments[i] = (matrixRow[i+8] === 'TRUE' || matrixRow[i+8] === true);
                }
            }

            return {
                id: id, type: row[1] || '', date: row[2] || '',
                receiveProgress: row[3] || '0%', installProgress: row[4] || '0%',
                cuttingProgress: row[5] || '0%', bendingProgress: row[6] || '0%',
                completionProgress: row[7] || '0%',
                matrix: matrixState // Attach live matrix data here
            };
        }).filter(trailer => trailer.id !== '');

        cachedData = { totalStock: globalStock, trailerList: trailers, lastUpdated: new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' }) };
    } catch (error) { console.error('Sync Error:', error.message); }
}

syncWithGoogle(); setInterval(syncWithGoogle, 120000);

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => { if (err) res.sendFile(path.join(__dirname, 'index.html')); }); });
app.get('/api/trailers', (req, res) => { res.json(cachedData); });

// Endpoint for standard checklists
app.get('/api/checklists/:trailerId', async (req, res) => {
    const trailerId = req.params.trailerId;
    try {
        const assemblyRes = await sheets.spreadsheets.values.get({ spreadsheetId: ASSEMBLY_SHEET_ID, range: `'${trailerId}'!B7:D150` });
        const cutBendRes = await sheets.spreadsheets.values.get({ spreadsheetId: ASSEMBLY_SHEET_ID, range: `'${trailerId} Cutting & Bending'!B8:E150` });
        res.json({ success: true, assembly: assemblyRes.data.values || [], cutBend: cutBendRes.data.values || [] });
    } catch (error) { res.json({ success: false, error: 'Tabs not found or error loading data.' }); }
});

// Endpoint to update standard checklists
app.post('/api/update-checklist', async (req, res) => {
    const { trailerId, type, row, col, isChecked } = req.body;
    let range = type === 'assembly' ? `'${trailerId}'!${col}${row + 7}` : `'${trailerId} Cutting & Bending'!${col}${row + 8}`;
    try {
        await sheets.spreadsheets.values.update({
            spreadsheetId: ASSEMBLY_SHEET_ID, range: range, valueInputOption: "USER_ENTERED",
            requestBody: { values: [[isChecked]] }
        });
        setTimeout(syncWithGoogle, 1500);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// NEW: Endpoint to update the Matrix Data tab
app.post('/api/update-matrix', async (req, res) => {
    const { trailerId, stageIndex, partIndex, isChecked } = req.body;
    try {
        // Find which row the trailer is on in the Matrix Data sheet
        const idsRes = await sheets.spreadsheets.values.get({ spreadsheetId: ASSEMBLY_SHEET_ID, range: "'Matrix Data'!A:A" });
        const ids = idsRes.data.values ? idsRes.data.values.map(row => row[0]) : [];
        const rowIndex = ids.indexOf(trailerId);
        
        if (rowIndex === -1) return res.json({ success: false, error: 'Trailer not found in Matrix Data sheet.' });
        const rowNum = rowIndex + 1; // Google Sheets row numbers start at 1
        
        // Calculate the exact column letter (Box = B through H, Attachments = I through O)
        const asciiCode = partIndex === 0 ? (66 + stageIndex) : (73 + stageIndex);
        const colLetter = String.fromCharCode(asciiCode);
        
        await sheets.spreadsheets.values.update({
            spreadsheetId: ASSEMBLY_SHEET_ID, 
            range: `'Matrix Data'!${colLetter}${rowNum}`, 
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[isChecked]] }
        });
        
        setTimeout(syncWithGoogle, 1500); // Force sync
        res.json({ success: true });
    } catch (error) {
        console.error('Matrix Write Error:', error.message);
        res.status(500).json({ success: false });
    }
});

app.post('/api/qa-report', async (req, res) => {
    const { trailerId, issue } = req.body;
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: MASTER_SHEET_ID, range: "'QA Issues'!A:C", valueInputOption: "USER_ENTERED",
            requestBody: { values: [[new Date().toLocaleString('en-ZA'), trailerId, issue]] }
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// Live Chat Engine
const chatHistory = [];
io.on('connection', socket => {
    socket.on('join-chat', (rawName, reply) => {
        const username = String(rawName || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        if (username.length < 2) { reply({ ok: false, error: 'Name too short.' }); return; }
        socket.data.username = username; socket.data.lastMessageAt = 0;
        socket.emit('chat-history', chatHistory); reply({ ok: true, username });
    });
    socket.on('chat-message', (rawText, reply) => {
        if (!socket.data.username) return;
        const text = String(rawText || '').trim().slice(0, 500);
        if (!text) return;
        const message = { id: randomUUID(), username: socket.data.username, text, timestamp: new Date().toISOString() };
        chatHistory.push(message); if (chatHistory.length > 100) chatHistory.shift();
        io.emit('chat-message', message); reply({ ok: true });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
