import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const SERVER = join(import.meta.dirname, 'server.mjs');
const SESSION = 'session-1';
const running = [];

after(async () => {
    for (const board of running) {
        board.process.kill();
        await rm(board.dataDir, { recursive: true, force: true });
    }
});

function freePort() {
    return new Promise(resolve => {
        const probe = createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

/**
 * Starts a board on a free port over a fresh data folder, holding one session that already opened its page, so no
 * test opens Chrome. `events` are written to the session before the board starts.
 */
async function startBoard({ events = [], imageFiles = [] } = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'show-and-tell-test-'));
    const sessionDir = join(dataDir, 'sessions', SESSION);
    const now = Date.now();
    await mkdir(join(sessionDir, 'images'), { recursive: true });
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({
        id: SESSION, title: 'Test', status: 'idle', isOpened: true, createdAt: now, updatedAt: now,
    }));
    await writeFile(join(sessionDir, 'events.jsonl'), events.map(event => `${JSON.stringify(event)}\n`).join(''));

    for (const file of imageFiles) {
        await writeFile(join(sessionDir, 'images', file), file);
    }

    const port = await freePort();
    const child = spawn(process.execPath, [SERVER], {
        env: { ...process.env, SHOW_AND_TELL_PORT: String(port), SHOW_AND_TELL_DATA_DIR: dataDir },
        stdio: 'ignore',
    });
    const board = { process: child, dataDir, sessionDir, url: `http://127.0.0.1:${port}` };
    running.push(board);

    for (let tries = 0; tries < 100; tries++) {
        if (await fetch(`${board.url}/up`).then(response => response.ok, () => false)) {
            return board;
        }

        await new Promise(resolve => setTimeout(resolve, 50));
    }

    throw new Error('The board did not start.');
}

async function post(board, path, body = {}) {
    const response = await fetch(`${board.url}/api/sessions/${SESSION}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    return response.status === 204 ? null : response.json();
}

async function events(board) {
    const response = await fetch(`${board.url}/api/sessions/${SESSION}`);

    return (await response.json()).events;
}

/**
 * Asks again until the answer is not null, for state the board reaches a moment later.
 */
async function eventually(ask) {
    for (let tries = 0; tries < 40; tries++) {
        const answer = await ask();

        if (answer !== null) {
            return answer;
        }

        await new Promise(resolve => setTimeout(resolve, 50));
    }

    throw new Error('The board never got there.');
}

function image(text) {
    return { name: `${text}.png`, base64: Buffer.from(text).toString('base64') };
}

function read(title, extra = {}) {
    return { kind: 'seen', auto: true, title, images: [image(title)], ...extra };
}

test('tells which plugin folder it runs from, and stops on request', async () => {
    const board = await startBoard();

    const up = await (await fetch(`${board.url}/up`)).json();
    assert.equal(up.root, dirname(import.meta.dirname));

    const exited = new Promise(resolve => board.process.on('exit', resolve));
    await fetch(`${board.url}/shutdown`, { method: 'POST' });
    await exited;
    assert.equal(await fetch(`${board.url}/up`).then(() => true, () => false), false);
});

test('stores an image read and then shown once', async () => {
    const board = await startBoard();

    await post(board, '/events', read('sofa'));
    await post(board, '/events', { kind: 'progress', title: 'Sofa', images: [image('sofa')] });

    assert.equal((await events(board)).length, 2);
    assert.equal((await readdir(join(board.sessionDir, 'images'))).length, 1);
});

test('groups reads into looks split by what the agent changed in between', async () => {
    const board = await startBoard();

    await post(board, '/events', read('a'));
    await post(board, '/events', read('b'));
    await post(board, '/events', read('c', { changes: { edits: 2, commands: 1, other: 0 } }));
    await post(board, '/events', read('x', { agent: 'Helper' }));
    await post(board, '/events', read('a'));
    await post(board, '/events', read('d', { changes: { edits: 0, commands: 0, other: 0 } }));

    const looks = Object.fromEntries((await events(board)).map(event => [event.title, event]));
    assert.equal(looks.b.look, 1);
    assert.equal(looks.c.look, 2);
    assert.deepEqual(looks.c.changesBefore, { edits: 2, commands: 1, other: 0 });
    assert.equal(looks.x.look, 1, 'each agent counts its own looks');
    assert.equal(looks.a.look, 2, 'an image read again moves to the current look');
    assert.equal(looks.a.readCount, 2);
    assert.equal(looks.d.look, 2, 'no change keeps the look');
});

test('keeps the newest 100 reads, and at least 10 of each agent', async () => {
    const now = Date.now();
    const seen = (id, agent, at) => ({
        id, at, kind: 'seen', title: id, agent, images: [{ url: `/images/${SESSION}/${id}.png`, name: `${id}.png` }],
    });
    const helper = Array.from({ length: 15 }, (unused, index) => seen(`h${index}`, 'Helper', now - 3 * 86_400_000 + index));
    const main = Array.from({ length: 120 }, (unused, index) => seen(`m${index}`, null, now - 120_000 + index * 1000));
    const shown = { ...seen('shown', null, now), kind: 'progress', images: main[0].images };
    const board = await startBoard({
        events: [...helper, ...main, shown],
        imageFiles: [...helper, ...main].map(event => `${event.id}.png`),
    });

    // The board trims right after it starts listening.
    const kept = await eventually(async () => {
        const seenNow = (await events(board)).filter(event => event.kind === 'seen');

        return seenNow.length < helper.length + main.length ? seenNow : null;
    });
    const files = await readdir(join(board.sessionDir, 'images'));
    assert.equal(kept.filter(event => event.agent === null).length, 100);
    assert.deepEqual(kept.filter(event => event.agent === 'Helper').map(event => event.id), helper.slice(5).map(event => event.id));
    assert.ok(files.includes('m0.png'), 'a file a shown report uses stays');
    assert.equal(files.length, 111);
});

test('counts reports the person has not seen, and keeps reviewed ones apart', async () => {
    const board = await startBoard();

    const { eventId, session } = await post(board, '/events', { kind: 'progress', title: 'Login page', images: [image('login')] });
    assert.equal(session.unseenCount, 1);
    assert.deepEqual(session.inReviewTitles, ['Login page']);

    const viewed = await post(board, '/viewed', { eventIds: [eventId] });
    assert.equal(viewed.session.unseenCount, 0);

    const reviewed = await post(board, `/events/${eventId}/reviewed`, { isReviewed: true });
    assert.equal(reviewed.session.reviewedCount, 1);
    assert.deepEqual(reviewed.session.inReviewTitles, []);
});

test('hands the messages to the session once, with the board state', async () => {
    const board = await startBoard();
    const { eventId } = await post(board, '/events', { kind: 'progress', title: 'Sofa', images: [image('sofa')] });

    await post(board, '/messages', { eventId, imageIndex: 0, text: 'too saturated' });
    const first = await post(board, '/inbox');
    const second = await post(board, '/inbox');

    assert.deepEqual(first.messages.map(message => message.text), ['About "Sofa" (sofa.png): too saturated']);
    assert.equal(first.session.unseenCount, 1);
    assert.deepEqual(second.messages, []);
});

test('takes the status the session reports', async () => {
    const board = await startBoard();

    const { session } = await post(board, '/status', { status: 'ended' });
    assert.equal(session.status, 'ended');
});
