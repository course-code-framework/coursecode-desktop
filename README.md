# CourseCode Desktop

> **For new courses, use [CourseCode Framework](https://github.com/course-code-framework/coursecode)** with Claude Code, Codex, or another AI tool that supports MCP. CourseCode Desktop stays available for existing users, but it is no longer promoted and may not receive further releases.

**Open-source, local-first desktop app for CourseCode authoring. Create, preview, export, and optionally deploy courses without Node.js or terminal setup.**

If you want the guided, button-based workflow, start on the Desktop site:

- **Website (recommended):** [coursecodedesktop.com](https://coursecodedesktop.com)
- **Install + docs:** [coursecodedesktop.com/docs/install](https://coursecodedesktop.com/docs/install)
- **User guide (site):** [coursecodedesktop.com/docs/user-guide](https://coursecodedesktop.com/docs/user-guide)

## Download (Beta)

Use the Desktop site for the current installers, release notes, and checksums:

- **Latest downloads:** [coursecodedesktop.com/download](https://coursecodedesktop.com/download)
- **GitHub Releases:** [course-code-framework/coursecode-desktop/releases](https://github.com/course-code-framework/coursecode-desktop/releases)

## Beta Note (Unsigned Apps)

CourseCode Desktop is a **beta**, and the installers are **not code signed or notarized**.

- macOS and Windows may show security warnings during install or first launch
- this is expected for the current beta builds
- install only from **[coursecodedesktop.com](https://coursecodedesktop.com)** or the official **[GitHub Releases](https://github.com/course-code-framework/coursecode-desktop/releases)**
- verify checksums from the release page if you want extra assurance

## What Desktop Is For

Use Desktop if you want:

- a guided workflow with buttons instead of terminal commands
- local preview and LMS export without Node.js setup
- optional AI-assisted authoring with your own provider API key (BYOK)
- optional one-click deploy to CourseCode Cloud

Desktop uses the same project format as the CourseCode Framework, so your files stay portable.

## Open Source + Optional Cloud

- **CourseCode Desktop**: open-source, local-first app
- **CourseCode Framework**: open-source framework + CLI
- **CourseCode Cloud**: optional hosted service for deployment, sharing, and analytics

Cloud is optional. Desktop and Framework remain useful for local authoring and export without Cloud.

## Start Here

- **Prefer the easiest setup:** Start with the Desktop site and install guide: [coursecodedesktop.com/docs/install](https://coursecodedesktop.com/docs/install)
- **Want the full Desktop walkthrough:** See the repo guide: [`USER_GUIDE.md`](./USER_GUIDE.md)
- **Using Claude Code, Codex, or another AI coding tool, or prefer the command line:** Use [CourseCode Framework](https://github.com/course-code-framework/coursecode) directly. New projects open ready in those tools.
- **Need hosted sharing/deploy workflows:** See [CourseCode Cloud](https://coursecodecloud.com)

## For Contributors / Developers

This repo contains the Electron app source.

```bash
npm install
npm run dev
```

Useful scripts:

- `npm test`
- `npm run test:e2e`
- `npm run package`

## License

MIT
