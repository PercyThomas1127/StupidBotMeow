const statusEl = document.getElementById('status');
const consoleView = document.getElementById('console-view');
const logView = document.getElementById('log-view');
const launchBtn = document.getElementById('launch-btn');
const shutdownBtn = document.getElementById('shutdown-btn');

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
        statusEl.textContent = `online${health}${totem}`;
        statusEl.className = 'status status-online';
    }
};

fetch('/api/log').then((r) => r.text()).then((text) => {
    logView.textContent = text;
    logView.scrollTop = logView.scrollHeight;
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
