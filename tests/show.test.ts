import type { On } from 'claude-code'
import { describe, type Engine, expect, mock, test } from 'claude-code/testing'

import { localizePaths, parseGateway, projectSlug, toLocalPath, toWindowsPath } from '../hooks/paths.ts'

type Request = { url: string; body: Record<string, unknown> | undefined }

const TOOL = 'mcp__show-and-tell__show'
const PNG = 'iVBORw0KGgo='
const SESSION = 'session-1'
const BOARD_URL = `http://localhost:7777/s/${SESSION}`

/**
 * Stands in for the host: a board that is up (or not), a session in C:\repos\demo, image files that read as PNG,
 * and a Read tool that always succeeds.
 */
function fakeHost(on: On, options: { isUp?: boolean; inbox?: string[]; isFollowed?: boolean; boardRoot?: string } = {}) {
    const inbox = [...(options.inbox ?? [])]
    const prompts: string[] = []
    const requests: Request[] = []
    const commands: (readonly string[])[] = []
    const tools: { name: string; isDeferred?: boolean }[] = []
    let isUp = options.isUp ?? true
    let startedRoot: string | undefined
    let unseen = 2
    const session = () => ({
        url: BOARD_URL,
        pendingCount: 1,
        unseenCount: unseen,
        inReviewTitles: ['Login page', 'Header options'],
    })

    mock.env(on, { USERPROFILE: 'C:\\Users\\me' })
    const clock = mock.clock(on)

    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: SESSION }))
    on('tool.register', ($, e) => {
        tools.push(e)

        return { value: { tool: `mcp__show-and-tell__${e.name}` } }
    })
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('prompt.submit', ($, e) => {
        prompts.push(e.text)

        return { text: e.text }
    })
    on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'image' } }))
    on('session.root', () => ({ value: 'C:\\repos\\demo' }))
    on('fs.exists', () => ({ value: false }))
    on('fs.list', () => ({ value: [] }))
    on('fs.read', () => ({ value: { base64: PNG } }))

    on('process.run', ($, e) => {
        commands.push(e.argv)
        isUp = true
        // A board reports the plugin folder it was started from.
        startedRoot = e.argv.at(-1)?.match(/"(.+)\\server\\server\.mjs"/)?.[1] ?? startedRoot

        return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })

    on('http.fetch', ($, e) => {
        const body = e.init?.body ? (JSON.parse(e.init.body) as Record<string, unknown>) : undefined
        requests.push({ url: e.url, body })

        if (!isUp) {
            return { deny: 'connection refused' }
        }

        if (e.url.endsWith('/up')) {
            return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ root: startedRoot ?? options.boardRoot }) } }
        }

        if (e.url.endsWith('/shutdown')) {
            isUp = false

            return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
        }

        if (e.url.endsWith('/inbox')) {
            const messages = inbox.splice(0).map((text, index) => ({ id: String(index), text }))

            return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ messages, session: session() }) } }
        }

        if (/\/api\/sessions\/[^/]+$/.test(e.url)) {
            return options.isFollowed
                ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(session()) } }
                : { value: { status: 404, ok: false, headers: {}, text: '{}' } }
        }

        return { value: { status: 201, ok: true, headers: {}, text: JSON.stringify({ session: session() }) } }
    })

    return {
        clock,
        requests,
        setUnseen: (count: number) => {
            unseen = count
        },
        prompts,
        commands,
        tools,
        posts: (path: string) => requests.filter(one => one.body !== undefined && one.url.endsWith(path)),
    }
}

async function startSession($: Engine) {
    await $.session.start({ cwd: 'C:\\repos\\demo', surface: 'terminal', isInteractive: true })
}

function mountBand($: Engine) {
    return $.ui.mount({
        plugin: 'show-and-tell',
        surface: 'terminal',
        component: 'AbovePrompt',
        props: {
            hasSurvey: false,
            isWorking: false,
            maxRows: 10,
            bodyColumns: 100,
            scroll: { offset: 0, bodyRows: 10 },
            view: {},
        },
    })
}

describe('show', () => {
    test('is offered to the model from the first prompt', async ($, on) => {
        const host = fakeHost(on)
        await startSession($)

        expect(host.tools).toContainEqual(expect.objectContaining({ name: 'show', isDeferred: false }))
        expect(host.tools).toContainEqual(expect.objectContaining({ name: 'close_questions' }))
    })

    test('close_questions closes the questions the user answered in chat', async ($, on) => {
        const host = fakeHost(on)
        await startSession($)

        const answer = await $.tool.call({ tool: 'mcp__show-and-tell__close_questions' })

        expect(answer.deny).toBeUndefined()
        expect(host.posts('/status')[0]?.body).toEqual({ isAnswered: true })
    })

    test('posts a question with its labeled options', async ($, on) => {
        const host = fakeHost(on)
        await startSession($)

        const answer = await $.tool.call({
            tool: TOOL,
            title: 'Which fence?',
            description: 'Both fit the palette.',
            question: true,
            images: [{ path: 'C:\\shots\\white.png', label: 'White picket' }, 'C:\\shots\\wood.png', 'C:\\notes\\plan.md'],
        })

        expect(answer.deny).toBeUndefined()
        expect(String(answer.result)).toContain('Shown 2 image(s)')
        expect(String(answer.result)).toContain('plan.md')
        expect(String(answer.result)).toContain(
            'Board: 1 report(s) the user has not seen yet. In review: "Login page", "Header options".',
        )

        const [post] = host.posts('/events')
        expect(post?.url).toBe(`http://127.0.0.1:7777/api/sessions/${SESSION}/events`)
        expect(post?.body).toMatchObject({
            kind: 'question',
            title: 'Which fence?',
            text: 'Both fit the palette.',
            images: [
                { name: 'white.png', base64: PNG, label: 'White picket' },
                { name: 'wood.png', base64: PNG },
            ],
            session: { title: 'demo', cwd: 'C:\\repos\\demo', platform: 'windows' },
        })
    })

    test('starts the board when it is down', async ($, on) => {
        const host = fakeHost(on, { isUp: false })
        await startSession($)

        const call = $.tool.call({ tool: TOOL, title: 'First step', images: ['C:\\shots\\a.png'] })
        await host.clock.advance(2000)
        const answer = await call

        expect(answer.deny).toBeUndefined()
        expect(host.commands[0]?.[0]).toBe('powershell.exe')
        expect(host.commands[0]?.at(-1)).toContain('Start-Process')
        expect(host.commands[0]?.at(-1)).toContain('server\\server.mjs')
    })

    test('replaces a board that runs from another copy of the plugin', async ($, on) => {
        const host = fakeHost(on, { boardRoot: 'C:\\old\\show-and-tell' })
        await startSession($)

        const call = $.tool.call({ tool: TOOL, title: 'First step', images: ['C:\\shots\\a.png'] })
        await host.clock.advance(2000)
        const answer = await call

        expect(answer.deny).toBeUndefined()
        expect(host.requests.some(one => one.url.endsWith('/shutdown'))).toBe(true)
        expect(host.commands[0]?.at(-1)).toContain('Start-Process')
    })

    test('keeps a board that runs from this copy of the plugin', async ($, on) => {
        const host = fakeHost(on, { isUp: false })
        await startSession($)

        await $.tool.call({ tool: TOOL, title: 'First step', images: ['C:\\shots\\a.png'] })
        await $.tool.call({ tool: TOOL, title: 'Second step', images: ['C:\\shots\\b.png'] })

        expect(host.requests.some(one => one.url.endsWith('/shutdown'))).toBe(false)
        expect(host.commands).toHaveLength(1)
    })

    test('refuses a call without a title or a readable image', async ($, on) => {
        const host = fakeHost(on)
        await startSession($)

        const untitled = await $.tool.call({ tool: TOOL, title: ' ', images: ['C:\\shots\\a.png'] })
        const imageless = await $.tool.call({ tool: TOOL, title: 'Notes', images: ['C:\\notes\\plan.md'] })

        expect(untitled.deny).toContain('title')
        expect(imageless.deny).toContain('None of the images')
        expect(host.posts('/events')).toHaveLength(0)
    })
})

describe('access from Claude Code', () => {
    test('/show-and-tell opens the board for the session', async ($, on) => {
        const host = fakeHost(on)
        await startSession($)

        const ran = await $.command.run({
            command: 'show-and-tell',
            args: '',
            origin: { kind: 'composer' },
            presentation: { isFullscreen: true, columns: 120 },
        })

        expect(ran.text).toBe('Opened the board in Chrome.')
        expect(host.posts('/open')[0]?.url).toBe(`http://127.0.0.1:7777/api/sessions/${SESSION}/open`)
    })

    test('the band links the board once the session has shown something', async ($, on) => {
        fakeHost(on)
        await startSession($)
        await $.tool.call({ tool: TOOL, title: 'Start', images: ['C:\\shots\\a.png'] })

        const band = await mountBand($)

        expect((await band.find({ type: 'Link' }))?.props).toMatchObject({ href: BOARD_URL })
        expect(await band.find({ type: 'Text', text: /2 new/ })).toBeDefined()
        expect(await band.find({ type: 'Text', text: /1 to pick/ })).toBeDefined()
    })

    test('the band follows the board as the user looks at it', async ($, on) => {
        const host = fakeHost(on)
        await startSession($)
        await $.tool.call({ tool: TOOL, title: 'Start', images: ['C:\\shots\\a.png'] })

        host.setUnseen(0)
        await host.clock.advance(2000)
        const band = await mountBand($)

        expect(await band.find({ type: 'Text', text: /new/ })).toBeUndefined()
    })
})

describe('messages from the board', () => {
    test('arrive as the next prompt while Claude waits', async ($, on) => {
        const host = fakeHost(on, { inbox: ['Answer to "Which bed?": B (Double bed).'] })
        await startSession($)
        await $.tool.call({ tool: TOOL, title: 'Start', images: ['C:\\shots\\a.png'] })

        await host.clock.advance(2000)

        expect(host.prompts).toEqual(['Answer to "Which bed?": B (Double bed).'])
    })

    test('join the running turn while Claude works', async ($, on) => {
        const host = fakeHost(on, { inbox: ['About "Sofa" (sofa.png): too saturated'] })
        const session = mock.session(on)
        on('turn.start', ($, e) => ({ turnId: e.turnId }))
        await startSession($)
        await $.tool.call({ tool: TOOL, title: 'Start', images: ['C:\\shots\\a.png'] })
        await $.turn.start({ text: 'build the sofa', turnId: 'turn-1' })

        await host.clock.advance(2000)

        expect(host.prompts).toEqual([])
        expect(JSON.stringify(session.appended().map(row => row.message))).toContain('too saturated')
    })

    test('wait until the session has shown something', async ($, on) => {
        const host = fakeHost(on, { inbox: ['hello'] })
        await startSession($)

        await host.clock.advance(4000)

        expect(host.prompts).toEqual([])
    })
})

describe('session status', () => {
    test('a session reopened after it ended waits for the user again', async ($, on) => {
        const host = fakeHost(on, { isFollowed: true })

        await startSession($)

        expect(host.posts('/status').map(one => one.body?.status)).toEqual(['idle'])
    })

    test('a session the board never followed stays off it', async ($, on) => {
        const host = fakeHost(on)

        await startSession($)

        expect(host.posts('/status')).toHaveLength(0)
    })
})

describe('subagents', () => {
    test('report when they start and finish a run', async ($, on) => {
        const host = fakeHost(on)
        on('agent.list', () => ({ value: [{ id: 'agent-1', description: 'interior art', type: 'general-purpose', status: 'running' }] }))
        on('turn.start', ($, e) => ({ turnId: e.turnId }))
        on('turn.complete', ($, e) => ({ text: e.answer }))
        await startSession($)
        await $.tool.call({ tool: TOOL, title: 'Start', images: ['C:\\shots\\a.png'] })

        await $.turn.start({ text: 'paint the sofa', turnId: 'turn-1', agentId: 'agent-1' })
        await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn-1', agentId: 'agent-1', reason: 'answer' })

        expect(host.posts('/agents').map(one => one.body)).toMatchObject([
            { agent: 'interior art', isRunning: true },
            { agent: 'interior art', isRunning: false },
        ])
    })
})

describe('compactions', () => {
    test('are reported, and skipped ones are not', async ($, on) => {
        const host = fakeHost(on)
        const messages = [{ role: 'user' as const, text: 'paint the sofa', toolUses: [] }]
        let isSkipping = false
        on('session.compact', () => (isSkipping ? { skip: 'nothing to compact' } : { messages }))
        await startSession($)
        await $.tool.call({ tool: TOOL, title: 'Start', images: ['C:\\shots\\a.png'] })

        await $.session.compact({ trigger: 'auto', messages })
        isSkipping = true
        await $.session.compact({ trigger: 'manual', messages })

        expect(host.posts('/compactions').map(one => one.body)).toMatchObject([{ agent: null, trigger: 'auto' }])
    })
})

describe('what Claude sees', () => {
    test('waits until the session shows something, then arrives in the order read', async ($, on) => {
        const host = fakeHost(on)
        await startSession($)

        await $.tool.call({ tool: 'Read', file_path: 'C:\\refs\\fence.png' })
        await $.tool.call({ tool: 'Read', file_path: 'C:\\refs\\gate.png' })

        expect(host.posts('/events')).toHaveLength(0)

        await $.tool.call({ tool: TOOL, title: 'Start', images: ['C:\\shots\\a.png'] })

        const seen = host.posts('/events').filter(one => one.body?.kind === 'seen')
        expect(seen.map(one => one.body?.title)).toEqual(['fence.png', 'gate.png'])
        expect(seen[0]?.body).toMatchObject({ auto: true, at: expect.any(Number), images: [{ name: 'fence.png', base64: PNG }] })
    })

    test('read before /show-and-tell arrives once the board opens', async ($, on) => {
        const host = fakeHost(on)
        await startSession($)

        await $.tool.call({ tool: 'Read', file_path: 'C:\\refs\\fence.png' })
        await $.command.run({
            command: 'show-and-tell',
            args: '',
            origin: { kind: 'composer' },
            presentation: { isFullscreen: true, columns: 120 },
        })

        const seen = host.posts('/events').filter(one => one.body?.kind === 'seen')
        expect(seen.map(one => one.body?.title)).toEqual(['fence.png'])
    })

    test('keeps only the newest 30 reads made before the board follows the session', async ($, on) => {
        const host = fakeHost(on)
        await startSession($)

        for (let index = 0; index < 35; index++) {
            await $.tool.call({ tool: 'Read', file_path: `C:\\refs\\${index}.png` })
        }

        await $.tool.call({ tool: TOOL, title: 'Start', images: ['C:\\shots\\a.png'] })

        const seen = host.posts('/events').filter(one => one.body?.kind === 'seen')
        expect(seen).toHaveLength(30)
        expect(seen[0]?.body?.title).toBe('5.png')
    })

    test('sends each image the session reads once it has shown something', async ($, on) => {
        const host = fakeHost(on)
        await startSession($)

        await $.tool.call({ tool: TOOL, title: 'Start', images: ['C:\\shots\\a.png'] })
        await $.tool.call({ tool: 'Read', file_path: 'C:\\refs\\fence.png' })
        await $.tool.call({ tool: 'Read', file_path: 'C:\\refs\\notes.md' })

        const seen = host.posts('/events').filter(one => one.body?.kind === 'seen')
        expect(seen).toHaveLength(1)
        expect(seen[0]?.body).toMatchObject({
            auto: true,
            title: 'fence.png',
            images: [{ name: 'fence.png', base64: PNG }],
        })
    })

    test('tells what changed between two looks, and not what only searched', async ($, on) => {
        const host = fakeHost(on)
        on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }))
        on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }))
        on('tool.call', { tool: 'Grep' }, () => ({ result: 'found' }))
        await startSession($)
        await $.tool.call({ tool: TOOL, title: 'Start', images: ['C:\\shots\\a.png'] })

        await $.tool.call({ tool: 'Read', file_path: 'C:\\refs\\a.png' })
        await $.tool.call({ tool: 'Grep', pattern: 'fence' })
        await $.tool.call({ tool: 'Read', file_path: 'C:\\refs\\b.png' })
        await $.tool.call({ tool: 'Edit', file_path: 'C:\\repos\\fence.ts', old_string: 'a', new_string: 'b' })
        await $.tool.call({ tool: 'Edit', file_path: 'C:\\repos\\fence.ts', old_string: 'b', new_string: 'c' })
        await $.tool.call({ tool: 'Bash', command: 'render' })
        await $.tool.call({ tool: 'Read', file_path: 'C:\\refs\\c.png' })

        const changes = host.posts('/events').filter(one => one.body?.kind === 'seen').map(one => one.body?.changes)
        expect(changes).toEqual([undefined, undefined, { edits: 2, commands: 1, other: 0 }])
    })
})

describe('paths', () => {
    test('spell Windows and WSL paths for each host', () => {
        expect(toLocalPath('C:\\repos\\a.png', 'wsl')).toBe('/mnt/c/repos/a.png')
        expect(toLocalPath('/mnt/c/repos/a.png', 'windows')).toBe('C:\\repos\\a.png')
        expect(toLocalPath('/c/repos/a.png', 'windows')).toBe('C:\\repos\\a.png')
        expect(toLocalPath('/home/me/a.png', 'wsl')).toBe('/home/me/a.png')
        expect(toWindowsPath('/mnt/c/repos/show-and-tell', 'wsl')).toBe('C:\\repos\\show-and-tell')
        expect(toWindowsPath('/home/me/.claude/x.jsonl', 'wsl', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\x.jsonl')
        expect(toWindowsPath('C:\\repos', 'windows')).toBe('C:\\repos')
    })

    test('respell the paths inside a message for the host that reads it', () => {
        const text = 'About "Living": what is this?\nCrop: C:\\Users\\me\\crops\\a.png'

        expect(localizePaths(text, 'wsl')).toBe('About "Living": what is this?\nCrop: /mnt/c/Users/me/crops/a.png')
        expect(localizePaths(text, 'windows')).toBe(text)
    })

    test('name project folders and the WSL gateway as Claude Code and ip do', () => {
        expect(projectSlug('C:\\repos\\medieval-life')).toBe('C--repos-medieval-life')
        expect(projectSlug('/home/me/my_app')).toBe('-home-me-my-app')
        expect(parseGateway('default via 172.17.144.1 dev eth0 proto kernel')).toBe('172.17.144.1')
        expect(parseGateway('')).toBeUndefined()
    })
})
