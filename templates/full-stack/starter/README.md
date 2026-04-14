# Generated App

This starter scaffold is copied from the `full-stack` template before the agent
fills in product-specific content.

## Local development

1. Copy `.env.example` to `.env`
2. Run `npm install`
3. Run `npm run db:init`
4. Run `npm run dev`

The default local database is SQLite at `prisma/dev.db`.

## UI framework

- Next.js App Router
- TailAdmin Next.js admin dashboard structure
- Tailwind CSS v4 tokens and utilities from the official TailAdmin example

## What the agent should customize

- Application name, summary, and metadata
- Prisma schema and seed data
- Dashboard content and entity navigation
- Entity CRUD pages under `app/<entity>/`
- Final `app-builder-report.md`
