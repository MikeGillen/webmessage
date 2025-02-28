const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const WebSocket = require('ws');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const os = require('os');

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
        for (const config of iface) {
            if (config.family === 'IPv4' && !config.internal) {
                return config.address;
            }
        }
    }
    return 'localhost'; // Fallback
}

const localIP = getLocalIP();

const port = 3000;

const app = express();
const wss = new WebSocket.Server({ port: '4000' });

// Midlleware to server static files (css, js, images)
app.use(express.static(path.join(__dirname, 'src')));
// Middleware to parse cookies
app.use(cookieParser());
// Middleware to parse JSON
app.use(express.json());
//readfiles easier instead of writing fs.promises.readFile(...)
const { readFile } = require('fs').promises;

function checkSession(req, res) {
    return new Promise((resolve, reject) => {
        let sessionId = req.cookies.sessionId;

        if (!sessionId) {
            return reject({ redirect: true });
        }
        
        db.get('SELECT * FROM sessions WHERE id = ?', [sessionId], (err, session) => {
            if (err || !session) {
                console.error('❌ Invalid session:', err ? err.message : 'Session not found');
                return reject({ redirect: true });
            }

            resolve(session.username); // Resolve with the username
        });
    });
}

// Connect to SQLite database
const db = new sqlite3.Database('database.db', (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
    }
});

// API to send the IP
app.get('/api/ip', (req, res) => {
    res.json({ ip: localIP });
});

// deliver html for index page
app.get('/', async (req, res) => {
    try {
        const username = await checkSession(req);
        res.cookie('sessionUsername', username, { httpOnly: false });
        res.send(await readFile('./src/chat.html', 'utf8'));
    } catch (err) {
        return res.redirect('/auth');
    }
});

// deliver html for chat page
app.get('/auth', async (req, res) => {
    res.send( await readFile('./src/auth.html','utf8'));
});

// manage login and register
app.post('/auth', (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM auth WHERE username = ?', [username], (err, auth) => {
        if (err) {
            console.error('❌ Database Error:', err.message);
            return res.status(500).json({ 
                success: false, 
                message: 'Database error', 
                type: 'check register/login',
                error: err.message 
            });
        }

        if (auth) {
            // User exists, check password
            bcrypt.compare(password, auth.password, (err, result) => {
                if (result) {
                    // Generate session ID
                    const sessionId = uuidv4();
                    db.run('INSERT INTO sessions (id, username) VALUES (?, ?)', [sessionId, username], (err) => {
                        if (err) {
                            console.error('❌ Error creating session:', err.message);
                            return res.status(500).json({ 
                                success: false, 
                                message: 'Error creating session', 
                                type: 'session',
                                error: err.message 
                            });
                        }
                        // Set session ID as a cookie
                        res.cookie('sessionId', sessionId, { httpOnly: true });
                        res.json({ success: true, message: 'Login successful', type: 'login' });
                    });
                } else {
                    console.error('❌ Incorrect password:');
                    return res.json({ 
                        success: false, 
                        message: 'Incorrect password',
                        type: 'login'
                    });
                }
            });
        } else {
            // User does not exist, create new auth
            bcrypt.hash(password, 10, (err, hash) => {
                if (err) {
                    console.error('❌ Error hashing password:', err.message);
                    return res.status(500).json({ 
                        success: false, 
                        message: 'Error hashing password', 
                        type: 'hashing',
                        error: err.message 
                    });
                }

                db.run('INSERT INTO auth (username, password) VALUES (?, ?)', [username, hash], (err) => {
                    if (err) {
                        console.error('❌ Error creating auth:', err.message);
                        return res.status(500).json({ 
                            success: false, 
                            message: 'Error creating auth', 
                            type: 'register',
                            error: err.message 
                        });
                    }
                    // Generate session ID
                    const sessionId = uuidv4();
                    db.run('INSERT INTO sessions (id, username) VALUES (?, ?)', [sessionId, username], (err) => {
                        if (err) {
                            console.error('❌ Error creating session:', err.message);
                            return res.status(500).json({ 
                                success: false, 
                                message: 'Error creating session', 
                                type: 'session',
                                error: err.message 
                            });
                        }
                        // Set session ID as a cookie
                        res.cookie('sessionId', sessionId, { httpOnly: true });
                        res.json({ success: true, message: 'User registered successfully', type: 'register' });
                    });
                });
            });
        }
    });
});

// WebSocket connection
wss.on('connection', (ws, req) => {

    //get username from cookie
    let username = null;
    if (req.headers.cookie) {
        const cookies = req.headers.cookie.split('; ');
        const usernameCookie = cookies.find(c => c.startsWith('sessionUsername='));
        if (usernameCookie) {
            username = decodeURIComponent(usernameCookie.split('=')[1]);
        }
    }

    // Send all previous messages to the newly connected client
    db.all('SELECT * FROM chat', (err, rows) => {
        if (err) {
            console.error('❌ failed to load history:', err.message);
        } else {
            ws.send(JSON.stringify({
                success: true, 
                message: "successfully loaded history", 
                type: 'history', 
                data: rows.map(row => ({ content: row.content, username: row.username, unixTimestamp: row.timestamp}))
            }));
        }
    });

    // Handle incoming messages
    ws.on('message', (data) => {
        const parsedData = JSON.parse(data);
        const { data: content} = parsedData;
        const unixTimestamp = Math.floor(Date.now() / 1000);
        // Store the message
        db.run('INSERT INTO chat (content, username, timestamp) VALUES (?, ?, ?)', [content, username, unixTimestamp], (err) => {
            if (err) {
                console.error('❌ failed to upload message:', err.message);
            }
        });
        // Broadcast the message to all clients
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ 
                    success: true,
                    message: "successfully uploaded message",
                    type: 'message', 
                    data: { content, username, unixTimestamp} 
                }));
            }
        });
    });
});

app.listen(process.env.PORT || port, () => console.log(`${localIP}:${port}`));