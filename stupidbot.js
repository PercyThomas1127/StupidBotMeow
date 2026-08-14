const mineflayer = require ('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const path = require('path');
const chatGameSolver = require('./chatgame-solver');
const schematicBuilder = require('./schematic-builder');

const logPath = path.join(__dirname, 'errors.txt');
const log = (label, detail) => {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${label} ${JSON.stringify(detail)}\n`);
};

const OPERATORS = ['VOlcarona_Alt', 'SpeedStrafe04', 'AustrichMC'];
const isFromOperator = (message) => OPERATORS.some(name => message.includes(name));

// mineflayer logs this whenever a map_chunk packet fails to parse into a
// usable column (real data loss - blockAt/pathfinding/building near that
// chunk can be wrong) - it's not cosmetic, but it's noisy, so we silence the
// console spam here rather than passing createBot's blanket hideErrors flag
// (which would also swallow unrelated, more important warnings/errors)
const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('Ignoring block entities as chunk failed to load')) return;
    originalConsoleWarn(...args);
};

// server to connect to - stored in server-config.json so the control panel
// can change it before a launch without editing code
const SERVER_CONFIG_PATH = path.join(__dirname, 'server-config.json');
const DEFAULT_SERVER_CONFIG = { host: 'play.skeletonmc.com', port: 25565, username: 'MeowMeowNya', version: null, hubNpcName: null };
const loadServerConfig = () => {
    try {
        return { ...DEFAULT_SERVER_CONFIG, ...JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf8')) };
    } catch {
        return DEFAULT_SERVER_CONFIG;
    }
};
// hosts with known per-version bugs get a hardcoded fallback so they keep
// working even if server-config.json doesn't pin a version explicitly -
// play.skeletonmc.com's actual backend is 1.21.11, but that version has
// broken item-component parsing and forces signed chat there, so it's
// pinned to the older 1.16.5 protocol to dodge both bugs
const KNOWN_HOST_VERSION_OVERRIDES = { 'play.skeletonmc.com': '1.16.5' };
// hubNpcName: some networks (e.g. ggsmp.net) require right-clicking a lobby
// NPC after login to actually enter the main server - optional, only acted
// on when the current server-config.json sets it.
// version: leave unset (or blank in the control panel) to have mineflayer
// gather this itself - passing `false` makes minecraft-protocol ping the
// server first and auto-detect its protocol version before connecting
// (this is what fixed ggsmp.net's "chunk failed to load" spam, which was
// caused by being pinned to a version that didn't match its real backend).
// Only override this per-server if that server's real version turns out to
// have its own bugs, the way play.skeletonmc.com does.
const { host: HOST, port: PORT, username: USERNAME, version: CONFIGURED_VERSION, hubNpcName: HUB_NPC_NAME } = loadServerConfig();
const VERSION = CONFIGURED_VERSION || KNOWN_HOST_VERSION_OVERRIDES[HOST] || false;

// tracks which host+username combos we've already registered, so a fresh
// server (or a different account on a known server) gets /register instead
// of /login on its first join, while known combos keep using /login
const REGISTERED_HOSTS_PATH = path.join(__dirname, 'registered-hosts.json');
const registeredHosts = new Set(
    fs.existsSync(REGISTERED_HOSTS_PATH)
        ? JSON.parse(fs.readFileSync(REGISTERED_HOSTS_PATH, 'utf8'))
        : []
);
const hostAccountKey = (host, username) => `${host}:${username}`;
const markHostRegistered = (host, username) => {
    registeredHosts.add(hostAccountKey(host, username));
    fs.writeFileSync(REGISTERED_HOSTS_PATH, JSON.stringify([...registeredHosts].sort(), null, 2) + '\n');
};

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
// disabled by default: the account was banned ("afk farming chat games") for
// this exact behavior - re-enable manually via "Meow, enable chat games."
// or the control panel once you're ready to risk it again
let chatGamesEnabled = false;

// the "CHAT GAMES" header is reused for the round's result/winner
// announcement too (e.g. "20s have passed! ... The correct answer was...",
// or "X was the fastest to fill `Word` ... and got a prize!") - that's not
// the game itself, so don't log it, just harvest any word it reveals
const RESULT_ANNOUNCEMENT_MARKERS = ['have passed!', 'is now over!', 'correct answer was', 'and got a prize!'];
const isResultAnnouncement = (block) => RESULT_ANNOUNCEMENT_MARKERS.some(marker => block.includes(marker));

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
        currentBot.chat(answer);
    } else {
        fs.appendFileSync(CHAT_GAMES_PATH, block + CHAT_GAMES_SEPARATOR);
    }
};

const recordChatGameLine = (message) => {
    if (!chatGamesEnabled) return;
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
        host: HOST,
        port: PORT,
        username: USERNAME,
        version: VERSION,
    });
    currentBot = bot
    bot.loadPlugin(pathfinder)

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

    // finds a solid neighbor of `position` to place a block against, and the
    // face vector (from that neighbor) pointing at `position` - mirrors how
    // a player has to click an existing block's face to place a new one
    const NEIGHBOR_OFFSETS = [
        new Vec3(0, -1, 0), new Vec3(0, 1, 0),
        new Vec3(-1, 0, 0), new Vec3(1, 0, 0),
        new Vec3(0, 0, -1), new Vec3(0, 0, 1),
    ]
    const findPlacementReference = (position) => {
        for (const offset of NEIGHBOR_OFFSETS) {
            const neighborPos = position.plus(offset)
            const neighborBlock = bot.blockAt(neighborPos)
            if (neighborBlock && neighborBlock.boundingBox === 'block') {
                return { referenceBlock: neighborBlock, faceVector: offset.scaled(-1) }
            }
        }
        return null
    }

    let buildCancelled = false

    const buildSchematic = async (payload) => {
        const match = payload && payload.match(/^(\S+)\s+at\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\.?$/i)
        if (!match) {
            bot.chat('Usage: Meow, build <name> at <x> <y> <z>.')
            return
        }
        const [, name, xStr, yStr, zStr] = match

        const schematic = await schematicBuilder.loadSchematic(name).catch(err => {
            log('BUILD_LOAD_ERROR', err.message)
            return null
        })
        if (!schematic) {
            bot.chat(`Schematic not found: ${name}`)
            return
        }

        const anchor = { x: parseInt(xStr, 10), y: parseInt(yStr, 10), z: parseInt(zStr, 10) }
        const plan = schematicBuilder.buildPlan(schematic, anchor)
        buildCancelled = false
        bot.chat(`Building ${name} (${plan.length} blocks)...`)

        let placed = 0
        let skipped = 0
        for (const step of plan) {
            if (buildCancelled) {
                bot.chat(`Build cancelled (${placed} placed, ${skipped} skipped).`)
                return
            }

            const position = new Vec3(step.x, step.y, step.z)
            const existing = bot.blockAt(position)
            if (existing && existing.name === step.blockName) {
                placed++
                continue
            }

            const item = bot.inventory.items().find(i => i.name === step.blockName)
            if (!item) {
                skipped++
                continue
            }

            try {
                await bot.pathfinder.goto(new goals.GoalPlaceBlock(position, bot.world, { range: 4, LOS: false }))
                const reference = findPlacementReference(position)
                if (!reference) {
                    skipped++
                    continue
                }
                await bot.equip(item, 'hand')
                await bot.placeBlock(reference.referenceBlock, reference.faceVector)
                placed++
            } catch (err) {
                log('BUILD_ERROR', { position: step, block: step.blockName, error: err.message })
                skipped++
            }
        }
        bot.chat(`Build complete: ${placed} placed, ${skipped} skipped.`)
    }

    // some networks (e.g. ggsmp.net) put you in a lobby after login and
    // require right-clicking an NPC to actually enter the main server -
    // only used when server-config.json sets hubNpcName for this host
    const HUB_NPC_MAX_ATTEMPTS = 10
    const HUB_NPC_RETRY_DELAY_MS = 2000
    const entityNameMatches = (entity, needle) => {
        const candidates = [entity.username, entity.displayName && entity.displayName.toString(), entity.name]
            .filter(Boolean)
        return candidates.some(name => name.toLowerCase().includes(needle.toLowerCase()))
    }
    // ggsmp.net's hub NPC (confirmed via "Meow, list entities.") is a fake
    // player entity whose username is scrambled with obfuscated formatting
    // codes (e.g. "§o§d§l§f§6§8§k§8") rather than literal text, so a plain
    // substring match on hubNpcName never finds it - real players never have
    // "§" in their username, so this is a reliable heuristic fallback. When
    // several such entities exist, prefer whichever sits closest to an
    // armor_stand (these networks float NPC nametag/hologram text on stacked
    // armor stands just above the NPC's head).
    const looksLikeObfuscatedNpc = (entity) => entity.type === 'player' && typeof entity.username === 'string' && /§/.test(entity.username)
    // "armor_stand" was what this showed up as under the wrong protocol
    // version (see version auto-detect fix) - at the correct version it's
    // actually a "text_display" hologram entity, but both are kept here in
    // case a differently-versioned server still uses classic armor stands
    const looksLikeHologram = (entity) => entity.position && (entity.name === 'armor_stand' || entity.name === 'text_display')
    const findObfuscatedNpc = (entities) => {
        const candidates = entities.filter(looksLikeObfuscatedNpc)
        const holograms = entities.filter(looksLikeHologram)
        if (!holograms.length) return candidates[0]
        return candidates.sort((a, b) => {
            const distA = Math.min(...holograms.map(s => s.position.distanceTo(a.position)))
            const distB = Math.min(...holograms.map(s => s.position.distanceTo(b.position)))
            return distA - distB
        })[0]
    }
    const HUB_NPC_INTERACT_RANGE = 2
    const findAndClickHubNpc = (attempt = 1) => {
        const entities = Object.values(bot.entities)
        let npc = entities.find(e => entityNameMatches(e, HUB_NPC_NAME))
        let matchType = 'name'
        if (!npc) {
            npc = findObfuscatedNpc(entities)
            matchType = 'obfuscated-name-heuristic'
        }
        if (npc) {
            const distance = npc.position.distanceTo(bot.entity.position)
            log('HUB_NPC_FOUND', { hubNpcName: HUB_NPC_NAME, entityName: npc.username || npc.name, matchType, distance })
            // activateEntity sends an interact packet regardless of range, but
            // anti-cheat on these networks silently drops it if we're too far
            // away (this is why earlier attempts logged FOUND but never
            // actually entered the main server) - walk within range first
            bot.pathfinder.goto(new goals.GoalNear(npc.position.x, npc.position.y, npc.position.z, HUB_NPC_INTERACT_RANGE))
                .then(() => bot.activateEntity(npc))
                .catch(err => log('HUB_NPC_ERROR', err.message))
            return
        }
        if (attempt >= HUB_NPC_MAX_ATTEMPTS) {
            log('HUB_NPC_NOT_FOUND', { hubNpcName: HUB_NPC_NAME })
            return
        }
        setTimeout(() => findAndClickHubNpc(attempt + 1), HUB_NPC_RETRY_DELAY_MS)
    }
    const enterHubIfConfigured = () => {
        if (HUB_NPC_NAME) setTimeout(() => findAndClickHubNpc(), HUB_NPC_RETRY_DELAY_MS)
    }

    bot.once('spawn', () => {
        console.log('Meow')
        console.log('[VERSION]', bot.version, 'protocol', bot.protocolVersion, 'configured', VERSION)
        if (registeredHosts.has(hostAccountKey(HOST, USERNAME))) {
            bot.chat('/login smolbrain')
            enterHubIfConfigured()
        } else {
            // brand new server (or new account on a known server): register,
            // then log in shortly after (some auth plugins don't auto-login
            // on successful registration)
            bot.chat('/register smolbrain smolbrain')
            markHostRegistered(HOST, USERNAME)
            setTimeout(() => {
                bot.chat('/login smolbrain')
                enterHubIfConfigured()
            }, 1500)
        }
        reportStatus()
        bot.on('health', reportStatus)

        bot.pathfinder.setMovements(new Movements(bot))

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
            data: { connected: !!bot.entity, health: bot.health, totemModeActive, chatGamesEnabled }
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
        enableChatGames: () => {
            chatGamesEnabled = true
            bot.chat('Chat game solver enabled.')
            reportStatus()
        },
        disableChatGames: () => {
            chatGamesEnabled = false
            bot.chat('Chat game solver disabled.')
            reportStatus()
        },
        toggleChatGames: () => {
            chatGamesEnabled = !chatGamesEnabled
            bot.chat(`Chat game solver ${chatGamesEnabled ? 'enabled' : 'disabled'}.`)
            reportStatus()
        },
        walkToMe: (username) => {
            const target = username && bot.players[username] && bot.players[username].entity
            if (!target) {
                bot.chat(`Can't see ${username || 'you'}`)
                return
            }
            const { x, y, z } = target.position
            bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1))
        },
        stopWalking: () => bot.pathfinder.setGoal(null),
        build: (payload) => buildSchematic(payload),
        stopBuilding: () => { buildCancelled = true },
        listEntities: () => {
            const entities = Object.values(bot.entities)
                .filter(e => e !== bot.entity && e.position)
                .map(e => ({
                    type: e.type,
                    name: e.name || null,
                    username: e.username || null,
                    displayName: e.displayName ? e.displayName.toString() : null,
                    position: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) },
                    distance: bot.entity ? +e.position.distanceTo(bot.entity.position).toFixed(1) : null,
                }))
                .sort((a, b) => (a.distance || 0) - (b.distance || 0))
            log('ENTITY_REPORT', { count: entities.length, entities })
            console.log(`[ENTITIES] ${entities.length} nearby:`)
            entities.forEach(e => {
                const label = e.displayName || e.username || e.name || '?'
                console.log(`  [${e.type}] "${label}" @ (${e.position.x},${e.position.y},${e.position.z}) dist=${e.distance}`)
            })
            bot.chat(`Found ${entities.length} nearby entities, check console for details.`)
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
        } else if (message.includes('Meow, stop.')) {
            actions.stopWalking()
            actions.stopBuilding()
        } else if (isFromOperator(message) && message.includes('Meow, walk to me.')) {
            const requester = OPERATORS.find(name => message.includes(name))
            actions.walkToMe(requester)
        } else if (isFromOperator(message) && message.includes('Meow, build ')) {
            const match = message.match(/Meow, build (.+)/)
            if (match) actions.build(match[1])
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
        } else if (isFromOperator(message) && message.includes('Meow, enable chat games.')) {
            actions.enableChatGames()
        } else if (isFromOperator(message) && message.includes('Meow, disable chat games.')) {
            actions.disableChatGames()
        } else if (isFromOperator(message) && message.includes('Meow, toggle chat games.')) {
            actions.toggleChatGames()
        } else if (isFromOperator(message) && message.includes('Meow, list entities.')) {
            actions.listEntities()
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
