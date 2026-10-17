import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ShowAndTellBoard } from '../types'
import {
    baseName,
    type Host,
    imageType,
    localizePaths,
    parseGateway,
    projectSlug,
    toLocalPath,
    toWindowsPath,
} from './paths.ts'

const PORT = 7777
const TOOL = 'mcp__show-and-tell__show'
const CLOSE_TOOL = 'mcp__show-and-tell__close_questions'
const LAYOUTS = ['grid', 'compare', 'collage', 'before-after', 'variations'] as const
const PROBE_TIMEOUT_MS = 1000
const AUTO_TIMEOUT_MS = 2000
const START_TIMEOUT_MS = 8000
const INBOX_EVERY_MS = 2000

const DESCRIPTION = `Show images to the user on their live image board: a Chrome tab that follows this session. The user cannot watch you work and does not want to read here: the board is for pictures, and you talk in chat.

Show early and often, so the user can stop a wrong direction before you build on it:
- every screenshot, render or generated image you produce, right after you produce it,
- the options you want the user to pick from (question: true, one labeled image per option, and ask in chat too).

One call is one report and its images stay together: show the login page and the settings page as two calls. Pick a layout that fits: compare for versions of one thing, before-after for a change, collage for many pieces, variations for numbered variants.

Each call answers with the board's state. Reports the user has not seen yet mean they are away: send fewer, grouped reports (a collage) rather than many. Reports in review are the user's own list of what they are comparing right now; the ones they marked reviewed are settled.

The user can answer a question, comment on an image or write to you from the board. Their words reach you as a message, during your turn or as their next prompt. A question stays open on the board until it is answered there: when the user answers it in chat instead, close it with close_questions.

Keep the title short. Add a description only when it tells something the picture cannot: the board shows its first line on the card, and the viewer shows it whole.
The images you open with Read appear on the board by themselves: do not show them again.
The first call opens the board in Chrome.`

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        title: {
            type: 'string',
            description: 'A short caption, like "Login page, mobile" or "Which header layout?".',
        },
        images: {
            type: 'array',
            description: 'The images: PNG, JPG, GIF, WEBP or SVG files up to 4 MiB each, by absolute path (Windows and WSL paths both work), or { path, label } to label an option.',
            items: {
                anyOf: [
                    { type: 'string' },
                    {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            label: { type: 'string', description: 'A few words, like "Dark theme".' },
                        },
                        required: ['path'],
                    },
                ],
            },
        },
        question: {
            type: 'boolean',
            description: 'Ask the user to pick from the images, one option each: the board pins it on top until it is answered. Default false.',
        },
        description: {
            type: 'string',
            description: 'An optional short note about the images, like what changed or what to look at: one line on the card, whole in the viewer. For a question, one line of context.',
        },
        multiSelect: {
            type: 'boolean',
            description: 'For a question: let the user pick several options. Default false.',
        },
        layout: {
            type: 'string',
            enum: LAYOUTS,
            description: 'How the images of one call are laid out. grid: a plain set (default). compare: 2 to 4 versions of the same thing side by side, the same size, labels under them. collage: many pieces packed tight, like "every screen so far". before-after: exactly 2 images, the first the before, stacked under a slider. variations: numbered variants of one thing. A question always shows its options as choices.',
        },
    },
    required: ['title', 'images'],
} as const

type Status = 'working' | 'idle' | 'ended'

type ShowInput = {
    title?: unknown
    images?: unknown
    question?: unknown
    description?: unknown
    multiSelect?: unknown
    layout?: unknown
}

type InboxResponse = {
    messages?: { id: string; text: string }[]
}

type ImageRequest = {
    path: string
    label?: string
}

type Image = {
    name: string
    base64: string
    label?: string
}

type Environment = {
    host: Host
    distro?: string
    baseUrl: string
}

/**
 * What an agent did between two of its image reads.
 */
type Changes = {
    edits: number
    commands: number
    other: number
}

type EventBody = {
    kind: 'seen'
    title: string
    agent: string | null
    images: Image[]
    changes?: Changes
}

type BoardResponse = {
    session?: {
        url: string
        unseenCount?: number
        pendingCount?: number
        inReviewTitles?: string[]
    }
}

/**
 * The board's state as Claude reads it after showing: what the user has not looked at, besides the report just
 * shown, and what they keep in review.
 */
function describeBoard(session: NonNullable<BoardResponse['session']>): string {
    // The report just shown is always unseen yet, so it says nothing about whether the user is away.
    const unseen = Math.max(0, (session.unseenCount ?? 0) - 1)
    const titles = session.inReviewTitles ?? []
    const seen = unseen ? `${unseen} report(s) the user has not seen yet` : 'The user has seen every report'
    const review = titles.length
        ? `In review: ${titles.map(title => `"${title}"`).join(', ')}`
        : 'Nothing in review: the user marked every report reviewed'

    return `Board: ${seen}. ${review}.`
}

const board = atom({ plugin: 'show-and-tell', key: 'board' } as const, null)

let environment: Promise<Environment> | undefined

// Whether each session has shown something on the board; its own events wait until it has.
const activity = new Map<string, boolean>()

const transcripts = new Map<string, string | null>()

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])
// Tools that only look, search or talk: running them between image reads keeps the reads in one look.
const LOOKING_TOOLS = new Set([
    'Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'TodoWrite', 'AskUserQuestion', 'WebSearch', 'WebFetch', 'Skill', 'LSP',
    TOOL, CLOSE_TOOL,
])

// What each agent did since its last image read, by agent id; '' is the main session.
const pendingChanges = new Map<string, Changes>()

function noteChange(agentKey: string, tool: string): void {
    const changes = pendingChanges.get(agentKey) ?? { edits: 0, commands: 0, other: 0 }
    const kind = EDIT_TOOLS.has(tool) ? 'edits' : COMMAND_TOOLS.has(tool) ? 'commands' : 'other'
    changes[kind]++
    pendingChanges.set(agentKey, changes)
}

/**
 * Hands over what an agent did since its last image read, and starts counting afresh.
 */
function takeChanges(agentKey: string): Changes | undefined {
    const changes = pendingChanges.get(agentKey)
    pendingChanges.delete(agentKey)

    return changes
}

let isTurnRunning = false
let isDelivering = false

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

async function withTimeout<T>($: EngineInterface, promise: Promise<T>, ms: number): Promise<T | undefined> {
    const timeout = $.clock.sleep(ms).then(
        () => undefined,
        () => new Promise<undefined>(() => {}),
    )

    return Promise.race([promise.catch(() => undefined), timeout])
}

async function detectEnvironment($: EngineInterface): Promise<Environment> {
    const distro = await $.env.get('WSL_DISTRO_NAME')

    if (distro) {
        const { stdout } = await $.process.run(['ip', 'route', 'show', 'default'])

        return { host: 'wsl', distro, baseUrl: `http://${parseGateway(stdout) ?? '127.0.0.1'}:${PORT}` }
    }

    const host: Host = /^[A-Za-z]:/.test($.plugin.root) ? 'windows' : 'posix'

    return { host, baseUrl: `http://127.0.0.1:${PORT}` }
}

function getEnvironment($: EngineInterface): Promise<Environment> {
    environment ??= detectEnvironment($).catch(error => {
        environment = undefined
        throw error
    })

    return environment
}

/**
 * The plugin folder the running board was started from: undefined when no board answers, and null when the board
 * does not say.
 */
async function runningRoot($: EngineInterface, env: Environment): Promise<string | null | undefined> {
    const response = await withTimeout($, $.http.fetch(`${env.baseUrl}/up`), PROBE_TIMEOUT_MS)

    if (response?.ok !== true) {
        return undefined
    }

    try {
        return (JSON.parse(response.text) as { root?: string }).root ?? null
    } catch {
        return null
    }
}

/**
 * This plugin's folder as the board spells it: the board runs on Windows unless the session runs elsewhere.
 */
function ownRoot($: EngineInterface, env: Environment): string {
    return toWindowsPath($.plugin.root, env.host, env.distro).replace(/[\\/]+$/, '')
}

function isSameFolder(a: string, b: string): boolean {
    const normalize = (path: string) => path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()

    return normalize(a) === normalize(b)
}

/**
 * Waits until the board is up or down, as asked; says whether it got there in time.
 */
async function waitForBoard($: EngineInterface, env: Environment, isUp: boolean): Promise<boolean> {
    const startedAt = await $.clock.now()

    while ((await $.clock.now()) - startedAt < START_TIMEOUT_MS) {
        if (((await runningRoot($, env)) !== undefined) === isUp) {
            return true
        }

        await $.clock.sleep(250)
    }

    return false
}

async function startServer($: EngineInterface, env: Environment): Promise<void> {
    if (env.host === 'posix') {
        const script = `${$.plugin.root}/server/server.mjs`
        await $.process.run(['sh', '-c', 'nohup node "$0" >/dev/null 2>&1 &', script])

        return
    }

    // The board always runs on Windows, so Chrome opens there and every session, Windows or WSL, shares it.
    const script = `${ownRoot($, env)}\\server\\server.mjs`.replaceAll("'", "''")
    const command = `Start-Process -WindowStyle Hidden -FilePath node -ArgumentList '"${script}"'`

    await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command], {
        cwd: env.host === 'wsl' ? '/mnt/c' : undefined,
        timeoutMs: 15_000,
    })
}

/**
 * Makes sure the board runs this copy of the plugin: starts it when it is down, and replaces one started from
 * another folder, such as the copy before an update.
 */
async function ensureServer($: EngineInterface): Promise<Environment> {
    const env = await getEnvironment($)
    const root = await runningRoot($, env)

    if (root && isSameFolder(root, ownRoot($, env))) {
        return env
    }

    if (root !== undefined) {
        await withTimeout($, $.http.fetch(`${env.baseUrl}/shutdown`, { method: 'POST' }), PROBE_TIMEOUT_MS)

        // A board too old to shut down on request keeps serving rather than leaving the session without one.
        if (!(await waitForBoard($, env, false))) {
            return env
        }
    }

    await startServer($, env)

    if (!(await waitForBoard($, env, true))) {
        throw new Error(`the board did not start on ${env.baseUrl}`)
    }

    return env
}

async function findTranscript($: EngineInterface, env: Environment, sessionId: string, cwd: string): Promise<string | null> {
    if (transcripts.has(sessionId)) {
        return transcripts.get(sessionId) ?? null
    }

    const home = env.host === 'windows' ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
    const projects = `${configDir}/projects`
    const file = `${sessionId}.jsonl`
    let found: string | null = null

    try {
        const guess = `${projects}/${projectSlug(cwd)}/${file}`

        if (await $.fs.exists(guess)) {
            found = guess
        } else {
            for (const entry of await $.fs.list(projects)) {
                const candidate = `${projects}/${entry.name}/${file}`

                if (entry.kind === 'dir' && (await $.fs.exists(candidate))) {
                    found = candidate
                    break
                }
            }
        }
    } catch {
        // Without the transcript the board names the session after its folder.
    }

    const transcript = found ? toWindowsPath(found, env.host, env.distro) : null
    transcripts.set(sessionId, transcript)

    return transcript
}

async function sessionFields($: EngineInterface, env: Environment, sessionId: string) {
    const cwd = await $.session.root()

    return {
        title: baseName(cwd),
        cwd,
        platform: env.host,
        transcriptPath: await findTranscript($, env, sessionId, cwd),
    }
}

async function agentLabel($: EngineInterface, agentId: string | undefined): Promise<string | null> {
    if (agentId === undefined) {
        return null
    }

    const agent = (await $.agent.list()).find(one => one.id === agentId)

    return agent?.name ?? agent?.description ?? agent?.type ?? 'subagent'
}

function sessionUrl(env: Environment, sessionId: string, path = ''): string {
    return `${env.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}${path}`
}

/**
 * Whether the session has shown something on the board, which it must before its own events are sent.
 */
async function isFollowed($: EngineInterface, env: Environment, sessionId: string): Promise<boolean> {
    const known = activity.get(sessionId)

    if (known !== undefined) {
        return known
    }

    const response = await withTimeout($, $.http.fetch(sessionUrl(env, sessionId)), PROBE_TIMEOUT_MS)
    activity.set(sessionId, response?.ok === true)

    return response?.ok === true
}

/**
 * Keeps the band's counts in step with what the board answered.
 */
async function remember($: EngineInterface, text: string): Promise<void> {
    const { session } = JSON.parse(text) as BoardResponse

    if (!session) {
        return
    }

    const next: ShowAndTellBoard = { url: session.url, newCount: session.unseenCount ?? 0, pendingCount: session.pendingCount ?? 0 }
    const current = await read($, board)

    // The inbox is polled every few seconds; the band only redraws when a count moved.
    if (current?.url !== next.url || current.newCount !== next.newCount || current.pendingCount !== next.pendingCount) {
        await update($, board, () => next)
    }
}

/**
 * Sends something the session did by itself to the board, when the board follows the session.
 * Never waits long, never throws.
 */
async function postAuto($: EngineInterface, path: string, build: () => object | Promise<object>, sessionId?: string): Promise<void> {
    try {
        const id = sessionId ?? (await $.session.id())
        const env = await getEnvironment($)

        if (!(await isFollowed($, env, id))) {
            return
        }

        const request = $.http.fetch(sessionUrl(env, id, path), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...(await build()), auto: true }),
        })

        const response = await withTimeout($, request, AUTO_TIMEOUT_MS)

        if (response?.ok && response.status !== 204) {
            await remember($, response.text)
        }
    } catch {
        // The board is a side channel: a failure never reaches the session.
    }
}

function postStatus($: EngineInterface, status: Status, sessionId?: string) {
    return postAuto($, '/status', () => ({ status }), sessionId)
}

/**
 * Tells the board a subagent started or finished a run, under the same name its images carry.
 */
function postAgentStatus($: EngineInterface, agentId: string, isRunning: boolean) {
    return postAuto($, '/agents', async () => ({ agent: await agentLabel($, agentId), isRunning }))
}

/**
 * Hands what the user sent from the board to the model: folded into the running turn, or as the next prompt.
 */
async function deliverInbox($: EngineInterface): Promise<void> {
    if (isDelivering) {
        return
    }

    isDelivering = true

    try {
        const sessionId = await $.session.id()
        const env = await getEnvironment($)

        if (!(await isFollowed($, env, sessionId))) {
            return
        }

        const response = await withTimeout($, $.http.fetch(sessionUrl(env, sessionId, '/inbox'), { method: 'POST' }), AUTO_TIMEOUT_MS)
        const { messages = [] } = response?.ok ? (JSON.parse(response.text) as InboxResponse) : {}

        // The same poll keeps the band's counts current as the user looks at the board.
        if (response?.ok) {
            await remember($, response.text)
        }

        for (const message of messages) {
            const said = localizePaths(message.text, env.host)
            $.ui.log(`Show and Tell: ${said}`)

            if (isTurnRunning) {
                const text = `The user sent this from the show-and-tell board:\n${said}`
                await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
            } else {
                await $.prompt.submit({ text: said, asUser: true })
            }
        }
    } catch {
        // A message the board handed over but that could not be delivered is lost; the next ones still arrive.
    } finally {
        isDelivering = false
    }
}

function parseImageRequests(value: unknown): ImageRequest[] {
    if (!Array.isArray(value)) {
        return []
    }

    return value.flatMap((item): ImageRequest[] => {
        if (typeof item === 'string') {
            return [{ path: item }]
        }

        if (item && typeof item === 'object' && typeof item.path === 'string') {
            return [{ path: item.path, label: typeof item.label === 'string' ? item.label : undefined }]
        }

        return []
    })
}

async function readImages($: EngineInterface, env: Environment, requests: readonly ImageRequest[]) {
    const images: Image[] = []
    const skipped: string[] = []

    for (const request of requests) {
        const local = toLocalPath(request.path, env.host)

        if (!imageType(local)) {
            skipped.push(`${request.path}: not a PNG, JPG, GIF, WEBP or SVG file`)
            continue
        }

        try {
            const { base64 } = await $.fs.read(local, { as: 'bytes' })
            images.push({ name: baseName(local), base64, label: request.label })
        } catch (error) {
            skipped.push(`${request.path}: ${errorMessage(error)}`)
        }
    }

    return { images, skipped }
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(value as T) ? (value as T) : fallback
}

export const register: Register = on => {
    on('session.start', async ($, e, next) => {
        await $.tool.register({
            name: 'show',
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
            isDeferred: false,
        })
        await $.tool.register({
            name: 'close_questions',
            description: 'Close the open questions on the image board once the user answered them in chat. An answer given on the board closes its question by itself.',
        })
        await $.command.register({
            name: 'show-and-tell',
            description: "Open this session's image board in Chrome",
            immediate: true,
        })
        $.clock.every(INBOX_EVERY_MS, () => void deliverInbox($))
        const result = await next(e)

        // A resumed session keeps its id, so the board may still show it as ended from its last run.
        await postStatus($, 'idle')

        return result
    })

    on('command.run', { command: 'show-and-tell' }, async $ => {
        try {
            const env = await ensureServer($)
            const sessionId = await $.session.id()
            const response = await $.http.fetch(sessionUrl(env, sessionId, '/open'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session: await sessionFields($, env, sessionId) }),
            })

            if (!response.ok) {
                return { text: `The board refused to open (${response.status}).` }
            }

            activity.set(sessionId, true)
            await remember($, response.text)

            return { text: 'Opened the board in Chrome.' }
        } catch (error) {
            return { text: `Could not open the board: ${errorMessage(error)}` }
        }
    })

    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const current = await read($, board)

        if (current === null || e.props.hasSurvey) {
            return next(e)
        }

        const { Box, Link, Text } = $.ui.resolve(e)

        return (
            <Box>
                <Text color="claude">▣ </Text>
                <Link href={current.url} label="Show and Tell" />
                {current.newCount > 0 && <Text color="claude"> · {current.newCount} new</Text>}
                {current.pendingCount > 0 && <Text color="warning"> · {current.pendingCount} to pick</Text>}
            </Box>
        )
    })

    on('tool.call', { tool: CLOSE_TOOL }, async $ => {
        try {
            const env = await ensureServer($)
            const response = await $.http.fetch(sessionUrl(env, await $.session.id(), '/status'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isAnswered: true }),
            })

            if (response.status === 204) {
                return { result: 'The board has no questions from this session.' }
            }

            await remember($, response.text)

            return { result: 'Closed the open questions on the board.' }
        } catch (error) {
            return { deny: `Could not reach the image board: ${errorMessage(error)}` }
        }
    }).catch(() => ({ deny: 'Closing the questions failed.' }))

    on('tool.call', { tool: TOOL }, async ($, e) => {
        const input = e as unknown as ShowInput

        if (typeof input.title !== 'string' || input.title.trim() === '') {
            return { deny: 'Give the images a title.' }
        }

        try {
            const env = await ensureServer($)
            const sessionId = await $.session.id()
            const { images, skipped } = await readImages($, env, parseImageRequests(input.images))

            if (images.length === 0) {
                return { deny: ['None of the images could be read.', ...skipped].join('\n- ') }
            }

            const body = {
                kind: input.question === true ? 'question' : 'progress',
                title: input.title,
                text: typeof input.description === 'string' ? input.description : '',
                isMultiSelect: input.multiSelect === true,
                layout: pick(input.layout, LAYOUTS, 'grid'),
                agent: await agentLabel($, e.agentId),
                images,
                session: await sessionFields($, env, sessionId),
            }

            const response = await $.http.fetch(sessionUrl(env, sessionId, '/events'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })

            if (!response.ok) {
                return { deny: `The board refused the images (${response.status}): ${response.text}` }
            }

            activity.set(sessionId, true)
            await remember($, response.text)
            const { session } = JSON.parse(response.text) as BoardResponse
            const lines = [`Shown ${images.length} image(s) on the board.`]

            if (skipped.length > 0) {
                lines.push('Skipped:', ...skipped.map(line => `- ${line}`))
            }

            if (session) {
                lines.push(describeBoard(session))
            }

            return { result: lines.join('\n') }
        } catch (error) {
            return { deny: `Could not reach the image board: ${errorMessage(error)}` }
        }
    }).catch(() => ({ deny: 'Showing the images failed.' }))

    on('turn.start', async ($, e, next) => {
        const result = await next(e)

        if (e.agentId === undefined) {
            isTurnRunning = true
            await postStatus($, 'working')
        } else {
            await postAgentStatus($, e.agentId, true)
        }

        return result
    })

    on('turn.complete', async ($, e, next) => {
        const result = await next(e)

        if (e.agentId === undefined) {
            isTurnRunning = false
            await postStatus($, 'idle')
        } else {
            await postAgentStatus($, e.agentId, false)
        }

        return result
    })

    // After a compaction the images read before it are gone from the model's context; the board marks them so.
    on('session.compact', async ($, e, next) => {
        const result = await next(e)

        if (e.trigger !== 'precompute' && result.skip === undefined) {
            await postAuto($, '/compactions', async () => ({ agent: await agentLabel($, e.agentId), trigger: e.trigger }))
        }

        return result
    })

    on('tool.call', { tool: 'Read' }, async ($, e, next) => {
        const ran = await next(e)

        if (ran.deny !== undefined || ran.isError || !imageType(e.file_path)) {
            return ran
        }

        const changes = takeChanges(e.agentId ?? '')

        // A file over the read limit throws inside postAuto and is left off the board.
        await postAuto($, '/events', async (): Promise<EventBody> => ({
            kind: 'seen',
            title: baseName(e.file_path),
            agent: await agentLabel($, e.agentId),
            images: [{ name: baseName(e.file_path), base64: (await $.fs.read(e.file_path, { as: 'bytes' })).base64 }],
            changes,
        }))

        return ran
    })

    // Anything an agent does besides looking splits its image reads into separate looks on the board.
    on('tool.call', async ($, e, next) => {
        const ran = await next(e)

        if (ran.deny === undefined && !ran.isError && !LOOKING_TOOLS.has(e.tool)) {
            noteChange(e.agentId ?? '', e.tool)
        }

        return ran
    })

    on('session.end', async ($, e, next) => {
        await postStatus($, 'ended', e.sessionId)

        // A /clear goes on under a new session, which the board does not follow yet.
        await update($, board, () => null)

        return next(e)
    })
}
