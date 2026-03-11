# CourseCode Desktop

**Open-source, local-first desktop app for CourseCode authoring — the easiest way to create, preview, export, and optionally deploy courses without dealing with Node.js or terminal setup.**

If you want the guided, button-based workflow, start on the Desktop site:

- **Website (recommended):** [coursecodedesktop.com](https://coursecodedesktop.com)
- **Install + docs:** [coursecodedesktop.com/docs/install](https://coursecodedesktop.com/docs/install)
- **User guide (site):** [coursecodedesktop.com/docs/user-guide](https://coursecodedesktop.com/docs/user-guide)

## Download (Beta)

You can download installers directly here to avoid extra steps:

- **macOS (Apple Silicon + Intel, beta):** [Download `.dmg` (v0.9.0)](https://github.com/course-code-framework/coursecode-desktop/releases/download/v0.9.0/CourseCode-Desktop-v0.9.0-mac.dmg)
- **Windows 10/11 x64 (beta):** [Download `.exe` (v0.9.0)](https://github.com/course-code-framework/coursecode-desktop/releases/download/v0.9.0/CourseCode-Desktop-v0.9.0-win.exe)
- **Release notes + checksums:** [GitHub Release v0.9.0 (February 15, 2026)](https://github.com/course-code-framework/coursecode-desktop/releases/tag/v0.9.0)

## Temporary Beta Note (Unsigned Apps)

CourseCode Desktop is currently in **beta testing**, and the installers are **not code signed / notarized yet**.

- macOS and Windows may show security warnings during install or first launch
- this is expected for the current beta builds
- install only from **[coursecodedesktop.com](https://coursecodedesktop.com)** or the official **[GitHub Releases](https://github.com/course-code-framework/coursecode-desktop/releases)**
- verify checksums from the release page if you want extra assurance

This note is temporary and will be removed once signed/notarized builds are available.

## What Desktop Is For

Use Desktop if you want:

- a guided workflow with buttons instead of terminal commands
- local preview and LMS export without Node.js setup
- optional AI-assisted authoring (BYOK or Cloud credits)
- optional one-click deploy to CourseCode Cloud

Desktop uses the same project format as the CourseCode Framework, so your files stay portable.

## Open Source + Optional Cloud

- **CourseCode Desktop**: open-source, local-first app
- **CourseCode Framework**: open-source framework + CLI
- **CourseCode Cloud**: optional hosted service for deployment, sharing, analytics, and managed AI credits

Cloud is optional. Desktop and Framework remain useful for local authoring and export without Cloud.

## Start Here

- **Prefer the easiest setup:** Start with the Desktop site and install guide: [coursecodedesktop.com/docs/install](https://coursecodedesktop.com/docs/install)
- **Want the full Desktop walkthrough:** See the repo guide: [`USER_GUIDE.md`](./USER_GUIDE.md)
- **Prefer editing files and running commands:** Use the Framework repo: [coursecode](https://github.com/course-code-framework/coursecode)
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
