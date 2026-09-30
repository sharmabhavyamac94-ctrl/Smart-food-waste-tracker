import HostelDashboard from './HostelDashboard';
import Analytics from './Analytics';

export default function OverviewAnalytics() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <HostelDashboard />
      <div style={{ borderTop: '2px solid var(--border)', paddingTop: '1.5rem' }}>
        <Analytics />
      </div>
    </div>
  );
}
