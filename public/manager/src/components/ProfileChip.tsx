import type { DashboardProfile } from '../types';

type ProfileChipProps = {
    profile: DashboardProfile;
    active: boolean;
    count?: number;
    onToggle: (profileId: string) => void;
};

export function ProfileChip(props: ProfileChipProps) {
    const count = props.count == null ? '' : ` ${props.count}`;
    return (
        <button
            type="button"
            className={`profile-chip ${props.active ? 'is-active' : ''}`}
            onClick={() => props.onToggle(props.profile.profileId)}
            aria-pressed={props.active}
            title={props.profile.homePath}
        >
            <span>{props.profile.label}</span>
            {count && <strong>{count}</strong>}
        </button>
    );
}
