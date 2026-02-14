# CourseCode Desktop — Technical Specification

A standalone Electron app that gives instructional designers a native GUI for CourseCode. No terminal, no Node install, no technical knowledge required. More than a GUI wrapper — it's the **setup hub** for the entire CourseCode authoring environment, guiding non-technical users through installing and configuring AI agents, editors, version control, and cloud deployment.

---

## Product Ecosystem

| Product | Audience | Role |
|---------|----------|------|
| **coursecode** | Developers, AI agents | Framework + CLI (MIT, open source) |
| **coursecode-desktop** | Instructional designers | GUI on-ramp, deploy button (MIT, open source) |
| **coursecode-cloud** | All users | Hosting, analytics, team features (paid SaaS) |

### User Workflows

| User | Flow |
|------|------|
| **Non-technical ID** | Desktop → create → preview → "Deploy" → done |
| **Tech-comfortable** | Desktop → create → preview → deploy from Desktop or `git push` → GitHub Action → deploys to cloud |
| **Developer** | CLI → AI authoring → `git push` → GitHub Action → deploys to cloud |

---

## Product Strategy (Open Source + Cloud)

### Boundary and Positioning

- `coursecode-desktop` and `coursecode` framework are open source and usable without cloud.
- `coursecode-cloud` is closed source and optional.
- All user-facing messaging must clearly label cloud capabilities as optional add-ons (hosting, auth, credits, collaboration).
- Desktop must keep local authoring and export workflows first-class even when the user is not signed in.

### Web and Repository Strategy

- Desktop app source of truth: `https://github.com/course-code-framework/coursecode-desktop`
- Desktop website source should live in a separate repository (`coursecode-desktop-site`) for clean CI/CD and ownership boundaries.
- Public website domain for Desktop: `https://coursecodedesktop.com`
- Cloud product domain: `https://coursecodecloud.com`

### Cross-Property Linking Strategy

- Desktop website should prominently link to:
  - Desktop GitHub repository (open source trust/contribution)
  - Desktop downloads (GitHub Releases artifacts)
  - Optional Cloud onboarding pages
- Cloud website should include direct CTAs back to Desktop install/download for local-first onboarding.
- In-app setup and settings should include optional Cloud connect steps without blocking non-cloud usage.

### Distribution and Trust Strategy

- Installers are distributed via GitHub Releases tied to desktop app tags.
- Auto-update channel uses published release artifacts from the official repository.
- Download pages must include:
  - latest version + release date
  - checksums
  - links to release notes
  - guidance to install only from official domain/repository
- Code signing/notarization is required for production trust once certificates are available:
  - Apple Developer ID + notarization (macOS)
  - Windows code-signing certificate (NSIS installer)

### Release and Channel Strategy

- Maintain at least two release channels:
  - Stable (default for non-technical users)
  - Beta (opt-in for early testing)
- Versioning source of truth and release flow:
  - **Git tag is the release trigger and CI source of truth** (tag format: `vX.Y.Z`, optional prerelease suffix like `vX.Y.Z-beta.1`)
  - `package.json` stores the app version used by Electron/electron-builder in local builds
  - CI syncs `package.json` version from the pushed tag before packaging (`npm version --no-git-tag-version`)
  - GitHub Release artifact names must match the website download metadata naming convention (`CourseCode-Desktop-v<version>-mac.dmg`, `CourseCode-Desktop-v<version>-win.exe`)
- Runtime version reporting rules:
  - App UI "About" and update checks must use Electron `app.getVersion()`
  - MCP client handshake version must use the app runtime version, not a hardcoded string
- Changelogs should distinguish:
  - Desktop app changes (open source)
  - Framework/CLI changes (open source)
  - Cloud service changes (closed source, optional)

### Release Versioning Runbook (Operational Steps)

Use this checklist for every Desktop release to avoid version drift between the app, GitHub Releases, and the website.

1. Pick the version and channel
   - Stable example: `v0.9.1`
   - Beta example: `v0.10.0-beta.1`
2. Update local app version for developer builds (recommended before tagging)
   - File: `coursecode-desktop/package.json`
   - Keep `coursecode-desktop/package-lock.json` root version in sync
   - Note: CI will also sync from the tag automatically, but updating locally keeps dev builds/About screens accurate before release
3. Update Desktop website release metadata (single source for website/download pages)
   - File: `coursecode-sites/apps/desktop-site/src/data/site.ts`
   - Update:
     - `release.version`
     - `release.date`
     - `release.channel` (`beta` or `stable`)
     - `release.githubRelease`
     - `release.assets.*.file`
     - `release.assets.*.url`
     - `release.assets.*.sha256`
   - Update signing flags:
     - `release.signing.macosNotarized`
     - `release.signing.windowsCodeSigned`
4. Build and verify locally (recommended)
   - `npm test`
   - `npm run build`
   - Optional packaging sanity check: `npm run package:mac` / `npm run package:win`
5. Create and push the Git tag
   - Push tag `vX.Y.Z` (or prerelease tag)
   - The GitHub Actions release workflow is triggered on `v*`
6. Let CI package artifacts and create the GitHub Release
   - CI syncs app version from tag before packaging
   - Artifact names are generated by `electron-builder.yml` and should match the website naming convention
7. Publish website metadata changes after checksums are confirmed
   - The desktop site `/download` and docs pages read from `src/data/site.ts`, so one metadata update propagates to download links, commands, and beta messaging
8. Verify public surfaces after release
   - Desktop app About screen version
   - GitHub Release version + files
   - `coursecodedesktop.com/download`
   - Install docs / FAQ beta note wording (if unsigned builds remain)

---

## Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Shell | Electron | Cross-platform, bundles Node.js for non-technical users |
| Build Tool | `electron-vite` | Coordinates main/preload/renderer builds in one config |
| Renderer | Svelte + Vite | Compiled-away reactivity, tiny runtime, built-in transitions |
| Routing | Conditional rendering in `App.svelte` | 5 views, SPA within Electron |
| Styling | Vanilla CSS with design tokens | Matches framework philosophy |
| State | Svelte stores | Project list, server status, settings, auth state, chat state |
| Distribution | `electron-builder` | `.dmg` (macOS), `.exe` NSIS (Windows), auto-update |
| Auto-update | `electron-updater` + GitHub Releases | Differential updates |

---

## Architecture

### Process Model

**Main process** (`main/`): Node.js — file system access, child process management, IPC handlers, cloud client, AI chat engine. All framework integration happens here by delegating to the `coursecode` CLI.

**Preload** (`preload/`): `contextBridge` — exposes a typed `window.api` object to the renderer. No direct Node.js access from the renderer.

**Renderer** (`renderer/`): Svelte — all UI. Communicates with main process exclusively through the preload bridge via `invoke` (request/response) and `on` (event streams).

### Directory Structure

```
coursecode-desktop/
├── package.json
├── electron-builder.yml          ← Distribution config
├── electron.vite.config.mjs      ← electron-vite build config (ESM)
├── main/
│   ├── index.js                  ← App lifecycle, window creation
│   ├── menu.js                   ← macOS + Windows menu bar
│   ├── ipc-handlers.js           ← IPC channel registration
│   ├── project-manager.js        ← Scan, create, validate projects
│   ├── preview-manager.js        ← Spawn/kill preview servers
│   ├── build-manager.js          ← Build/export orchestration
│   ├── cloud-client.js           ← Cloud operations via CLI (auth, deploy, status)
│   ├── chat-engine.js            ← AI chat orchestration, agentic tool loop
│   ├── llm-provider.js           ← LLM API abstraction (Anthropic, OpenAI, Cloud proxy)
│   ├── mcp-client.js             ← MCP tool discovery and invocation via CLI
│   ├── system-prompts.js         ← Dynamic system prompt assembly
│   ├── ref-manager.js            ← Reference document ingestion and conversion
│   ├── settings.js               ← Persistent settings (JSON)
│   ├── cli-installer.js          ← Ensure bundled CLI readiness; fallback install path
│   ├── tool-integrations.js      ← Detect, install, configure external tools
│   ├── tool-registry.json        ← Tool detection config and download URLs
│   └── node-env.js               ← Bundled Node/npm path resolution
├── preload/
│   └── index.js                  ← contextBridge API definition
├── renderer/
│   ├── index.html
│   ├── src/
│   │   ├── App.svelte            ← Root component, router
│   │   ├── main.js               ← Svelte mount
│   │   ├── stores/
│   │   │   ├── projects.js       ← Project list + status
│   │   │   ├── settings.js       ← User preferences
│   │   │   ├── auth.js           ← Cloud auth state
│   │   │   ├── chat.js           ← Chat messages, streaming, tool use state
│   │   │   └── tabs.js           ← Open tab management (home + course tabs)
│   │   ├── views/
│   │   │   ├── Dashboard.svelte  ← Project cards grid
│   │   │   ├── CreateWizard.svelte ← Multi-step course creation
│   │   │   ├── ProjectDetail.svelte ← Actions, chat workspace, console output
│   │   │   ├── ChatPanel.svelte  ← AI chat interface (messages, input, model picker)
│   │   │   ├── RefsPanel.svelte  ← Reference document sidebar (drag-and-drop)
│   │   │   ├── SetupAssistant.svelte ← First-launch + revisitable tool setup
│   │   │   └── Settings.svelte   ← Preferences
│   │   ├── components/
│   │   │   ├── TabBar.svelte          ← Tab strip for home + open course tabs
│   │   │   ├── ToolCard.svelte        ← Reusable card for Setup Assistant + Settings
│   │   │   ├── Icon.svelte            ← Reusable SVG icon wrapper (flex-safe)
│   │   │   ├── EmptyState.svelte      ← Icon + CTA for empty views
│   │   │   ├── MessageBubble.svelte   ← Chat message rendering (markdown, tools, screenshots)
│   │   │   ├── MentionDropdown.svelte ← @mention autocomplete for slides/refs/interactions
│   │   │   └── ModelPicker.svelte     ← AI model/provider selection dropdown (BYOK + Cloud)
│   │   └── styles/
│   │       ├── tokens.css        ← Design system variables (light/dark)
│   │       └── global.css        ← Base styles, buttons, cards, utilities
└── build/
    └── entitlements.mac.plist    ← macOS entitlements
```

---

## Bundled Node.js Environment

The target audience does not have Node.js installed. Electron bundles its own Node.js runtime, and the desktop app uses it to run all project operations.

### `node-env.js` Module

Resolves paths to Electron's bundled Node binary and a bundled copy of npm. All child process spawns (preview server, builds, npm install) route through this module.

**Resolution strategy:**
- In development: use the system Node/npm (developer has it installed).
- In production (packaged app): use `process.execPath` for Node. Bundle `npm` as a vendored dependency within the app's `resources/` directory.

**PATH injection:** When spawning child processes for project operations, the module prepends Electron's Node binary directory to the child's `PATH` environment variable. This ensures that `node`, `npm`, and `npx` resolve to the bundled versions, not the system (which may not exist).

**npm bundling:** The app packages a copy of `npm` in its `resources/vendor/npm/` directory. This is extracted from the npm tarball at build time via a postinstall script. The `node-env.js` module constructs the full path to `npm-cli.js` and invokes it via the bundled Node binary.

---

## IPC Bridge

All communication between renderer and main process flows through typed IPC channels. The preload script exposes `window.api` with the following surface:

### Projects
- `api.projects.scan()` → `Project[]` — Scan projects directory, return all detected projects.
- `api.projects.create(options)` → `Project` — Create new project via `coursecode create`. Options: `name`, `format`, `layout`, `blank`, `location`.
- `api.projects.open(projectPath)` → `Project` — Load a specific project's details.
- `api.projects.reveal(projectPath)` → `void` — Open project folder in Finder/Explorer.
- `api.projects.delete(projectPath)` → `void` — Move project to trash.

### Preview
- `api.preview.start(projectPath, opts?)` → `{ port }` — Start preview server, return assigned port. Options: `{ openBrowser: boolean }` (default `true`). When `false`, starts the server without opening an external browser window (used for embedded preview in chat mode).
- `api.preview.stop(projectPath)` → `void` — Stop preview server for project.
- `api.preview.status(projectPath)` → `'running' | 'stopped'` — Check server status.
- `api.preview.port(projectPath)` → `number | null` — Get the port of a running preview server.
- `api.preview.statusAll()` → `Record<string, 'running' | 'stopped'>` — Check status of all preview servers.
- `api.preview.onLog(callback)` → `unsubscribe` — Stream preview server stdout/stderr to renderer.
- `api.preview.onOpenInBrowser(callback)` → `unsubscribe` — Listen for menu bar "Open Preview in Browser" command.

### Build
- `api.build.export(projectPath, format)` → `{ zipPath, size, duration }` — Build and package.
- `api.build.onProgress(callback)` → `unsubscribe` — Stream build progress events.

### Cloud
- `api.cloud.login()` → `{ success, user }` — Spawn `coursecode login` (opens browser, nonce-based auth). Sends progress events during polling.
- `api.cloud.logout()` → `void` — Spawn `coursecode logout` to clear credentials.
- `api.cloud.getUser()` → `User | null` — Spawn `coursecode whoami --json` to get current auth state.
- `api.cloud.deploy(projectPath, options?)` → `{ success, timestamp }` — Spawn `coursecode deploy`. Sends structured progress events. Options: `{ message?: string }` — optional deploy reason appended to the audit log via the CLI's `-m` flag.
- `api.cloud.getDeployStatus(projectPath)` → `DeployStatus` — Spawn `coursecode status --json`.
- `api.cloud.onLoginProgress(callback)` → `unsubscribe` — Stream login progress: `{ stage, message, user }`.
- `api.cloud.onDeployProgress(callback)` → `unsubscribe` — Stream deploy progress: `{ stage, message, log }`.

### Chat (AI)
- `api.chat.send(projectPath, message, mentions, mode?)` → `void` — Send a user message to the AI. `mode` is `'byok'` or `'cloud'` (per-conversation). Triggers an agentic loop that streams responses and tool use events back to the renderer.
- `api.chat.stop(projectPath)` → `void` — Abort the current AI generation.
- `api.chat.loadHistory(projectPath)` → `Message[]` — Load conversation history from disk.
- `api.chat.clear(projectPath)` → `void` — Clear the conversation for a project.
- `api.chat.getMentions(projectPath)` → `MentionIndex` — Get available @mention targets (slides, refs, interactions).
- `api.chat.onStream(callback)` → `unsubscribe` — Stream AI response text chunks: `{ token }`.
- `api.chat.onToolUse(callback)` → `unsubscribe` — Stream tool invocations: `{ id, name, args, status }`.
- `api.chat.onDone(callback)` → `unsubscribe` — Fired when a full response (including tool loop) completes: `{ message, usage }`.
- `api.chat.onError(callback)` → `unsubscribe` — AI error events: `{ error }`.
- `api.chat.onScreenshot(callback)` → `unsubscribe` — Screenshot captured during tool use: `{ data }`.
- `api.chat.onNewChat(callback)` → `unsubscribe` — Listen for menu bar "New Chat" command.

### References
- `api.refs.list(projectPath)` → `Ref[]` — List converted reference documents in the project.
- `api.refs.read(projectPath, filename)` → `string` — Read a reference document's markdown content.
- `api.refs.convert(projectPath, filePath)` → `void` — Convert a file (PDF, DOCX, etc.) to markdown via `coursecode ingest`. Streams progress events.
- `api.refs.onConvertProgress(callback)` → `unsubscribe` — Stream conversion progress.

### AI Settings
- `api.ai.getConfig()` → `{ providers, currentProvider, currentModel, hasKey }` — Get AI configuration including available providers, models, and key status.
- `api.ai.getProviders()` → `Provider[]` — Get all registered providers with models and key status.
- `api.ai.setProvider(providerId)` → `void` — Set the active AI provider.
- `api.ai.setModel(modelId)` → `void` — Set the active AI model.
- `api.ai.setApiKey(provider, key)` → `{ valid, error? }` — Validate, encrypt, and store an API key using Electron's `safeStorage`.
- `api.ai.removeApiKey(provider)` → `void` — Remove a stored API key.
- `api.ai.setCustomInstructions(text)` → `void` — Save custom AI instructions.
- `api.ai.getCloudModels()` → `CloudModel[]` — Fetch available models from the cloud proxy (requires cloud auth).
- `api.ai.getCloudUsage()` → `Usage | null` — Fetch credit balance and recent usage from the cloud proxy.

### Settings
- `api.settings.get()` → `Settings` — Read all settings.
- `api.settings.set(key, value)` → `void` — Update a single setting.

### Setup & Tools
- `api.setup.getStatus()` → `SetupStatus` — Returns installation and configuration state for all tools (CLI, AI agent, editor, Git, cloud). Each tool has a state: `installed-configured`, `installed-not-configured`, `not-installed`.
- `api.setup.installCLI()` → `{ success }` — Ensure CourseCode tools are ready. Uses bundled CLI first, and falls back to installation flow when needed. Streams progress via events.
- `api.setup.onInstallProgress(callback)` → `unsubscribe` — Stream CLI install progress.
- `api.setup.configureMCP(agent)` → `{ success }` — Write MCP configuration file for the specified AI agent (e.g., Claude Code). Creates/updates the agent's config file to register the `coursecode` MCP server.
- `api.setup.openDownloadPage(tool)` → `void` — Open the download page for an external tool (VS Code, Claude Code, GitHub Desktop) in the default browser.
- `api.tools.detect()` → `ToolMap` — Check which external tools are available: `{ cli, vscode, claudeCode, git, githubDesktop }`.
- `api.tools.openInVSCode(projectPath)` → `void` — Launch VS Code at path.
- `api.tools.openTerminal(projectPath)` → `void` — Open terminal at path.
- `api.tools.openInFinder(projectPath)` → `void` — Open in Finder/Explorer.

### Dialog
- `api.dialog.pickFolder(defaultPath?)` → `string | null` — Open native folder picker dialog.

### App
- `api.app.getVersion()` → `string`
- `api.app.checkForUpdates()` → `UpdateInfo | null`
- `api.app.onUpdateAvailable(callback)` → `unsubscribe`

---

## Views

### Dashboard

The primary view. Displays all detected projects as cards in a responsive grid.

**Header bar**: App title and logo on left. "New Course" button and Settings gear icon on right. Cloud auth state indicator (avatar or "Sign In" link).

**Toolbar**: Below the header bar, a row containing:
- **Search field** — Filters projects by name as the user types.
- **Format filter** — Dropdown to filter by LMS format (All, cmi5, SCORM 2004, SCORM 1.2, LTI).
- **Sort dropdown** — Sort by: Last Modified (default), Name A-Z, Format, Date Created.
- **Pin filter** — Toggle to show only pinned/favorited projects.

**Project cards** show:
- **Thumbnail** — A small preview screenshot of the course, captured automatically during preview or build. Falls back to a format-specific placeholder illustration if no screenshot exists.
- Course name (from `course-config.js` → `metadata.title`)
- LMS format badge (cmi5, SCORM 2004, SCORM 1.2, LTI)
- Last modified timestamp (from filesystem)
- Preview status indicator: green dot = server running, grey = stopped
- **Pin icon** — A star/pin toggle in the card corner. Pinned projects always sort to the top of the grid regardless of the active sort order.

**Card click** navigates to Project Detail view.

**Loading state**: While scanning projects, the grid shows **skeleton card placeholders** (pulsing grey rectangles matching the card layout) instead of a blank screen or spinner. Feels instantaneous even on slow disks.

**Empty state**: Full-width illustration with "Create Your First Course" heading, description of what CourseCode does, and a prominent "New Course" button. Friendly, not intimidating.

**Project scanning**: On app launch and when returning to Dashboard, the main process scans the configured projects directory (one level deep) looking for directories containing `course-config.js` or `.coursecoderc.json`.

### Create Wizard

A multi-step modal or full-view wizard for creating a new course project.

**Step 1 — Name Your Course**: Text input for course name. Validates: non-empty, no special characters that break directory names. Below the input:
- **Location picker**: Shows the full path (e.g., `~/CourseCode Projects/My Course`) with a "Browse…" button that opens the native folder picker dialog.
- **"Start blank" checkbox**: When checked, creates the project without example slides (passes `--blank` to the CLI).

**Step 2 — Pick Format**: Radio cards with plain-English descriptions. Each card shows the format name, a one-sentence description, and a "Recommended" badge on cmi5. Options:
- **cmi5** — "Modern standard. Works with newer LMS platforms. Recommended."
- **SCORM 2004** — "Widely supported. Works with most LMS platforms."
- **SCORM 1.2** — "Legacy standard. Use only if your LMS requires it."
- **LTI** — "Web standard for tool integration."

**Step 3 — Pick Layout**: Visual preview cards showing a thumbnail of each layout metaphor:
- **Article** — "Scrolling document style, like a blog post."
- **Traditional** — "Classic LMS layout with sidebar navigation."
- **Presentation** — "Full-screen slides, like PowerPoint."
- **Focused** — "Immersive, distraction-free content."

**Creation process**: On "Create", the wizard shows a spinner ("Creating your course..."). Delegates to `coursecode create <name>` via the CLI, which handles template scaffolding and `npm install`. On success, navigates to the Project Detail view.

If creation fails, the error is shown inline with a "Try Again" button.

### Project Detail

The workspace view for an active project. Navigated to from Dashboard by clicking a project card.

**Default window size**: 1440×900, minimum 1024×640.

**Compact toolbar** (~36px): A single row of icon-only buttons with tooltips. Replaces the old header + action bar.

Toolbar buttons (left to right):
- **Preview** (▶/⏹) — Toggle the preview server. Tooltip shows state.
- **Export** (↓) — Runs the build. Shows progress in console.
- **Deploy** (↑) — Build + upload to cloud. Requires cloud auth.
- | separator |
- **AI Chat** (✨) — Toggle the chat workspace. Also controlled by `aiChatEnabled` setting.
- | spacer |
- **VS Code** — Hidden if VS Code not detected.
- **Finder** — Reveal in Finder/Explorer.
- **Terminal** — Open system terminal at project path.

**Chat workspace mode**: When AI Chat is active, the view becomes a 2-column workspace:
- **Left column** (~33%, min 300px, max 480px): Contains two stacked sections:
  - **References** — Collapsible section at top. Collapsed by default with a count badge (e.g., "References (3)"). Expands to show reference documents with drag-and-drop support for PDF, DOCX, PPTX, TXT → markdown conversion. Max height 280px when expanded.
  - **Chat** — The full AI chat interface. Takes remaining vertical space. Input area at bottom includes ModelPicker, usage badge, and Clear button.
- **Right column** (~67%): Live preview iframe updating in real-time as the AI makes changes.

The preview server is automatically started when the chat workspace opens. If `aiChatEnabled` is on, courses open directly into this layout.

**Non-chat mode**: Shows console output panel and project info (path, format, framework version). Preview status bar visible when server is running.

### Settings

Preferences view accessible from the Dashboard header.

**Sections:**

**General**
- **Projects directory**: Path input with a "Browse" button (opens native directory picker). Default: `~/CourseCode Projects/`. Changing this triggers a re-scan.
- **Default format**: Dropdown (cmi5, SCORM 2004, SCORM 1.2, LTI). Pre-selects in the Create Wizard.
- **Default layout**: Dropdown (article, traditional, presentation, focused).

**Appearance**
- **Theme**: Light / Dark / System. The app follows the OS preference by default.

**AI Assistant**

Configuration for the built-in AI chat feature.

- **Enable AI Chat**: Toggle switch. When enabled, opening any course defaults to the AI chat workspace (chat on left, live preview on right) with preview auto-started. Default: off.
- **Default AI Mode**: Segmented toggle — "Your Key" (BYOK) or "Cloud". Cloud option is disabled until the user signs in.
- **Provider**: Dropdown to select AI provider (Anthropic, OpenAI).
- **Model**: Dropdown to select model (e.g., Claude Sonnet, GPT-4o).
- **API Key**: Secure input for BYOK (Bring Your Own Key). Keys are encrypted at rest using Electron's `safeStorage`. Includes validation, save/remove, and error/success feedback.
- **Custom Instructions**: Textarea for user-defined instructions appended to the AI system prompt.

**Tools & Integrations**

A persistent status dashboard for the authoring environment. Shows every tool from the Setup Assistant with its current state. Each tool displays as a card with:
- Tool name and icon
- Status: ✅ Installed & Configured, ⚙️ Needs Configuration, ⬇️ Not Installed
- Action button: "Configure", "Install", or "Reconfigure"
- For the CourseCode CLI: version number and "Update" button if a newer version is available.

Tools shown:
- **CourseCode CLI** — version, install/update status.
- **AI Assistant** — Claude Code detection and MCP configuration status.
- **Code Editor** — VS Code detection.
- **Version Control** — Git and GitHub Desktop detection.
- **CourseCode Cloud** — auth status, linked account.

Clicking any tool's action button runs the same logic as the Setup Assistant step for that tool. This makes the Setup Assistant revisitable without needing to re-run the wizard.

**Cloud Account**
- If signed in: Shows user email, org name, credit balance with "Top up" link, and a "Sign Out" button.
- If not signed in: "Sign In to CourseCode Cloud" button.

**About**
- App version, framework version, "Check for Updates" button, link to documentation.

**Storage**: Settings are persisted to `app.getPath('userData')/settings.json` via the main process `settings.js` module. Renderer reads/writes via IPC.

---

## Main Process Modules

### `index.js` — App Lifecycle

Creates the main `BrowserWindow` with these defaults:
- Size: 1200×800, minimum 900×600.
- `titleBarStyle: 'hiddenInset'` on macOS for native traffic light buttons with custom title bar.
- Standard title bar on Windows.
- Preload script loaded via `electron-vite` resolution.

Registers all IPC handlers via `ipc-handlers.js` before window creation.

Sets up the application menu bar (see Menu Bar section).

Handles `app.on('window-all-closed')` — quit on all platforms (no dock persistence behavior needed).

Handles `app.on('activate')` — re-create window on macOS dock click.

Loads settings and creates the main window.

### `ipc-handlers.js` — IPC Registration

Central registry that imports all domain modules and maps IPC channel names to handler functions. Uses `ipcMain.handle()` for request/response. Event streams (preview logs, build progress, deploy progress) use `webContents.send()` from within the handler modules.

### `project-manager.js` — Project Scanning & Creation

**Scanning**: Reads the configured projects directory. For each subdirectory, checks for `course-config.js` or `.coursecoderc.json`. If found, reads course metadata:
- Title from `course-config.js` via regex extraction (fast, no eval)
- Format from `course-config.js` via regex extraction
- Version from `.coursecoderc.json` → `frameworkVersion`
- Last modified from `fs.stat` on the directory

Returns an array of `Project` objects sorted by last modified (newest first).

**Creation**: Delegates to `coursecode create <name>` via the CLI. Accepts options: `name`, `blank` (creates without example slides), and `location` (custom parent directory, defaults to configured projects dir). The CLI handles all template scaffolding and dependency installation.

**Validation**: Before creation, validates that the target directory doesn't already exist and that the project name produces a valid directory name.

### `preview-manager.js` — Preview Server Lifecycle

Manages one preview server process per project. Stores a `Map<projectPath, ChildProcess>`.

**Start**: Spawns `preview-server.js` from the `coursecode` package as a child process using the bundled Node binary. Passes `LMS_FORMAT` as an environment variable. Uses an auto-assigned port (finds a free port, passes it to the server). Polls `http://localhost:<port>` with a 30s timeout for readiness before resolving the IPC response. Accepts an `{ openBrowser }` option (default `true`) — when `false`, starts the server without opening an external browser (used for embedded preview in chat mode).

Pipes stdout and stderr to the renderer via IPC events (`preview:log` channel) for the console output panel.

**Stop**: Sends `SIGTERM` to the child process. If it doesn't exit within 5s, sends `SIGKILL`. Removes from the process map.

**Status**: Checks if the stored child process is still alive (`process.killed`, `process.exitCode`).

**Cleanup**: On app quit (`app.on('before-quit')`), kills all running preview servers.

**Browser launch**: Conditional. When `openBrowser` is `true` (the default), calls `shell.openExternal(`http://localhost:<port>`)` after server readiness. When starting from chat mode, browser launch is suppressed since the preview renders in an embedded iframe.

### `build-manager.js` — Build & Export

Orchestrates course builds by invoking the `coursecode` build pipeline programmatically.

**Export flow**:
1. Receives `(projectPath, format)` from IPC.
2. Spawns `coursecode build --format <format>` in the project directory via bundled Node, with `LMS_FORMAT` set.
3. Streams build output to renderer via IPC progress events.
4. On success, locates the generated `.zip` file in the project root.
5. Returns `{ zipPath, size, duration }` to the renderer.

**Reveal**: Provides a `revealInFinder(zipPath)` helper using `shell.showItemInFolder()`.

### `cloud-client.js` — CourseCode Cloud Integration

A thin wrapper that delegates all cloud operations to the `coursecode` CLI. No direct API calls or Electron-specific auth logic.

**Authentication**: Credentials are managed solely by the CLI at `~/.coursecode/credentials.json`. The desktop reads this file to check auth status. Login spawns `coursecode login`, which opens the browser for nonce-based authentication and writes the token to the credential file on success.

**Login progress**: During login, the module parses CLI stdout and sends structured `cloud:loginProgress` IPC events (`{ stage, message, user }`) so the renderer can show a spinner ("Waiting for browser authentication…") and user info on completion.

**Deploy flow**: Spawns `coursecode deploy` in the project directory. Parses CLI output into structured progress events (`{ stage, message, log }`) with stages: `building` → `uploading` → `complete`. The `log` field carries raw CLI text for optional subtle display.

**User info**: Spawns `coursecode whoami --json` and returns parsed JSON.

**Deploy status**: Spawns `coursecode status --json` in the project directory.

**Cloud project linking**: On first deploy, the CLI stamps a `cloudId` into `.coursecoderc.json`. Team members who clone the repo get this ID automatically, skipping slug-based resolution on subsequent deploys.

### `settings.js` — Persistent Preferences

Reads and writes a JSON file at `app.getPath('userData')/settings.json`.

**Schema with defaults**:
- `projectsDir`: `path.join(os.homedir(), 'CourseCode Projects')` — the directory to scan for projects.
- `defaultFormat`: `'cmi5'`
- `defaultLayout`: `'article'`
- `theme`: `'system'` — `'light'`, `'dark'`, or `'system'`.
- `setupCompleted`: `false` — whether the Setup Assistant has been completed.
- `cliVersion`: `null` — installed CLI version for update checks.
- `windowBounds`: `{ width: 1200, height: 800 }` — restored on launch.
- `aiProvider`: `'anthropic'` — selected AI provider.
- `aiModel`: `'claude-sonnet-4-20250514'` — selected AI model.
- `aiCustomInstructions`: `''` — user-defined AI instructions.
- `aiChatEnabled`: `false` — when `true`, courses open in chat workspace mode by default.
- `defaultAiMode`: `'byok'` — `'byok'` or `'cloud'`, persisted active AI mode. Updated when the user selects a model; restored on app launch.
- `cloudAiModel`: `null` — selected cloud AI model ID.

Cloud tokens are managed by the CLI at `~/.coursecode/credentials.json`, not in desktop settings.

API keys are encrypted and stored separately at `app.getPath('userData')/ai-keys/` using Electron's `safeStorage`.

Creates the projects directory if it doesn't exist on first launch.

Saves window position/size on move/resize (debounced) and restores on next launch.

### `cli-installer.js` — CourseCode Tools Readiness

Ensures CourseCode tools are available with a bundled-first strategy for non-technical users. In packaged builds, Desktop prefers the bundled CLI path and verifies readiness by running `coursecode --version` through `node-env.js`.

**Install flow**:
1. Uses `node-env.js` to resolve bundled CLI/Node paths.
2. Verifies bundled CLI availability first (`coursecode --version`).
3. If bundled CLI is unavailable, falls back to npm install flow.
4. Streams progress/status to the renderer via IPC events.
5. Stores detected CLI version in settings.

**Update flow**: On app launch, compares the installed CLI version against the stored version in settings. Update flow (checking for newer versions, one-click update) is scaffolded for future implementation.

### `tool-integrations.js` — External Tool Discovery & Configuration

Detects, installs, and configures external tools in the CourseCode authoring environment. Extends beyond simple detection to include automated configuration of tool integrations.

**Tool registry**: Maintains a list of known tools with detection strategies, download URLs, and configuration logic.

**Detection**:

| Tool | macOS Detection | Windows Detection |
|------|----------------|-------------------|
| CourseCode CLI | Bundled CLI check, then `which coursecode` | Bundled CLI check, then `where coursecode` |
| VS Code | `/usr/local/bin/code` or `.app` bundle | `code` on PATH |
| Claude Code | `which claude` | `where claude` |
| Git | `which git` | `where git` |
| GitHub Desktop | `/Applications/GitHub Desktop.app` | Registry/PATH check |

**AI Agent Configuration (MCP)**:

The most important integration. When the user clicks "Configure" for Claude Code, the module:
1. Locates the Claude Code MCP config file (`~/.claude/mcp.json` or creates it).
2. Adds the `coursecode` MCP server entry, pointing to the `coursecode mcp` command (bundled-first resolution).
3. The MCP config entry includes the server name, command, and args — no manual JSON editing needed.
4. If a project-level `.mcp.json` is preferred, the module can write per-project configs instead.

This is the bridge that enables AI-assisted course authoring. Once configured, users open Claude Code in a project directory and the AI has full access to CourseCode's MCP tools (preview, build, lint, navigate, interact, screenshot).

**Download URLs**: Each tool has a platform-specific download URL. "Install" buttons open the download page in the default browser via `shell.openExternal()`. The app does not download or install third-party software itself — it directs users to official download pages.

**Status caching**: Detection results are cached in-memory and refreshed when the user opens the Setup Assistant or Settings → Tools & Integrations. No background polling.

---

## Menu Bar

The app provides a native menu bar appropriate to each platform.

**macOS**:
- **CourseCode Desktop**: About, Preferences (⌘,), Quit (⌘Q)
- **File**: New Course (⌘N), Open Projects Folder
- **Edit**: Standard edit menu
- **View**: Reload, Force Reload, DevTools, Open Preview in Browser (⇧⌘P), Fullscreen
- **Window**: Standard window menu
- **Help**: Documentation (opens web), Report Issue (opens GitHub issues)

**Windows**:
- **File**: New Course (Ctrl+N), Open Projects Folder, Settings, Exit
- **Edit**: Standard edit menu
- **View**: Reload, Force Reload, DevTools, Open Preview in Browser (Ctrl+Shift+P), Fullscreen
- **Help**: Documentation, Report Issue, About

Shortcuts are registered via menu accelerators. ⌘N / Ctrl+N triggers navigation to the Create Wizard. ⌘, / Ctrl+, triggers navigation to Settings.

**Open Preview in Browser** (⇧⌘P / Ctrl+Shift+P): Sends an event to the renderer, which opens the current preview server port in the system's default browser. Useful when the preview is running embedded in the chat workspace and the user wants to view it externally.

---

## Setup Assistant

The Setup Assistant is the first-launch experience and the ongoing hub for managing the authoring environment. It transforms the desktop app from a simple GUI wrapper into the central orchestrator for the entire CourseCode toolchain.

### First Launch

When the app opens for the first time (`setupCompleted` is `false`), the Setup Assistant runs as a full-screen guided flow with a sidebar navigation.

**Progress persistence**: The current step is saved to `lastSetupStep` in settings. If the user quits mid-setup and reopens the app, the assistant resumes from where they left off instead of restarting.

### Revisitable

After first launch, the Setup Assistant is accessible from Settings → Tools & Integrations → "Run Setup Assistant" button. The Settings view also shows a condensed version of the tool status cards inline.

### Steps

**Welcome** — Animated CourseCode logo reveal transitions into a welcome card with one-line description ("Let's get your environment set up") and a "Let's Go" button. Sets the tone: friendly, approachable, non-technical. Explains that tools are optional and can be skipped.

**Step 1 — CourseCode Tools** (recommended, skippable) — Shows CourseCode tools readiness. If not ready, "Install CourseCode Tools" runs `cli-installer.js` to verify bundled tools first and use fallback install only when needed. On success, shows green checkmark and installed version. On failure, shows error with retry.

> ℹ️ **Why?** tooltip: "CourseCode Tools power everything — previews, builds, exports, and AI integration. This is the foundation."

**Step 2 — AI Assistant** (recommended, skippable) — "Claude Code can create entire courses for you using AI."

- Status: ✅ Installed & Configured / ⚙️ Installed, Needs Setup / ⬇️ Not Installed
- If not installed: "Download Claude Code" button opens the download page in the browser.
- If installed but not configured: "Connect to CourseCode" button runs MCP configuration automatically — writes the MCP config file so Claude Code discovers the `coursecode` server.
- If installed and configured: Green checkmark.

The card uses plain language throughout. No mention of "MCP", "CLI", or "config files." The framing is: "Connect your AI assistant so it can help you build courses."

> ℹ️ **Why?** tooltip: "Claude Code can generate an entire 20-slide course from a single prompt. It's the fastest way to author content."

**Step 3 — Code Editor** (recommended, skippable) — "A code editor lets you edit course files directly."

- **VS Code** detection
- Status: ✅ Installed / ⬇️ Not Installed
- If not installed: "Download VS Code" button opens download page.
- If installed: Green checkmark.

> ℹ️ **Why?** tooltip: "VS Code gives you full control over your course files. It's also where Claude Code runs."

**Step 4 — Version Control** (optional, skippable) — "Git and GitHub Desktop help you track changes and deploy automatically."

Shows two ToolCards side-by-side:
- **Git** — detection status
- **GitHub Desktop** — detection status
- Download buttons shown for tools that aren't installed.

> ℹ️ **Why?** tooltip: "Version control lets you undo mistakes, collaborate with teammates, and set up automatic deployments via GitHub."

**Step 5 — CourseCode Cloud** (optional, skippable) — "Sign in to deploy courses to the web with one click."
- "Sign In to CourseCode Cloud" button → spawns `coursecode login` (opens browser).
- Shows ⏳ "Waiting for browser authentication…" spinner during polling.
- On success: ✅ "Signed in as [name]" with email.
- On error: ⚠️ "Sign in failed" with "Try Again" button.

> ℹ️ **Why?** tooltip: "CourseCode Cloud hosts your courses and provides a shareable URL, analytics, and team management."

Each **"Why?"** tooltip is a small ℹ️ icon next to the step title. Clicking or hovering expands a brief explanation of the tool's value in plain language.

**Done** — "You're All Set!" with a "Get Started" button. Notes that setup can be revisited from Settings. Redirects to the Dashboard.

### Tool Card Component

Each step (3-6) uses a reusable `ToolCard.svelte` component that shows:
- Tool icon and name
- One-sentence description in plain English
- Status indicator: green checkmark (✅ ready), gear icon (⚙️ needs config), download icon (⬇️ not installed)
- Primary action button (context-dependent: "Install", "Configure", "Sign In")
- Secondary link ("Skip", "Reconfigure", "Learn more")

The same component is reused in Settings → Tools & Integrations for the persistent status view.

### Language Philosophy

The Setup Assistant never uses developer terminology directly:
- "Install Node.js" → never mentioned (bundled invisibly)
- "MCP server" → "Connect to CourseCode"
- "CLI" → "CourseCode tools" or just implied
- "Git" → "version control" or "auto-deploy"
- "Repository" → "project"
- "npm install" → "Installing dependencies" or "Setting things up"
- "PATH" → never mentioned (handled silently)

Subsequent launches skip the Setup Assistant and go directly to the Dashboard.

---

## Cloud Deploy

The desktop app delegates all deployment to the `coursecode deploy` CLI command.

**Flow**: User clicks "Deploy" in Project Detail → desktop spawns `coursecode deploy` → CLI builds the project, uploads to CourseCode Cloud, and reports status → structured progress events are sent to the renderer.

**Progress events**: The deploy sends `{ stage, message, log }` events to the renderer:
- `building` — "Building course…"
- `uploading` — "Uploading to Cloud…"
- `complete` — "Deployed!"
- Raw CLI output is available in the `log` field for optional subtle display.

**Cloud project linking**: On first deploy, the CLI resolves the project slug (from directory name) and creates a cloud record. The resulting `cloudId` is stamped into `.coursecoderc.json`. Team members who clone the repo get this ID automatically, skipping slug-based resolution.

**Git-based CI/CD**: For power users, deploying via GitHub Actions is an option configured outside the desktop app. The CLI provides the same deploy command for CI environments.

**Desktop UI**: The Project Detail view shows:
- **Deploy reason popover**: Clicking the Deploy button opens a small popover with an optional text input for a deploy reason (e.g., "Fixed accessibility issues on slide 3"). The user can type a reason and click "Deploy" to confirm, or leave it blank and deploy without a reason. Pressing Enter confirms; Escape cancels. The reason is passed to the CLI via the `-m` flag, which appends it as the `reason` field in the deploy audit log. If omitted, the server's default message is used.
- Deploy progress (Building → Uploading → Live)
- Last deploy timestamp and URL
- "View on Cloud" link (if `cloudId` is present in `.coursecoderc.json`)

---

## AI Chat

A built-in AI assistant that can create, modify, and debug courses through natural language conversation. Supports two modes: **BYOK** (Bring Your Own Key) for direct provider access, and **Cloud** for credit-based access through the CourseCode Cloud AI proxy.

### Architecture

**Main process modules**:

**`chat-engine.js`** — Orchestrates the AI conversation loop. Implements an agentic tool-use pattern: sends user messages to the LLM, processes tool calls, executes them, and loops until the LLM produces a final text response (no more tool requests). Streams response tokens and tool invocations back to the renderer via IPC events. Manages conversation history per project and persists it to disk. Accepts a `mode` parameter (`'byok'` or `'cloud'`) to select the provider path.

**`llm-provider.js`** — Abstracts LLM API calls across providers. Supports Anthropic (Claude), OpenAI (GPT), and CourseCode Cloud (proxy). The cloud proxy provider uses the cloud auth token (from `~/.coursecode/credentials.json`) to call the proxy's SSE endpoint, yielding the same event types as direct providers so the agentic loop works identically. Handles API key storage using Electron's `safeStorage` for BYOK keys. Also provides `getCloudModels(token)` and `getCloudUsage(token)` for fetching available cloud models and credit balances.

**`system-prompts.js`** — Dynamically assembles the system prompt sent to the LLM. Combines:
- A base persona (CourseCode authoring expert)
- Tool definitions from the CourseCode MCP server
- Project context (current project path, config, structure)
- User custom instructions from settings

**`ref-manager.js`** — Manages reference documents. Lists, reads, and converts files (PDF, DOCX, PPTX, etc.) to markdown using the `coursecode ingest` CLI command. Supports drag-and-drop conversion from the RefsPanel UI.

### Tool Use

The AI has access to the full CourseCode MCP tool set, enabling it to:
- Navigate and inspect course slides
- Take screenshots of the live preview
- Create and edit slide HTML files
- Modify `course-config.js`
- Run the linter and fix issues
- Create and test interactions (quizzes, drag-drop, etc.)
- Read reference documents for context

Tool invocations are displayed as interactive pills in the chat UI showing the tool name and status (running/complete/error).

### Chat UI Components

**`ChatPanel.svelte`** — The main chat view. Contains the message list, input area with @mention support, model picker, and streaming indicators. Integrates with the `chat` Svelte store for reactive state.

**`MessageBubble.svelte`** — Renders individual messages with:
- Markdown content (rendered via `marked`)
- Tool use pills with status indicators
- Inline screenshots from tool use
- @mention chips
- Usage display (tokens for BYOK, credits for Cloud)

**`MentionDropdown.svelte`** — @mention autocomplete that groups suggestions by type (Slides, References, Interactions). Triggered by typing `@` in the chat input. Resolves mentions to file contents or context before sending to the LLM.

**`ModelPicker.svelte`** — Provider and model selection dropdown. Groups models into two sections: **"Your Keys"** (BYOK providers) and **"CourseCode Cloud"** (fetched from the cloud proxy). Selecting a model sets the per-conversation `aiMode` (`'byok'` or `'cloud'`). Cloud models show credit cost per message instead of dollar estimates. Cloud section is gated behind authentication — shows "Sign in to use" if the user is not logged in.

**`RefsPanel.svelte`** — Reference document sidebar with drag-and-drop file conversion. Lists converted references with preview. Available as a standalone panel.

### Credit System

In cloud mode, AI usage is charged in credits. Credits are deducted before each LLM call based on estimated input tokens and maximum output tokens. The `chat:done` IPC event includes `creditsCharged` when in cloud mode. The chat store tracks credit balance via `loadCredits()` which calls `GET /api/ai/usage`. The ModelPicker displays the current credit balance inline when cloud mode is active.

Credit errors (HTTP 402) are translated to a friendly "You're out of credits" message with a link to top up.

### Chat State (`chat.js` store)

Manages reactive state for the chat UI:
- `messages` — Writable store of all messages in the current conversation
- `streaming` — Whether the AI is currently generating a response
- `activeTools` — Currently executing tool invocations
- `sessionUsage` — Token usage tracking: `{ inputTokens, outputTokens, estimatedCost }`
- `aiMode` — Per-conversation mode: `'byok'` or `'cloud'`
- `credits` — Cloud credit balance (populated via `loadCredits()`)

Provides `subscribeToChatEvents()` to set up IPC listeners for real-time streaming updates.

### Security

- BYOK API keys are encrypted at rest using Electron's `safeStorage` API
- Keys are stored in `app.getPath('userData')/ai-keys/`, separate from settings
- Keys are never exposed to the renderer process
- Cloud mode uses the same Bearer token as cloud deploy (from `~/.coursecode/credentials.json`)
- API errors are translated into human-readable messages

---

## Logging & Error Handling

> **RULES — these are mandatory, not guidelines:**
> 1. **All main-process modules MUST use the structured logger** (`createLogger`). Bare `console.log`, `console.error`, or `console.warn` calls are **forbidden** outside of `logger.js` itself.
> 2. **No silent `catch {}` blocks.** Every catch must log the error — use `log.debug` for expected/non-critical failures, `log.warn` for recoverable problems, `log.error` for actual failures.
> 3. **All IPC handlers MUST be wrapped** with `wrapIpcHandler` from `errors.js` — never register a raw `ipcMain.handle` directly.

### Structured Logger (`main/logger.js`)

Zero-dependency logger providing scoped, leveled output. Every module creates a scoped instance via `createLogger('moduleName')`.

**API**: `log.debug()`, `log.info()`, `log.warn()`, `log.error()` — each accepts a message string and optional context (object or Error).

| Behavior | Development (`!app.isPackaged`) | Production (`app.isPackaged`) |
|---|---|---|
| Console output | All levels (debug+), colorized | warn+ only |
| File logging | None | JSON lines to `userData/logs/main.log` |
| File rotation | N/A | 5 MB max, 3 backups |

### Error Translation (`main/errors.js`)

Centralizes mapping of raw errors to user-friendly messages with error codes:

- `PORT_IN_USE` — "Another app is using that port."
- `AUTH_EXPIRED` — Cloud vs BYOK context-aware messages
- `CREDITS_EXHAUSTED`, `RATE_LIMITED`, `NETWORK_ERROR` — Self-explanatory user messages
- `UNKNOWN` — Fallback with original error message

**`wrapIpcHandler(channel, fn)`** — wraps any IPC handler with automatic error logging and translation. Every IPC handler in `ipc-handlers.js` uses this.

**`translateChatError(err, isCloud)`** — context-aware chat error translation used by `chat-engine.js`.

### Error Handling UX

Every action button follows a consistent state machine:

**Idle → Loading → Success / Error**

- **Loading**: Button shows a spinner, label changes to action verb ("Building...", "Deploying..."). Button is disabled. If the action supports progress, a progress bar appears below.
- **Success**: Toast notification with **contextual action buttons** — e.g., build success toast includes "Reveal in Finder", deploy success toast includes "Open in Browser".
- **Error**: Toast with error summary in red. Expandable error detail panel in the console output area. "Try Again" button where appropriate.

**Undo for destructive actions**: Deleting a project shows a toast with an "Undo" button for 5 seconds before actually moving the files to the system trash.

**Console output** is the primary error detail surface. All spawned processes (preview, build, npm install) stream their output to the console panel in the Project Detail view.

### Global Error Handlers

`main/index.js` installs `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers. In production, these log the error and show a dialog. In development, they log prominently to the console.

---

## Auto-Update

Uses `electron-updater` with GitHub Releases as the update source.

**Flow**:
1. On app launch (after a 5s delay to avoid blocking startup), checks for updates via `autoUpdater.checkForUpdates()`.
2. If an update is available, a non-intrusive notification bar appears at the top of the window: "Update available (v1.2.3) — Restart to update" with a "Restart" button and a "Dismiss" option.
3. The update downloads in the background.
4. When the user clicks "Restart", calls `autoUpdater.quitAndInstall()`.

**Configuration**: The update feed URL points to the GitHub Releases API for the `coursecode-desktop` repo. Release assets include platform-specific files (`latest-mac.yml`, `latest.yml`) that `electron-updater` uses for differential updates.

---

## Distribution & Code Signing

### Build Configuration

`electron-builder.yml` defines the packaging targets:

**macOS**:
- Target: `.dmg` with drag-to-Applications layout.
- Architecture: Universal binary (Intel + Apple Silicon).
- Category: `public.app-category.developer-tools`.
- Hardened runtime enabled.
- Notarize: disabled by default, enabled when signing identity is configured.
- Identity: `null` (unsigned) until Apple Developer certificate is obtained.

**Windows**:
- Target: NSIS installer (`.exe`).
- One-click install, per-user (no admin required).
- Includes uninstaller.
- Unsigned initially; signing identity added when certificate is obtained.

### Signing Configuration

Code signing is scaffolded but disabled. To enable:

**macOS**: Set the `CSC_NAME` environment variable or `mac.identity` in `electron-builder.yml` to the Developer ID Application certificate name. Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for notarization.

**Windows**: Set `CSC_LINK` (path to .pfx file) and `CSC_KEY_PASSWORD` environment variables.

All signing credentials are environment variables, never committed to the repo. CI/CD (GitHub Actions) stores them as encrypted secrets.

### CI/CD Release Pipeline

A `.github/workflows/release.yml` workflow automates builds:
- Triggered on `git tag v*` push.
- Derives app version from the tag (`vX.Y.Z` → `X.Y.Z`) and syncs `package.json` before packaging.
- Matrix build: macOS (universal) and Windows (x64).
- Runs `electron-vite build` + `electron-builder`.
- Produces versioned installer filenames (`CourseCode-Desktop-v<version>-mac.dmg`, `CourseCode-Desktop-v<version>-win.exe`) plus update metadata files (`latest*.yml`).
- Creates a GitHub Release with the built artifacts (marked prerelease automatically for `-beta` / `-alpha` tags).
- Maintainer verifies artifacts/checksums and updates desktop-site release metadata (`coursecode-sites/apps/desktop-site/src/data/site.ts`).

### Estimated Sizes

| Platform | Format | Size |
|----------|--------|------|
| macOS | `.dmg` | ~150MB (includes bundled Node + npm) |
| Windows | `.exe` installer | ~110MB |

---

## Testing

### Unit Tests (Vitest)

Unit tests use [Vitest](https://vitest.dev/) with v8 coverage to test main process modules in isolation. The goal is **bug-finding over line-count** — tests target pure logic, edge cases, security boundaries, and data consistency rather than mocking every integration seam.

**Stack**: `vitest` + `@vitest/coverage-v8`. Config in `vitest.config.js`.

**Directory**: `test/` at the project root. Test files follow a `test/main/<module>.test.js` convention mirroring the source structure.

**Electron mocking**: `test/mocks/electron.js` provides stubs for `app`, `shell`, `ipcMain`, and `safeStorage`. All main process modules import from `electron`, which is intercepted via `vi.mock('electron', ...)` in each test file.

**Test isolation**: Tests that involve filesystem I/O (settings, projects, snapshots, refs, files) create isolated temporary directories via `mkdtemp` and clean up in `afterEach`. Heavy dependencies (CLI spawning, LLM network calls) are mocked out.

**Modules tested**:
- `errors.js` — all ERROR_MAP entries, rule priority ordering, null/empty errors, `translateChatError` cloud vs BYOK branching, `wrapIpcHandler` middleware
- `settings.js` — load/save cycle, corrupt JSON recovery, default merging, projects directory creation
- `project-manager.js` — project scanning, metadata extraction (title/format/version), edge cases (corrupt configs, missing dirs)
- `node-env.js` — path resolution, env merging, CLI spawn arg construction, local mode toggle
- `logger.js` — factory shape, all argument patterns (string, data, Error, undefined)
- `cloud-client.js` — token loading null path, `getCloudUser` short-circuit
- `file-manager.js` — path traversal security (`../../` escape, absolute path injection), language detection for all extensions, directory listing filtering (hidden files, ignored dirs, editable-only types), `course/` subdirectory auto-resolution
- `system-prompts.js` — prompt assembly with all context permutations (title, slides, refs, memory, custom instructions), whitespace-only handling
- `ai-config.js` (via system-prompts tests) — schema validation of `TOOL_DEFINITIONS` (name, description, input_schema, required fields), cross-referencing `TOOL_LABELS` and `PREVIEW_TOOLS` against `TOOL_DEFINITIONS` for consistency
- `snapshot-manager.js` — real `isomorphic-git` operations: init, commit, log, diff, change detection. Includes a regression test for the stat-cache staging fix (same-length same-second writes)
- `ref-manager.js` — reference file listing, reading, `formatSize` at all scales (B, KB, MB), missing file errors
- `workflow-runner.js` — outline parsing regex (ID generation, special chars, numeric prefixes, trailing hyphen stripping), config generation with single-quote escaping
- `update-manager.js` — dev-mode guard, install state machine, idempotent init
- `tool-integrations.js` — tool registry data integrity (names, URLs, MCP config), `getToolMeta` lookup for known and unknown tools

**Intentionally not unit-tested**: `chat-engine.js`, `llm-provider.js`, `mcp-client.js`, `ipc-handlers.js`, `preview-manager.js`, `build-manager.js`, `cli-installer.js`. These modules are integration-heavy (spawning processes, making network calls, wiring IPC) and are better covered by E2E tests.

**Coverage**: v8 provider generates reports in four formats:
- `text` — inline terminal summary
- `text-summary` — compact terminal summary
- `html` — browsable report at `coverage/index.html`
- `lcov` — machine-readable for CI integration

Coverage scope includes all `main/**/*.js` files except `main/index.js` (app lifecycle, requires real Electron).

**Running**:
```bash
npm test                 # Run all unit tests
npm run test:watch       # Interactive watch mode
npm run test:coverage    # Run with v8 coverage report
```

### E2E Tests (Playwright)

End-to-end tests use [Playwright's Electron integration](https://playwright.dev/docs/api/class-electron) to launch the real app, interact with the Svelte renderer, and assert on user-visible behavior.

**Stack**: `@playwright/test` with `_electron.launch()`. No browser matrix — tests run against the Electron shell directly.

**Directory**: `e2e/` at the project root. Config in `playwright.config.js`.

**Test isolation**: Each test launches the app with an isolated temporary `userData` directory via the `ELECTRON_USER_DATA_DIR` environment variable. The main process checks for this env var before any modules reference `app.getPath('userData')`, and `settings.js` resolves the settings path lazily via `getSettingsPath()` so the override takes effect. This means tests never touch real user settings or projects.

**Shared helper** (`e2e/helpers.js`):
- `launchApp()` — Creates a temp `userData` dir, seeds `settings.json` with `setupCompleted: true` (skips Setup Assistant), and returns the `app` and `window`.
- `launchApp({ freshInstall: true })` — Same but without seeding settings, for testing the Setup Assistant flow.

**Selectors**: Key UI elements have `data-testid` attributes for stable, CSS/text-independent selectors. The `App.svelte` container also exposes a `data-view` attribute reflecting the current view name (`dashboard`, `setup`, `project`, etc.).

**Running**:
```bash
npm run build && npm run test:e2e
```

Tests require a build first (`electron-vite build`) since they launch `./out/main/index.js`.

---

## Snapshot & Restore System

The app tracks project state using `isomorphic-git` (pure JS, zero native dependencies — no Git installation required). All complexity is hidden behind a "History" metaphor.

### Architecture

| Layer | File | Role |
|-------|------|------|
| Core | `main/snapshot-manager.js` | Git init, commit, checkout, diff, log, prune |
| IPC | `main/ipc-handlers.js` | `snapshots:*` channels |
| Preload | `preload/index.js` | `window.api.snapshots.*` namespace |
| Store | `renderer/src/stores/snapshots.js` | Reactive state for snapshot list and pending changes |
| UI | `renderer/src/components/HistoryPanel.svelte` | Timeline slide-over panel |

Commits use `[CourseCode]` message prefix to coexist with user-managed Git repos. Metadata (label, chatIndex, files changed) is stored as JSON in the commit message body.

### Auto-Snapshot Triggers

| Trigger | Label | Location |
|---------|-------|----------|
| Project creation | "Project created" | `project-manager.js` |
| Before AI chat turn | "Before AI changes" | `chat-engine.js` |
| After AI chat turn | "AI: \<summary\>" | `chat-engine.js` |
| Before export | "Before export" | `build-manager.js` |

### Pruning Policy

Pruning runs lazily during `listSnapshots()`:

- **< 24h**: Keep all
- **1–7 days**: Max 10 per day
- **7–30 days**: Max 2 per day
- **> 30 days**: Only milestones (project created, before export/deploy)

### History UI

- **Toolbar**: Clock icon in both chat and non-chat modes toggles the History panel
- **Panel**: Slide-over on the right side showing a timeline of snapshots
- **Expand**: Click a snapshot to see added/modified/deleted files
- **Restore**: Full-state restore to any snapshot (creates a reversible restore-point commit)
- **Undo**: 5-second toast after restore allows reverting the restore action
- **Chat linking**: Snapshots with `chatIndex` metadata show a "View Chat" link

### Chat Integration

After each AI turn that modifies files, a `chat:changeSummary` event is emitted. The chat store appends a compact change summary card (e.g., "📝 3 files changed — +2 added · ~1 modified") to the message history.

---

## Design System

### Brand Palette

The framework CSS palette is the source of truth. The desktop app mirrors those raw palette tokens in `renderer/src/styles/tokens.css`, and all UI colors reference semantic tokens derived from that framework palette.

| Token | Hex | Role |
|-------|-----|------|
| `--palette-white` | `#ffffff` | Light backgrounds, dark-mode text |
| `--palette-black` | `#000000` | Reserved |
| `--palette-gray` | `#808080` | Muted text, borders |
| `--palette-charcoal` | `#23272e` | Premium neutral ink for dark neutrals |
| `--palette-blue` | `#14213d` | Prussian Blue: sidebar background, primary text, logo |
| `--palette-blue-light` | `#4a6fa5` | Info accent, links |
| `--palette-green` | `#1d7648` | Success states, running servers |
| `--palette-yellow` | `#f7b801` | Accent yellow, warning support |
| `--palette-amber` | `#f18701` | Tiger Orange: primary app accent and action buttons |
| `--palette-orange` | `#f35b04` | Cayenne: vibrant brand supporting accent |
| `--palette-red` | `#c7322b` | Danger/error states, destructive actions |

**Surfaces**: Prussian Blue sidebar (`#14213d`) with light content area (`#fafafa`) in light mode. In dark mode, structural surfaces remain blue-based while elevated surfaces (cards/panels/inputs) use Charcoal (`#23272e`) for neutral depth.

**Primary accent**: Tiger Orange (`#f18701`, `--palette-amber`) is the primary accent color used for all action buttons (CTAs, "Let's Go", "Deploy", etc.).

**Typography**: System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`). Monospace for console output and paths (`'SF Mono', 'Cascadia Code', 'Consolas', monospace`).

### Logo & Identity

The CourseCode logo is an SVG depicting angle brackets `< >` with a lightbulb icon nestled between them (`logo-coursecode.svg`). It is embedded inline as SVG in three locations:

- **Dashboard header** — 24×24, next to the "CourseCode" app title.
- **Tab bar home tab** — 14×14, replacing the default house icon.
- **Setup Assistant welcome** — 64×64, as a hero visual on the first-launch screen.

**Monochrome rule**: The logo and the "CourseCode" wordmark are always monochromatic. They use `--text-primary`, which resolves to **Prussian Blue** (`#14213d`) in light mode and **white** (`#e8e8f0`) in dark mode. No gradients, no accent colors on the logo or title.

**App icon**: `build/icon.png` — a 1024×1024 PNG with the logo rendered in white on a Prussian Blue squircle background. `electron-builder` generates `.icns` (macOS) and `.ico` (Windows) from this source image.

### Desktop UI Conventions

> **Hard rule**: This is a native desktop application, not a website. All interaction patterns, feedback, and motion must follow desktop app conventions (VS Code, Figma, Linear, Slack) — not web/marketing conventions.

Key differences from web UI:
- **No hover lift** (`translateY`) on buttons or cards. Desktop apps use background color shifts and subtle shadow changes.
- **No gradient buttons or shimmer effects**. Those belong in course content (the framework), not app chrome.
- **Disabled controls**: `opacity: 0.5` + `pointer-events: none` + `cursor: default`. Native apps don't show a 🚫 (`not-allowed`) cursor — disabled elements simply don't respond.
- **Focus rings**: Soft `box-shadow` glow using the accent color at low opacity (macOS convention), not a hard 2px outline (web convention).
- **System font stack**: Always. No custom web fonts.

### Button System

Defined in `global.css`. All buttons use the base `button` element styles (inline-flex, no border, font-weight 500, 150ms transitions).

| Class | Background | Text | Use |
|-------|-----------|------|-----|
| `.btn-primary` | `--accent` (Orange) | White | Primary CTAs: "Preview", "Deploy", "Let's Go" |
| `.btn-secondary` | Transparent | `--text-primary` | Secondary actions with border |
| `.btn-ghost` | Transparent | `--text-secondary` | Tertiary/toolbar actions, no border |
| `.btn-danger` | `--error` (Red) | White | Destructive actions: "Delete" |

**Sizes**: `.btn-sm` (compact, for toolbars), default, `.btn-lg` (prominent actions).

**Hover**: Background color darkens + shadow appears. No transform/movement.

**Focus**: `box-shadow: 0 0 0 3px var(--accent-subtle)` — a soft orange glow matching macOS focus ring convention. `outline: none` suppresses the browser default.

**Disabled**: `opacity: 0.5`, `pointer-events: none`, `cursor: default`.

### Visual Language

- **Cards**: Rounded corners (8px), subtle shadow, background darken on hover (no lift).
- **Status indicators**: Colored dots (green/grey/red) with animated feedback:
  - Running preview → subtle green pulse.
  - Deploy in progress → animated progress ring around the deploy icon.
  - Build in progress → indeterminate progress bar on the project card.
- **Transitions**: Svelte's built-in `fade`, `slide`, and `fly` transitions for view changes and modal appearances. 200-300ms duration.
- **Skeleton loading**: Pulsing grey placeholder cards matching the real card layout, shown while scanning projects or loading data.
- **Empty states**: Centered illustration (generated or icon-based) with heading, description, and CTA button.
- **Toast notifications**: Slide in from bottom-right, auto-dismiss after 5s, manually dismissable. Include contextual action buttons ("Reveal in Finder", "Open in Browser") where applicable.
- **Contextual help panel**: A `?` button in each view's header that slides open a narrow help sidebar with 2-3 tips relevant to the current view. Dismissable and non-intrusive.

### Theme Support

Light mode, dark mode, and system-follow. Implemented via CSS custom properties on `:root` and `[data-theme="dark"]`. Svelte store tracks the current theme and applies the data attribute. `nativeTheme.themeSource` is set to match so native Electron dialogs follow the same theme.

---

## What This Spec Does NOT Cover

- Built-in course editor or WYSIWYG (courses are edited in VS Code / AI tools or via the framework's preview server visual editing)
- Mobile app
- Cloud admin dashboard (that's the cloud platform's web UI)
- Linux distribution (can be added later with minimal effort)
