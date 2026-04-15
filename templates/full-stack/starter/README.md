# Generated App

This starter scaffold is copied from the `full-stack` template before the agent
fills in product-specific content.

## Local development

1. Copy `.env.example` to `.env`
2. Run `pnpm install`
3. Run `pnpm db:init`
4. Run `pnpm dev`

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
- Sidebar navigation in `config/sidebar-menu.json`
- Sidebar supports at most two levels; unknown `icon` keys fall back to a generic item icon
- Final `app-builder-report.md`
