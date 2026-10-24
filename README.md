# show-and-tell

A Claude Code mod that puts a live image board in a Chrome tab next to your terminal. You see what Claude makes while it makes it, so you can stop a wrong direction early instead of finding out hours later.

The board shows three things:

- **What Claude made**: screenshots, renders and generated images, in a masonry grid. Wide images get more room.
- **What Claude looked at**: every image Claude opens, including its subagents, in a side column with a counter. Use it to check that Claude really looked at everything you asked it to. The images are grouped into looks: a new look starts when Claude changed something (edited files, ran commands) since its last read, and the line between two looks says what it did.
- **Options to pick from**: a question with one labeled image per option (A, B, C...), like Claude Code's own questions. Pick one or more, write something else, add notes, and send. Answering in the terminal works too.

There is no text to read on the board. Claude talks in the terminal, the board is for pictures.

You can also talk back from the board: leave a note on an image from the viewer, or mark an area of it and ask about that area. Claude gets it within a couple of seconds: in the middle of its work, or as your next prompt when it is waiting for you. The viewer also saves an image to your downloads, and clicking the shield beside a session's title protects it from the cleanup (the shield turns green).

The board tracks two things for each report, and Claude learns both each time it shows something:

- **New or seen**: a new report has a dot. It counts as seen once it stays in view for two seconds while the board is the window in front, or once you open it. Many unseen reports tell Claude you are away, so it sends fewer, grouped ones.
- **In review or reviewed**: the reports in review are the ones you are still comparing. Marking one **reviewed** puts it away under the Reviewed tab (and you can bring it back).

The session tabs on top are the sessions still running. They can be dragged into the same order as your terminal tabs, and the board remembers the order. Sessions that stopped move to the **History** column on the left, grouped by day.

## Install

From a shell:

```
claude plugin marketplace add jhm-ciberman/claude-show-and-tell
claude plugin install show-and-tell@show-and-tell
```

Then run `/reload-plugins` in any open session.

## How it works

- The mod gives Claude a `show` tool: a title and some images, with an optional description and layout, or a question for you to answer.
- The first time a session shows something, the mod starts the board server if it is not running and opens the session's page in Chrome. Sessions that never show anything never open a tab.
- From then on, the session also sends what it does on its own: each image it reads, whether it is working or waiting for you, and when it ends. The images it read before the board opened come too, up to the newest 30.
- A question stays on top until you answer it on the board or dismiss it. When you answer in the terminal instead, Claude closes it with its `close_questions` tool. Click **Notify me** in the top bar to also get a desktop notification when Claude asks while you are in another window.
- Each call to `show` is one report, and the board keeps its images together as one card. A report picks its layout: a plain grid, a side-by-side comparison, a packed collage, a before-and-after slider, or numbered variations.

Once a session shows something, a line above the prompt links to its board and counts the reports you have not seen yet and the questions waiting for you (ctrl+click the link). `/show-and-tell` opens the board at any time. The board's browser tab shows the same count, for every session, in its title.

The server runs at `http://localhost:7777` and is shared by every session on the machine. On Windows, sessions inside WSL use the server on the Windows side: they reach it through the WSL virtual network, and paths are converted both ways.

## Requirements

- Windows, macOS or Linux, with Node.js 20.11 or newer. On Windows, sessions can also run inside WSL.
- Chrome. Without it, the board opens in your default browser.

## Data

Sessions and their images are stored in `.claude/show-and-tell` in your home folder (`%USERPROFILE%` on Windows). Of the images Claude looked at, each session keeps the newest 100, at any age, and at least the newest 10 of each agent. A session idle for 7 days is deleted, and when everything goes over 1 GB the oldest sessions are deleted first. Sessions with auto cleanup off are never touched.

## Development

```
claude plugin validate .
claude plugin test .
node --test server/server.test.mjs
```

The board server restarts by itself when `server/server.mjs` changes. When the plugin moves to another folder, as it does on an update, the next `show` replaces the running board with the new copy.
