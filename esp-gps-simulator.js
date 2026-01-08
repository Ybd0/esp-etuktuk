const io = require("socket.io-client");

// Hier Server IP anpassen!
const socket = io("http://localhost:3000", {
    auth: { apiKey: "mein-geheimer-esp-schlüssel" }
});

let lat = 52.5200;
let lon = 13.4050;

socket.on("connect", () => {
    console.log("Simulator verbunden!");
    
    setInterval(() => {
        lat += 0.0001;
        socket.emit("esp-gps", { id: "ESP-01", lat, lon });
    }, 1000);
});

socket.on("cmd-led", (data) => {
    console.log("Befehl empfangen: LED " + data.value);
});
