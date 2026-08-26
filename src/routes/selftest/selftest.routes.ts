import { Router } from 'express';
import { z } from 'zod';
import { environment } from '@config/config';
import { MSG_KEYS, RES_STATUS } from '@constant/message.constant';
import { validateRequest } from '@middleware/validation';
import { handleApiResponse } from '@utils/handleResponse';

/**
 * Local-only echo endpoint.
 *
 * The M0 contract that most needs proving end to end is the encryption
 * boundary: ciphertext in → decrypt → zod validate → controller → encrypt →
 * ciphertext out, with `decrypted_data` present only in local. Until M1 lands a
 * real POST route there is nothing to point that test at, and "we verified it
 * in a unit test" is not the same claim.
 *
 * Mounted **only when APP_ENV=local** (see routes/index.ts). It is an
 * unauthenticated reflector, so it must never exist in a shared environment —
 * the same reason observability.md §8 forbids a "decrypt this for me" endpoint.
 */
export const selfTestRouter = Router();

const echoSchema = z.object({
  message: z.string().min(1, 'validation.requiredFields'),
  // Present so a malformed value exercises the 422 path with a field map.
  count: z.number().int().min(0).optional(),
});

selfTestRouter.post('/echo', validateRequest({ body: echoSchema }), (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: MSG_KEYS.SUCCESS,
    data: {
      received: req.body,
      env: environment.appEnv,
      locale: res.getLocale(),
      requestId: req.requestId,
      rawBodyCaptured: Buffer.isBuffer(req.rawBody),
    },
  });
});

selfTestRouter.get('/paginated', (_req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    messageKey: MSG_KEYS.FETCHED,
    data: [{ id: '1' }, { id: '2' }],
    pagination: { page: 1, limit: 20, total: 153 },
  });
});
