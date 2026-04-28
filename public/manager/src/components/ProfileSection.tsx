import type { DashboardProfile } from '../types';

type ProfileSectionProps = {
    profile: DashboardProfile;
    count: number;
};

function formatLastSeen(value: string | null): string {
    if (!value) return 'not seen';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'not seen';
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ProfileSection(props: ProfileSectionProps) {
    return (
        <div className="profile-section-header">
            <div>
                <span>{props.profile.label}</span>
                <small>{props.profile.serviceMode} · {formatLastSeen(props.profile.lastSeenAt)}</small>
            </div>
            <strong>{props.count}</strong>
        </div>
    );
}
