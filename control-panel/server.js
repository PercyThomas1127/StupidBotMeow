const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');
const express = require('express');
const WebSocket = require('ws');

const BOT_SCRIPT = path.join(__dirname, '..', 'stupidbot.js');
const LOG_PATH = path.join(__dirname, '..', 'errors.txt');
const SERVER_CONFIG_PATH = path.join(__dirname, '..', 'server-config.json');
const DEFAULT_SERVER_CONFIG = { host: 'play.skeletonmc.com', port: 25565 };
const PORT = 4000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let botProcess = null;
let lastStatus = { running: false, connected: false, health: null, totemModeActive: false };

const broadcast = (type, data) => {
    const message = JSON.stringify({ type, data });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
};

const setStatus = (patch) => {
    lastStatus = { ...lastStatus, ...patch };
    broadcast('status', lastStatus);
};

const launchBot = () => {
    if (botProcess) return;
    botProcess = fork(BOT_SCRIPT, [], { silent: true });
    setStatus({ running: true, connected: false });

    botProcess.stdout.on('data', (chunk) => broadcast('console', chunk.toString()));
    botProcess.stderr.on('data', (chunk) => broadcast('console', chunk.toString()));

    botProcess.on('message', (msg) => {
        if (msg && msg.type === 'status') setStatus(msg.data);
    });

    botProcess.on('exit', (code) => {
        broadcast('console', `\n[bot process exited with code ${code}]\n`);
        setStatus({ running: false, connected: false });
        botProcess = null;
    });
};

const shutdownBot = () => {
    if (!botProcess) return;
    botProcess.kill();
};

const sendCommand = (name, payload) => {
    if (!botProcess) return false;
    botProcess.send({ type: 'command', name, payload });
    return true;
};

app.post('/api/launch', (req, res) => {
    launchBot();
    res.json(lastStatus);
});

app.post('/api/shutdown', (req, res) => {
    shutdownBot();
    res.json(lastStatus);
});

app.post('/api/command', (req, res) => {
    const ok = sendCommand(req.body.name, req.body.payload);
    res.json({ ok });
});

app.get('/api/log', (req, res) => {
    fs.readFile(LOG_PATH, 'utf8', (err, data) => res.send(err ? '' : data));
});

// the server the bot connects to on its next launch - only takes effect on
// (re)launch, since the running bot process already read this at startup
app.get('/api/server-config', (req, res) => {
    fs.readFile(SERVER_CONFIG_PATH, 'utf8', (err, data) => {
        res.json(err ? DEFAULT_SERVER_CONFIG : JSON.parse(data));
    });
});

app.post('/api/server-config', (req, res) => {
    const host = (req.body.host || '').trim();
    if (!host) return res.status(400).json({ error: 'host is required' });
    const port = Number(req.body.port) || DEFAULT_SERVER_CONFIG.port;
    const hubNpcName = (req.body.hubNpcName || '').trim() || null;
    const config = { host, port, hubNpcName };
    fs.writeFileSync(SERVER_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    res.json(config);
});

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'status', data: lastStatus }));
});

// stream new lines appended to errors.txt to connected clients
let lastLogSize = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;
if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');
fs.watch(LOG_PATH, () => {
    fs.stat(LOG_PATH, (err, stats) => {
        if (err) return;
        if (stats.size < lastLogSize) lastLogSize = 0; // log file was truncated/replaced
        if (stats.size === lastLogSize) return;
        const stream = fs.createReadStream(LOG_PATH, { start: lastLogSize, end: stats.size });
        let chunk = '';
        stream.on('data', (d) => { chunk += d; });
        stream.on('end', () => {
            lastLogSize = stats.size;
            if (chunk) broadcast('log', chunk);
        });
    });
});

server.listen(PORT, () => {
    console.log(`Control panel running at http://localhost:${PORT}`);
});
