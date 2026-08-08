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
        username: 'MeowMeowNya',
        version: '1.16.5',
    });

    let totemModeActive = false

    const EQUIP_RETRY_DELAY_MS = 1500
    const EQUIP_MAX_ATTEMPTS = 3
    const SWAP_TO_OFFHAND_STATUS = 6

    const spin720 = () => {
        const steps = 24
        const stepRadians = (720 * Math.PI / 180) / steps
        let currentYaw = bot.entity.yaw
        let i = 0
        const step = () => {
            if (i >= steps) return
            currentYaw += stepRadians
            bot.look(currentYaw, 0, true)
            i++
            setTimeout(step, 50)
        }
        step()
    }

    const equipTotem = (attempt = 1) => {
        const totem = bot.inventory.items().find(item => item.name === 'totem_of_undying')
        if (!totem) {
            bot.chat('Totem required')
            return
        }

        const inHotbar = totem.slot >= bot.QUICK_BAR_START && totem.slot < bot.QUICK_BAR_START + 9
        if (inHotbar) {
            // selecting a hotbar slot + swapping to offhand only needs simple
            // packets (held_item_slot, block_dig) - no window-click transaction,
            // which is the thing the server won't acknowledge (see EQUIP_ERROR).
            // Selecting the slot and swapping in the same tick reads as instant/
            // bot-like to anticheat, so space them out like a real key press.
            bot.setQuickBarSlot(totem.slot - bot.QUICK_BAR_START)
            setTimeout(() => {
                bot._client.write('block_dig', {
                    status: SWAP_TO_OFFHAND_STATUS,
                    location: { x: 0, y: 0, z: 0 },
                    face: 0
                })
            }, 300 + Math.random() * 200)
            return
        }

        bot.equip(totem, 'off-hand').catch(err => {
            log('EQUIP_ERROR', err.message)
            if (attempt < EQUIP_MAX_ATTEMPTS) {
                setTimeout(() => equipTotem(attempt + 1), EQUIP_RETRY_DELAY_MS)
            } else {
                bot.chat('Failed to equip totem')
                spin720()
            }
        })
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

    const CROUCH_TOGGLE_INTERVAL_MS = 400

    const crouch = (times) => {
        let toggles = 0
        const step = () => {
            if (toggles >= times * 2) return
            bot.setControlState('sneak', toggles % 2 === 0)
            toggles++
            setTimeout(step, CROUCH_TOGGLE_INTERVAL_MS)
        }
        step()
    }

    bot.on('messagestr', (message) => {
        if (message.includes('Meow, tp to me.')) {
            bot.chat('/tpa VOlcarona_Alt')
        } else if (message.includes('Meow, tp me to you.')) {
            bot.chat('/tpahere VOlcarona_Alt')
        } else if (isFromOperator(message) && message.includes('Meow, enable totem mode.')) {
            totemModeActive = true
            crouch(3)
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
