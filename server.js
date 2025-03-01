(async () => {
    const express = require('express');
    const sqlite3 = require('sqlite3').verbose();
    const bcrypt = require('bcrypt');
    const WebSocket = require('ws');
    const cookieParser = require('cookie-parser');
    const { v4: uuidv4 } = require('uuid');
    const path = require('path');
    const os = require('os');
    const { readFile } = require('fs').promises;

    /** 
     * Get the local network IP address (waits until a valid one is found)
     */
    const getLocalIP = () => new Promise((resolve) => {
        const findIP = () => {
            for (const iface of Object.values(os.networkInterfaces())) {
                for (const { family, internal, address } of iface) {
                    if (family === 'IPv4' && !internal) return resolve(address);
                }
            }
            setTimeout(findIP, 1000); // Retry if no valid IP found
        };
        findIP();
    });

    const localIP = await getLocalIP();
    const app = express();
    const port = process.env.PORT || 3000;
    const wss = new WebSocket.Server({ host: localIP, port: 4000 });

    // Connect to SQLite database
    const db = new sqlite3.Database('database.db', (err) => {
        if (err) console.error('❌ Database connection error:', err.message);
        else console.log('✅ Connected to SQLite database.');
    });

    /** 
     * Check user session validity 
     */
    const checkSession = (req) => new Promise((resolve, reject) => {
        const sessionId = req.cookies.sessionId;
        if (!sessionId) return reject({ redirect: true });

        db.get('SELECT * FROM sessions WHERE id = ?', [sessionId], (err, session) => {
            if (err || !session) return reject({ redirect: true });
            resolve(session.username);
        });
    });

    // Middleware
    app.use(express.static(path.join(__dirname, 'src')));
    app.use(cookieParser());
    app.use(express.json());

    // API route to send the server IP
    app.get('/api/ip', (req, res) => res.json({ ip: localIP }));

    // Serve main chat page (requires session check)
    app.get('/', async (req, res) => {
        try {
            const username = await checkSession(req);
            res.cookie('sessionUsername', username, { httpOnly: false });
            res.send(await readFile('./src/chat.html', 'utf8'));
        } catch (err) {
            res.redirect('/auth');
        }
    });

    // Serve authentication page
    app.get('/auth', async (req, res) => {
        res.send(await readFile('./src/auth.html', 'utf8'));
    });

    // Handle user login and registration
    app.post('/auth', (req, res) => {
        const { username, password } = req.body;
        
        db.get('SELECT * FROM auth WHERE username = ?', [username], (err, auth) => {
            if (err) return res.status(500).json({ success: false, message: 'Database error' });

            if (auth) {
                // User exists, verify password
                bcrypt.compare(password, auth.password, (err, result) => {
                    if (result) {
                        const sessionId = uuidv4();
                        db.run('INSERT INTO sessions (id, username) VALUES (?, ?)', [sessionId, username], () => {
                            res.cookie('sessionId', sessionId, { httpOnly: true });
                            res.json({ success: true, message: 'Login successful' });
                        });
                    } else {
                        res.json({ success: false, message: 'Incorrect password' });
                    }
                });
            } else {
                // Register new user
                bcrypt.hash(password, 10, (err, hash) => {
                    db.run('INSERT INTO auth (username, password) VALUES (?, ?)', [username, hash], () => {
                        const sessionId = uuidv4();
                        db.run('INSERT INTO sessions (id, username) VALUES (?, ?)', [sessionId, username], () => {
                            res.cookie('sessionId', sessionId, { httpOnly: true });
                            res.json({ success: true, message: 'User registered successfully' });
                        });
                    });
                });
            }
        });
    });

    // WebSocket handling
    wss.on('connection', (ws, req) => {
        let username = null;
        if (req.headers.cookie) {
            const cookies = req.headers.cookie.split('; ');
            const usernameCookie = cookies.find(c => c.startsWith('sessionUsername='));
            if (usernameCookie) username = decodeURIComponent(usernameCookie.split('=')[1]);
        }

        // Send chat history to new clients
        db.all('SELECT * FROM chat', (err, rows) => {
            if (!err) {
                ws.send(JSON.stringify({
                    success: true, type: 'history', data: rows.map(({ content, username, timestamp }) => ({ content, username, timestamp }))
                }));
            }
        });

        // Handle new messages
        ws.on('message', (data) => {
            const { data: content } = JSON.parse(data);
            const timestamp = Math.floor(Date.now() / 1000);
            
            db.run('INSERT INTO chat (content, username, timestamp) VALUES (?, ?, ?)', [content, username, timestamp]);
            
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ success: true, type: 'message', data: { content, username, timestamp } }));
                }
            });
        });
    });

    // Start the server
    app.listen(port, () => console.log(`✅ Server running at http://${localIP}:${port}`));
})();
