'use client';

/**
 * PushSettingsSection — MobileDrawer-Section "Benachrichtigungen".
 *
 * Master-Toggle + per-Push-Rule-Toggle.
 *
 * Master-Toggle:
 *   - Aus: ruft `unsubscribe()` auf — der Browser dropt die Subscription,
 *     der Server bekommt DELETE und die Lambdas senden nichts mehr.
 *   - An: ruft `subscribe()` auf — Permission-Request + Subscribe-Flow.
 *
 * Per-Rule-Toggle:
 *   - Schreibt PATCH /api/push/rules { ruleId, enabled }
 *   - Server setzt level='silent' + locked=1 wenn enabled=false
 *   - Server setzt locked=0 (decay übernimmt) wenn enabled=true
 *
 * State wird optimistisch gesetzt + bei Server-Fehler zurückgerollt.
 */

import { useCallback, useEffect, useState } from 'react';

import { usePushSubscription } from '@/lib/pwa/usePushSubscription';

interface RuleStatus {
  id: string;
  defaultPriority: 'p0' | 'p1' | 'p2';
  level: string;
  locked: boolean;
  enabled: boolean;
}

interface RuleLabel {
  id: string;
  label: string;
  description: string;
}

/**
 * UX-Labels pro Rule. Source-of-truth: lib/push/rules.ts. Wenn dort
 * eine neue Rule hinzukommt, hier ergänzen — sonst wird sie mit
 * fallback-Label `id` angezeigt.
 */
const RULE_LABELS: ReadonlyArray<RuleLabel> = [
  { id: 'ticket-p0-created', label: 'P0-Tickets', description: 'Neue Tickets mit P0-Priority' },
  { id: 'approval-requested', label: 'Approvals', description: 'Wenn ein Workstream auf deine Freigabe wartet' },
  { id: 'workspace-stale', label: 'Workspace-Stale', description: 'Wenn ein Workspace > 1h schläft' },
  { id: 'errors-burst', label: 'Error-Burst', description: '5+ Errors in 5 Min — sofort prüfen' },
  { id: 'routine-failed', label: 'Routine-Fehler', description: 'Eine Routine ist fehlgeschlagen' },
  { id: 'master-auto-closed', label: 'Master fertig', description: 'Master-Ticket nach Sub-Tickets-done auto-geschlossen' },
  { id: 'sub-dispatch-failed', label: 'Sub-Pipeline-Fehler', description: 'Sub-Pipeline finalfehlgeschlagen' },
  { id: 'sniper-pause-start', label: 'Sniper-Window', description: 'Sniper pausiert — du kannst korrigieren' },
  { id: 'workstream-stuck', label: 'Workstream hängt', description: 'Kein Fortschritt seit > 2 min' },
  { id: 'plan-open-questions', label: 'Plan-Fragen', description: 'Plan stellt dir offene Fragen' },
  { id: 'synthesis-unfalsifiable', label: 'Synthesis-Review', description: 'These möglicherweise tautologisch' },
];

interface Props {
  vapidPublicKey: string;
}

export function PushSettingsSection({ vapidPublicKey }: Props): React.JSX.Element {
  const sub = usePushSubscription({ vapidPublicKey });
  const [rules, setRules] = useState<RuleStatus[]>([]);
  const [rulesError, setRulesError] = useState<string>('');
  const [rulesLoading, setRulesLoading] = useState<boolean>(true);

  const loadRules = useCallback(async (): Promise<void> => {
    setRulesLoading(true);
    setRulesError('');
    try {
      const res = await fetch('/api/push/rules', { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as { rules: RuleStatus[] };
      setRules(json.rules ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'load failed';
      setRulesError(msg);
    } finally {
      setRulesLoading(false);
    }
  }, []);

  useEffect(() => {
    // Microtask-Kick statt direkter Sync-State-Set — vermeidet
    // react-hooks/set-state-in-effect Lint und entkoppelt vom Render-Cycle.
    if (sub.state === 'subscribed') {
      const handle = Promise.resolve().then(() => loadRules());
      return () => {
        void handle;
      };
    }
    const handle = Promise.resolve().then(() => setRulesLoading(false));
    return () => {
      void handle;
    };
  }, [sub.state, loadRules]);

  const onMasterToggle = useCallback(async () => {
    if (sub.state === 'subscribed') {
      await sub.unsubscribe();
    } else if (sub.state === 'idle' || sub.state === 'error') {
      await sub.subscribe();
    }
  }, [sub]);

  const onRuleToggle = useCallback(async (ruleId: string, enabled: boolean) => {
    // Optimistic update
    const prev = rules;
    setRules((rs) =>
      rs.map((r) => (r.id === ruleId ? { ...r, enabled } : r)),
    );
    try {
      const res = await fetch('/api/push/rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleId, enabled }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      // Rollback
      setRules(prev);
      const msg = err instanceof Error ? err.message : 'patch failed';
      setRulesError(`Rule ${ruleId}: ${msg}`);
    }
  }, [rules]);

  const masterChecked = sub.state === 'subscribed';
  const masterDisabled =
    sub.state === 'unsupported' ||
    sub.state === 'denied' ||
    sub.state === 'working' ||
    sub.state === 'loading';

  const masterStatusText = (() => {
    switch (sub.state) {
      case 'unsupported':
        return sub.message || 'Browser unterstützt keine Push-Notifications.';
      case 'denied':
        return 'Push blockiert. iOS-Settings → Notifications → laz.ing zulassen.';
      case 'subscribed':
        return 'Push aktiv';
      case 'idle':
        return 'Tippen zum Aktivieren';
      case 'working':
        return 'Wird umgeschaltet …';
      case 'loading':
        return 'Status lädt …';
      case 'error':
        return sub.message || 'Fehler beim Umschalten';
      default:
        return '';
    }
  })();

  return (
    <section
      className="topnav-drawer-section topnav-drawer-push"
      aria-label="Benachrichtigungen"
    >
      <h2 className="topnav-drawer-heading">Benachrichtigungen</h2>

      <div className="topnav-drawer-push-master">
        <div className="topnav-drawer-push-master-info">
          <span className="topnav-drawer-push-master-label">Push-Benachrichtigungen</span>
          <span className="topnav-drawer-push-master-meta">{masterStatusText}</span>
        </div>
        <button
          type="button"
          className={`topnav-drawer-push-switch${masterChecked ? ' is-on' : ''}`}
          role="switch"
          aria-checked={masterChecked}
          aria-label="Push global aktivieren oder deaktivieren"
          disabled={masterDisabled}
          onClick={onMasterToggle}
        >
          <span className="topnav-drawer-push-switch-track" aria-hidden="true">
            <span className="topnav-drawer-push-switch-thumb" />
          </span>
        </button>
      </div>

      {sub.state === 'subscribed' ? (
        <>
          {rulesLoading ? (
            <p className="topnav-drawer-push-meta">Kategorien laden …</p>
          ) : rulesError ? (
            <p className="topnav-drawer-push-meta topnav-drawer-push-meta--error">
              {rulesError}
            </p>
          ) : (
            <ul className="topnav-drawer-push-rules" role="list">
              {rules.map((r) => {
                const labelDef = RULE_LABELS.find((l) => l.id === r.id);
                const label = labelDef?.label ?? r.id;
                const description = labelDef?.description ?? '';
                return (
                  <li key={r.id} className="topnav-drawer-push-rule">
                    <div className="topnav-drawer-push-rule-info">
                      <span className="topnav-drawer-push-rule-label">{label}</span>
                      {description ? (
                        <span className="topnav-drawer-push-rule-desc">
                          {description}
                        </span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className={`topnav-drawer-push-switch topnav-drawer-push-switch--sm${r.enabled ? ' is-on' : ''}`}
                      role="switch"
                      aria-checked={r.enabled}
                      aria-label={`${label} ${r.enabled ? 'an' : 'aus'}`}
                      onClick={() => void onRuleToggle(r.id, !r.enabled)}
                    >
                      <span className="topnav-drawer-push-switch-track" aria-hidden="true">
                        <span className="topnav-drawer-push-switch-thumb" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

export default PushSettingsSection;
