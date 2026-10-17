/**
 * What the band above the prompt shows about the session's board.
 */
export type ShowAndTellBoard = {
    /** The session's page on the board. */
    url: string
    /** How many reports the user has not seen yet. */
    newCount: number
    /** How many questions wait for an answer. */
    pendingCount: number
}

declare module 'claude-code' {
    interface PluginState {
        'show-and-tell': {
            /** The session's board, once the board follows the session. */
            board: ShowAndTellBoard | null
        }
    }
}
