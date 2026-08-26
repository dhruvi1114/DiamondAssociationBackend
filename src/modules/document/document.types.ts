import { z } from 'zod';

/** Request schemas for document verification (M3, screen A-13). */

export const verifyDocumentSchema = z
  .object({
    status: z.enum(['VERIFIED', 'REJECTED']),
    remarks: z.string().trim().max(1000, 'validation.tooLong').optional(),
  })
  .refine((value) => value.status !== 'REJECTED' || Boolean(value.remarks?.trim()), {
    // Mirrors the database CHECK. The constraint is the guarantee; this is the
    // message the reviewer can act on, pointed at the field they must fill.
    message: 'document.rejectionNeedsRemarks',
    path: ['remarks'],
  });

export type VerifyDocumentInput = z.infer<typeof verifyDocumentSchema>;
