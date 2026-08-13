const mineflayer = require ('mineflayer');
const fs = require('fs');
const path = require('path');
const chatGameSolver = require('./chatgame-solver');

const logPath = path.join(__dirname, 'errors.txt');
const log = (label, detail) => {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${label} ${JSON.stringify(detail)}\n`);
};

const OPERATORS = ['VOlcarona_Alt', 'SpeedStrafe04', 'AustrichMC'];
const isFromOperator = (message) => OPERATORS.some(name => message.includes(name));

// Chat Games are multi-line broadcast puzzles (header, blank lines, equations,
// etc.) sent as a burst of separate chat messages. Buffer every message from
// the "CHAT GAMES" header onward, and once the burst goes quiet for a bit,
// flush the whole block to chatgames.txt - but only if we haven't already
// logged that exact block before, so repeats of the same puzzle aren't logged.
const CHAT_GAMES_PATH = path.join(__dirname, 'chatgames.txt');
const CHAT_GAMES_FLUSH_DELAY_MS = 900;
const CHAT_GAMES_SEPARATOR = '\n---\n';

const loggedChatGames = new Set(
    fs.existsSync(CHAT_GAMES_PATH)
        ? fs.readFileSync(CHAT_GAMES_PATH, 'utf8').split(CHAT_GAMES_SEPARATOR).map(s => s.trim()).filter(Boolean)
        : []
);

let chatGameBuffer = null;
let chatGameFlushTimer = null;
let currentBot = null; // set in connect(); flushChatGame lives outside connect() but needs to chat

// the "CHAT GAMES" header is reused for the round's result/winner
// announcement too (e.g. "20s have passed! ... The correct answer was...",
// or "X was the fastest to fill `Word` ... and got a prize!") - that's not
// the game itself, so don't log it, just harvest any word it reveals
const RESULT_ANNOUNCEMENT_MARKERS = ['have passed!', 'is now over!', 'correct answer was', 'and got a prize!'];
const isResultAnnouncement = (block) => RESULT_ANNOUNCEMENT_MARKERS.some(marker => block.includes(marker));

const CHAT_GAME_ANSWER_MIN_DELAY_MS = 1000;
const CHAT_GAME_ANSWER_MAX_DELAY_MS = 1800;

const flushChatGame = () => {
    const buffer = chatGameBuffer;
    chatGameBuffer = null;
    if (!buffer || buffer.length === 0) return;
    const block = buffer.join('\n').trim();
    if (!block || loggedChatGames.has(block)) return;
    loggedChatGames.add(block);

    if (isResultAnnouncement(block)) {
        chatGameSolver.learnFromAnnouncement(block);
        return;
    }

    const answer = chatGameSolver.solve(block);
    if (answer != null && currentBot) {
        const delay = CHAT_GAME_ANSWER_MIN_DELAY_MS + Math.random() * (CHAT_GAME_ANSWER_MAX_DELAY_MS - CHAT_GAME_ANSWER_MIN_DELAY_MS);
        setTimeout(() => currentBot.chat(answer), delay);
    } else {
        fs.appendFileSync(CHAT_GAMES_PATH, block + CHAT_GAMES_SEPARATOR);
    }
};

const recordChatGameLine = (message) => {
    if (message.includes('CHAT GAMES')) {
        chatGameBuffer = [message];
    } else if (chatGameBuffer) {
        chatGameBuffer.push(message);
    } else {
        return;
    }
    if (chatGameFlushTimer) clearTimeout(chatGameFlushTimer);
    chatGameFlushTimer = setTimeout(flushChatGame, CHAT_GAMES_FLUSH_DELAY_MS);
};

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
    currentBot = bot

    let totemModeActive = false

    const EQUIP_RETRY_DELAY_MS = 1500
    const EQUIP_MAX_ATTEMPTS = 3
    const SWAP_TO_OFFHAND_STATUS = 6
    const DROP_ITEM_STACK_STATUS = 3

    // location is meaningless for these action types per vanilla, but some
    // anti-cheat plugins validate it against the player's actual position for
    // every player-action packet regardless of type - use our real feet
    // position instead of a dummy (0,0,0) in case that's why they're ignored
    const feetPosition = () => {
        const pos = bot.entity.position
        return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
    }

    // drops the currently held item stack via the vanilla "Q" action - unlike
    // bot.tossStack(), this needs no window-click transaction (see EQUIP_ERROR/
    // ARMOR_EQUIP_ERROR: this server never acknowledges those)
    const dropHeldItemStack = () => {
        log('DROP_ITEM', { held: bot.heldItem && bot.heldItem.name })
        bot._client.write('block_dig', {
            status: DROP_ITEM_STACK_STATUS,
            location: feetPosition(),
            face: 0
        })
    }

    // swaps the currently held item with whatever's in the offhand (vanilla
    // "F" action) - no window-click transaction needed
    const offhandSlotItemName = () => {
        const item = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]
        return item && item.name
    }

    const swapHeldItemToOffhand = () => {
        log('SWAP_OFFHAND_BEFORE', { held: bot.heldItem && bot.heldItem.name, offhand: offhandSlotItemName() })
        bot._client.write('block_dig', {
            status: SWAP_TO_OFFHAND_STATUS,
            location: feetPosition(),
            face: 0
        })
        setTimeout(() => {
            log('SWAP_OFFHAND_AFTER', { held: bot.heldItem && bot.heldItem.name, offhand: offhandSlotItemName() })
        }, 1000)
    }

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

    const ARMOR_DESTINATION_BY_SUFFIX = [
        ['_helmet', 'head'],
        ['_chestplate', 'torso'],
        ['_leggings', 'legs'],
        ['_boots', 'feet'],
    ]
    const armorDestinationFor = (itemName) => {
        const match = ARMOR_DESTINATION_BY_SUFFIX.find(([suffix]) => itemName.endsWith(suffix))
        return match ? match[1] : null
    }

    const armorSlotsInProgress = new Set()

    const equipArmorPiece = (slot, destination) => {
        const inHotbar = slot >= bot.QUICK_BAR_START && slot < bot.QUICK_BAR_START + 9
        if (!inHotbar) {
            spin720() // no keybind-only way to move it into the hotbar - see Commands List.txt caveat
            return
        }
        if (armorSlotsInProgress.has(slot)) return // bot.equip's own optimistic slot updates can re-trigger this
        armorSlotsInProgress.add(slot)

        log('ARMOR_DETECTED', { slot, destination })
        bot.setQuickBarSlot(slot - bot.QUICK_BAR_START)
        setTimeout(() => {
            // right-clicking armor auto-equips it (vanilla behavior), swapping any
            // currently worn piece into hand - avoids window-click transactions
            bot.activateItem()
            setTimeout(() => {
                const held = bot.heldItem
                if (held && armorDestinationFor(held.name) === destination) {
                    dropHeldItemStack()
                }
                armorSlotsInProgress.delete(slot)
            }, 500)
        }, 300 + Math.random() * 200)
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
            setTimeout(swapHeldItemToOffhand, 300 + Math.random() * 200)
            return
        }

        bot.equip(totem, 'off-hand').catch(err => {
            log('EQUIP_ERROR', err.message)
            if (attempt < EQUIP_MAX_ATTEMPTS) {
                setTimeout(() => equipTotem(attempt + 1), EQUIP_RETRY_DELAY_MS)
            } else {
                spin720()
            }
        })
    }

    bot.once('spawn', () => {
        console.log('Meow')
        bot.chat('/login smolbrain')
        reportStatus()
        bot.on('health', reportStatus)

        bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
            if (totemModeActive && slot === bot.getEquipmentDestSlot('off-hand')) {
                const hadTotem = oldItem && oldItem.name === 'totem_of_undying'
                const stillHasTotem = newItem && newItem.name === 'totem_of_undying'
                if (hadTotem && !stillHasTotem) equipTotem()
            }

            if (newItem && (!oldItem || oldItem.type !== newItem.type)) {
                const destination = armorDestinationFor(newItem.name)
                if (destination && slot !== bot.getEquipmentDestSlot(destination)) {
                    equipArmorPiece(slot, destination)
                }
            }
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

    const reportStatus = () => {
        if (!process.send) return
        process.send({
            type: 'status',
            data: { connected: !!bot.entity, health: bot.health, totemModeActive }
        })
    }

    // actions shared between the in-game chat triggers and the control
    // panel's IPC commands, so both paths do exactly the same thing
    const actions = {
        tpToMe: () => bot.chat('/tpa VOlcarona_Alt'),
        tpMeToYou: () => bot.chat('/tpahere VOlcarona_Alt'),
        enableTotemMode: () => {
            totemModeActive = true
            crouch(3)
            equipTotem()
            reportStatus()
        },
        disableTotemMode: () => {
            totemModeActive = false
            bot.chat('Totem mode disabled.')
            reportStatus()
        },
        dropItem: () => dropHeldItemStack(),
        offhand: () => swapHeldItemToOffhand(),
        doCommand: (payload) => {
            if (payload) bot.chat(`/${payload.trim()}`)
        },
        say: (payload) => {
            if (payload) bot.chat(payload.trim())
        },
    }

    // only fires when launched via child_process.fork (e.g. by the control
    // panel) - process.on('message') is a no-op otherwise
    process.removeAllListeners('message')
    process.on('message', (msg) => {
        if (!msg || msg.type !== 'command') return
        const action = actions[msg.name]
        if (action) action(msg.payload)
    })

    let lastHudMessage = null
    const HUD_MESSAGE_PATTERN = /^❤ \d+\/\d+ \| ★ \d+\/\d+ \| ⛨ \d+$/

    bot.on('messagestr', (message) => {
        recordChatGameLine(message)

        const isHudMessage = HUD_MESSAGE_PATTERN.test(message)
        if (!isHudMessage || message !== lastHudMessage) {
            console.log('[CHAT]', message)
        }
        if (isHudMessage) lastHudMessage = message

        if (message.includes('Meow, tp to me.')) {
            actions.tpToMe()
        } else if (message.includes('Meow, tp me to you.')) {
            actions.tpMeToYou()
        } else if (isFromOperator(message) && message.includes('Meow, enable totem mode.')) {
            actions.enableTotemMode()
        } else if (isFromOperator(message) && message.includes('Meow, disable totem mode.')) {
            actions.disableTotemMode()
        } else if (isFromOperator(message) && message.includes('Meow, drop item.')) {
            actions.dropItem()
        } else if (isFromOperator(message) && message.includes('Meow, offhand.')) {
            actions.offhand()
        } else if (isFromOperator(message) && message.includes('Meow, say ')) {
            const match = message.match(/Meow, say (.+)/)
            if (match) actions.say(match[1])
        } else if (isFromOperator(message)) {
            const match = message.match(/Meow, do (.+)/)
            if (match) actions.doCommand(match[1])
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
        if (process.send) process.send({ type: 'status', data: { connected: false } })
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
