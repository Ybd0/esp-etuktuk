const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- KONFIGURATION BITTE ANPASSEN ---
// Die URL, unter der Keycloak erreichbar ist (z.B. http://192.168.1.50:8080)
const KEYCLOAK_URL = 'https://auth.birguel.de'; 
const REALM = 'iot-project'; 

// Statische Dateien ausliefern
app.use(express.static('public'));

// Setup um Schlüssel von Keycloak zu holen
const client = jwksClient({
  jwksUri: `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/certs`
});

function getKey(header, callback){
  client.getSigningKey(header.kid, function(err, key) {
    if (err) return callback(err);
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

// Socket.io Middleware (Sicherheitskontrolle)

io.use((socket, next) => {
    // 1.--- AUSNAHME FÜR ESP32 / SIMULATOR ---
    if (socket.handshake.auth.apiKey === "mein-geheimer-esp-schlüssel") {
        socket.user = { username: "ESP32-Device", roles: [] }; // ESP hat keine Admin Rollen
        return next();
    }
    // ---------------------------------------

    // 2. Token prüfen (für Browser User)
    const token = socket.handshake.auth.token;

    // --- ÄNDERUNG: Wenn KEIN Token da ist, ist es ein Gast ---
    if (!token) {
        // Wir lassen ihn rein, aber markieren ihn als Gast
        socket.user = { username: "Gast", roles: ['guest'] };
        return next();
    }
    // ---------------------------------------------------------

    // Wenn Token da ist, prüfen wir es wie gewohnt
    jwt.verify(token, getKey, { 
        algorithms: ['RS256'],
        issuer: `${KEYCLOAK_URL}/realms/${REALM}`
    }, (err, decoded) => {
        if (err) {
            // Wenn ein Token da ist, aber ungültig -> Fehler
            console.log("Token ungültig:", err.message);
            return next(new Error("Ungültiges Token"));
        }
        
        // Rollen extrahieren (Realm + Client)
        const realmRoles = (decoded.realm_access && decoded.realm_access.roles) ? decoded.realm_access.roles : [];
        const resourceAccess = decoded.resource_access || {};
        const clientRoles = (resourceAccess['esp-web-app'] && resourceAccess['esp-web-app'].roles) ? resourceAccess['esp-web-app'].roles : [];
        const allRoles = [...realmRoles, ...clientRoles];

        socket.user = {
            username: decoded.preferred_username,
            roles: allRoles
        };
        next();
    });
});

io.on('connection', (socket) => {
    console.log(`User verbunden: ${socket.user.username} [Rollen: ${socket.user.roles}]`);

    // GPS Daten empfangen (vom ESP) und weiterleiten (an Browser)
    socket.on('esp-gps', (data) => {
        io.emit('update-map', data);
    });

    // LED Status vom ESP empfangen
    socket.on('esp-led-status', (status) => {
        io.emit('update-led-ui', status);
    });

    // Befehl zum Schalten (Nur Admins!)
    socket.on('toggle-led', (command) => {
        if (socket.user.roles.includes('admin')) {
            console.log(`Admin ${socket.user.username} schaltet LED.`);
            io.emit('cmd-led', command);
        } else {
            console.log(`Zugriff verweigert für ${socket.user.username}`);
            socket.emit('error-msg', 'Keine Berechtigung!');
        }
    });
});

server.listen(3000, '0.0.0.0', () => {
    console.log('Server läuft auf Port 3000');
});
