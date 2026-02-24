#!/usr/bin/env python3
"""Add dual-key i18n fields to skills registry.

For each skill:
  - name_ko = current name
  - name_en = English name
  - desc_ko = current description
  - desc_en = English description
  - Preserves original name/description for backward compat
"""
import json
from pathlib import Path

REGISTRY = Path(__file__).resolve().parent.parent / 'skills_ref' / 'registry.json'

# Manual name translations (19 skills with Korean names)
NAME_EN = {
    'himalaya': 'Email (Himalaya)',
    'github': 'GitHub',
    'skill-creator': 'Skill Creator',
    'weather': 'Weather',
    'video-frames': 'Video Frames',
    'summarize': 'URL Summarizer',
    'goplaces': 'Places Search',
    'nano-banana-pro': 'Image Gen (Gemini)',
    'browser': 'Browser Control',
    'develop-web-game': 'Web Game Dev',
    'figma-implement-design': 'Figma → Code',
    'notion-knowledge-capture': 'Notion Knowledge Capture',
    'notion-meeting-intelligence': 'Notion Meeting Intelligence',
    'notion-research-documentation': 'Notion Research Documentation',
    'notion-spec-to-implementation': 'Notion Spec → Tasks',
    'sora': 'Sora Video',
    'transcribe': 'Speech → Text',
    'imagegen': 'Image Gen (OpenAI)',
    'pdf': 'PDF Reader/Writer',
}

# Full description translations for all 107 skills
DESC_EN = {
    'notion': 'Notion page/DB CRUD via curl API calls. Complements Codex notion-* skills.',
    'trello': 'Trello board/list/card management via curl REST API.',
    'obsidian': 'Obsidian vault note creation, search, and tag management.',
    'things-mac': 'Things 3 todo add/complete/search. AppleScript + URL scheme.',
    'apple-notes': 'Apple Notes create/search. AppleScript-based.',
    'apple-reminders': 'Apple Reminders add/complete/list management. AppleScript-based.',
    'apple-messages': 'Send iMessage/SMS via AppleScript.',
    'linear': 'Linear issue/project/cycle management via GraphQL API.',
    'bear': 'Bear note markdown editing/archiving. x-callback-url scheme.',
    'google-calendar': 'gcalcli-based Google Calendar event CRUD.',
    'himalaya': 'Terminal email read/write/reply/search. Gmail/Outlook supported.',
    'gog': 'Gmail, Calendar, Drive, Sheets, Docs integrated management.',
    'xurl': 'Tweet post/search/reply/DM/media upload.',
    'telegram-send': 'Send voice/photo/document directly via Telegram local API.',
    'github': 'GitHub gh CLI integration: issues, PRs, CI, code review, API + PR comments, CI debugging, auto-fix.',
    'tmux': 'tmux session remote control. Send keystrokes + read output.',
    'skill-creator': 'Auto-generate new SKILL.md. Template + guidelines provided.',
    'weather': 'wttr.in weather/forecast lookup. No API key needed.',
    'video-frames': 'Extract video frames/segments with ffmpeg.',
    'summarize': 'Summarize URLs, YouTube videos, and files to text.',
    'goplaces': 'Google Places API for location, reviews, and business hours search.',
    '1password': '1Password CLI for password/document/OTP lookup.',
    'nano-banana-pro': 'Generate/edit images with Gemini 3 Pro. Different model from Codex imagegen.',
    'spotify-player': 'Spotify play/pause/search/playlist management.',
    'openhue': 'Hue light/scene control. "Dim living room to 50%"',
    'browser': 'Chrome browser automation. Identify elements via ref snapshots → click/type.',
    'vision-click': 'Vision-based coordinate clicking. Codex CLI only. Screenshot → AI coordinate → pixel click.',
    'tts': 'macOS say command text-to-speech. Multi-language, file output.',
    'screen-capture': 'macOS screenshot/webcam/recording. Full/region/window/multi-monitor. Default fallback when tool-specific capture unavailable.',
    'atlas': 'Control ChatGPT Atlas app. macOS only.',
    'cloudflare-deploy': 'Deploy to Cloudflare Workers/Pages. wrangler CLI.',
    'develop-web-game': 'Web game development + Playwright test loop.',
    'figma-implement-design': 'Convert Figma designs to 1:1 code. Requires Figma MCP.',
    'jupyter-notebook': '.ipynb create/edit. Bundled Python script.',
    'netlify-deploy': 'Deploy Netlify sites. netlify CLI.',
    'notion-knowledge-capture': 'Conversation → Notion wiki/FAQ/HOW-TO capture. Notion MCP.',
    'notion-meeting-intelligence': 'Meeting prep (per-attendee context, agenda). Notion MCP.',
    'notion-research-documentation': 'Notion multi-source → report/comparison synthesis. Notion MCP.',
    'notion-spec-to-implementation': 'PRD/spec → implementation plan + auto task creation. Notion MCP.',
    'render-deploy': 'Deploy Render services. Blueprint YAML.',
    'sentry': 'Sentry issue/event lookup. Bundled Python script.',
    'sora': 'Sora video generation/management. OpenAI API.',
    'speech': 'OpenAI TTS voice synthesis. Bundled Python script.',
    'transcribe': 'OpenAI Whisper speech-to-text + speaker diarization.',
    'vercel-deploy': 'Vercel project deployment.',
    'memory': 'Long-term memory across sessions. Stored in markdown files, grep search.',
    'imagegen': 'Generate/edit images via OpenAI Images API.',
    'openai-docs': 'OpenAI product/API official documentation reference. Build guides.',
    'pdf': 'PDF read/create/edit/review. reportlab/pdfplumber/pypdf + nano-pdf natural language editing.',
    'frontend-design': 'Unique, production-grade frontend UI/page design and implementation.',
    'docx': '.docx document create/edit/read. Visual verification (soffice→PDF→PNG), tracked changes, python-docx.',
    'xlsx': '.xlsx/.xlsm/.csv/.tsv file create/edit/analyze/format. Includes pandas data analysis.',
    'webapp-testing': 'Playwright-based web app interaction/verification/debugging test skill.',
    'mcp-builder': 'Design/implement MCP servers for external API integration.',
    'pptx': 'Presentation (.pptx) create/edit/analyze skill.',
    'doc-coauthoring': 'Structured planning/spec/document co-authoring workflow skill.',
    'web-artifacts-builder': 'React/Tailwind complex web artifact creation skill.',
    'theme-factory': 'Apply reusable themes to document/slide/HTML outputs.',
    'web-routing': 'Guide skill for routing browser requests to browser/webapp-testing.',
    'algorithmic-art': 'p5.js generative art. Algorithm-based visual artwork creation.',
    'canvas-design': 'Create PNG/PDF visual designs via Canvas API.',
    'react-best-practices': 'React code patterns, performance optimization, component design best practices.',
    'web-perf': 'Core Web Vitals audit. Lighthouse/CrUX-based performance analysis.',
    'agents-sdk': 'Cloudflare Workers AI Agents SDK usage guide.',
    'durable-objects': 'Cloudflare Durable Objects (RPC+SQLite+WebSocket) stateful workers.',
    'static-analysis': 'CodeQL+Semgrep+SARIF static security analysis.',
    'insecure-defaults': 'Detect hardcoded secrets, weak crypto, and insecure defaults.',
    'modern-python': 'uv+ruff+ty+pytest Python best practices.',
    'differential-review': 'Security-focused diff review. Analyze security impact of code changes.',
    'property-based-testing': 'Multi-language property-based testing (Hypothesis/fast-check etc.).',
    'security-best-practices': 'Language-specific security vulnerability pattern review.',
    'security-ownership-map': 'Codebase owner/bus-factor mapping.',
    'security-threat-model': 'Per-repo threat model generation (STRIDE/DREAD).',
    'hugging-face-cli': 'HF Hub CLI for model/dataset/space management.',
    'hugging-face-model-trainer': 'TRL: SFT/DPO/GRPO model training.',
    'hugging-face-evaluation': 'vLLM/lighteval model evaluation and benchmarks.',
    'fal-image-edit': 'fal.ai AI image editing (style transfer, object removal).',
    'brainstorming': 'Pre-coding idea refinement → design document creation (obra/superpowers).',
    'writing-plans': '2-5 minute task decomposition. File paths/code/verification included.',
    'tdd': 'RED-GREEN-REFACTOR TDD cycle enforcement.',
    'requesting-code-review': 'Internal agent code review. Severity-based blocking.',
    'receiving-code-review': 'Code review feedback reception and response patterns.',
    'dispatching-parallel-agents': 'Parallel sub-agent dispatch patterns.',
    'debugging-helpers': 'Systematic debugging helpers.',
    'git-worktrees': 'git worktree-based isolated branch workflow.',
    'codebase-orientation': 'Project entrypoint/module/build mapping. Onboarding guide.',
    'debugging-checklist': 'Reproduce → isolate → log → hypothesis verification debugging checklist.',
    'error-message-explainer': 'Compiler/runtime error → cause + fix suggestions.',
    'config-file-explainer': 'Config file structure/keys/defaults explanation.',
    'data-structure-chooser': 'Data structure time/space tradeoff recommendations.',
    'log-summarizer': 'Log grouping + first failure identification + action suggestions.',
    'linter-fix-guide': 'Lint rule explanation + pattern examples + minimal fix suggestions.',
    'dependency-install-helper': 'Platform-specific dependency installation steps + verification commands.',
    'changelog-generator': 'git commit → changelog/release notes generation.',
    'video-downloader': 'yt-dlp wrapper. YouTube/media download.',
    'email-draft-polish': 'Email draft tone adjustment/formatting.',
    'postgres': 'PostgreSQL read-only queries. Schema exploration.',
    'deep-research': 'Multi-step research agent. Search → analyze → summarize.',
    'context-compression': 'Context compression strategies. Long session optimization.',
    'ios-simulator': 'iOS Simulator control. App build/run/test.',
    'apple-hig-skills': 'Apple HIG 14 guides (foundations/platforms/components/patterns).',
    'whatsapp': 'WhatsApp message automation (automate-whatsapp).',
    'aws-skills': 'AWS infrastructure automation (CDK/CloudFormation/Lambda).',
    'terraform': 'HashiCorp Terraform HCL/modules/providers IaC.',
    'kreuzberg': '62+ format text extraction (PDF/DOCX/PPTX/images etc.).',
    'dev': 'Common development guide. Modular dev, self-reference patterns, skills_ref exploration, changelog.',
    'dev-frontend': 'Frontend role guide. Unique UI/UX implementation, component design, aesthetic standards.',
    'dev-backend': 'Backend role guide. Express.js patterns, SQLite, error handling, security basics.',
    'dev-data': 'Data role guide. ETL pipelines, CSV/JSON processing, SQL queries, analysis.',
    'dev-testing': 'Debugging phase only. Playwright web app testing, recon-action pattern.',
}

def main():
    with open(REGISTRY) as f:
        data = json.load(f)

    skills = data['skills']
    updated = 0

    for skill_id, skill in skills.items():
        name = skill.get('name', skill_id)
        desc = skill.get('description', '')

        # Set ko fields
        skill['name_ko'] = name
        skill['desc_ko'] = desc

        # Set en fields
        has_ko_name = any('\uac00' <= c <= '\ud7af' for c in name)
        if has_ko_name:
            skill['name_en'] = NAME_EN.get(skill_id, name)
        else:
            skill['name_en'] = name

        skill['desc_en'] = DESC_EN.get(skill_id, desc)
        updated += 1

    # Reorder keys: keep original order, insert i18n fields after description
    new_skills = {}
    for skill_id, skill in skills.items():
        ordered = {}
        for k, v in skill.items():
            ordered[k] = v
            if k == 'name':
                ordered['name_ko'] = skill['name_ko']
                ordered['name_en'] = skill['name_en']
            elif k == 'description':
                ordered['desc_ko'] = skill['desc_ko']
                ordered['desc_en'] = skill['desc_en']
        # Remove duplicates from natural ordering
        new_skills[skill_id] = ordered

    data['skills'] = new_skills

    with open(REGISTRY, 'w') as f:
        json.dump(data, f, indent=4, ensure_ascii=False)

    print(f'Updated {updated} skills with i18n fields')

    # Verify
    missing_en = [k for k, v in new_skills.items() if not v.get('desc_en')]
    if missing_en:
        print(f'WARNING: {len(missing_en)} skills missing desc_en: {missing_en}')
    else:
        print('All skills have desc_en ✓')

if __name__ == '__main__':
    main()
