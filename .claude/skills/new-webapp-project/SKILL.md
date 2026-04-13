---
name: new-webapp-project
description: "Scaffold a new full-stack web application project inside the projects/ folder. Creates a monorepo with a React + Vite + TypeScript frontend and a Node.js + Express + TypeScript API backend, following Threadbeast code standards from TB-claude-playbook. Use this skill whenever someone wants to start a new project, create a new app, scaffold a web app, spin up a new codebase, or initialize a new web project — even if they don't say 'scaffold' explicitly."
---

# New Web App Project Scaffolder

This skill creates a new full-stack web application project inside the `projects/` folder of this repository. Every project follows Threadbeast's code standards from the TB-claude-playbook.

## What Gets Created

Each project is a **monorepo** with two workspaces:

```
projects/{project-name}/
├── package.json              # Root workspace config
├── tsconfig.base.json        # Shared TS config
├── Dockerfile                # Multi-stage build (client + server)
├── docker-compose.yml        # Local dev with optional MySQL
├── nginx.conf                # Nginx config for production container
├── supervisord.conf          # Runs nginx + node in single container
├── .dockerignore
├── .env.example              # Environment variable template
├── .gitignore
├── README.md
├── client/                   # React + Vite + TypeScript frontend
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── eslint.config.js
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── app.css
│       ├── components/
│       │   └── layout/
│       │       └── Header.tsx
│       ├── features/
│       ├── hooks/
│       ├── pages/
│       │   └── HomePage.tsx
│       ├── types/
│       │   └── index.ts
│       └── utils/
│           └── cn.ts
└── server/                   # Node.js + Express + TypeScript API
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts          # Entry point — server bootstrap
        ├── app.ts            # Express app config (middleware, routes)
        ├── routes/
        │   ├── index.ts      # Route aggregator
        │   └── health.ts     # Health check endpoint
        ├── middleware/
        │   ├── errorHandler.ts
        │   └── requestLogger.ts
        ├── types/
        │   └── index.ts
        └── utils/
            └── env.ts        # Typed environment variable access
```

### Optional: MySQL Database Layer

If the user wants a database, add a MySQL + Prisma layer to the server:

```
server/
├── prisma/
│   └── schema.prisma         # Prisma schema with MySQL provider
└── src/
    └── lib/
        └── prisma.ts         # Singleton Prisma client
```

Only add the database layer if the user explicitly asks for it or says the project needs a database. Default to no database.

## How to Use This Skill

### Step 1: Gather Requirements

Ask the user for:

1. **Project name** — will become the directory name (kebab-case). This is required.
2. **One-line description** — what the app does. This is required.
3. **Database needed?** — MySQL + Prisma, or no database. Default: no database.

That's it. Don't over-interview. If they give you a name and description, start building.

### Step 2: Run the Scaffold Script

Run the scaffolding script to generate all project files:

```bash
python3 {skill-path}/scripts/scaffold.py \
  --name "{project-name}" \
  --description "{description}" \
  --output "{repo-root}/projects/{project-name}" \
  [--with-db]
```

The `--with-db` flag adds MySQL + Prisma setup. Omit it for a database-free project.

### Step 3: Install Dependencies

```bash
cd {repo-root}/projects/{project-name}
npm install
```

### Step 4: Verify the Scaffold

Run a quick check that everything is wired up:

```bash
cd {repo-root}/projects/{project-name}
# TypeScript compiles
npx tsc --noEmit -p client/tsconfig.json
npx tsc --noEmit -p server/tsconfig.json
# Dev servers start (quick smoke test)
```

If there are TypeScript errors, fix them before finishing.

### Step 5: Tell the User What Was Created

Give a brief summary:
- Project location
- How to run the dev servers (`npm run dev:client` and `npm run dev:server`)
- Whether database was included
- Remind them to copy `.env.example` to `.env` and fill in values if using a database

## Code Standards (from TB-claude-playbook)

These are baked into the templates, but here's a summary so you understand the why:

### Frontend (React + Vite + TypeScript)
- **TypeScript strict mode** — no `any`, use `unknown` and narrow
- **Path aliases** — `@/` maps to `src/`
- **Named exports** for components, default exports only for pages
- **Props as interfaces** — named `{ComponentName}Props`
- **Feature-first architecture** — `src/features/{name}/` with co-located slice, hooks, components
- **Tailwind CSS v4** via `@tailwindcss/vite` plugin
- **Vite** with `@vitejs/plugin-react`
- **ESLint** flat config with `typescript-eslint` and `eslint-plugin-react-hooks`
- **Vitest + React Testing Library** for tests
- **react-router-dom v6+** for routing

### Backend (Express + TypeScript)
- **TypeScript strict mode** — same standards as frontend
- **Feature-based route organization** — routes grouped by domain
- **Environment variables** via typed accessor (never hardcode secrets)
- **Error handling middleware** — centralized, never swallow errors
- **CORS configured** for the frontend dev server
- **Helmet** for security headers
- **Request logging** via a simple middleware

### Shared
- Self-documenting code — comments only when logic is genuinely non-obvious
- Conventional Commits for commit messages
- No dead code, no unused imports
- Parameterized queries only (if using database)
- Validate and sanitize all external input at API boundaries
