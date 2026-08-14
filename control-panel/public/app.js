const statusEl = document.getElementById('status');
const consoleView = document.getElementById('console-view');
const logView = document.getElementById('log-view');
const launchBtn = document.getElementById('launch-btn');
const shutdownBtn = document.getElementById('shutdown-btn');
const chatGamesToggle = document.getElementById('chat-games-toggle');
const serverHostInput = document.getElementById('server-host-input');
const serverPortInput = document.getElementById('server-port-input');

const appendAndScroll = (el, text) => {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent += text;
    if (atBottom) el.scrollTop = el.scrollHeight;
};

const setStatus = (status) => {
    launchBtn.disabled = status.running;
    shutdownBtn.disabled = !status.running;

    if (!status.running) {
        statusEl.textContent = 'offline';
        statusEl.className = 'status status-offline';
    } else if (!status.connected) {
        statusEl.textContent = 'connecting...';
        statusEl.className = 'status status-connecting';
    } else {
        const health = status.health != null ? ` (health ${status.health})` : '';
        const totem = status.totemModeActive ? ' | totem mode on' : '';
        const chatGames = status.chatGamesEnabled === false ? ' | chat games off' : '';
        statusEl.textContent = `online${health}${totem}${chatGames}`;
        statusEl.className = 'status status-online';
    }

    chatGamesToggle.checked = status.chatGamesEnabled === true;
};

fetch('/api/log').then((r) => r.text()).then((text) => {
    logView.textContent = text;
    logView.scrollTop = logView.scrollHeight;
});

fetch('/api/server-config').then((r) => r.json()).then((config) => {
    serverHostInput.value = config.host;
    serverPortInput.value = config.port;
});

const connectSocket = () => {
    const ws = new WebSocket(`ws://${location.host}`);
    ws.onmessage = (event) => {
        const { type, data } = JSON.parse(event.data);
        if (type === 'status') setStatus(data);
        else if (type === 'console') appendAndScroll(consoleView, data);
        else if (type === 'log') appendAndScroll(logView, data);
    };
    ws.onclose = () => setTimeout(connectSocket, 2000);
};
connectSocket();

launchBtn.addEventListener('click', () => fetch('/api/launch', { method: 'POST' }));
shutdownBtn.addEventListener('click', () => fetch('/api/shutdown', { method: 'POST' }));

document.getElementById('save-server-btn').addEventListener('click', () => {
    const host = serverHostInput.value.trim();
    if (!host) return;
    fetch('/api/server-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port: serverPortInput.value }),
    }).then((r) => r.json()).then((config) => {
        serverHostInput.value = config.host;
        serverPortInput.value = config.port;
    });
});

document.querySelectorAll('.btn[data-command]').forEach((btn) => {
    btn.addEventListener('click', () => {
        fetch('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: btn.dataset.command }),
        });
    });
});

document.getElementById('do-command-btn').addEventListener('click', () => {
    const input = document.getElementById('do-command-input');
    if (!input.value.trim()) return;
    fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'doCommand', payload: input.value }),
    });
    input.value = '';
});

chatGamesToggle.addEventListener('change', () => {
    fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: chatGamesToggle.checked ? 'enableChatGames' : 'disableChatGames' }),
    });
});

document.getElementById('say-btn').addEventListener('click', () => {
    const input = document.getElementById('say-input');
    if (!input.value.trim()) return;
    fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'say', payload: input.value }),
    });
    input.value = '';
});
