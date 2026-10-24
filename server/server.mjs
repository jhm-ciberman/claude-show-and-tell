import { exec, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, watch } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, extname, join } from 'node:path';

const PORT = Number(process.env.SHOW_AND_TELL_PORT ?? 7777);
const DATA_DIR = process.env.SHOW_AND_TELL_DATA_DIR ?? join(homedir(), '.claude', 'show-and-tell');
const PUBLIC_DIR = join(import.meta.dirname, 'public');
// The plugin folder this server runs from; the mod replaces a server that runs from another one.
const PLUGIN_ROOT = dirname(import.meta.dirname);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const TITLE_REFRESH_MS = 15_000;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LOOKED_AT_KEPT = 100;
const LOOKED_AT_KEPT_PER_AGENT = 10;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const KINDS = new Set(['progress', 'seen', 'question']);
const LAYOUTS = new Set(['grid', 'compare', 'collage', 'before-after', 'variations']);
const STATUSES = new Set(['working', 'idle', 'ended']);
const IMAGE_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
};

/** @type {Map<string, Session>} */
const sessions = new Map();

/** @type {Set<import('node:http').ServerResponse>} */
const streams = new Set();

/** @type {Map<string, import('node:http').Server>} */
const listeners = new Map();

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string} title
 * @property {string} cwd
 * @property {string} platform
 * @property {string | null} transcriptPath
 * @property {'working' | 'idle' | 'ended'} status
 * @property {boolean} isOpened
 * @property {boolean} isKept
 * @property {{ id: string, at: number, text: string }[]} inbox
 * @property {Record<string, { isRunning: boolean, at: number }>} agents
 * @property {Record<string, number[]>} compactions When each agent's context was compacted; '' is the main session.
 * @property {Record<string, number>} looks Each agent's current look; '' is the main session.
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} titleCheckedAt
 * @property {Event[]} events
 */

/**
 * @typedef {object} Event
 * @property {string} id
 * @property {number} at
 * @property {string} kind
 * @property {string} title
 * @property {string} text
 * @property {string | null} agent
 * @property {{ url: string, name: string, label: string | null, hash: string }[]} images
 * @property {number} readCount
 * @property {string} layout
 * @property {boolean} isMultiSelect
 * @property {{ choices: number[], other: string, notes: string } | null} answer
 * @property {boolean} isSeen
 * @property {boolean} isViewed
 * @property {boolean} isReviewed
 * @property {number} [look] For an image Claude read: which run of reads of its agent it belongs to, from 1.
 * @property {Changes | null} [changesBefore] What the agent did between the previous look and this one.
 */

/**
 * @typedef {object} Changes
 * @property {number} edits
 * @property {number} commands
 * @property {number} other
 */

function sessionDir(id) {
    return join(DATA_DIR, 'sessions', id);
}

function summary(session) {
    const { events, titleCheckedAt, inbox, ...rest } = session;
    const countImages = list => list.reduce((total, event) => total + event.images.length, 0);
    const seenCount = countImages(events.filter(event => event.kind === 'seen'));
    const imageCount = countImages(events);

    return {
        ...rest,
        url: `http://localhost:${PORT}/s/${session.id}`,
        imageCount,
        shownCount: imageCount - seenCount,
        seenCount,
        pendingCount: events.filter(isPending).length,
        // The newest reports the person keeps in review; Claude reads their titles.
        inReviewTitles: events.filter(isInReview).slice(-5).reverse().map(event => event.title),
        unseenCount: events.filter(isUnseen).length,
        reviewedCount: events.filter(event => event.isReviewed === true).length,
        waitingCount: inbox.length,
    };
}

function isPending(event) {
    return event.kind === 'question' && !event.isSeen;
}

/**
 * Whether a report is in review: shown, not a question, and not marked reviewed.
 */
function isInReview(event) {
    return event.kind !== 'seen' && event.images.length > 0 && !isPending(event) && event.isReviewed !== true;
}

/**
 * Whether the person has not even glanced at a report yet: the board marks one seen once it stays in view.
 */
function isUnseen(event) {
    return event.kind !== 'seen' && event.images.length > 0 && event.isViewed !== true && event.isReviewed !== true;
}

async function saveSession(session) {
    const { events, titleCheckedAt, ...meta } = session;
    await writeFile(join(sessionDir(session.id), 'session.json'), JSON.stringify(meta, null, 2));
}

async function saveEvents(session) {
    const lines = session.events.map(event => JSON.stringify(event)).join('\n');
    await writeFile(join(sessionDir(session.id), 'events.jsonl'), lines ? `${lines}\n` : '');
}

async function loadSessions() {
    const root = join(DATA_DIR, 'sessions');
    await mkdir(root, { recursive: true });

    for (const id of await readdir(root)) {
        try {
            const meta = JSON.parse(await readFile(join(root, id, 'session.json'), 'utf8'));
            const raw = await readFile(join(root, id, 'events.jsonl'), 'utf8').catch(() => '');
            const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
            sessions.set(id, { isKept: false, inbox: [], agents: {}, compactions: {}, looks: {}, ...meta, titleCheckedAt: 0, events });
        } catch (error) {
            console.error(`Skipping session ${id}: ${error.message}`);
        }
    }
}

async function directorySize(path) {
    let total = 0;

    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
        const child = join(path, entry.name);
        total += entry.isDirectory() ? await directorySize(child) : (await stat(child)).size;
    }

    return total;
}

async function deleteSession(id) {
    sessions.delete(id);
    await rm(sessionDir(id), { recursive: true, force: true });
    broadcast('removed', { sessionId: id });
}

/**
 * Keeps only the images Claude read most recently, at any age: the newest LOOKED_AT_KEPT of the session, plus
 * the newest LOOKED_AT_KEPT_PER_AGENT of each agent, so busy subagents never push another agent's out.
 */
async function trimLookedAt(session) {
    const newestFirst = session.events.filter(event => event.kind === 'seen').sort((a, b) => b.at - a.at);
    const keep = new Set(newestFirst.slice(0, LOOKED_AT_KEPT).map(event => event.id));
    const perAgent = new Map();

    for (const event of newestFirst) {
        const count = perAgent.get(event.agent) ?? 0;

        if (count < LOOKED_AT_KEPT_PER_AGENT) {
            keep.add(event.id);
            perAgent.set(event.agent, count + 1);
        }
    }

    const old = newestFirst.filter(event => !keep.has(event.id));

    if (old.length === 0) {
        return;
    }

    const ids = new Set(old.map(event => event.id));
    session.events = session.events.filter(event => !ids.has(event.id));
    const fileOf = image => image.url.split('/').pop();
    // A file a report still shows stays: the same image may have been read and shown.
    const inUse = new Set(session.events.flatMap(event => event.images.map(fileOf)));

    for (const file of old.flatMap(event => event.images.map(fileOf))) {
        if (!inUse.has(file)) {
            await rm(join(sessionDir(session.id), 'images', file), { force: true });
        }
    }

    await saveEvents(session);
    broadcast('session', { session: summary(session), seenIds: [], droppedIds: [...ids] });
}

/**
 * Deletes sessions idle for over a week, then the oldest ones until everything fits in the size budget, and
 * trims the images Claude read in the rest. Kept sessions are never touched, though they count toward the budget.
 */
async function prune() {
    const now = Date.now();
    const byAge = [...sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt);

    for (const session of byAge) {
        if (session.isKept) {
            continue;
        }

        if (now - session.updatedAt > MAX_AGE_MS) {
            await deleteSession(session.id);
        } else {
            await trimLookedAt(session);
        }
    }

    const sized = await Promise.all(
        [...sessions.values()].map(async session => ({ session, bytes: await directorySize(sessionDir(session.id)) })),
    );
    let total = sized.reduce((sum, one) => sum + one.bytes, 0);

    for (const { session, bytes } of sized.sort((a, b) => a.session.updatedAt - b.session.updatedAt)) {
        if (total <= MAX_TOTAL_BYTES) {
            break;
        }

        if (!session.isKept) {
            await deleteSession(session.id);
            total -= bytes;
        }
    }
}

/**
 * Reads the newest title Claude Code recorded for the session: a /rename title first, then the generated one.
 */
async function readTranscriptTitle(path) {
    let handle;

    try {
        handle = await open(path, 'r');
        const { size } = await handle.stat();
        const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const tail = buffer.toString('utf8');

        for (const field of ['customTitle', 'agentName', 'aiTitle']) {
            const matches = [...tail.matchAll(new RegExp(`"${field}":"((?:[^"\\\\]|\\\\.)*)"`, 'g'))];

            if (matches.length > 0) {
                return JSON.parse(`"${matches.at(-1)[1]}"`);
            }
        }
    } catch {
        // The transcript may not exist yet, or may live on a WSL distro that is not running.
    } finally {
        await handle?.close();
    }

    return null;
}

async function refreshTitle(session) {
    if (!session.transcriptPath || Date.now() - session.titleCheckedAt < TITLE_REFRESH_MS) {
        return;
    }

    session.titleCheckedAt = Date.now();
    const title = await readTranscriptTitle(session.transcriptPath);

    if (title && title !== session.title) {
        session.title = title;
        await saveSession(session);
    }
}

function broadcast(type, payload) {
    const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

    for (const response of streams) {
        response.write(message);
    }
}

/**
 * Opens a page in Chrome, or in the default browser where Chrome is not installed.
 */
function openInChrome(url) {
    if (process.platform === 'win32') {
        exec(`start "" chrome "${url}"`, { windowsHide: true }, error => {
            if (error) {
                console.error(`Could not open Chrome: ${error.message}`);
            }
        });

        return;
    }

    const command = process.platform === 'darwin'
        ? `open -a "Google Chrome" "${url}" || open "${url}"`
        : `google-chrome "${url}" || chromium "${url}" || xdg-open "${url}"`;

    // A browser started here may run for hours and talk a lot, so it is left on its own instead of awaited.
    spawn(command, { shell: true, stdio: 'ignore', detached: true }).unref();
}

function hashImage(base64) {
    return createHash('sha1').update(base64).digest('hex');
}

/**
 * When the event happened: the time the session gives for something it did by itself, unless it is ahead of now.
 */
function eventTime(body) {
    const now = Date.now();

    return body.auto === true && Number.isFinite(body.at) && body.at <= now ? body.at : now;
}

function readChanges(value) {
    const count = key => (Number.isInteger(value?.[key]) && value[key] > 0 ? value[key] : 0);
    const changes = { edits: count('edits'), commands: count('commands'), other: count('other') };

    return changes.edits + changes.commands + changes.other > 0 ? changes : null;
}

/**
 * Places an image an agent read in its current look, or starts the agent's next look when it changed something
 * since its last read.
 */
function placeInLook(session, agent, body) {
    const key = agent ?? '';
    const current = session.looks[key] ?? 0;
    const changes = readChanges(body.changes);
    const look = current === 0 || changes ? current + 1 : current;
    session.looks[key] = look;

    return { look, changesBefore: look === current ? null : changes };
}

/**
 * Counts a read of an image the same agent already read, by content, instead of storing it again.
 */
async function countRereading(session, body, place) {
    const agent = body.agent ? String(body.agent) : null;
    const hash = typeof body.images?.[0]?.base64 === 'string' ? hashImage(body.images[0].base64) : null;
    const index = session.events.findIndex(event =>
        event.kind === 'seen' && event.agent === agent && event.images[0]?.hash === hash,
    );

    if (hash === null || index === -1) {
        return null;
    }

    const [event] = session.events.splice(index, 1);
    event.readCount = (event.readCount ?? 1) + 1;
    event.at = eventTime(body);

    if (event.look !== place.look) {
        Object.assign(event, place);
    }

    session.events.push(event);
    session.updatedAt = Math.max(session.updatedAt, event.at);
    await saveEvents(session);
    await saveSession(session);
    broadcast('event', { session: summary(session), event });

    return { session, event };
}

async function storeImages(session, images) {
    const dir = join(sessionDir(session.id), 'images');
    await mkdir(dir, { recursive: true });
    const stored = [];

    for (const image of images) {
        const extension = extname(image.name ?? '').toLowerCase();

        if (!IMAGE_TYPES[extension] || typeof image.base64 !== 'string') {
            continue;
        }

        // Files are named by their content, so an image read and then shown is stored once.
        const hash = hashImage(image.base64);
        const file = `${hash}${extension}`;
        await writeFile(join(dir, file), Buffer.from(image.base64, 'base64'), { flag: 'wx' }).catch(error => {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        });
        stored.push({
            url: `/images/${session.id}/${file}`,
            name: image.name,
            label: typeof image.label === 'string' && image.label ? image.label : null,
            hash,
        });
    }

    return stored;
}

async function createSession(id, fields) {
    const now = Date.now();
    const session = {
        id,
        title: fields?.title ?? id.slice(0, 8),
        cwd: fields?.cwd ?? '',
        platform: fields?.platform ?? 'unknown',
        transcriptPath: fields?.transcriptPath ?? null,
        status: 'working',
        isOpened: false,
        isKept: false,
        inbox: [],
        agents: {},
        compactions: {},
        looks: {},
        createdAt: now,
        updatedAt: now,
        titleCheckedAt: 0,
        events: [],
    };

    sessions.set(id, session);
    await mkdir(sessionDir(id), { recursive: true });

    return session;
}

async function addEvent(id, body) {
    const isAuto = body.auto === true;
    const session = sessions.get(id) ?? (isAuto ? null : await createSession(id, body.session));

    if (!session) {
        return null;
    }

    if (body.session?.transcriptPath) {
        session.transcriptPath = body.session.transcriptPath;
    }

    const kind = KINDS.has(body.kind) ? body.kind : 'progress';
    const agent = body.agent ? String(body.agent) : null;
    const place = kind === 'seen' ? placeInLook(session, agent, body) : null;
    const reread = place ? await countRereading(session, body, place) : null;

    if (reread) {
        return reread;
    }

    const event = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        at: eventTime(body),
        kind,
        title: String(body.title ?? ''),
        text: String(body.text ?? ''),
        agent,
        images: await storeImages(session, Array.isArray(body.images) ? body.images : []),
        readCount: 1,
        layout: LAYOUTS.has(body.layout) ? body.layout : 'grid',
        isMultiSelect: body.isMultiSelect === true,
        answer: null,
        isSeen: false,
        ...place,
    };

    session.events.push(event);
    session.updatedAt = Math.max(session.updatedAt, event.at);
    session.status = 'working';

    await refreshTitle(session);
    await appendFile(join(sessionDir(id), 'events.jsonl'), `${JSON.stringify(event)}\n`);

    const shouldOpen = !session.isOpened && !isAuto;

    if (shouldOpen) {
        session.isOpened = true;
    }

    await saveSession(session);
    broadcast('event', { session: summary(session), event });

    if (shouldOpen) {
        openInChrome(summary(session).url);
    }

    if (kind === 'seen' && !session.isKept) {
        await trimLookedAt(session);
    }

    return { session, event };
}

/**
 * Applies a status change of a session the dashboard follows. Answering closes every open question.
 */
async function updateStatus(id, body) {
    const session = sessions.get(id);

    if (!session) {
        return null;
    }

    if (STATUSES.has(body.status)) {
        session.status = body.status;
    }

    const answered = body.isAnswered === true ? session.events.filter(isPending) : [];

    for (const event of answered) {
        event.isSeen = true;
    }

    if (answered.length > 0) {
        await saveEvents(session);
    }

    session.updatedAt = Date.now();
    await saveSession(session);
    broadcast('session', { session: summary(session), seenIds: answered.map(event => event.id) });

    return session;
}

/**
 * Opens the session's page in Chrome, starting to follow the session if the board did not yet.
 */
async function openSession(id, body) {
    const session = sessions.get(id) ?? (await createSession(id, body.session));
    session.isOpened = true;
    await saveSession(session);
    broadcast('session', { session: summary(session), seenIds: [] });
    openInChrome(summary(session).url);

    return session;
}

/**
 * Words an answer the way Claude reads it: the options picked, by letter and label, then the notes.
 */
function describeAnswer(event, answer) {
    const picked = answer.choices.map(index => {
        const label = event.images[index]?.label;

        return label ? `${LETTERS[index]} (${label})` : LETTERS[index];
    });

    if (answer.other) {
        picked.push(`something else: ${answer.other}`);
    }

    const lines = [`Answer to "${event.title}": ${picked.join(', ') || 'no option picked'}.`];

    if (answer.notes) {
        lines.push(`Notes: ${answer.notes}`);
    }

    return lines.join('\n');
}

/**
 * Words what the person sent from the board as the message Claude reads: an answer to a question, a note
 * about one image, or a plain message.
 */
function composeMessage(session, body) {
    const event = session.events.find(one => one.id === body.eventId);
    const text = String(body.text ?? '').trim();

    if (event && body.answer) {
        const answer = {
            choices: (Array.isArray(body.answer.choices) ? body.answer.choices : [])
                .filter(index => Number.isInteger(index) && event.images[index]),
            other: String(body.answer.other ?? '').trim(),
            notes: String(body.answer.notes ?? '').trim(),
        };

        if (answer.choices.length === 0 && !answer.other) {
            return null;
        }

        event.answer = answer;
        event.isSeen = true;
        event.isViewed = true;

        return describeAnswer(event, answer);
    }

    if (!text) {
        return null;
    }

    const image = event?.images[body.imageIndex];

    return image ? `About "${event.title}" (${image.name}): ${text}` : text;
}

/**
 * Queues a message for Claude, which the session's mod picks up within a few seconds.
 */
async function queueMessage(id, body) {
    const session = sessions.get(id);
    const text = session ? composeMessage(session, body) : null;

    if (!session || !text) {
        return null;
    }

    const message = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), text };
    session.inbox.push(message);
    await saveSession(session);
    await saveEvents(session);
    const answered = session.events.find(event => event.id === body.eventId && body.answer);
    broadcast('session', {
        session: summary(session),
        seenIds: answered ? [answered.id] : [],
        viewedIds: answered ? [answered.id] : [],
        answers: answered ? [{ eventId: answered.id, answer: answered.answer }] : [],
    });

    return message;
}

function decodePng(base64) {
    return Buffer.from(String(base64 ?? '').replace(/^data:image\/png;base64,/, ''), 'base64');
}

/**
 * Queues a question about one area of an image: the area cut out, and the whole image with the area outlined,
 * saved with the session (so they go when it goes) for Claude to open.
 */
async function queueAreaQuestion(id, body) {
    const session = sessions.get(id);
    const event = session?.events.find(one => one.id === body.eventId);
    const image = event?.images[body.imageIndex];
    const text = String(body.text ?? '').trim();
    const box = body.box ?? {};

    if (!image || !text || typeof body.crop !== 'string' || typeof body.marked !== 'string') {
        return null;
    }

    const dir = join(sessionDir(id), 'crops');
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const crop = join(dir, `${stamp}.png`);
    const marked = join(dir, `${stamp}-marked.png`);
    await mkdir(dir, { recursive: true });
    await writeFile(crop, decodePng(body.crop));
    await writeFile(marked, decodePng(body.marked));

    const area = `x ${box.x0}-${box.x1}, y ${box.y0}-${box.y1} of ${box.width}x${box.height}`;

    return queueText(session, [
        `About "${event.title}" (${image.name}), the marked area (${area}): ${text}`,
        `Crop: ${crop}`,
        `Marked: ${marked}`,
    ].join('\n'));
}

async function queueText(session, text) {
    const message = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), text };
    session.inbox.push(message);
    await saveSession(session);
    broadcast('session', { session: summary(session), seenIds: [] });

    return message;
}

/**
 * Hands the waiting messages to Claude and empties the inbox.
 */
async function takeMessages(id) {
    const session = sessions.get(id);

    if (!session || session.inbox.length === 0) {
        return [];
    }

    const messages = session.inbox;
    session.inbox = [];
    await saveSession(session);
    broadcast('delivered', { session: summary(session), messageIds: messages.map(message => message.id) });

    return messages;
}

/**
 * Records that the person saw the given reports.
 */
async function markViewed(id, eventIds) {
    const session = sessions.get(id);

    if (!session) {
        return null;
    }

    const ids = new Set(Array.isArray(eventIds) ? eventIds : []);
    const viewed = session.events.filter(event => ids.has(event.id) && event.isViewed !== true);

    for (const event of viewed) {
        event.isViewed = true;
    }

    if (viewed.length > 0) {
        await saveEvents(session);
        broadcast('session', { session: summary(session), seenIds: [], viewedIds: viewed.map(event => event.id) });
    }

    return session;
}

/**
 * Marks every report still in review as reviewed.
 */
async function markAllReviewed(id) {
    const session = sessions.get(id);

    if (!session) {
        return null;
    }

    const reviewed = session.events.filter(isInReview);

    for (const event of reviewed) {
        event.isReviewed = true;
    }

    if (reviewed.length > 0) {
        await saveEvents(session);
        broadcast('session', {
            session: summary(session),
            seenIds: [],
            reviewed: reviewed.map(event => ({ eventId: event.id, isReviewed: true })),
        });
    }

    return session;
}

/**
 * Marks a report reviewed, which moves it to the Reviewed tab, or moves it back in review.
 */
async function setReviewed(sessionId, eventId, isReviewed) {
    const session = sessions.get(sessionId);
    const event = session?.events.find(one => one.id === eventId);

    if (!event) {
        return null;
    }

    event.isReviewed = isReviewed;
    await saveEvents(session);
    broadcast('session', { session: summary(session), seenIds: [], reviewed: [{ eventId, isReviewed }] });

    return session;
}

/**
 * Records that a subagent of the session started or finished a run, keyed by the name the board shows it under.
 */
async function setAgentStatus(id, body) {
    const session = sessions.get(id);

    if (!session || typeof body.agent !== 'string' || !body.agent) {
        return null;
    }

    session.agents[body.agent] = { isRunning: body.isRunning === true, at: Date.now() };
    await saveSession(session);
    broadcast('session', { session: summary(session), seenIds: [] });

    return session;
}

/**
 * Records that an agent's context was compacted now: the images it read before are no longer in its context.
 */
async function addCompaction(id, body) {
    const session = sessions.get(id);

    if (!session) {
        return null;
    }

    const key = typeof body.agent === 'string' ? body.agent : '';
    session.compactions[key] = [...(session.compactions[key] ?? []), Date.now()];
    await saveSession(session);
    broadcast('session', { session: summary(session), seenIds: [] });

    return session;
}

async function setKept(id, isKept) {
    const session = sessions.get(id);

    if (!session) {
        return null;
    }

    session.isKept = isKept;
    await saveSession(session);
    broadcast('session', { session: summary(session), seenIds: [] });

    return session;
}

async function markSeen(sessionId, eventId) {
    const session = sessions.get(sessionId);
    const event = session?.events.find(one => one.id === eventId);

    if (!event) {
        return false;
    }

    event.isSeen = true;
    await saveEvents(session);
    broadcast('session', { session: summary(session), seenIds: [eventId] });

    return true;
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        request.on('data', chunk => {
            size += chunk.length;

            if (size > MAX_BODY_BYTES) {
                reject(new Error('Body too large'));
                request.destroy();

                return;
            }

            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

function sendJson(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
}

function sendNoContent(response) {
    response.writeHead(204);
    response.end();
}

async function sendFile(response, path, contentType) {
    try {
        const info = await stat(path);
        response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': info.size });
        createReadStream(path).pipe(response);
    } catch {
        sendJson(response, 404, { error: 'Not found' });
    }
}

async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method;

    if (method === 'GET' && url.pathname === '/up') {
        sendJson(response, 200, { root: PLUGIN_ROOT });

        return;
    }

    if (method === 'POST' && url.pathname === '/shutdown') {
        sendJson(response, 200, {});
        response.on('finish', () => void stop().then(() => process.exit(0)));

        return;
    }

    if (method === 'GET' && (url.pathname === '/' || parts[0] === 's')) {
        await sendFile(response, join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');

        return;
    }

    if (method === 'GET' && url.pathname === '/stream-worker.js') {
        await sendFile(response, join(PUBLIC_DIR, 'stream-worker.js'), 'text/javascript; charset=utf-8');

        return;
    }

    if (method === 'GET' && parts[0] === 'images' && parts.length === 3) {
        const [, sessionId, file] = parts;
        const type = IMAGE_TYPES[extname(file).toLowerCase()];

        if (!sessions.has(sessionId) || !type || file.includes('..')) {
            sendJson(response, 404, { error: 'Not found' });

            return;
        }

        await sendFile(response, join(sessionDir(sessionId), 'images', file), type);

        return;
    }

    if (method === 'GET' && url.pathname === '/api/stream') {
        response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        response.write(': connected\n\n');
        streams.add(response);
        request.on('close', () => streams.delete(response));

        return;
    }

    if (parts[0] !== 'api' || parts[1] !== 'sessions') {
        sendJson(response, 404, { error: 'Not found' });

        return;
    }

    const [, , sessionId, child, eventId, action] = parts;

    if (method === 'GET' && !sessionId) {
        const list = [...sessions.values()].map(summary).sort((a, b) => b.updatedAt - a.updatedAt);
        sendJson(response, 200, list);

        return;
    }

    if (method === 'GET' && sessionId && !child) {
        const session = sessions.get(sessionId);

        if (!session) {
            sendJson(response, 404, { error: 'Unknown session' });

            return;
        }

        await refreshTitle(session);
        sendJson(response, 200, { ...summary(session), events: session.events });

        return;
    }

    if (method === 'POST' && sessionId && child === 'status') {
        const updated = await updateStatus(sessionId, JSON.parse(await readBody(request)));

        if (updated) {
            sendJson(response, 200, { session: summary(updated) });
        } else {
            sendNoContent(response);
        }

        return;
    }

    if (method === 'POST' && sessionId && child === 'messages') {
        const message = await queueMessage(sessionId, JSON.parse(await readBody(request)));
        sendJson(response, message ? 201 : 422, message ? { message } : { error: 'Nothing to send' });

        return;
    }

    if (method === 'POST' && sessionId && child === 'areas') {
        const message = await queueAreaQuestion(sessionId, JSON.parse(await readBody(request)));
        sendJson(response, message ? 201 : 422, message ? { message } : { error: 'Nothing to send' });

        return;
    }

    if (method === 'POST' && sessionId && child === 'inbox') {
        const messages = await takeMessages(sessionId);
        const session = sessions.get(sessionId);
        sendJson(response, 200, { messages, session: session ? summary(session) : undefined });

        return;
    }

    if (method === 'POST' && sessionId && child === 'viewed') {
        const updated = await markViewed(sessionId, JSON.parse(await readBody(request)).eventIds);
        sendJson(response, updated ? 200 : 404, updated ? { session: summary(updated) } : { error: 'Unknown session' });

        return;
    }

    if (method === 'POST' && sessionId && child === 'reviewed') {
        const updated = await markAllReviewed(sessionId);
        sendJson(response, updated ? 200 : 404, updated ? { session: summary(updated) } : { error: 'Unknown session' });

        return;
    }

    if (method === 'POST' && sessionId && child === 'compactions') {
        const updated = await addCompaction(sessionId, JSON.parse(await readBody(request)));

        if (updated) {
            sendJson(response, 200, { session: summary(updated) });
        } else {
            sendNoContent(response);
        }

        return;
    }

    if (method === 'POST' && sessionId && child === 'agents') {
        const updated = await setAgentStatus(sessionId, JSON.parse(await readBody(request)));

        if (updated) {
            sendJson(response, 200, { session: summary(updated) });
        } else {
            sendNoContent(response);
        }

        return;
    }

    if (method === 'POST' && sessionId && child === 'keep') {
        const kept = await setKept(sessionId, JSON.parse(await readBody(request)).isKept === true);
        sendJson(response, kept ? 200 : 404, kept ? { session: summary(kept) } : { error: 'Unknown session' });

        return;
    }

    if (method === 'POST' && sessionId && child === 'open') {
        const opened = await openSession(sessionId, JSON.parse(await readBody(request)));
        sendJson(response, 200, { session: summary(opened) });

        return;
    }

    if (method === 'POST' && sessionId && child === 'events' && !eventId) {
        const added = await addEvent(sessionId, JSON.parse(await readBody(request)));

        if (!added) {
            sendNoContent(response);

            return;
        }

        sendJson(response, 201, { eventId: added.event.id, session: summary(added.session) });

        return;
    }

    if (method === 'POST' && sessionId && child === 'events' && eventId && action === 'reviewed') {
        const updated = await setReviewed(sessionId, eventId, JSON.parse(await readBody(request)).isReviewed === true);
        sendJson(response, updated ? 200 : 404, updated ? { session: summary(updated) } : { error: 'Unknown event' });

        return;
    }

    if (method === 'POST' && sessionId && child === 'events' && eventId && action === 'seen') {
        const isMarked = await markSeen(sessionId, eventId);
        sendJson(response, isMarked ? 200 : 404, { isMarked });

        return;
    }

    sendJson(response, 404, { error: 'Not found' });
}

/**
 * The loopback address, plus the Windows side of the WSL virtual network so WSL sessions can reach the server.
 */
function listenAddresses() {
    const addresses = ['127.0.0.1'];

    for (const [name, entries] of Object.entries(networkInterfaces())) {
        if (!name.includes('WSL')) {
            continue;
        }

        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4') {
                addresses.push(entry.address);
            }
        }
    }

    return addresses;
}

let isStopping = false;

function syncListeners() {
    if (isStopping) {
        return;
    }

    for (const address of listenAddresses()) {
        if (listeners.has(address)) {
            continue;
        }

        const server = createServer((request, response) => {
            handle(request, response).catch(error => {
                console.error(error);

                if (!response.headersSent) {
                    sendJson(response, 500, { error: error.message });
                }
            });
        });

        server.on('error', error => {
            listeners.delete(address);

            if (address === '127.0.0.1' && error.code === 'EADDRINUSE') {
                console.error(`Port ${PORT} is taken: another dashboard is already running.`);
                process.exit(0);
            }

            console.error(`Could not listen on ${address}:${PORT}: ${error.message}`);
        });

        server.listen(PORT, address, () => console.log(`Listening on http://${address}:${PORT}`));
        listeners.set(address, server);
    }
}

function pruneQuietly() {
    prune().catch(error => console.error(`Pruning failed: ${error.message}`));
}

/**
 * Stops listening and drops every open connection, the event streams included, which the board pages reopen.
 */
function stop() {
    isStopping = true;
    const closing = [...listeners.values()].map(server => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    listeners.clear();

    return Promise.all(closing);
}

/**
 * Hands over to a fresh copy of this server, started from the file as it is now on disk.
 */
async function restart() {
    await stop();
    spawn(process.execPath, [import.meta.filename], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    process.exit(0);
}

/**
 * Restarts the server once its own code changes, so an edit takes effect without anyone stopping it.
 */
function watchOwnCode() {
    let timer = null;

    // Editors often replace a file instead of writing it in place, so the folder is watched, not the file.
    watch(import.meta.dirname, (eventType, name) => {
        if (name === 'server.mjs') {
            clearTimeout(timer);
            timer = setTimeout(() => void restart(), 500);
        }
    });
}

await loadSessions();
syncListeners();
pruneQuietly();
watchOwnCode();

// The WSL interface appears only once WSL starts, which may be after the dashboard did.
setInterval(syncListeners, 15_000);
setInterval(pruneQuietly, PRUNE_EVERY_MS);

// Proxies drop idle event streams; a comment line keeps them open.
setInterval(() => {
    for (const response of streams) {
        response.write(': ping\n\n');
    }
}, 25_000);
