// ── Constants ──
export const MODEL_MAP = {
    claude: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-6[1m]', 'claude-opus-4-6[1m]', 'claude-haiku-4-5-20251001'],
    codex: ['gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'],
    gemini: ['gemini-3.0-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
    opencode: [
        'github-copilot/claude-sonnet-4.5', 'github-copilot/claude-opus-4.6',
        'github-copilot/gpt-5', 'github-copilot/gemini-2.5-pro',
        'opencode/big-pickle', 'opencode/GLM-5 Free', 'opencode/MiniMax M2.5 Free',
        'opencode/Kimi K2.5 Free', 'opencode/GPT 5 Nano Free', 'opencode/Grok Code Fast 1 Free',
    ],
};

export const ROLE_PRESETS = [
    { value: 'frontend', label: '🎨 프론트엔드', prompt: 'React/Vue 기반 UI 컴포넌트 개발, 스타일링' },
    { value: 'backend', label: '⚙️ 백엔드', prompt: 'API 서버, DB 스키마, 비즈니스 로직 구현' },
    { value: 'fullstack', label: '🔄 풀스택', prompt: '프론트엔드와 백엔드 모두 담당' },
    { value: 'devops', label: '🚀 DevOps', prompt: 'CI/CD, Docker, 인프라 자동화' },
    { value: 'qa', label: '🧪 QA', prompt: '테스트 작성, 버그 재현, 품질 관리' },
    { value: 'data', label: '📊 데이터', prompt: '데이터 파이프라인, ETL, 분석 쿼리' },
    { value: 'docs', label: '📝 테크라이터', prompt: 'API 문서화, README, 가이드 작성' },
    { value: 'custom', label: '✏️ 커스텀...', prompt: '' },
];
