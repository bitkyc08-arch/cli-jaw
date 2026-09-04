# ─── cli-jaw Docker image (npm 배포판) ───────────
FROM node:22-slim

# 시스템 Chromium + better-sqlite3 빌드 deps + curl (uv 설치용)
# findChrome()이 /usr/bin/chromium 탐지 → Playwright 캐시 경로 불필요
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    chromium \
    fonts-noto-cjk fonts-nanum \
    curl \
    && rm -rf /var/lib/apt/lists/*

# non-root 사용자 (Chromium sandbox 정상 동작 보장)
RUN groupadd -r jaw && useradd -r -g jaw -m jaw

# cli-jaw 글로벌 설치 (postinstall이 5-CLI + MCP + skills 자동 설치)
# CLI_JAW_HOME을 설치 전에 설정 → postinstall이 /home/jaw/.cli-jaw에 초기화
ENV CLI_JAW_HOME=/home/jaw/.cli-jaw
ARG CLI_JAW_VERSION=latest
RUN npm install -g cli-jaw@${CLI_JAW_VERSION}

# 빌드 시 기능 가드 — /api/health 엔드포인트가 있는 버전인지 확인
RUN node -e "const s=require('fs').readFileSync(require.resolve('cli-jaw/dist/server.js'),'utf8'); if(!s.includes('/api/health')) { console.error('ERROR: cli-jaw@'+require('cli-jaw/package.json').version+' does not include /api/health. Minimum required version not met.'); process.exit(1); }"

# 런타임 — CHROME_NO_SANDBOX 의도적 미설정 (sandbox 기본 유지)
ENV PORT=3457
RUN chown -R jaw:jaw /home/jaw/.cli-jaw
USER jaw
EXPOSE 3457

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3457/api/health').then(r=>{if(!r.ok)throw 1})" || exit 1

ENTRYPOINT ["jaw", "serve", "--no-open"]
