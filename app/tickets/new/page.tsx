import { redirect } from 'next/navigation';

/**
 * /tickets/new — convenience redirect.
 *
 * The create flow lives in the `QuickCreateDrawer` on `/tickets`. We
 * redirect here so bookmarks and external links (e.g. from an agent)
 * still land somewhere sensible. A future version may pre-open the
 * drawer via a `?open=1` query param.
 */
export default function NewTicketPage() {
  redirect('/tickets?open=1');
}
