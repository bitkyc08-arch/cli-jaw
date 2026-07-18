import { useCallback, useEffect, useState } from 'react';
import type { DockTabProps } from './dock-settings';
import { filterSkills, SKILL_FILTERS, type SkillFilter, type SkillItem } from './skill-filter';

const FILTER_LABELS: Record<SkillFilter, string> = {
    all: '전체',
    installed: '설치됨',
    productivity: '생산성',
    communication: '커뮤',
    devtools: '개발',
    'ai-media': 'AI',
    utility: '유틸',
    smarthome: '홈',
    other: '기타',
};

export function SkillsTab({ client, active, locale }: DockTabProps & { locale?: string | undefined }) {
    const [skills, setSkills] = useState<SkillItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<SkillFilter>('all');
    const [search, setSearch] = useState('');
    const [pendingId, setPendingId] = useState<string | null>(null);

    const load = useCallback(() => {
        setError(null);
        client.get<SkillItem[]>(`/api/skills?locale=${encodeURIComponent(locale || 'ko')}`)
            .then((data) => setSkills(Array.isArray(data) ? data : []))
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }, [client, locale]);

    useEffect(() => {
        if (active) load();
    }, [active, load]);

    // Non-optimistic toggle (030 audit): disable while in flight, reload on
    // success, surface the error without state change on failure.
    const toggleSkill = useCallback((skill: SkillItem) => {
        if (pendingId) return;
        setPendingId(skill.id);
        setError(null);
        const endpoint = skill.enabled ? '/api/skills/disable' : '/api/skills/enable';
        client.post(endpoint, { id: skill.id })
            .then(() => load())
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setPendingId(null));
    }, [client, load, pendingId]);

    if (error && !skills) return <div className="dock-error">스킬 로드 실패: {error}</div>;
    if (!skills) return <div className="dock-loading">로딩 중...</div>;

    const filtered = filterSkills(skills, filter, search);
    const enabledCount = skills.filter((skill) => skill.enabled).length;

    return (
        <div className="dock-skills">
            <input
                className="dock-skill-search"
                type="search"
                placeholder="스킬 검색..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
            />
            <div className="dock-skill-filters">
                {SKILL_FILTERS.map((item) => (
                    <button
                        key={item}
                        type="button"
                        className={`dock-skill-filter${filter === item ? ' is-active' : ''}`}
                        onClick={() => setFilter(item)}
                    >
                        {FILTER_LABELS[item]}
                    </button>
                ))}
            </div>
            <div className="dock-dim">
                {search ? `${filtered.length}개 표시 · 활성 ${enabledCount}/${skills.length}` : `활성 ${enabledCount}/${skills.length}`}
            </div>
            {error && <div className="dock-error">{error}</div>}
            {filtered.length === 0 && <div className="dock-dim">검색 결과가 없습니다</div>}
            {filtered.map((skill) => (
                <div key={skill.id} className={`dock-skill${skill.enabled ? ' is-enabled' : ''}`}>
                    <div className="dock-skill-head">
                        <span className="dock-skill-name">{skill.name || skill.id}</span>
                        <button
                            type="button"
                            className={`dock-skill-toggle${skill.enabled ? ' is-on' : ''}`}
                            disabled={pendingId === skill.id}
                            aria-label={`${skill.name || skill.id} toggle`}
                            onClick={() => toggleSkill(skill)}
                        >
                            {skill.enabled ? 'ON' : 'OFF'}
                        </button>
                    </div>
                    {skill.description && <div className="dock-skill-desc">{skill.description}</div>}
                </div>
            ))}
        </div>
    );
}
