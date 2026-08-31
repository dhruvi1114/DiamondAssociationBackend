import { z } from 'zod';
import {
  NEWS_PAGE_SIZE,
  NEWS_PAGE_SIZE_MAX,
  NEWS_STATUS,
  NEWS_VISIBILITY,
} from '@modules/news/news.constants';

/**
 * A slug the association typed itself.
 *
 * Lower case, digits and single hyphens. Accepting anything else would put the
 * escaping question into every link the site builds, and a slug with a slash in
 * it is a second route pretending to be a page.
 */
const slugField = z
  .string()
  .trim()
  .min(3)
  .max(180)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'validation.invalidSlug');

const idField = z.string().trim().regex(/^\d+$/, 'validation.invalidId');

const articleShape = z.object({
  title: z.string().trim().min(3).max(220),
  /*
    Optional on the wire, generated from the title when it is absent. Staff
    should not have to think about URLs to save a draft, but an association that
    wants a short address for a press release is entitled to set one.
  */
  slug: slugField.optional(),
  excerpt: z.string().trim().min(10).max(400),
  /*
    20 000 characters of HTML, before sanitising. Generous for an article and
    small enough that a runaway paste is refused at the edge rather than after
    it has been cleaned.
  */
  body: z.string().max(20_000).default(''),
  cover_image_alt: z.string().trim().max(200).nullable().optional().default(null),
  /*
    A string on the wire — every id in this API is, since a bigint does not
    survive JSON intact — and nullable, because an association that has not yet
    settled its category list must still be able to write.
  */
  category_id: idField.nullable().optional().default(null),
  visibility: z
    .union([z.literal(NEWS_VISIBILITY.MEMBER_ONLY), z.literal(NEWS_VISIBILITY.PUBLIC)])
    .default(NEWS_VISIBILITY.PUBLIC),
});

export const createArticleSchema = articleShape;
export type CreateArticleInput = z.infer<typeof createArticleSchema>;

export const updateArticleSchema = articleShape;
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;

/** Query for the admin news list. */
export const listArticlesSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().max(200).optional(),
  status: z.coerce.number().int().min(NEWS_STATUS.DRAFT).max(NEWS_STATUS.ARCHIVED).optional(),
  visibility: z.coerce
    .number()
    .int()
    .min(NEWS_VISIBILITY.MEMBER_ONLY)
    .max(NEWS_VISIBILITY.PUBLIC)
    .optional(),
  category_id: idField.optional(),
});

export type ListArticlesQuery = z.infer<typeof listArticlesSchema>;

/**
 * Query for the public and member listing.
 *
 * The category arrives as its slug, not its id: it is a filter a visitor can see
 * in the address bar and share, and `?category=press-release` is a link a person
 * can read where `?category=3` is not.
 */
export const listPublicNewsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(NEWS_PAGE_SIZE_MAX).default(NEWS_PAGE_SIZE),
  category: slugField.optional(),
  /*
    Free text over the headline and the summary, not the body. A reader looking
    for an article is remembering what it was called, and matching the body
    would return every circular that happens to mention the word once.
  */
  search: z.string().trim().min(1).max(120).optional(),
  /*
    Two orders, both by publication date. "Relevance" would be a third thing to
    define and defend, and this list is a chronology.
  */
  sort: z.enum(['newest', 'oldest']).default('newest'),
});

export type ListPublicNewsQuery = z.infer<typeof listPublicNewsSchema>;

/** `:slug` in a public route. */
export const slugParamSchema = z.object({ slug: slugField });

/** `:id` plus `:imageId`, for deleting one inline image. */
export const imageParamSchema = z.object({ id: idField, imageId: idField });

/** `:id` plus `:attachmentId`, for the staff copy and the delete. */
export const attachmentParamSchema = z.object({ id: idField, attachmentId: idField });

/**
 * `:slug` plus `:publicId`, for a public download.
 *
 * The id is a UUID rather than a row id — validated as one here so a malformed
 * path is refused before it reaches a query.
 */
export const slugAttachmentParamSchema = z.object({
  slug: slugField,
  publicId: z.string().uuid('validation.invalidId'),
});

const categoryShape = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(30)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'validation.invalidCode'),
  name: z.string().trim().min(2).max(120),
  slug: slugField.max(140).optional(),
  display_order: z.coerce.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
});

export const createCategorySchema = categoryShape;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

/*
  The code is immutable once created — reports and any future hard-coded
  reference read it — so the update shape is the create shape without it.
*/
export const updateCategorySchema = categoryShape.omit({ code: true }).partial();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

/** Query for the admin category list. Live rows only unless asked otherwise. */
export const listCategoriesSchema = z.object({
  include_inactive: z.coerce.boolean().default(false),
});

export type ListCategoriesQuery = z.infer<typeof listCategoriesSchema>;
