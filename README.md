# filechat

A single-page browser app that lets you chat with Claude about your files — no server required.

## What it does

Drop files into your browser, then ask Claude questions about them or have it edit them for you. Everything stays local: files are stored in IndexedDB and your API token lives in localStorage.

**Features:**
- Drag-and-drop file loading (text, code, markdown, JSON, CSV, etc.)
- Ask questions about file contents with full context sent to Claude
- Claude can create and edit files using built-in tools, with an optional review step
- Local commands: `ls`, `cat`, `search`, `rm`
- Dark terminal-style UI

## Setup

1. Deploy to GitHub Pages (or open `index.html` locally)
2. Click **set token** and enter your API gateway bearer token
3. Add files and start chatting

> **Note:** The app points at a configurable API proxy by default. To use the Anthropic API directly, change `API_BASE` in the `<script>` section to `https://api.anthropic.com`.

## GitHub Pages

This repo is ready to serve as a static GitHub Pages site. Enable Pages in your repo settings (source: **Deploy from a branch**, branch: **main**, folder: **/ (root)**) and it will serve `index.html` directly.
