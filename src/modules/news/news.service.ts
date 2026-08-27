import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import type { Db } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { uuidv4 } from '@helpers/random';
import {
  HOMEPAGE_LIMIT,
  MAX_ATTACHMENTS,
  NEWS_STATUS,
  NEWS_VISIBILITY,
} from '@modules/news/news.constants';
import * as media from '@modules/news/news.media.service';
import * as repo from '@modules/news/news.repository';
import { hasReadableText, sanitiseArticleBody } from '@modules/news/news.sanitize';
import type {
  CreateArticleInput,
  CreateCategoryInput,
  ListArticlesQuery,
  ListPublicNewsQuery,
  UpdateArticleInput,
  UpdateCategoryInput,
} from '@modules/news/news.types';
import { AppError } from '@utils/appError';

/**
 * News: the association's own writing, published to the website.
 *
 * Two rules run through everything below and are worth stating once.
 *
 * The body is sanitised on the way IN. This markup is served to logged-out
 * browsers, so it has to be safe in the database — cleaning it at render time
 * would mean every future reader of the column has to remember to do it too.
 *
 * A member-only article is absent from public queries rather than fetched and
 * hidden. A 403 confirms the article exists, which is itself the thing being
 * withheld, so the public reader simply does not select it and the public detail
 * endpoint answers 404.
 */

export interface NewsActor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const notFound = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'news.notFound' });

const conflict = (messageKey: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey });

const invalid = (messageKey: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.INVALID_REQUEST, messageKey });

/**
 * A URL-safe slug for the title, with a short random suffix.
 *
 * The suffix is not decoration: two articles called "Annual General Meeting
 * Notice" are completely normal, and without it the second one fails to save on
 * a unique violation the writer can do nothing about. A slug the association
 * typed itself is used as given — and refused as a conflict if it is taken,
 * because silently appending characters to an address somebody chose is worse
 * than telling them it is in use.
 */
const slugify = (title: string): string => {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);

  return `${base || 'news'}-${randomBytes(3).toString('hex')}`;
};

/** The columns an article write controls. Status and slug are handled separately. */
const articleColumns = (input: CreateArticleInput | UpdateArticleInput) => ({
  title: input.title,
  excerpt: input.excerpt,
  body: sanitiseArticleBody(input.body),
  cover_image_alt: input.cover_image_alt ?? null,
  /*
    Not validated against the master here. The foreign key already refuses an id
    that is not a live category, inside the same transaction as the write — a
    lookup first would be a second round trip that can still lose the race with
    a deactivation happening beside it.
  */
  category_id: input.category_id ? BigInt(input.category_id) : null,
  visibility: input.visibility,
});

/** Resolve the slug for a write, refusing one that is already taken. */
const resolveSlug = async (
  db: Db,
  title: string,
  requested: string | undefined,
  exceptId?: bigint,
): Promise<string> => {
  if (!requested) return slugify(title);

  if (await repo.slugExists(db, requested, exceptId)) throw conflict('news.slugTaken');

  return requested;
};

/* -------------------------------------------------------------- articles -- */

/** Create a draft. Nobody outside the admin panel can see it. */
export const createArticle = async (input: CreateArticleInput, actor: NewsActor) => {
  const created = await prisma.$transaction(async (tx) => {
    const article = await repo.createArticle(tx, {
      ...articleColumns(input),
      slug: await resolveSlug(tx, input.title, input.slug),
      status: NEWS_STATUS.DRAFT,
      created_by_admin_id: actor.id,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.NEWS_CREATED,
      entityName: 'NewsArticles',
      entityId: article.id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      after: { title: article.title, visibility: article.visibility, status: article.status },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return article;
  });

  return repo.findArticleById(prisma, created.id);
};

/**
 * Edit an article.
 *
 * The slug is editable only while the article is a draft. Once published the
 * address has been shared, indexed and linked to, and changing it turns every
 * existing link into a dead one — so a published article keeps the slug it went
 * out with, and a request to change it is refused rather than quietly ignored.
 */
export const updateArticle = async (id: bigint, input: UpdateArticleInput, actor: NewsActor) => {
  const existing = await repo.findArticleById(prisma, id);

  if (!existing) throw notFound();

  const isDraft = existing.status === NEWS_STATUS.DRAFT;

  if (input.slug && input.slug !== existing.slug && !isDraft) {
    throw conflict('news.slugLockedAfterPublish');
  }

  await prisma.$transaction(async (tx) => {
    const slug =
      isDraft && input.slug ? await resolveSlug(tx, input.title, input.slug, id) : existing.slug;

    await repo.updateArticle(tx, id, {
      ...articleColumns(input),
      slug,
      updated_by_admin_id: actor.id,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.NEWS_UPDATED,
      entityName: 'NewsArticles',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { title: existing.title, visibility: existing.visibility },
      after: { title: input.title, visibility: input.visibility },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return repo.findArticleById(prisma, id);
};

/**
 * Put an article on the site.
 *
 * The four things checked here are the four things a card is made of: headline,
 * summary, cover image and readable body. A card missing any of them is a hole
 * on the homepage that only the public sees, so publishing refuses rather than
 * producing one.
 *
 * `published_at` is stamped once and kept. Re-stamping it on a republish would
 * move a two-year-old press release back to the top of the homepage after a
 * typo fix.
 */
export const publishArticle = async (id: bigint, actor: NewsActor) => {
  const article = await repo.findArticleById(prisma, id);

  if (!article) throw notFound();
  if (article.status === NEWS_STATUS.PUBLISHED) throw conflict('news.alreadyPublished');
  if (!article.cover_image_path) throw invalid('news.coverRequired');
  if (!hasReadableText(article.body)) throw invalid('news.bodyRequired');

  await prisma.$transaction(async (tx) => {
    await repo.updateArticle(tx, id, {
      status: NEWS_STATUS.PUBLISHED,
      published_at: article.published_at ?? new Date(),
      updated_by_admin_id: actor.id,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.NEWS_PUBLISHED,
      entityName: 'NewsArticles',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { status: article.status },
      after: { status: NEWS_STATUS.PUBLISHED, visibility: article.visibility },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return repo.findArticleById(prisma, id);
};

/** Pull an article back to draft — a correction, not a retirement. */
export const unpublishArticle = async (id: bigint, actor: NewsActor) => {
  const article = await repo.findArticleById(prisma, id);

  if (!article) throw notFound();
  if (article.status !== NEWS_STATUS.PUBLISHED) throw conflict('news.notPublished');

  await prisma.$transaction(async (tx) => {
    await repo.updateArticle(tx, id, {
      status: NEWS_STATUS.DRAFT,
      updated_by_admin_id: actor.id,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.NEWS_UNPUBLISHED,
      entityName: 'NewsArticles',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { status: article.status },
      after: { status: NEWS_STATUS.DRAFT },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return repo.findArticleById(prisma, id);
};

/**
 * Retire an article from the site, keeping it in the panel and in the record.
 *
 * The retirement path, rather than delete: a press release that has been public
 * for two years is a record of what the association said, and removing the row
 * would remove the audit trail of who published it with it.
 */
export const archiveArticle = async (id: bigint, actor: NewsActor) => {
  const article = await repo.findArticleById(prisma, id);

  if (!article) throw notFound();
  if (article.status === NEWS_STATUS.ARCHIVED) throw conflict('news.alreadyArchived');
  if (article.status === NEWS_STATUS.DRAFT) throw conflict('news.draftCannotArchive');

  await prisma.$transaction(async (tx) => {
    await repo.updateArticle(tx, id, {
      status: NEWS_STATUS.ARCHIVED,
      updated_by_admin_id: actor.id,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.NEWS_ARCHIVED,
      entityName: 'NewsArticles',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { status: article.status },
      after: { status: NEWS_STATUS.ARCHIVED },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return repo.findArticleById(prisma, id);
};

/**
 * Remove an article.
 *
 * Drafts only. Anything that has been on the public web archives instead — and
 * the guard is here rather than in the screen because "delete the mistake I just
 * wrote" and "erase what we published last year" are different acts that happen
 * to share a button.
 *
 * Soft delete for the row, hard delete for the files: the record of who wrote
 * and who removed it is worth keeping, and the bytes are not.
 */
export const deleteArticle = async (id: bigint, actor: NewsActor) => {
  const article = await repo.findArticleById(prisma, id);

  if (!article) throw notFound();
  if (article.status !== NEWS_STATUS.DRAFT) throw conflict('news.onlyDraftsDeletable');

  await prisma.$transaction(async (tx) => {
    await repo.updateArticle(tx, id, { deletedAt: new Date(), updated_by_admin_id: actor.id });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.NEWS_DELETED,
      entityName: 'NewsArticles',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { title: article.title, status: article.status },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  await media.removeAllFilesFor(id);
};

export const listArticlesForAdmin = (query: ListArticlesQuery) =>
  repo.listArticlesForAdmin(prisma, query);

export const getArticleForAdmin = async (id: bigint) => {
  const article = await repo.findArticleById(prisma, id);

  if (!article) throw notFound();

  const images = await repo.listImages(prisma, id);

  return { article, images };
};

/* ----------------------------------------------------------------- media -- */

/** Replace the cover. New file first, then the row, then the old bytes. */
export const setCover = async (id: bigint, file: media.UploadedFile, actor: NewsActor) => {
  const article = await repo.findArticleById(prisma, id);

  if (!article) throw notFound();

  const stored = await media.storeCover(id, file);

  await repo.updateArticle(prisma, id, {
    cover_image_path: stored.key,
    updated_by_admin_id: actor.id,
  });

  await media.removeFile(article.cover_image_path);

  return repo.findArticleById(prisma, id);
};

/**
 * Attach one more PDF.
 *
 * Added, never replaced: an article may carry a circular, its annexure and the
 * form to fill in, and the previous upload is not a draft of this one. Removing
 * a file is its own deliberate act.
 */
export const addAttachment = async (id: bigint, file: media.UploadedFile, actor: NewsActor) => {
  const article = await repo.findArticleById(prisma, id);

  if (!article) throw notFound();

  const existing = await repo.countAttachments(prisma, id);

  if (existing >= MAX_ATTACHMENTS) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'news.tooManyAttachments',
      // `replacements` is what fills the {{max}} in the message; `details` is
      // for the client to act on. A number needed in both places goes in both.
      replacements: { max: String(MAX_ATTACHMENTS) },
      details: { max: MAX_ATTACHMENTS },
    });
  }

  const stored = await media.storeAttachment(id, file);

  const attachment = await repo.createAttachment(prisma, {
    article_id: id,
    public_id: uuidv4(),
    file_path: stored.key,
    original_name: file.originalname.slice(0, 255),
    mime_type: stored.mime,
    size_bytes: BigInt(stored.size),
    checksum_sha256: stored.checksum,
    // Appended, so the order the writer uploaded them in is the order they read.
    display_order: existing,
    created_by_admin_id: actor.id,
  });

  await repo.updateArticle(prisma, id, { updated_by_admin_id: actor.id });

  return { article: await repo.findArticleById(prisma, id), attachment };
};

/** Detach one PDF. The row goes first; the bytes follow, best effort. */
export const removeAttachment = async (id: bigint, attachmentId: bigint, actor: NewsActor) => {
  const attachment = await repo.findAttachment(prisma, id, attachmentId);

  if (!attachment) throw notFound();

  await repo.deleteAttachment(prisma, attachmentId);
  await repo.updateArticle(prisma, id, { updated_by_admin_id: actor.id });
  await media.removeFile(attachment.file_path);
};

/** Upload one picture for the body and hand back the URL to write into it. */
export const addInlineImage = async (id: bigint, file: media.UploadedFile, actor: NewsActor) => {
  const article = await repo.findArticleById(prisma, id);

  if (!article) throw notFound();

  return media.storeInlineImage(prisma, id, file, actor.id);
};

export const removeInlineImage = async (id: bigint, imageId: bigint) => {
  const image = await repo.findImage(prisma, id, imageId);

  if (!image) throw notFound();

  await repo.deleteImage(prisma, imageId);
  await media.removeFile(image.file_path);
};

/* ----------------------------------------------------------- public read -- */

/** The homepage Newsroom block: the latest four, automatically. */
export const homepageNews = async (includeMemberOnly: boolean) => {
  const { rows } = await repo.listPublishedArticles(prisma, {
    page: 1,
    limit: HOMEPAGE_LIMIT,
    includeMemberOnly,
  });

  return rows;
};

export const listPublishedNews = (query: ListPublicNewsQuery, includeMemberOnly: boolean) =>
  repo.listPublishedArticles(prisma, {
    page: query.page,
    limit: query.limit,
    categorySlug: query.category,
    includeMemberOnly,
  });

/**
 * One article by slug.
 *
 * Missing and not-yours are the same answer on purpose. A logged-out visitor
 * asking for a members-only article gets 404, because 403 would tell them the
 * article exists and what it is called.
 */
export const getPublishedArticle = async (slug: string, includeMemberOnly: boolean) => {
  const article = await repo.findPublishedArticleBySlug(prisma, slug, includeMemberOnly);

  if (!article) throw notFound();

  return article;
};

export const listPublicCategories = (includeMemberOnly: boolean) =>
  repo.listCategoriesWithPublished(prisma, includeMemberOnly);

/* ------------------------------------------------------------ categories -- */

const categorySlugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140) || 'category';

export const listCategories = (includeInactive: boolean) =>
  repo.listCategories(prisma, includeInactive);

export const createCategory = async (input: CreateCategoryInput, actor: NewsActor) => {
  if (await repo.categoryCodeExists(prisma, input.code)) throw conflict('news.categoryCodeTaken');

  const slug = input.slug ?? categorySlugify(input.name);

  if (await repo.categorySlugExists(prisma, slug)) throw conflict('news.categorySlugTaken');

  return prisma.$transaction(async (tx) => {
    const category = await repo.createCategory(tx, {
      code: input.code,
      name: input.name,
      slug,
      display_order: input.display_order,
      is_active: input.is_active,
      created_by_admin_id: actor.id,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.NEWS_CATEGORY_CREATED,
      entityName: 'NewsCategories',
      entityId: category.id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      after: { code: category.code, name: category.name },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return category;
  });
};

export const updateCategory = async (id: bigint, input: UpdateCategoryInput, actor: NewsActor) => {
  const existing = await repo.findCategoryById(prisma, id);

  if (!existing) throw notFound();

  if (input.slug && input.slug !== existing.slug) {
    if (await repo.categorySlugExists(prisma, input.slug, id)) {
      throw conflict('news.categorySlugTaken');
    }
  }

  return prisma.$transaction(async (tx) => {
    const data: Prisma.NewsCategoryUncheckedUpdateInput = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      ...(input.display_order === undefined ? {} : { display_order: input.display_order }),
      ...(input.is_active === undefined ? {} : { is_active: input.is_active }),
      updated_by_admin_id: actor.id,
    };

    const category = await repo.updateCategory(tx, id, data);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.NEWS_CATEGORY_UPDATED,
      entityName: 'NewsCategories',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { name: existing.name, is_active: existing.is_active },
      after: { name: category.name, is_active: category.is_active },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return category;
  });
};

/**
 * Remove a category.
 *
 * Refused while any article still points at it, and the refusal carries the
 * count so the screen can say how many rather than just no. The alternative the
 * message names — deactivate — is the one the association almost always wants:
 * it takes the tab off the site and leaves the filing intact.
 */
export const deleteCategory = async (id: bigint, actor: NewsActor) => {
  const category = await repo.findCategoryById(prisma, id);

  if (!category) throw notFound();

  const inUse = await repo.countArticlesInCategory(prisma, id);

  if (inUse > 0) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'news.categoryInUse',
      // Same pairing as the attachment cap: the count is in the sentence and in
      // the payload, so the screen can say how many either way.
      replacements: { articles: String(inUse) },
      details: { articles: inUse },
    });
  }

  await prisma.$transaction(async (tx) => {
    await repo.updateCategory(tx, id, { deletedAt: new Date(), updated_by_admin_id: actor.id });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.NEWS_CATEGORY_DELETED,
      entityName: 'NewsCategories',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { code: category.code, name: category.name },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });
};

export { NEWS_STATUS, NEWS_VISIBILITY };
