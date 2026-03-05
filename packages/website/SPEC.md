# Conductor OSS Marketing Website Spec

## Goal
Build a stunning, modern landing page for Conductor OSS — a markdown-native AI agent orchestrator. Think Linear.app meets GitHub meets vibekanban.com, but darker and more technical.

## Tech Stack (MUST USE)
- Next.js 16 (already in package.json)
- Tailwind CSS v4 (via `@tailwindcss/postcss`)
- Framer Motion for scroll animations
- Lucide React for icons
- Inter + JetBrains Mono fonts (via next/font/google)
- NO additional UI libraries — hand-craft all components

## Design Direction
- **Dark mode ONLY** — bg: `#09090b` (zinc-950), surfaces: `#18181b` (zinc-900)
- **Accent:** Electric violet `#7C3AED` (brand) + cyan `#06B6D4` for CTAs
- **Typography:** Large, bold headlines (Inter 800), monospace for code (JetBrains Mono)
- **Glassmorphism cards** with subtle borders (`border-zinc-800`)
- **Gradient text** on hero headline (violet → cyan)
- **Smooth scroll animations** — fade in on scroll, stagger children
- **Full-width sections**, max-w-6xl content container
- **Mobile responsive** — works on all screens

## Page Sections (in order)

### 1. Navigation Bar (sticky)
- Logo: "conductor" in bold monospace + small "oss" badge
- Links: Features, How it Works, Agents, Install
- GitHub stars badge (link to repo)
- CTA button: "Get Started" → scrolls to install section

### 2. Hero Section
- Large headline: "Orchestrate AI Coding Agents" with gradient text
- Subtitle: "Write tasks in markdown. Conductor spawns agents, manages worktrees, tracks PRs, and updates your board — all locally."
- Two CTAs: "Get Started" (primary, violet) + "View on GitHub" (outline)
- Below: animated terminal mockup showing `npx conductor-oss start` → watching boards → spawning agent
- "Works with" row: logos/icons for Claude Code, Codex, Gemini, Amp, Cursor, OpenCode, Droid, Qwen Code, CCR, GitHub Copilot

### 3. Problem Section — "Your Bottleneck Has Shifted"
- Left: text explaining the problem (coding agents are fast, but planning/review is the bottleneck)
- Right: simple diagram showing: Human → Planning → Multiple Agents in Parallel → Review → Ship
- Clean, minimal layout

### 4. Features Grid (3 columns, 2 rows)
Cards for:
1. **Markdown Native** — Write tasks in Obsidian, VS Code, or any editor. No proprietary UI.
2. **10 Agent Plugins** — Claude Code, Codex, Gemini, Amp, and 6 more. Swap freely.
3. **Git Worktree Isolation** — Every task gets its own worktree. No branch conflicts.
4. **Live Dashboard** — Real-time session status, diffs, chat, terminal output.
5. **Full PR Lifecycle** — Open → CI → Review → Merge. Automated end to end.
6. **Zero Cloud** — No database. No SaaS. Runs entirely on your machine.

### 5. How it Works — 3 Steps
Horizontal layout:
1. **PLAN** — Write a task in your kanban board (show markdown snippet)
2. **DISPATCH** — Conductor auto-tags, spawns agent in isolated worktree
3. **REVIEW** — Dashboard shows diff, output, PR status. Approve and merge.

### 6. Dashboard Preview
- Full-width screenshot/mockup of the Conductor dashboard
- Overlay badges: "Real-time sessions", "Code diffs", "Agent chat"
- Subtle glow effect behind the screenshot

### 7. Comparison Table
Conductor vs Manual vs Other Tools (same data as README but styled nicely)

### 8. Install Section — "Get Started in 60 Seconds"
- Terminal-style code block:
  ```
  npm install -g conductor-oss
  conductor init
  conductor start
  ```
- Below: "Open localhost:4747 and start orchestrating"
- Link to docs

### 9. Footer
- Logo
- Links: GitHub, npm, Docs, Discord
- "Built by the community. MIT Licensed."
- Copyright

## File Structure
```
packages/website/
├── src/
│   ├── app/
│   │   ├── layout.tsx        (root layout, fonts, metadata)
│   │   ├── page.tsx          (landing page — all sections)
│   │   └── globals.css       (tailwind imports + custom CSS)
│   └── components/
│       ├── Navbar.tsx
│       ├── Hero.tsx
│       ├── Problem.tsx
│       ├── Features.tsx
│       ├── HowItWorks.tsx
│       ├── DashboardPreview.tsx
│       ├── Comparison.tsx
│       ├── Install.tsx
│       ├── Footer.tsx
│       ├── TerminalMock.tsx   (animated terminal component)
│       └── FadeIn.tsx         (scroll animation wrapper)
├── next.config.ts
├── tsconfig.json
├── postcss.config.mjs
└── package.json (already exists)
```

## Key Interactions
- Smooth scroll between sections via nav links
- Terminal mockup: typewriter animation showing commands running
- Feature cards: fade up on scroll with stagger
- Dashboard preview: subtle parallax or scale on scroll
- CTA buttons: hover glow effect

## Critical Rules
- NO placeholder images — use CSS/SVG for all visuals
- ALL text must be real copy, not lorem ipsum
- Mobile responsive — test at 375px, 768px, 1280px
- Performance: aim for 95+ Lighthouse score
- Accessible: proper heading hierarchy, ARIA labels on interactive elements
- GitHub repo link: https://github.com/charannyk06/conductor-oss
- npm package: conductor-oss
