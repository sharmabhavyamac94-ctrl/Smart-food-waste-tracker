import Actions from './Actions';
import AIInsights from './AIInsights';

export default function AIAnalytics() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <Actions />
      <div style={{ borderTop: '2px solid var(--border)', paddingTop: '1.5rem' }}>
        <AIInsights />
      </div>
    </div>
  );
}
