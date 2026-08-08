const mineflayer = require ('mineflayer');
const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, 'errors.txt');
const log = (label, detail) => {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${label} ${JSON.stringify(detail)}\n`);
};

const OPERATORS = ['VOlcarona_Alt', 'SpeedStrafe04'];
const isFromOperator = (message) => OPERATORS.some(name => message.includes(name));

const RECONNECT_DELAY_MS = 5000;
const QUICK_FAILURE_THRESHOLD_MS = 10000;
const STALE_SESSION_RECONNECT_DELAY_MS = 40000;
let reconnecting = false;

const scheduleReconnect = (reason, delay) => {
    if (reconnecting) return;
    reconnecting = true;
    console.log('RECONNECTING in', delay, 'ms due to', reason);
    log('RECONNECTING', reason);
    setTimeout(() => {
        reconnecting = false;
        connect();
    }, delay);
};

function connect() {
    const connectStartedAt = Date.now();
    const disconnectDelay = () => (Date.now() - connectStartedAt < QUICK_FAILURE_THRESHOLD_MS)
        ? STALE_SESSION_RECONNECT_DELAY_MS
        : RECONNECT_DELAY_MS;

    const bot = mineflayer.createBot({
        host: 'play.skeletonmc.com',
        port: 25565,
        username: 'stupidbotidk',
        version: '1.16.5',
    });

    let totemModeActive = false

    const equipTotem = () => {
        const totem = bot.inventory.items().find(item => item.name === 'totem_of_undying')
        if (totem) {
            bot.equip(totem, 'off-hand').catch(err => log('EQUIP_ERROR', err.message))
        } else {
            bot.chat('Totem required')
        }
    }

    bot.once('spawn', () => {
        console.log('Meow')
        bot.chat('/login smolbrain')

        bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
            if (!totemModeActive) return
            if (slot !== bot.getEquipmentDestSlot('off-hand')) return
            const hadTotem = oldItem && oldItem.name === 'totem_of_undying'
            const stillHasTotem = newItem && newItem.name === 'totem_of_undying'
            if (hadTotem && !stillHasTotem) equipTotem()
        })
    })

    bot.on('messagestr', (message) => {
        if (message.includes('Meow, tp to me.')) {
            bot.chat('/tpa VOlcarona_Alt')
        } else if (message.includes('Meow, tp me to you.')) {
            bot.chat('/tpahere VOlcarona_Alt')
        } else if (isFromOperator(message) && message.includes('Meow, enable totem mode.')) {
            totemModeActive = true
            bot.chat('Totem mode enabled')
            equipTotem()
        } else if (isFromOperator(message) && message.includes('Meow, disable totem mode.')) {
            totemModeActive = false
            bot.chat('Totem mode disabled.')
        } else if (isFromOperator(message)) {
            const match = message.match(/Meow, do (.+)/)
            if (match) {
                bot.chat(`/${match[1].trim()}`)
            }
        }
    })

    bot.on('death', () => {
        console.log('DIED, respawning')
        log('DEATH', 'bot died, calling respawn')
        bot.respawn()
    })

    bot.on('kicked', (reason) => {
        console.log('KICKED', reason)
        log('KICKED', reason)
    })
    bot.on('end', (reason) => {
        console.log('END', reason)
        log('END', reason)
        scheduleReconnect(`end: ${reason}`, disconnectDelay())
    })
    bot.on('error', (err) => {
        console.log('ERROR', err)
        log('ERROR', err.stack || err.message || err)
        // reconnect is scheduled from 'end', not here: 'end' only fires once the
        // socket has actually finished closing, which can lag well behind 'error'
        // (e.g. a keepalive timeout emits 'error' immediately but the socket can
        // take ~30s more to close) - reconnecting here raced ahead of that and
        // caused "already connected" collisions with our own not-yet-closed session
    })
}

connect();
