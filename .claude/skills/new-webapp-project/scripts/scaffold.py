#!/usr/bin/env python3
"""
Scaffold a new Threadbeast web application project.

Creates a monorepo with:
  - client/  — React + Vite + TypeScript frontend
  - server/  — Node.js + Express + TypeScript API backend
  - Optional MySQL + Prisma database layer

Usage:
  python3 scaffold.py --name "my-app" --description "A cool app" --output ./projects/my-app [--with-db]
"""

import argparse
import json
import os
import sys
import textwrap


def write_file(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def scaffold(name: str, description: str, output: str, with_db: bool) -> None:
    if os.path.exists(output) and os.listdir(output):
        print(f"Error: {output} already exists and is not empty.", file=sys.stderr)
        sys.exit(1)

    os.makedirs(output, exist_ok=True)

    # ── Root files ──────────────────────────────────────────────

    write_file(f"{output}/package.json", json.dumps({
        "name": name,
        "private": True,
        "description": description,
        "workspaces": ["client", "server"],
        "scripts": {
            "dev:client": "npm run dev --workspace=client",
            "dev:server": "npm run dev --workspace=server",
            "build:client": "npm run build --workspace=client",
            "build:server": "npm run build --workspace=server",
            "lint": "npm run lint --workspace=client",
            "typecheck": "npx tsc --noEmit -p client/tsconfig.json && npx tsc --noEmit -p server/tsconfig.json"
        }
    }, indent=2) + "\n")

    write_file(f"{output}/tsconfig.base.json", json.dumps({
        "compilerOptions": {
            "target": "ES2022",
            "module": "ESNext",
            "moduleResolution": "bundler",
            "strict": True,
            "esModuleInterop": True,
            "skipLibCheck": True,
            "forceConsistentCasingInFileNames": True,
            "resolveJsonModule": True,
            "isolatedModules": True,
            "noUnusedLocals": True,
            "noUnusedParameters": True
        }
    }, indent=2) + "\n")

    env_lines = [
        "# Server",
        "PORT=3001",
        "NODE_ENV=development",
        "CLIENT_URL=http://localhost:5173",
        "",
    ]
    if with_db:
        env_lines += [
            "# Database (MySQL)",
            'DATABASE_URL="mysql://root:password@localhost:3306/' + name.replace("-", "_") + '"',
            "",
        ]
    write_file(f"{output}/.env.example", "\n".join(env_lines))

    write_file(f"{output}/.gitignore", textwrap.dedent("""\
        node_modules/
        dist/
        .env
        .env.*
        !.env.example
        *.tsbuildinfo
        .vite/
        coverage/
    """))

    write_file(f"{output}/.dockerignore", textwrap.dedent("""\
        node_modules/
        dist/
        .env
        .env.*
        !.env.example
        *.tsbuildinfo
        .vite/
        coverage/
        .git/
        .gitignore
        README.md
        docker-compose.yml
    """))

    # ── Dockerfile (single file, builds both client + server) ───

    write_file(f"{output}/Dockerfile", textwrap.dedent("""\
        # ── Stage 1: Install all workspace dependencies ─────────
        FROM node:22-alpine AS deps
        WORKDIR /app
        COPY package.json ./
        COPY client/package.json ./client/
        COPY server/package.json ./server/
        RUN npm install

        # ── Stage 2: Build the React client ─────────────────────
        FROM deps AS client-build
        WORKDIR /app
        COPY tsconfig.base.json ./
        COPY client/ ./client/
        RUN npm run build:client

        # ── Stage 3: Build the Express server ───────────────────
        FROM deps AS server-build
        WORKDIR /app
        COPY tsconfig.base.json ./
        COPY server/ ./server/
        RUN npm run build:server

        # ── Stage 4: Production image ───────────────────────────
        # Nginx serves the frontend and proxies /api to the Node backend
        FROM node:22-alpine AS production

        RUN apk add --no-cache nginx supervisor

        WORKDIR /app

        # Copy built server + production node_modules
        COPY --from=deps /app/node_modules ./node_modules
        COPY --from=deps /app/server/node_modules ./server/node_modules
        COPY --from=server-build /app/server/dist ./server/dist
        COPY server/package.json ./server/

        # Copy built client static files to nginx
        COPY --from=client-build /app/client/dist /usr/share/nginx/html

        # Nginx config
        COPY nginx.conf /etc/nginx/http.d/default.conf

        # Supervisor config to run both nginx and node
        COPY supervisord.conf /etc/supervisord.conf

        ENV NODE_ENV=production
        EXPOSE 80 3001

        CMD ["supervisord", "-c", "/etc/supervisord.conf"]
    """))

    write_file(f"{output}/nginx.conf", textwrap.dedent("""\
        server {
            listen 80;
            server_name localhost;
            root /usr/share/nginx/html;
            index index.html;

            location / {
                try_files $uri $uri/ /index.html;
            }

            location /api {
                proxy_pass http://127.0.0.1:3001;
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto $scheme;
            }
        }
    """))

    write_file(f"{output}/supervisord.conf", textwrap.dedent("""\
        [supervisord]
        nodaemon=true
        logfile=/dev/stdout
        logfile_maxbytes=0

        [program:nginx]
        command=nginx -g "daemon off;"
        autostart=true
        autorestart=true
        stdout_logfile=/dev/stdout
        stdout_logfile_maxbytes=0
        stderr_logfile=/dev/stderr
        stderr_logfile_maxbytes=0

        [program:server]
        command=node /app/server/dist/index.js
        directory=/app/server
        autostart=true
        autorestart=true
        stdout_logfile=/dev/stdout
        stdout_logfile_maxbytes=0
        stderr_logfile=/dev/stderr
        stderr_logfile_maxbytes=0
    """))

    # ── Docker Compose (for local development with optional DB) ─

    compose = textwrap.dedent(f"""\
        services:
          app:
            build:
              context: .
              dockerfile: Dockerfile
            ports:
              - "80:80"
              - "3001:3001"
            env_file:
              - .env
    """)

    if with_db:
        db_name = name.replace("-", "_")
        compose += textwrap.dedent(f"""\
            depends_on:
              db:
                condition: service_healthy

          db:
            image: mysql:8.0
            ports:
              - "3306:3306"
            environment:
              MYSQL_ROOT_PASSWORD: password
              MYSQL_DATABASE: {db_name}
            volumes:
              - db_data:/var/lib/mysql
            healthcheck:
              test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
              interval: 10s
              timeout: 5s
              retries: 5

        volumes:
          db_data:
        """)

    write_file(f"{output}/docker-compose.yml", compose)

    write_file(f"{output}/README.md", textwrap.dedent(f"""\
        # {name}

        {description}

        ## Getting Started

        ```bash
        # Install dependencies
        npm install

        # Start the frontend dev server (port 5173)
        npm run dev:client

        # Start the API server (port 3001)
        npm run dev:server
        ```

        ## Project Structure

        ```
        {name}/
        ├── client/    # React + Vite + TypeScript frontend
        └── server/    # Express + TypeScript API backend
        ```

        ## Scripts

        | Command | Description |
        |---|---|
        | `npm run dev:client` | Start frontend dev server |
        | `npm run dev:server` | Start API dev server |
        | `npm run build:client` | Build frontend for production |
        | `npm run build:server` | Build API for production |
        | `npm run lint` | Run ESLint on frontend |
        | `npm run typecheck` | Type-check both client and server |

        ## Docker

        ```bash
        # Build and run all services
        docker compose up --build

        # Run in detached mode
        docker compose up --build -d

        # Stop all services
        docker compose down
        ```

        The client is served via Nginx on port 80 and proxies `/api` requests to the server on port 3001.
    """))

    # ── Client (React + Vite + TypeScript) ──────────────────────

    client = f"{output}/client"

    write_file(f"{client}/package.json", json.dumps({
        "name": f"{name}-client",
        "private": True,
        "type": "module",
        "scripts": {
            "dev": "vite",
            "build": "tsc -b && vite build",
            "preview": "vite preview",
            "lint": "eslint ."
        },
        "dependencies": {
            "react": "^19.1.0",
            "react-dom": "^19.1.0",
            "react-router-dom": "^7.5.0"
        },
        "devDependencies": {
            "@tailwindcss/vite": "^4.1.3",
            "@types/react": "^19.1.0",
            "@types/react-dom": "^19.1.0",
            "@vitejs/plugin-react": "^4.4.1",
            "eslint": "^9.22.0",
            "eslint-plugin-react-hooks": "^5.2.0",
            "tailwindcss": "^4.1.3",
            "typescript": "~5.7.0",
            "typescript-eslint": "^8.26.0",
            "vite": "^6.3.0"
        }
    }, indent=2) + "\n")

    write_file(f"{client}/tsconfig.json", json.dumps({
        "extends": "../tsconfig.base.json",
        "compilerOptions": {
            "lib": ["ES2022", "DOM", "DOM.Iterable"],
            "jsx": "react-jsx",
            "outDir": "./dist",
            "baseUrl": ".",
            "paths": {
                "@/*": ["./src/*"]
            }
        },
        "include": ["src"]
    }, indent=2) + "\n")

    write_file(f"{client}/vite.config.ts", textwrap.dedent("""\
        import { defineConfig } from 'vite'
        import react from '@vitejs/plugin-react'
        import tailwindcss from '@tailwindcss/vite'
        import path from 'path'

        export default defineConfig({
          plugins: [react(), tailwindcss()],
          resolve: {
            alias: {
              '@': path.resolve(__dirname, './src'),
            },
          },
          server: {
            proxy: {
              '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
              },
            },
          },
        })
    """))

    write_file(f"{client}/eslint.config.js", textwrap.dedent("""\
        import js from '@eslint/js'
        import tseslint from 'typescript-eslint'
        import reactHooks from 'eslint-plugin-react-hooks'

        export default tseslint.config(
          { ignores: ['dist'] },
          {
            extends: [js.configs.recommended, ...tseslint.configs.recommended],
            files: ['**/*.{ts,tsx}'],
            plugins: {
              'react-hooks': reactHooks,
            },
            rules: {
              ...reactHooks.configs.recommended.rules,
              '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            },
          },
        )
    """))

    write_file(f"{client}/index.html", textwrap.dedent(f"""\
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>{name}</title>
          </head>
          <body>
            <div id="root"></div>
            <script type="module" src="/src/main.tsx"></script>
          </body>
        </html>
    """))

    write_file(f"{client}/src/main.tsx", textwrap.dedent("""\
        import { StrictMode } from 'react'
        import { createRoot } from 'react-dom/client'
        import { BrowserRouter } from 'react-router-dom'
        import { App } from '@/App'
        import '@/app.css'

        createRoot(document.getElementById('root')!).render(
          <StrictMode>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </StrictMode>,
        )
    """))

    write_file(f"{client}/src/App.tsx", textwrap.dedent("""\
        import { Routes, Route } from 'react-router-dom'
        import { Header } from '@/components/layout/Header'
        import HomePage from '@/pages/HomePage'

        export const App = () => {
          return (
            <div className="min-h-screen bg-white text-gray-900">
              <Header />
              <main>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                </Routes>
              </main>
            </div>
          )
        }
    """))

    write_file(f"{client}/src/app.css", textwrap.dedent("""\
        @import "tailwindcss";
    """))

    write_file(f"{client}/src/components/layout/Header.tsx", textwrap.dedent(f"""\
        import {{ Link }} from 'react-router-dom'

        export const Header = () => {{
          return (
            <header className="border-b border-gray-200 bg-white">
              <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
                <Link to="/" className="text-xl font-bold text-gray-900">
                  {name}
                </Link>
                <nav className="flex items-center gap-6">
                  <Link to="/" className="text-sm font-medium text-gray-600 hover:text-gray-900">
                    Home
                  </Link>
                </nav>
              </div>
            </header>
          )
        }}
    """))

    write_file(f"{client}/src/pages/HomePage.tsx", textwrap.dedent(f"""\
        const HomePage = () => {{
          return (
            <div className="mx-auto max-w-7xl px-4 py-16">
              <h1 className="text-4xl font-bold tracking-tight text-gray-900">
                {name}
              </h1>
              <p className="mt-4 text-lg text-gray-600">
                {description}
              </p>
            </div>
          )
        }}

        export default HomePage
    """))

    write_file(f"{client}/src/types/index.ts", textwrap.dedent("""\
        export interface ApiResponse<T> {
          data: T
          message?: string
        }

        export interface ApiError {
          message: string
          statusCode: number
        }
    """))

    write_file(f"{client}/src/utils/cn.ts", textwrap.dedent("""\
        export function cn(...classes: (string | boolean | undefined | null)[]): string {
          return classes.filter(Boolean).join(' ')
        }
    """))

    # Create empty directories with .gitkeep
    for dir_name in ["features", "hooks", "assets"]:
        write_file(f"{client}/src/{dir_name}/.gitkeep", "")

    # ── Server (Express + TypeScript) ───────────────────────────

    server = f"{output}/server"

    server_deps = {
        "cors": "^2.8.5",
        "express": "^5.1.0",
        "helmet": "^8.1.0",
    }
    server_dev_deps = {
        "@types/cors": "^2.8.17",
        "@types/express": "^5.0.2",
        "@types/node": "^22.14.0",
        "tsx": "^4.19.0",
        "typescript": "~5.7.0"
    }

    if with_db:
        server_deps["@prisma/client"] = "^6.5.0"
        server_dev_deps["prisma"] = "^6.5.0"

    server_scripts = {
        "dev": "tsx watch src/index.ts",
        "build": "tsc",
        "start": "node dist/index.js"
    }
    if with_db:
        server_scripts["db:generate"] = "prisma generate"
        server_scripts["db:push"] = "prisma db push"
        server_scripts["db:studio"] = "prisma studio"

    write_file(f"{server}/package.json", json.dumps({
        "name": f"{name}-server",
        "private": True,
        "type": "module",
        "scripts": server_scripts,
        "dependencies": server_deps,
        "devDependencies": server_dev_deps
    }, indent=2) + "\n")

    write_file(f"{server}/tsconfig.json", json.dumps({
        "extends": "../tsconfig.base.json",
        "compilerOptions": {
            "lib": ["ES2022"],
            "outDir": "./dist",
            "rootDir": "./src",
            "declaration": True
        },
        "include": ["src"]
    }, indent=2) + "\n")

    write_file(f"{server}/src/index.ts", textwrap.dedent("""\
        import { app } from './app.js'
        import { env } from './utils/env.js'

        const port = env.PORT

        app.listen(port, () => {
          console.log(`Server running on http://localhost:${port}`)
        })
    """))

    write_file(f"{server}/src/app.ts", textwrap.dedent("""\
        import express from 'express'
        import cors from 'cors'
        import helmet from 'helmet'
        import { routes } from './routes/index.js'
        import { errorHandler } from './middleware/errorHandler.js'
        import { requestLogger } from './middleware/requestLogger.js'
        import { env } from './utils/env.js'

        export const app = express()

        app.use(helmet())
        app.use(cors({ origin: env.CLIENT_URL }))
        app.use(express.json())
        app.use(requestLogger)

        app.use('/api', routes)

        app.use(errorHandler)
    """))

    write_file(f"{server}/src/routes/index.ts", textwrap.dedent("""\
        import { Router } from 'express'
        import { healthRouter } from './health.js'

        export const routes = Router()

        routes.use('/health', healthRouter)
    """))

    write_file(f"{server}/src/routes/health.ts", textwrap.dedent("""\
        import { Router } from 'express'

        export const healthRouter = Router()

        healthRouter.get('/', (_req, res) => {
          res.json({ status: 'ok', timestamp: new Date().toISOString() })
        })
    """))

    write_file(f"{server}/src/middleware/errorHandler.ts", textwrap.dedent("""\
        import type { ErrorRequestHandler } from 'express'

        export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
          const statusCode = err.statusCode ?? 500
          const message = err.message ?? 'Internal server error'

          if (process.env.NODE_ENV !== 'production') {
            console.error(err)
          }

          res.status(statusCode).json({ message, statusCode })
        }
    """))

    write_file(f"{server}/src/middleware/requestLogger.ts", textwrap.dedent("""\
        import type { RequestHandler } from 'express'

        export const requestLogger: RequestHandler = (req, _res, next) => {
          const timestamp = new Date().toISOString()
          console.log(`[${timestamp}] ${req.method} ${req.url}`)
          next()
        }
    """))

    write_file(f"{server}/src/types/index.ts", textwrap.dedent("""\
        export interface ApiResponse<T> {
          data: T
          message?: string
        }

        export interface AppError extends Error {
          statusCode: number
        }
    """))

    write_file(f"{server}/src/utils/env.ts", textwrap.dedent("""\
        function requireEnv(key: string, fallback?: string): string {
          const value = process.env[key] ?? fallback
          if (value === undefined) {
            throw new Error(`Missing required environment variable: ${key}`)
          }
          return value
        }

        export const env = {
          PORT: parseInt(requireEnv('PORT', '3001'), 10),
          NODE_ENV: requireEnv('NODE_ENV', 'development'),
          CLIENT_URL: requireEnv('CLIENT_URL', 'http://localhost:5173'),
    """ + ("""\
          DATABASE_URL: requireEnv('DATABASE_URL'),
    """ if with_db else "") + """\
        } as const
    """))

    # ── Optional: Prisma / MySQL ────────────────────────────────

    if with_db:
        db_name = name.replace("-", "_")
        write_file(f"{server}/prisma/schema.prisma", textwrap.dedent(f"""\
            generator client {{
              provider = "prisma-client-js"
            }}

            datasource db {{
              provider = "mysql"
              url      = env("DATABASE_URL")
            }}

            // Add your models below. Example:
            // model User {{
            //   id        Int      @id @default(autoincrement())
            //   email     String   @unique
            //   name      String?
            //   createdAt DateTime @default(now())
            //   updatedAt DateTime @updatedAt
            // }}
        """))

        write_file(f"{server}/src/lib/prisma.ts", textwrap.dedent("""\
            import { PrismaClient } from '@prisma/client'

            const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

            export const prisma = globalForPrisma.prisma ?? new PrismaClient()

            if (process.env.NODE_ENV !== 'production') {
              globalForPrisma.prisma = prisma
            }
        """))

    print(f"Project '{name}' scaffolded at {output}")
    if with_db:
        print("  - MySQL + Prisma database layer included")
    print()
    print("Next steps:")
    print(f"  cd {output}")
    print("  cp .env.example .env")
    print("  npm install")
    print("  npm run dev:client   # Frontend on :5173")
    print("  npm run dev:server   # API on :3001")
    if with_db:
        print("  npm run db:push --workspace=server  # Push schema to database")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scaffold a Threadbeast web app project")
    parser.add_argument("--name", required=True, help="Project name (kebab-case)")
    parser.add_argument("--description", required=True, help="One-line project description")
    parser.add_argument("--output", required=True, help="Output directory path")
    parser.add_argument("--with-db", action="store_true", help="Include MySQL + Prisma setup")
    args = parser.parse_args()

    scaffold(args.name, args.description, args.output, args.with_db)
