---
name: browser
description: "Chrome browser control: open pages, take ref snapshots, click, type, screenshot. Requires cli-claw server running."
metadata:
  {
    "openclaw":
      {
        "emoji": "🌐",
        "requires": { "bins": ["cli-claw"], "system": ["Google Chrome"] },
        "install":
          [
            {
              "id": "brew-cliclick",
              "kind": "brew",
              "formula": "cliclick",
              "bins": ["cliclick"],
              "label": "Install cliclick (optional, for coordinate-based clicks)",
            },
          ],
      },
  }
---

# Browser Control

Control Chrome browser via `cli-claw browser` commands.
Uses ref-based snapshots to identify page elements, then click/type by ref ID.

## Prerequisites

- cli-claw server must be running (`cli-claw serve`)
- Google Chrome must be installed
- playwright-core must be installed (`npm i playwright-core`)

## Quick Start

```bash
cli-claw browser start                          # Start Chrome (CDP port 9240)
cli-claw browser navigate "https://example.com" # Go to URL
cli-claw browser snapshot                        # Get page structure with ref IDs
cli-claw browser click e3                        # Click ref e3
cli-claw browser type e5 "hello"                 # Type into ref e5
cli-claw browser screenshot                      # Save screenshot
```

## Core Workflow

> **Always follow this pattern:**
> 1. `snapshot` → See page structure + ref IDs
> 2. `click`/`type`/`press` → Interact using ref
> 3. `snapshot` → Verify result → Repeat

## Commands

### Browser Management

```bash
cli-claw browser start [--port 9240]  # Start Chrome (default CDP port: 9240)
cli-claw browser stop                 # Stop Chrome
cli-claw browser status               # Connection status
```

### Observe

```bash
cli-claw browser snapshot                # Ref snapshot (all elements)
cli-claw browser snapshot --interactive  # Interactive elements only (buttons, links, inputs)
cli-claw browser screenshot              # Current viewport
cli-claw browser screenshot --full-page  # Full page
cli-claw browser screenshot --ref e5     # Specific ref element only
cli-claw browser text                    # Page text content
cli-claw browser text --format html      # HTML source
```

### Snapshot Output Example

```
e1   link       "Gmail"
e2   link       "Images"
e3   textbox    "Search"           ← To type here: type e3 "query"
e4   button     "Google Search"    ← To click: click e4
e5   button     "I'm Feeling Lucky"
```

### Act

```bash
cli-claw browser click e3              # Click element
cli-claw browser type e3 "hello"       # Type text
cli-claw browser type e3 "hello" --submit  # Type + press Enter
cli-claw browser press Enter           # Press key
cli-claw browser press Escape
cli-claw browser press Tab
cli-claw browser hover e5              # Mouse hover
```

### Navigate

```bash
cli-claw browser navigate "https://example.com"  # Go to URL
cli-claw browser open "https://example.com"       # Open in new tab
cli-claw browser tabs                             # List tabs
cli-claw browser evaluate "document.title"        # Execute JS
```

## Common Workflows

### Web Search

```bash
cli-claw browser start
cli-claw browser navigate "https://www.google.com"
cli-claw browser snapshot --interactive
# → e3 textbox "Search"
cli-claw browser type e3 "search query" --submit
cli-claw browser snapshot --interactive
# Click desired result link
cli-claw browser click e7
```

### Form Filling

```bash
cli-claw browser snapshot --interactive
# → e1 textbox "Name", e2 textbox "Email", e3 button "Submit"
cli-claw browser type e1 "John Doe"
cli-claw browser type e2 "john@example.com"
cli-claw browser click e3
cli-claw browser snapshot  # Verify result
```

### Read Page Content

```bash
cli-claw browser navigate "https://news.ycombinator.com"
cli-claw browser text | head -100  # First 100 lines
# Or structured:
cli-claw browser snapshot  # Element list with roles
```

## macOS Alternatives (No Server Required)

These work without cli-claw server using native macOS tools:

```bash
# Screenshot
screencapture -x ~/screenshot.png
screencapture -R 0,0,1280,720 ~/region.png

# Open URL
open "https://example.com"
open -a "Google Chrome" "https://example.com"

# Current tab URL
osascript -e 'tell app "Chrome" to URL of active tab of front window'

# Tab list
osascript -e 'tell app "Chrome" to get {title, URL} of every tab of front window'

# Execute JavaScript
osascript -e 'tell app "Chrome" to execute front window'\''s active tab javascript "document.title"'

# Coordinate-based clicks (requires: brew install cliclick)
cliclick c:500,300
cliclick t:"text input"
```

## Notes

- Ref IDs **reset on navigation**. Always re-run `snapshot` after `navigate`.
- Use `--interactive` to show only clickable/typeable elements (shorter list).
- Screenshots are saved to `~/.cli-claw/screenshots/`.
- Default CDP port is 9240 (change via `browser.cdpPort` in settings.json).
- If Chrome is already running, `start` connects to the existing instance.

## Non-DOM Elements

If `snapshot` returns **no ref** for your target (Canvas, iframe, Shadow DOM, etc.),
use the **vision-click** skill (Codex only). See `skills_ref/vision-click/SKILL.md`.
