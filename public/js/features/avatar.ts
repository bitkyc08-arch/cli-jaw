// ── Agent & User Avatar ──
const AGENT_KEY = 'agentAvatar';
const USER_KEY = 'userAvatar';
const DEFAULT_AGENT = '🦈';
const DEFAULT_USER = '👤';

let agentAvatar = DEFAULT_AGENT;
let userAvatar = DEFAULT_USER;

export function getAgentAvatar(): string { return agentAvatar; }
export function getUserAvatar(): string { return userAvatar; }

export function setAgentAvatar(emoji: string): void {
    agentAvatar = (emoji || '').trim() || DEFAULT_AGENT;
    localStorage.setItem(AGENT_KEY, agentAvatar);
    document.querySelectorAll('.agent-icon').forEach(el => { el.textContent = agentAvatar; });
}

export function setUserAvatar(emoji: string): void {
    userAvatar = (emoji || '').trim() || DEFAULT_USER;
    localStorage.setItem(USER_KEY, userAvatar);
    document.querySelectorAll('.user-icon').forEach(el => { el.textContent = userAvatar; });
}

export function initAvatar(): void {
    agentAvatar = localStorage.getItem(AGENT_KEY) || DEFAULT_AGENT;
    userAvatar = localStorage.getItem(USER_KEY) || DEFAULT_USER;

    const ai = document.getElementById('agentAvatarInput') as HTMLInputElement | null;
    const ui = document.getElementById('userAvatarInput') as HTMLInputElement | null;
    if (ai) ai.value = agentAvatar;
    if (ui) ui.value = userAvatar;

    document.getElementById('avatarSave')?.addEventListener('click', () => {
        const a = document.getElementById('agentAvatarInput') as HTMLInputElement | null;
        const u = document.getElementById('userAvatarInput') as HTMLInputElement | null;
        if (a) setAgentAvatar(a.value);
        if (u) setUserAvatar(u.value);
    });

    for (const id of ['agentAvatarInput', 'userAvatarInput']) {
        document.getElementById(id)?.addEventListener('keydown', (e: Event) => {
            if ((e as KeyboardEvent).key === 'Enter') {
                (e as KeyboardEvent).preventDefault();
                document.getElementById('avatarSave')?.click();
                (e.target as HTMLInputElement).blur();
            }
        });
    }
}
