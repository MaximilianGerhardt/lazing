import type { ReactNode } from 'react';

interface MsgUserProps {
  children: ReactNode;
  /** ISO-8601 string — rendered inside a <time> element. */
  timestamp?: string;
  /**
   * Optional sender label for non-user-max messages. Wenn gesetzt zeigt
   * die Bubble einen kleinen Pill-Header ueber dem Content (z.B. "via API",
   * "Terminal-Claude") und nutzt einen reduzierten Akzent — so erkennt Max
   * sofort dass die Message NICHT von ihm selbst kam, sondern z.B. von
   * einem Bearer-Auth-Skript ueber /api/chat/stream.
   *
   * Wenn `senderLabel` undefined ist, rendert die Bubble normal (wie bisher).
   */
  senderLabel?: string;
}

/** Human-friendly format: "heute 14:22", "gestern 09:15", "Mo 11:30", "17.04. 08:00". */
function formatHuman(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  if (sameDay) return `heute ${hh}:${mm}`;
  if (isYesterday) return `gestern ${hh}:${mm}`;
  const diffDays = Math.floor(
    (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays < 7) {
    const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()];
    return `${wd} ${hh}:${mm}`;
  }
  const dd = d.getDate().toString().padStart(2, '0');
  const mo = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${dd}.${mo}. ${hh}:${mm}`;
}

export function MsgUser({ children, timestamp, senderLabel }: MsgUserProps) {
  // Differenzierte Bubble fuer extern-injizierte Messages (Bearer-Auth /
  // System / Terminal-Claude). Visuell:
  //   - reduzierter Akzent (Border statt Fill)
  //   - kleiner Sender-Pill ueber dem Text
  //   - bleibt rechts-buendig wie normale User-Bubble (kontextuell ein
  //     "User-Side"-Event), aber unverwechselbar anders
  // Styling lebt jetzt in app/components.css unter `.msg-u-ext` /
  // `.msg-u-pill` (Surface-Refactor Welle 2).
  if (senderLabel) {
    return (
      <div
        className="msg-u msg-u-ext"
        role="article"
        aria-label={`Externe Message von ${senderLabel}`}
      >
        <div className="bub">
          <span className="msg-u-pill" aria-hidden="false">
            via {senderLabel}
          </span>
          <span className="msg-u-ext-content">{children}</span>
        </div>
        {timestamp ? (
          <time className="msg-ts" dateTime={timestamp}>
            {formatHuman(timestamp)}
          </time>
        ) : null}
      </div>
    );
  }
  return (
    <div className="msg-u" role="article" aria-label="User message">
      <div className="bub">{children}</div>
      {timestamp ? (
        <time className="msg-ts" dateTime={timestamp}>
          {formatHuman(timestamp)}
        </time>
      ) : null}
    </div>
  );
}
