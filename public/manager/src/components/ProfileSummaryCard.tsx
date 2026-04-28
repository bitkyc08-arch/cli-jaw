import type { DashboardProfile } from '../types';

type ProfileSummaryCardProps = {
    profile: DashboardProfile;
    count: number;
};

export function ProfileSummaryCard(props: ProfileSummaryCardProps) {
    return (
        <article className="profile-summary-card">
            <div>
                <span>{props.profile.label}</span>
                <strong>{props.count} instance{props.count === 1 ? '' : 's'}</strong>
            </div>
            <dl>
                <div><dt>Port</dt><dd>{props.profile.preferredPort || 'n/a'}</dd></div>
                <div><dt>Mode</dt><dd>{props.profile.serviceMode}</dd></div>
                <div><dt>CLI</dt><dd>{props.profile.defaultCli || 'n/a'}</dd></div>
            </dl>
        </article>
    );
}
