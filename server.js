const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { Pool } = require('pg'); // Postgres

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- KONFIGURATION ---
const KEYCLOAK_PUBLIC_URL = 'https://auth.birguel.de'; 
const KEYCLOAK_INTERNAL_URL = 'http://localhost:8080'; 
const REALM = 'iot-project'; 

// Datenbank Verbindung
const db = new Pool({
    user: 'iot_user',
    host: 'localhost',
    database: 'iot_db',
    password: 'unxrb\\nm%k_D#7tInz4[',
    port: 5432,
});

app.use(express.static('public'));
app.use(express.json()); // Wichtig für POST Requests

// --- AUTH HELPER (Keycloak) ---
const client = jwksClient({
  jwksUri: `${KEYCLOAK_PUBLIC_URL}/realms/${REALM}/protocol/openid-connect/certs`
});

function getKey(header, callback){
  client.getSigningKey(header.kid, function(err, key) {
    if (err) return callback(err);
    callback(null, key.publicKey || key.rsaPublicKey);
  });
}

// API ENDPUNKTE FÜR BUCHUNGEN ---

// 1. Alle Buchungen abrufen (für den Kalender)
app.get('/api/bookings', async (req, res) => {
    try {
        const result = await db.query('SELECT id, esp_id, username, start_time, end_time FROM bookings WHERE end_time > NOW() - INTERVAL \'7 days\'');
        
        // FullCalendar Format:
        const events = result.rows.map(row => ({
            title: `Gebucht: ${row.username}`,
            start: row.start_time,
            end: row.end_time,
            color: '#e74c3c' 
        }));
        res.json(events);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Neue Buchung erstellen
app.post('/api/bookings', async (req, res) => {
    // Hier wird der Token manuell überprüft, da es ein normaler HTTP Request ist
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).send("Kein Token");
    
    const token = authHeader.split(' ')[1];
    
    jwt.verify(token, getKey, { issuer: `${KEYCLOAK_PUBLIC_URL}/realms/${REALM}` }, async (err, user) => {
        if (err) return res.status(403).send("Ungültiges Token");

        const { espId, start, end } = req.body;
        const startDate = new Date(start);
        const endDate = new Date(end);
        const durationHours = (endDate - startDate) / (1000 * 60 * 60);

        // REGEL A: Maximale Dauer pro Slot z.B. 4 Stunden
        if (durationHours > 4) return res.status(400).json({ error: "Max 4 Stunden am Stück!" });

        try {
            // REGEL B: Überschneidung prüfen
            const conflict = await db.query(
                `SELECT id FROM bookings WHERE esp_id = $1 AND 
                (start_time < $3 AND end_time > $2)`,
                [espId, startDate, endDate]
            );
            if (conflict.rows.length > 0) return res.status(409).json({ error: "Zeitraum schon belegt!" });

            // REGEL C: Wochenkontingent (2 Stunden = 120 min)
            // Hier werden alle Buchungen des Users der letzten 7 Tage + Zukunft summiert
            const quota = await db.query(
                `SELECT SUM(EXTRACT(EPOCH FROM (end_time - start_time))/3600) as hours 
                 FROM bookings WHERE user_id = $1 AND start_time > NOW() - INTERVAL '7 days'`,
                [user.sub]
            );
            
            const usedHours = parseFloat(quota.rows[0].hours || 0);
            if ((usedHours + durationHours) > 2.0) { // 2 Stunden Limit
                return res.status(400).json({ error: `Limit erreicht! Verbraucht: ${usedHours.toFixed(1)}h` });
            }

            // Alles OK -> Buchen
            await db.query(
                `INSERT INTO bookings (esp_id, user_id, username, start_time, end_time) VALUES ($1, $2, $3, $4, $5)`,
                [espId, user.sub, user.preferred_username, startDate, endDate]
            );

            // Socket Bescheid geben, dass sich Kalender geändert hat
            io.emit('calendar-update'); 
            res.json({ success: true });

        } catch (dbErr) {
            res.status(500).json({ error: dbErr.message });
        }
    });
});

// --- SOCKET LOGIK ---

// --- SOCKET MIDDLEWARE

io.use((socket, next) => {
    // 1. API Key Prüfung (für ESP32 und Simulator)
    const apiKeyAuth = socket.handshake.auth.apiKey;
    const apiKeyQuery = socket.handshake.query.apiKey; // Wichtig für C++
    
    // Hier den Key eintragen!
    if (apiKeyAuth === "geheim123" || apiKeyQuery === "geheim123") {
        socket.user = { username: "ESP-Device", roles: [] }; 
        return next();
    }

    // 2. Token holen
    const token = socket.handshake.auth.token;

    // 3. Gast-Check: Wenn kein Token da ist, lassen wir ihn als Gast rein
    if (!token) {
        socket.user = { username: "Gast", roles: ['guest'] };
        return next();
    }

    // 4. Token Prüfung (für eingeloggte User)
    jwt.verify(token, getKey, { 
        algorithms: ['RS256'],
        issuer: `${KEYCLOAK_PUBLIC_URL}/realms/${REALM}`
    }, (err, decoded) => {
        if (err) {
            console.log("Token Fehler:", err.message);
            return next(new Error("Token ungültig"));
        }
        
        // Rollen extrahieren (Realm + Client)
        const realmRoles = (decoded.realm_access && decoded.realm_access.roles) ? decoded.realm_access.roles : [];
        const resourceAccess = decoded.resource_access || {};
        const clientRoles = (resourceAccess['esp-web-app'] && resourceAccess['esp-web-app'].roles) ? resourceAccess['esp-web-app'].roles : [];
        const allRoles = [...realmRoles, ...clientRoles];
        
        socket.user = {
            sub: decoded.sub,            
            username: decoded.preferred_username,
            roles: allRoles
        };
        next();
    });
});

io.on('connection', (socket) => {
    socket.on('esp-gps', (data) => io.emit('update-map', data));
    socket.on('esp-led-status', (status) => io.emit('update-led-ui', status));

    // Die LED Schalt logig
    socket.on('toggle-led', async (command) => {
        
        // SICHERHEITS-CHECK 1: Ist der User überhaupt definiert?
        if (!socket.user || !socket.user.sub) {
            console.log("Schaltversuch ohne gültige User-ID");
            return socket.emit('error-msg', 'Fehler: Benutzer nicht korrekt identifiziert.');
        }

        // SICHERHEITS-CHECK 2: Admin darf immer (Optional)
        // if (socket.user.roles.includes('admin')) {
        //    io.emit('cmd-led', command);
        //    return;
        // }

        try {
            const now = new Date();
            // Hier wird eine Buchung gesucht, die jetzt aktiv ist für diesen ESP
            const result = await db.query(
                `SELECT user_id, username FROM bookings 
                 WHERE esp_id = $1 AND start_time <= $2 AND end_time >= $2`,
                ['ESP-Real-Hardware', now] 
            );

            if (result.rows.length === 0) {
                socket.emit('error-msg', 'ESP ist gerade nicht gebucht! Bitte erst im Kalender reservieren.');
                return;
            }

            const booking = result.rows[0];

            if (booking.user_id === socket.user.sub) {
                console.log(`Erlaubt: ${socket.user.username} schaltet LED.`);
                io.emit('cmd-led', command);
            } else {
                console.log(`Blockiert: ${socket.user.username} wollte schalten, aber ${booking.username} hat gebucht.`);
                socket.emit('error-msg', `Gesperrt! Aktuell gebucht von: ${booking.username}`);
            }

        } catch (err) {
            console.error("DB Fehler beim Schalten:", err);
            socket.emit('error-msg', 'Interner Serverfehler');
        }
    });
});

server.listen(3000, () => console.log('Server läuft...'));
