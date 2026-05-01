# CourseCode Desktop User Guide

CourseCode Desktop is the local-first desktop app for creating, previewing, exporting, and optionally deploying CourseCode projects without needing terminal or Node.js setup.

CourseCode Desktop and CourseCode Framework are open source and work without Cloud. CourseCode Cloud is an optional hosted layer for deployment, licensing, analytics, and managed services.

Cloud is mainly about saving time and reducing deployment friction: easier sharing, hosted delivery workflows, and fewer LMS packaging decisions.

## Table of Contents

1. [What Desktop Is For](#what-desktop-is-for)
2. [Core Workflow](#core-workflow)
3. [First Launch](#first-launch)
4. [The Main Views](#the-main-views)
5. [Preview, Export, and Deploy (Important Terms)](#preview-export-and-deploy-important-terms)
6. [Local-First vs Cloud (Optional)](#local-first-vs-cloud-optional)
7. [AI in Desktop (Optional)](#ai-in-desktop-optional)
8. [Project Files and Ownership](#project-files-and-ownership)
9. [Troubleshooting Basics](#troubleshooting-basics)
10. [Where to Go Next](#where-to-go-next)

---

## What Desktop Is For

Use Desktop when you want:
- a guided GUI workflow for CourseCode projects
- local preview and export without command-line setup
- built-in setup help for AI tools, editors, and integrations
- optional one-click deploy to CourseCode Cloud

Desktop uses the same CourseCode project format and runtime ecosystem as the Framework/CLI.

## Core Workflow

1. Install CourseCode Desktop
2. Create a project
3. Preview locally
4. Edit content (Desktop + external editor + optional AI workflows)
5. Export locally for LMS upload, or deploy to CourseCode Cloud (optional)

## First Launch

On first launch, Desktop guides you through setup:
- CourseCode tools readiness (CLI/runtime support)
- optional editor/tool integrations
- optional Cloud sign-in

You can skip Cloud sign-in and still use local authoring, preview, and export workflows.

## The Main Views

### Dashboard

The Dashboard is your project home base:
- shows projects in your configured projects folder
- lets you create new courses
- shows preview status and quick actions

### Create Wizard

The Create Wizard helps you create a new project with:
- course name
- location
- LMS format (for local workflow defaults; CourseCode Cloud deploy uses a universal build)
- layout
- optional blank project start

### Project Detail

Project Detail is your working view for a single course.

Typical actions:
- `Preview` (start/stop local preview server)
- `Export` (build LMS package locally)
- `Deploy` (publish to CourseCode Cloud, optional)
- Cloud deployment management for linked courses
- open in editor / reveal in Finder / open terminal

### Settings

Settings controls:
- projects directory
- default format/layout
- appearance/theme
- AI settings (BYOK or Cloud models, if enabled)
- tools & integrations status

## Preview, Export, and Deploy (Important Terms)

### Preview

`Preview` means running a local preview server with a stub LMS for testing your course locally.

### Export

`Export` means building a local LMS package (for example SCORM/cmi5 output) for manual upload or delivery.

### Deploy

`Deploy` means publishing your course to CourseCode Cloud.

Deploy is optional.

Cloud deploy uses a universal build:
- the LMS format you choose in Desktop is a local default for local export workflows
- Cloud can generate the needed LMS format later without rebuilding
- Cloud-served launches auto-configure runtime error/data/channel endpoints (zero-config cloud wiring)

If a project has manual endpoint settings in `course-config.js` for error reporting, data reporting, or channel relay, Cloud launches override them with cloud-injected runtime config. Keep manual endpoint settings for self-hosted/custom endpoint workflows.

### Why Use Cloud (Optional, but useful)

Cloud is most helpful when you want to spend less time on packaging and file sharing.

What Cloud gives you:
- a hosted course version you can access online after deploy
- a main preview link for reviewers and stakeholders
- password-protected preview sharing by default, with passwordless sharing as an explicit choice
- Production and Preview pointers so you can stage review versions without changing what learners see
- LMS format downloads later (SCORM/cmi5) from the same uploaded build
- simpler updates (redeploy once, then use Cloud for future downloads/sharing)
- cloud-managed runtime services (reporting/channel) without manual endpoint setup

This is especially useful if you:
- review courses with clients/SMEs before LMS upload
- support multiple LMS environments or clients
- want a cleaner handoff process than emailing ZIP files back and forth

### When to Use Cloud vs Local Export

- Use `Export` if you just need a local ZIP file for manual LMS upload and nothing else.
- Use `Deploy` if you want hosted previews, easier sharing, and format flexibility later.
- Many teams use both: `Preview` during development, `Deploy` for review/share, then Cloud download for LMS delivery.

## Local-First vs Cloud (Optional)

### Local-first (no Cloud required)

You can use Desktop fully for:
- creating projects
- previewing locally
- exporting packages
- using your own tools/editor setup

### Optional Cloud workflows

If you sign in to CourseCode Cloud, Desktop can also support:
- one-click deploy
- cloud-hosted delivery workflows
- cloud-linked AI credit usage (instead of BYOK)

Typical non-technical workflow:
1. Build and test in Desktop with `Preview`
2. Click `Deploy` to publish to Cloud
3. Keep `Require password` on for the main preview link unless you intentionally want a passwordless review URL
4. Share the Cloud preview link with reviewers
5. Make fixes in Desktop and deploy again
6. Use the Cloud Deployments panel to move the Preview pointer for review or Production pointer when approved
7. Download the LMS package you need from Cloud when approved

### Managing Cloud Deployments in Desktop

For a linked Cloud course, Project Detail includes a Cloud Deployments panel. It is a focused Desktop subset of the Cloud web app.

Use it to:
- create, enable, disable, copy, or open the main preview link
- add, change, or remove the preview password
- extend preview expiry by seven days
- see the current Production and Preview pointer versions
- view recent deployments
- move the Preview pointer to a selected deployment
- move the Production pointer to a selected deployment when the course is not GitHub-linked

The main preview link follows the Preview pointer. That means the shared URL can stay the same while you choose which deployment reviewers see.

Desktop keeps advanced Cloud workflows in the Cloud web app, including multiple pinned stakeholder preview links, cleanup, analytics, and detailed audit exploration.

### GitHub-Linked Courses

If a course is linked to a GitHub repository, production deploys are managed by GitHub. Push to the repo to update Production.

Desktop still supports:
- preview-only deploys
- Preview pointer changes
- main preview link password/expiry management

Desktop disables Production pointer changes for GitHub-linked courses to avoid conflicting with the repository workflow.

Cloud features should always be labeled optional in Desktop UI/docs.

## AI in Desktop (Optional)

Desktop can include an AI chat workspace for project work.

Modes:
- `BYOK` — use your own API key with supported providers
- `Cloud` — use CourseCode Cloud models/credits (requires sign-in)

AI is an optional assistive workflow. You can still build courses without it.

## Project Files and Ownership

Desktop works with normal project folders on disk. Your course files remain in your local project directory.

Recommended habits:
- keep projects in a dedicated folder
- use version control for important projects
- treat Desktop as a tool for your files, not a lock-in container

## Troubleshooting Basics

### Preview won’t start

Check:
- another process using the same port
- project is a valid CourseCode project
- local tooling installation/setup completed

### Deploy is unavailable

Check:
- Cloud sign-in status
- internet connection
- course builds successfully locally
- your account/org has access to CourseCode Cloud features

### AI Cloud mode unavailable

Check:
- signed in to CourseCode Cloud
- cloud credits/model availability

## Where to Go Next

- [Desktop site docs](https://coursecodedesktop.com/docs) (install / first run / FAQ)
- [Framework docs](https://coursecodeframework.com/docs) (for deeper runtime/CLI workflows)
- [CourseCode Cloud](https://coursecodecloud.com) (when using hosted workflows)
