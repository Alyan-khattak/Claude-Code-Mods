# Claude Code Mods by Alyan

Ten mods for [Claude Code](https://code.claude.com): undo to any prompt, a usage-limit meter, a live context forecast, a guard for destructive commands, a replay of every edit, a list of every file Claude touched, a daily journal of your sessions, a code pet, a clean checklist view, and a driving game that plays while Claude works.

A mod is a small TypeScript module that runs inside your Claude Code session. Once installed, these run on their own in every project: there is nothing to start.

| Mod | What it does | You use it with |
| --- | --- | --- |
| **[Waypoint](#waypoint)** | Snapshots your whole project before every prompt. Pick any earlier prompt, preview what it changed, restore. Catches Bash changes too. | `/waypoints`, `/waypoints-restore` |
| **[Limit Meter](#limit-meter)** | Your plan's 5-hour and weekly limits above the prompt: percent used, time to reset, how much of the week you used today. Warns at 75%, 90%, 100%. | automatic, `/limits` |
| **[Token Weather](#token-weather)** | One line above the prompt: how full the context window is, as a forecast (☀ Clear → ↯ Compact soon). | automatic |
| **[Blast Radius](#blast-radius)** | Holds `rm -rf`, `git reset --hard`, force pushes and friends, shows exactly what they would destroy, asks Proceed or Cancel. | automatic |
| **[Replay Theater](#replay-theater)** | Records every edit in a turn, then steps through the diffs one at a time. | `/replay` |
| **[Files Seen](#files-seen)** | Every file Claude read or edited this session, grouped and counted. | `/seen` |
| **[Code Pet](#code-pet)** | A tiny ASCII pet above your prompt (`=^.^=`): cheers when tests pass, worries when commands fail, naps when you're idle, and levels up as you work. | automatic, `/pet` |
| **[Session Journal](#session-journal)** | A markdown log of each prompt, changed file and command, per day. | `/standup`, `/journal` |
| **[Clean View](#clean-view)** | Hides all tool rows and command output while Claude works. Shows a plain-English checklist above the prompt instead. Off by default. | `/simple on`, `/simple off` |
| **[Road Trip](#road-trip)** | Top-down text driving game in a pane. Task coins rain down every time Claude finishes a step. An Arrived card pops when the job is done. | `/roadtrip` |

## Install

**Requirement:** Claude Code 2.1.287 or newer.

```sh
claude --version
```

If not installed: [claude.ai/code](https://claude.ai/code)

Waypoint also needs **git** on your PATH.

---

### Option A — Install everything at once (recommended)

**macOS / Linux:**

```sh
git clone https://github.com/Alyan-khattak/Claude-Code-Mods
cd Claude-Code-Mods
sh install-all.sh
```

**Windows (PowerShell):**

```powershell
git clone https://github.com/Alyan-khattak/Claude-Code-Mods
cd Claude-Code-Mods
./install-all.ps1
```

Then inside Claude Code:

```
/reload-plugins
```

---

### Option B — Pick mods one by one (no clone needed)

Inside Claude Code, run:

```
/plugin marketplace add Alyan-khattak/Claude-Code-Mods
```

Then install whichever you want:

```
/plugin install waypoint@alyan-mods
/plugin install limit-meter@alyan-mods
/plugin install token-weather@alyan-mods
/plugin install blast-radius@alyan-mods
/plugin install replay-theater@alyan-mods
/plugin install files-seen@alyan-mods
/plugin install session-journal@alyan-mods
/plugin install code-pet@alyan-mods
/plugin install clean-view@alyan-mods
/plugin install road-trip@alyan-mods
```

Then:

```
/reload-plugins
```

---

### Verify it worked

```
/plugin list
```

Should show ten `@alyan-mods` entries. Then try:

```
/waypoints        → opens the checkpoint timeline
/seen             → files Claude touched this session
/pet              → pat your code pet
/limits           → usage meter
/simple on        → enable clean checklist view
/roadtrip         → open the driving game
```

---

### Remove a mod

```
/plugin uninstall <name>@alyan-mods
```

Mods installed this way are for your user, so they load in every project.

> A mod runs on your machine with the same access Claude Code has. Read the code before installing mods from anyone, including me. Everything here is in plain TypeScript under each folder's `hooks/`.

---

## Waypoint

Claude Code's built-in `/rewind` restores files Claude edited with its edit tools. Waypoint snapshots the **folder itself**, so it also catches what `/rewind` misses: files changed by Bash commands (`rm`, `mv`, generators, formatters), edits made by subagents, and your own edits in another editor.

**How it works.** Before every prompt starts, and again when its turn ends, Waypoint commits the whole project to a hidden git repository at `~/.claude/waypoint/<project>-<id>`. Your project's own `.git` and history are never touched.

**Using it from the list.** Type `/waypoints`. A pane lists every checkpoint, newest first:

```
#12  17:42  add login validation                     3 files +45 −12
#11  17:30  rename the helper                        2 files +8 −8
⟲10  17:28  before restoring to after #8
```

Move with **↑ ↓** and press **Enter** to open one and see exactly what that prompt changed. Then press **a** to restore to *after* it (the state right after that prompt finished), **b** to restore to *before* it, or **x** to go back (Tab also moves between the buttons). Esc closes the pane.

If the keys don't reach the list, the pane doesn't have the keyboard: press **Ctrl+X** then **Tab** (more than once if several panes are open), or use the commands below.

**Using it from the prompt.** Every action is also a command, which works whether or not the pane has focus:

| Command | What it does |
| --- | --- |
| `/waypoints` | Opens the list |
| `/waypoints-open 12` | Shows what prompt #12 changed |
| `/waypoints-restore 12` | Restores every file to how it was **after** prompt #12 |
| `/waypoints-restore 12 before` | Restores every file to how it was **before** prompt #12 |
| `/waypoints-save <label>` | Saves a checkpoint of your files right now (★), for example before a risky refactor |

The short forms `/waypoints 12`, `/waypoints restore 12 [before]` and `/waypoints save <label>` work too.

Every restore asks you to confirm, saves your current files as a safety checkpoint (⟲) first so any restore can be undone, restores, and tells Claude on your next prompt that the files changed under it. To undo a restore, restore the safety checkpoint: `/waypoints-restore <its number>`.

**What it skips.** Anything your `.gitignore` files ignore (so `.env` secrets are never copied), plus `node_modules/`, `.venv/`, `dist/`, `build/`, `target/`, caches and logs. Edit `info/exclude` inside the snapshot folder to change that list.

**What it cannot undo.** Anything outside the project folder: databases, globally installed packages, commits you already pushed, deployments, emails sent.

**Settings.** `WAYPOINT_HOME` moves the snapshot store (default `~/.claude/waypoint`).

## Limit Meter

A usage counter for Claude Code. One line above the prompt shows your plan's limit windows:

```
5h ████░░░░ 47.5% · 2h 13m    week ██░░░░░░ 24% · Thu 09:00 · today +6%
```

- **5h** is the rolling 5-hour session limit, **week** the weekly limit (plans with a separate model limit show that too). Claude Code plans have no separate daily limit; the 5-hour window is the short one.
- After each figure: time until it resets, or the day and time when that is more than a day away.
- **today** is how much of the weekly limit you used since your first response of the day.
- Colors go green → yellow (50%) → magenta (75%) → red (90%), and a toast warns once per window at 75%, 90% and 100%.

`/limits` opens a pane with full bars, exact reset times, used today, this session's cost, and when the readings were last updated.

The readings are the ones Claude Code receives with every response, so they refresh as you work (and the countdowns move every minute). They appear after the first response of a session, and only when you sign in with a Claude subscription (Pro or Max). With an API key there are no plan limits, so the line stays hidden and `/limits` shows the session cost.

**Settings.** `LIMIT_METER=status` puts it in the status line instead of above the prompt; `LIMIT_METER=off` hides the line but keeps the warnings and `/limits`.

## Token Weather

A single line above the prompt, updated after every turn:

```
☂ Showers  67% of context  134.4k / 200k  ▁▂▃▅▆▇  ▲ +98.3k last turn  $1.42
```

| Used | Forecast |
| --- | --- |
| under 25% | ☀ Clear |
| 25–49% | ☁ Cloudy |
| 50–74% | ☂ Showers |
| 75–89% | ☇ Storm |
| 90% and up | ↯ Compact soon (time for `/compact`) |

The sparkline, trend and cost appear when the terminal is wide enough. Subagent turns are not counted.

## Blast Radius

When Claude is about to run a destructive command, Blast Radius holds it, works out what it would touch with a dry run, shows the report and asks **Proceed** or **Cancel**:

| Command | What the preview shows |
| --- | --- |
| `rm -r`, `rm -f`, `Remove-Item -Recurse`, `rmdir /s`, `del /s` | Files and total size that would be deleted, with a warning for the project folder, home or root |
| `git reset --hard [ref]` | Uncommitted changes that would be lost, and commits dropped from the branch |
| `git clean -f…` | The untracked files it would delete (`git clean -n`) |
| `git push --force` | Remote commits that would be overwritten (as of your last fetch) |
| `git checkout -- …`, `git restore …` | Unstaged changes that would be discarded |
| `git branch -D` | Commits that exist only on that branch |
| SQL `DROP`/`TRUNCATE`, migrations, `docker … prune`, `compose down -v`, `git stash clear` | A warning that this changes data outside your files and has no preview |

**Cancel** refuses the command and tells Claude why, so it asks you instead of retrying. Pressing Esc counts as Cancel. In non-interactive runs (`claude -p`, the SDK) it stays out of the way.

It reads the command text, so it is a safety net, not a lock: a script that deletes files gets past it. Use [permission rules](https://code.claude.com/docs/en/settings) for a hard block. `BLAST_RADIUS=off` switches it off.

## Replay Theater

While a turn runs, Replay Theater records every Edit and Write: the file before and after. When the turn ends a hint appears above the prompt:

```
↺ Last turn: 5 edits in 3 files  [ Replay ]  Hide
```

Press **Replay** (or type `/replay`) for a pane that walks through the edits one diff at a time: **Prev** (`p`), **Next** (`n`), **Close** (`c`). It never blocks or changes an edit.

## Files Seen

The status line shows `◉ 12 read · ✎ 3 edited`. `/seen` opens a pane with every file Claude read or edited this session, split into **Edited** and **Read only**, newest first, with the files touched in the current turn marked ●. **Reset list** (`r`) starts it over. A `/clear` starts it over too.

## Code Pet

A tiny pet that lives above your prompt and reacts to your session. It's plain ASCII by default, so it lines up in every terminal:

```
=^o^= \o/ Mochi: 42 tests passed! +10 XP x3 in a row              Lv 3 [###..] x3
```

| What happens | Pet |
| --- | --- |
| Claude is working | `=o_o= ...` / `=>_<= [#]` with what it's doing: *"building app.js"* |
| Tests pass (`npm test`, `pytest`, `flutter test`, `go test`, `cargo test`...) | `=^o^= \o/` *"42 tests passed! +10 XP"* |
| A command fails | `=O.O= !` *"uh oh, `npm run build` failed"*; three in a row: `=T_T= ;(` |
| A long turn finishes | `=^-^= *` *"done! that took 4m"* |
| Context window over 75% | `=@_@= !!` *"it's crowded in here... /compact?"* |
| Plan limit over 90% | `=-_-= zz` *"I'm tired..."* |
| Idle 5 minutes / 15 minutes | `=-_-= ...` / `=-.-= zZz` asleep |
| 1-5 AM | `=u_u= C` *"it's late... go to sleep?"* |
| You pat it (`/pet`) | `=^w^= <3` |

**It grows.** Passing tests give 10 XP, every finished turn 2 XP. It starts as an egg `(^)`, hatches at level 2, and becomes a legend `*=^.^=*` at level 10. Its name, species, XP and streaks are saved, so it keeps growing across sessions.

**Species:** cat `=^.^=`, dog `U^.^U`, bunny `(\^.^/)`, bear `(^.^)`, fox `<^.^>`, panda `[^.^]`, frog `@^.^@`, chick `{^.^}`.

| Command | Effect |
| --- | --- |
| `/pet` | Pat it |
| `/pet name Mochi` | Name it |
| `/pet species dog` | Change species (list above) |
| `/pet stats` | Level, XP, test streak, tests passed today, pats |

**Settings.** `CODE_PET_STYLE=emoji` switches to emoji (🐱 🎉 💤); `CODE_PET=status` shows it in the status line instead of above the prompt; `CODE_PET=off` hides it.

## Clean View

Clean View hides every tool row, file diff and command output while Claude works, and replaces them with a plain-English checklist above the prompt.

**Off by default.** Turn it on with `/simple on` (or the toggle button in the band). Turn it off with `/simple off`. The setting persists across sessions.

When active, the band shows a title for the current task, a phase badge, and a numbered step list:

```
● Working on it                                           [Simple ON]
  ✓  Read your notes
  ▶  Build the pricing section  ████████░░  60%
     Add the contact form
     Polish the footer
```

**Phase badges:**

| Badge | Meaning |
| --- | --- |
| `● Working on it` | Claude is running tools |
| `⚡ Needs you` | Waiting for your input or permission |
| `✕ Stuck` | Consecutive tool failures |
| `◼ Stopped` | Session ended or rate-limited |
| `✓ Done` | Turn finished (collapses after 5 s) |

**How the checklist is built.** Claude uses two custom tools:

- `plan_steps` — declares the steps for a turn before doing anything else
- `report_progress` — marks a step done or sets its percent complete

A system-prompt instruction tells Claude to call `plan_steps` at the start of every turn. If it skips this, its first real tool call is denied with a reminder to plan first (a few built-ins like `TodoWrite` and `AskUserQuestion` are exempt from the gate).

The band title comes from a background Haiku call at the start of each turn, which rewrites Claude's first message into a short human-readable label.

**Commands:**

| Command | Effect |
| --- | --- |
| `/simple on` | Enable Clean View |
| `/simple off` | Disable Clean View |
| `/simple` | Toggle |

## Session Journal

After every turn, appends an entry to `.claude/journal/YYYY-MM-DD.md` in your project:

```markdown
## 17:42 · add login validation

> add login validation to the signup form and write tests

**Files** (3)
- `src/auth.ts` (edited)
- `src/auth.test.ts` (created)

**Commands** (2)
- ✓ `npm test`
- ✗ `npm run build`

**Outcome:** answered in 1m 12s
**Reply:** Added validation for email and password, with tests…
```

`/standup` turns today's journal into a short list for a standup (`/standup yesterday` or `/standup 2026-10-03` for other days). `/journal` shows where today's file is.

Add `.claude/journal/` to your `.gitignore` if you don't want it committed. `SESSION_JOURNAL_DIR` writes it somewhere else (absolute, or relative to the project). Waypoint never snapshots the journal, so a restore never rolls it back.

## Road Trip

A top-down text driving game that lives in a pane beside your transcript. Waiting on a long Claude job becomes fun instead of dead time — and the game is wired directly to what Claude is doing.

**Opening it.** Type `/roadtrip` (or `/roadtrip play`). The pane opens with a "Get ready… 3, 2, 1, GO!" countdown. `/roadtrip off` hides it; `/roadtrip on` brings it back. Closing the pane saves your progress automatically.

**Controls** (pane must be focused — click it or Tab to it first):

| Key | Action |
| --- | --- |
| **A** | Switch one lane left |
| **D** | Switch one lane right |
| **P** | Pause / unpause |
| **G** | Open the garage |
| **B** | Buy or drive a car (in garage); Close (on Arrived card) |

**The road.** Three lanes scroll toward your car. Avoid striped barriers, cones and pothole — hitting one causes a "Flat tire!" and restarts the run. At least one lane is always clear. Collect coin rows for 1 coin each.

**Task coins.** Every time Claude finishes a step (a Clean View checklist step, a completed to-do, or a TaskUpdate), an orange `($)` task coin worth **10 coins** rolls onto the road. Up to 3 queue at a time.

**Quiz gates.** Every 25–30 seconds a question about Claude or running a business appears at the top of the road. A colored gate rolls down with one answer per lane: drive through the correct one for **+15 coins, +50 XP**, and a few seconds of **NITRO** (faster speed, smash obstacles for 2 coins each).

**Arrived card.** When Claude finishes a job, the game pauses on an Arrived card showing distance, coins, quiz score and your level. Press **A** to keep driving, **G** for the garage, or **B** to close.

**The garage.** Five cars unlock with coins and levels:

| Car | Price | Level | Perk |
| --- | --- | --- | --- |
| Starter Hatch | Free | 1 | None |
| Side Hustle Coupe | 60 | 2 | Coin magnet: also grabs coins in the adjacent lane |
| Agency Wagon | 180 | 3 | Shield: survives one hit per run |
| Founder GT | 450 | 5 | Double coins on everything |
| Unicorn Hyper | 1,000 | 8 | All perks + nitro start |

**XP and levels.** Distance and quiz answers earn XP. The level bar is in the HUD. Level 10 unlocks the Unicorn Hyper. Bank, owned cars, XP and best distance persist across sessions via `$.store`.

**Other commands:**

| Command | Effect |
| --- | --- |
| `/roadtrip` | Open the game |
| `/roadtrip off` | Hide (persists) |
| `/roadtrip on` | Re-enable |
| `/roadtrip retro on` | Switch to 1980s arcade look (black road, neon magenta edges, cyan lane lines, phosphor green HUD) |
| `/roadtrip retro off` | Back to default colors |

---

## Mods that share the space above the prompt

Code Pet, Limit Meter, Token Weather and Replay Theater all draw above the prompt, and Blast Radius does too when the terminal is too narrow for its pane. Each one draws its own line and passes the rest on, so they stack instead of hiding each other.

Clean View also draws above the prompt, but when it is active it suppresses the raw tool rows that the other mods sit alongside — the other mods' own bands still render normally.

## Development

```sh
git clone https://github.com/Alyan-khattak/Claude-Code-Mods
cd Claude-Code-Mods

claude --plugin-dir ./waypoint          # try one live; every save hot-reloads
claude plugin validate ./waypoint       # checks the manifest, hooks and state
claude plugin test ./waypoint           # runs tests/*.test.ts(x)
```

Each mod is a plugin folder: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming `hooks/register.tsx`, a `types/index.d.ts` contract for the values it keeps in `$.state`, and tests. Claude Code writes the API's type declarations into each mod's `.claude-plugin/types/` when it loads the mod, so editors and `tsc -p <mod>` work with no setup. Those are regenerated per build and not committed.

To ship an update, bump `version` in that mod's `plugin.json` and push. Users get it with `claude plugin update <name>@alyan-mods` and `/reload-plugins`.

**Status.** Built and tested against Claude Code 2.1.289: every mod passes `claude plugin validate` and `claude plugin test`, and they were exercised in real sessions on Linux. Windows paths and Windows delete commands are handled in the code; if something misbehaves on Windows or macOS, please [open an issue](https://github.com/Alyan-khattak/Claude-Code-Mods/issues) with the output of `claude --debug`.

## For agents

If a user asks you to install, configure or debug these mods, these facts apply.

- Marketplace: `Alyan-khattak/Claude-Code-Mods`, name `alyan-mods`. Plugins: `waypoint`, `limit-meter`, `token-weather`, `blast-radius`, `replay-theater`, `files-seen`, `session-journal`, `code-pet`, `clean-view`, `road-trip`. Install with `claude plugin install <name>@alyan-mods --scope user`, then a new session or `/reload-plugins`.
- Type: Claude Code plugins with one hooks module each (`hooks/register.tsx`). No MCP servers, no skills, no network calls.
- Commands they register: `/waypoints [<n> | restore <n> [before] | save <label>]`, `/waypoints-open <n>`, `/waypoints-restore <n> [before]`, `/waypoints-save <label>`, `/limits`, `/replay`, `/seen`, `/standup [yesterday|YYYY-MM-DD]`, `/journal`, `/pet [name <name> | species <kind> | stats]`, `/simple [on|off]`, `/roadtrip [on|off|retro on|off]`.
- Processes they run: Waypoint runs `git` against a bare repository at `$WAYPOINT_HOME` or `~/.claude/waypoint/<project>-<hash>` with the project as work tree (`add -A`, `commit`, `diff`, `read-tree -u --reset` on restore). Blast Radius runs read-only `git` commands (`status`, `diff`, `log`, `clean -n`, `rev-parse`) for its preview.
- Files they write: Session Journal writes `.claude/journal/YYYY-MM-DD.md` in the project (or `$SESSION_JOURNAL_DIR`). Waypoint writes only inside its snapshot folder, except when the user restores.
- Environment variables (all optional): `WAYPOINT_HOME`, `SESSION_JOURNAL_DIR`, `BLAST_RADIUS=off`, `LIMIT_METER=band|status|off`, `CODE_PET=band|status|off`, `CODE_PET_STYLE=ascii|emoji`.
- Clean View: off by default; enable with `/simple on`. Registers tools `mcp__clean-view__plan_steps` and `mcp__clean-view__report_progress` for Claude to call. Injects a system-prompt instruction requiring `plan_steps` before the first real tool call each turn. Persists enabled state in `$.store`.
- Verify: `claude plugin list` shows the ten `@alyan-mods` entries. In a new session, `/journal` answers with a path, and `/waypoints` opens the timeline. If nothing appears, run `claude plugin validate <plugin folder>` and `claude --debug`.

## Credits

Token Weather, Blast Radius and Replay Theater are my own implementations of ideas from [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/) on the claude.dev blog. Waypoint, Limit Meter, Files Seen, Session Journal and Code Pet are original.

MIT license · Made by [Alyan Khattak](https://github.com/Alyan-khattak)