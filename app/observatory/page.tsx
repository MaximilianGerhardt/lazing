import { ObservatoryDashboard } from "./ObservatoryDashboard";

export const dynamic = "force-dynamic";

/**
 * /observatory — minimal live dashboard.
 *
 * Auth is enforced by middleware. Reaching this page means we have
 * a valid session cookie, so we can render the client component
 * unconditionally.
 */
export default function ObservatoryPage() {
  return <ObservatoryDashboard />;
}
