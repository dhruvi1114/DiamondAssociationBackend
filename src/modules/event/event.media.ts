import { API_V1, END_POINTS } from '@constant';

/**
 * Where an event's poster is fetched from.
 *
 * Its own module because two services need it and one of them cannot import the
 * other: `event.service` already imports `registration.service`
 * (`cancelEventWithRefunds`), so the bookings list reaching back for this helper
 * would close a cycle. A four-line pure function is a cheaper thing to share
 * than a second copy that drifts.
 *
 * Keyed by slug, and the endpoint behind it re-checks the event's status and
 * visibility — the URL is a request, not a grant. Null when there is no poster,
 * so the card draws its own placeholder rather than a broken image.
 */
export const bannerUrl = (slug: string, path: string | null): string | null =>
  path ? `${API_V1}${END_POINTS.PUBLIC}${END_POINTS.EVENTS}/${slug}/banner` : null;
