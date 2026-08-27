import { Prisma } from '@prisma/client';
import type { Db } from '@db/prisma';
import { NEWS_STATUS, NEWS_VISIBILITY } from '@modules/news/news.constants';
import type { ListArticlesQuery } from '@modules/news/news.types';

/**
 * Data access for news.
 *
 * Every reader here filters `deletedAt: null` and, on the public side, status
 * and visibility as well. That is the point of putting them in one file: the
 * rule that a member-only article never appears in a public list is a WHERE
 * clause in this module, not a check some controller is trusted to remember.
 */

/*
  The category comes back as its name on every reader. Each caller renders the
  article for a person — the admin table, the card, the article page — and not
  one of them has a use for the id alone.
*/
const articleInclude = {
  category: { select: { id: true, name: true, slug: true } },
  /*
    Attachments travel with every read of an article. They are what the foot of
    the page is made of, so a detail response without them would need a second
    request before the page could render — and the list uses the count to show
    that an article carries downloads at all.
  */
  attachments: {
    orderBy: [{ display_order: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.NewsArticleInclude;

const LIVE = { deletedAt: null } as const;

/** Published and public: what a logged-out visitor may see. */
const PUBLIC_WHERE = {
  ...LIVE,
  status: NEWS_STATUS.PUBLISHED,
  visibility: NEWS_VISIBILITY.PUBLIC,
} as const;

/** Published, either visibility: what a signed-in member may see. */
const MEMBER_WHERE = { ...LIVE, status: NEWS_STATUS.PUBLISHED } as const;

export const findArticleById = (db: Db, id: bigint) =>
  db.newsArticle.findFirst({ where: { id, ...LIVE }, include: articleInclude });

export const findArticleBySlug = (db: Db, slug: string) =>
  db.newsArticle.findFirst({ where: { slug, ...LIVE }, include: articleInclude });

/**
 * Does any row hold this slug — including a soft-deleted one?
 *
 * Deliberately not filtered by `deletedAt`. The unique index is not filtered
 * either: a slug is a public address that has been indexed and linked to, and
 * handing it to a different article after a delete turns an old bookmark into a
 * quietly wrong page.
 */
export const slugExists = async (db: Db, slug: string, exceptId?: bigint): Promise<boolean> =>
  (await db.newsArticle.count({
    where: { slug, ...(exceptId === undefined ? {} : { id: { not: exceptId } }) },
  })) > 0;

export const createArticle = (db: Db, data: Prisma.NewsArticleUncheckedCreateInput) =>
  db.newsArticle.create({ data });

export const updateArticle = (db: Db, id: bigint, data: Prisma.NewsArticleUncheckedUpdateInput) =>
  db.newsArticle.update({ where: { id }, data });

/** The admin table: every status, every visibility, newest first. */
export const listArticlesForAdmin = async (db: Db, query: ListArticlesQuery) => {
  const where: Prisma.NewsArticleWhereInput = {
    ...LIVE,
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.visibility === undefined ? {} : { visibility: query.visibility }),
    ...(query.category_id === undefined ? {} : { category_id: BigInt(query.category_id) }),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { excerpt: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.newsArticle.findMany({
      where,
      include: articleInclude,
      /*
        A draft has no publish date, so ordering by it alone would drop every
        unpublished article to one undifferentiated block at the end. `createdAt`
        behind it keeps the drafts in the order they were written, which is the
        order the person who wrote them is looking for.
      */
      orderBy: [{ published_at: 'desc' }, { createdAt: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    db.newsArticle.count({ where }),
  ]);

  return { rows: await withActorNames(db, rows), total };
};

/**
 * Attach the staff names behind `created_by_admin_id` / `updated_by_admin_id`.
 *
 * One extra query for the whole page rather than a relation on the model: the
 * audit columns are deliberately plain ids with no foreign key — the same shape
 * every other table in this system uses — and adding a relation purely to render
 * a name would put a constraint on the schema to serve a column.
 *
 * An id with no matching row comes back as null rather than as the number. A
 * deactivated staff account is still a name; a deleted one is genuinely unknown,
 * and printing a bare id in a "Created By" column tells the reader nothing.
 */
const withActorNames = async <
  T extends { created_by_admin_id: bigint | null; updated_by_admin_id: bigint | null },
>(
  db: Db,
  rows: T[],
): Promise<(T & { created_by: string | null; updated_by: string | null })[]> => {
  const ids = [
    ...new Set(
      rows
        .flatMap((row) => [row.created_by_admin_id, row.updated_by_admin_id])
        .filter((id): id is bigint => id !== null)
        .map((id) => id.toString()),
    ),
  ].map((id) => BigInt(id));

  const admins =
    ids.length === 0
      ? []
      : await db.adminUser.findMany({
          where: { id: { in: ids } },
          select: { id: true, full_name: true },
        });

  const names = new Map(admins.map((admin) => [admin.id.toString(), admin.full_name]));

  return rows.map((row) => ({
    ...row,
    created_by: row.created_by_admin_id
      ? (names.get(row.created_by_admin_id.toString()) ?? null)
      : null,
    updated_by: row.updated_by_admin_id
      ? (names.get(row.updated_by_admin_id.toString()) ?? null)
      : null,
  }));
};

interface PublicListArgs {
  page: number;
  limit: number;
  categorySlug?: string;
  /** True for a signed-in member: member-only articles come back too. */
  includeMemberOnly: boolean;
}

/** The homepage block, `/news`, and the member view of the same list. */
export const listPublishedArticles = async (db: Db, args: PublicListArgs) => {
  const where: Prisma.NewsArticleWhereInput = {
    ...(args.includeMemberOnly ? MEMBER_WHERE : PUBLIC_WHERE),
    ...(args.categorySlug ? { category: { slug: args.categorySlug, deletedAt: null } } : {}),
  };

  const [rows, total] = await Promise.all([
    db.newsArticle.findMany({
      where,
      include: articleInclude,
      orderBy: [{ published_at: 'desc' }, { id: 'desc' }],
      skip: (args.page - 1) * args.limit,
      take: args.limit,
    }),
    db.newsArticle.count({ where }),
  ]);

  return { rows, total };
};

export const findPublishedArticleBySlug = (db: Db, slug: string, includeMemberOnly: boolean) =>
  db.newsArticle.findFirst({
    where: { slug, ...(includeMemberOnly ? MEMBER_WHERE : PUBLIC_WHERE) },
    include: articleInclude,
  });

/* ----------------------------------------------------------- attachments -- */

export const createAttachment = (db: Db, data: Prisma.NewsArticleAttachmentUncheckedCreateInput) =>
  db.newsArticleAttachment.create({ data });

export const findAttachment = (db: Db, articleId: bigint, attachmentId: bigint) =>
  db.newsArticleAttachment.findFirst({ where: { id: attachmentId, article_id: articleId } });

export const deleteAttachment = (db: Db, attachmentId: bigint) =>
  db.newsArticleAttachment.delete({ where: { id: attachmentId } });

export const countAttachments = (db: Db, articleId: bigint) =>
  db.newsArticleAttachment.count({ where: { article_id: articleId } });

/**
 * One attachment by its public id, with just enough of its article to decide
 * whether the bytes may be served.
 *
 * Unlike an inline image, the visibility test is not skipped here: an inline
 * picture is meaningless without the article it sits in, while an attachment is
 * a document that stands on its own — a members-only circular stays members-only
 * whether or not somebody has the link.
 */
export const findAttachmentByPublicId = (db: Db, publicId: string) =>
  db.newsArticleAttachment.findFirst({
    where: { public_id: publicId, article: { deletedAt: null } },
    select: {
      id: true,
      file_path: true,
      mime_type: true,
      original_name: true,
      article: { select: { id: true, slug: true, status: true, visibility: true } },
    },
  });

/* ---------------------------------------------------------------- images -- */

export const createImage = (db: Db, data: Prisma.NewsArticleImageUncheckedCreateInput) =>
  db.newsArticleImage.create({ data });

export const listImages = (db: Db, articleId: bigint) =>
  db.newsArticleImage.findMany({ where: { article_id: articleId }, orderBy: { id: 'asc' } });

export const findImage = (db: Db, articleId: bigint, imageId: bigint) =>
  db.newsArticleImage.findFirst({ where: { id: imageId, article_id: articleId } });

export const deleteImage = (db: Db, imageId: bigint) =>
  db.newsArticleImage.delete({ where: { id: imageId } });

/* ------------------------------------------------------------ categories -- */

export const listCategories = (db: Db, includeInactive: boolean) =>
  db.newsCategory.findMany({
    where: { ...LIVE, ...(includeInactive ? {} : { is_active: true }) },
    orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
  });

/**
 * The filter tabs.
 *
 * Only categories that have something to show: a tab that leads to an empty page
 * is a promise the site does not keep. Counted against the same visibility the
 * caller is allowed to see, so a members-only article never puts a tab in front
 * of a logged-out visitor.
 */
export const listCategoriesWithPublished = (db: Db, includeMemberOnly: boolean) =>
  db.newsCategory.findMany({
    where: {
      ...LIVE,
      is_active: true,
      articles: { some: includeMemberOnly ? MEMBER_WHERE : PUBLIC_WHERE },
    },
    orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
  });

export const findCategoryById = (db: Db, id: bigint) =>
  db.newsCategory.findFirst({ where: { id, ...LIVE } });

export const categoryCodeExists = async (db: Db, code: string): Promise<boolean> =>
  (await db.newsCategory.count({ where: { code } })) > 0;

export const categorySlugExists = async (
  db: Db,
  slug: string,
  exceptId?: bigint,
): Promise<boolean> =>
  (await db.newsCategory.count({
    where: { slug, ...(exceptId === undefined ? {} : { id: { not: exceptId } }) },
  })) > 0;

export const createCategory = (db: Db, data: Prisma.NewsCategoryUncheckedCreateInput) =>
  db.newsCategory.create({ data });

export const updateCategory = (db: Db, id: bigint, data: Prisma.NewsCategoryUncheckedUpdateInput) =>
  db.newsCategory.update({ where: { id }, data });

/** How many live articles still point at this category — the delete guard. */
export const countArticlesInCategory = (db: Db, categoryId: bigint) =>
  db.newsArticle.count({ where: { category_id: categoryId, ...LIVE } });

/**
 * One inline image by its public id, with just enough of its article to decide
 * whether the bytes may be served.
 *
 * The id is the permission — it is random and only ever appears inside the
 * article body — so the check here is narrow on purpose: the article must still
 * exist. A draft's images are reachable to whoever holds the draft's markup,
 * which is staff, and a published article's images are reachable to everyone
 * who can read the article they are embedded in.
 */
export const findImageByPublicId = (db: Db, publicId: string) =>
  db.newsArticleImage.findFirst({
    where: { public_id: publicId, article: { deletedAt: null } },
    select: {
      id: true,
      file_path: true,
      mime_type: true,
      article: { select: { id: true, status: true, visibility: true } },
    },
  });
