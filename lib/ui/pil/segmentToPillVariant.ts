import type { PillVariant } from './Pill';

/**
 * Maps a segment identifier (as used by the App-Layout routing) to its
 * canonical Pill variant. Unknown segments fall back to 'north' so the
 * UI never renders a "missing" pill — ambient context always has a
 * colour, even if we don't yet recognise the segment.
 *
 * Extend this map when a new segment is introduced. Keep the mapping
 * total: every segment that can appear in the layout must have an
 * explicit entry (or be expected to default to 'north').
 */
const SEGMENT_TO_VARIANT: Readonly<Record<string, PillVariant>> = {
  '@north': 'north',
  '@clientb': 'clientb',
  '@own': 'own',
  '@private': 'private',
};

export function segmentToPillVariant(segmentId: string): PillVariant {
  return SEGMENT_TO_VARIANT[segmentId] ?? 'north';
}

export default segmentToPillVariant;
