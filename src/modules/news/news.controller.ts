import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import { prisma } from '@db/prisma';
import { NEWS_STATUS, NEWS_VISIBILITY } from '@modules/news/news.constants';
import * as media from '@modules/news/news.media.service';
import * as present from '@modules/news/news.presenter';
import * as repo from '@modules/news/news.repository';
import * as service from '@modules/news/news.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

/**
 * HTTP layer for news.
 *
 * Three audiences share the readers below and are separated by exactly one
 * boolean, `includeMemberOnly`, resolved from which router the request arrived
 * on. A member sees everything a visitor sees plus the member-only articles;
 * nothing is subtracted for signing in.
 */

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

const actor = (req: Request) => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  return {
    id: req.actor.id,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  };
};

const uploadedFile = (req: Request): media.UploadedFile => {
  if (!req.file) {
    throw new AppError({ errorType: ERROR_TYPES.INVALID_REQUEST, messageKey: 'news.fileRequired' });
  }

  return { buffer: req.file.buffer, originalname: req.file.originalname };
};

/** True when this request came in on a router that has already authenticated a member. */
const isMember = (req: Request): boolean => req.actor?.id !== undefined;

/* --------------------------------------------------------------- reading -- */

/** `GET /public/news/home` · `GET /news/home` — the homepage Newsroom block. */
export const homepageNews = handler(async (req, res) => {
  const rows = await service.homepageNews(isMember(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: { articles: rows.map(present.toCard) },
  });
});

/** `GET /public/news` · `GET /news` — the listing, newest first. */
export const listNews = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listPublishedNews>[0];
  const { rows, total } = await service.listPublishedNews(query, isMember(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: { articles: rows.map(present.toCard) },
    pagination: { page: query.page, limit: query.limit, total },
  });
});

/** `GET /public/news/categories` · `GET /news/categories` — the filter tabs. */
export const listNewsCategories = handler(async (req, res) => {
  const rows = await service.listPublicCategories(isMember(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: { categories: rows.map(present.toPublicCategory) },
  });
});

/** `GET /public/news/:slug` · `GET /news/:slug` — one article. */
export const getNewsArticle = handler(async (req, res) => {
  const { slug } = req.params as { slug: string };
  const article = await service.getPublishedArticle(slug, isMember(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: { article: present.toDetail(article) },
  });
});

/* ------------------------------------------------------------- streaming -- */

const streamFile = (
  req: Request,
  res: Response,
  file: media.StreamedFile,
  etagSource: string,
  disposition: 'inline' | 'attachment',
): void => {
  const etag = `"${etagSource}"`;

  res.setHeader('ETag', etag);
  /*
    `no-cache` is "keep it, but ask every time", not "do not store". It has to be
    that: the cover at /news/<slug>/cover is a mutable resource at a fixed URL,
    and an article whose visibility was just changed to members-only must stop
    being served from a stranger's disk cache. Revalidation is cheap — the ETag
    makes the usual answer a 304 with no body.
  */
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();

    return;
  }

  res.setHeader(
    'Content-Disposition',
    disposition === 'attachment' && file.filename
      ? `attachment; filename="${file.filename.replace(/["\\]/g, '')}"`
      : 'inline',
  );
  file.stream.pipe(res);
};

const notFound = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'news.notFound' });

/** `GET /public/news/:slug/cover` — the cover image, if this audience may see it. */
export const serveCover = handler(async (req, res) => {
  const { slug } = req.params as { slug: string };
  const article = await service.getPublishedArticle(slug, isMember(req));

  if (!article.cover_image_path) throw notFound();

  const mime = media.imageMimeForKey(article.cover_image_path);

  if (!mime) throw notFound();

  const file = await media.openFile(article.cover_image_path, mime);

  streamFile(req, res, file, article.cover_image_path, 'inline');
});

/**
 * `GET /public/news/:slug/attachments/:publicId` — one attached file.
 *
 * The article is read first, through the same visibility-aware reader every
 * other public endpoint uses, and the file must belong to it. Both halves
 * matter: the id alone would serve a members-only circular to anyone who came
 * by the link, and the slug alone would let one article's URL fetch another's
 * documents.
 */
export const serveAttachment = handler(async (req, res) => {
  const { slug, publicId } = req.params as { slug: string; publicId: string };
  const article = await service.getPublishedArticle(slug, isMember(req));
  const attachment = await repo.findAttachmentByPublicId(prisma, publicId);

  if (!attachment || attachment.article.id !== article.id) throw notFound();

  const file = await media.openFile(
    attachment.file_path,
    attachment.mime_type,
    attachment.original_name,
  );

  streamFile(req, res, file, attachment.file_path, 'attachment');
});

/**
 * `GET /public/news/media/:publicId` — one picture from inside an article body.
 *
 * The random id in the path is the permission, which is why this endpoint does
 * not repeat the status and visibility test: the URL only ever exists inside the
 * body of the article that owns it, so anyone holding it was already given the
 * article. Testing visibility here would break the admin preview of a draft
 * without protecting anything the id had not already granted.
 */
export const serveMedia = handler(async (req, res) => {
  const { publicId } = req.params as { publicId: string };
  const image = await repo.findImageByPublicId(prisma, publicId);

  if (!image) throw notFound();

  const file = await media.openFile(image.file_path, image.mime_type);

  streamFile(req, res, file, image.file_path, 'inline');
});

/**
 * `GET /admin/news/:id/cover` · `GET /admin/news/:id/attachment` — staff copies.
 *
 * The public endpoints above answer 404 for a draft or a members-only article,
 * which is exactly right for a stranger and useless for the person writing it.
 * Staff hold a token and a permission, so they get their own route rather than
 * a weakened public one.
 *
 * The admin app fetches these with its bearer token and renders the bytes from a
 * blob, because an `<img src>` cannot carry an Authorization header — and
 * putting the token in the URL would write it into every proxy log on the way.
 */
export const serveAdminCover = handler(async (req, res) => {
  const { id } = req.params as { id: string };
  const { article } = await service.getArticleForAdmin(BigInt(id));

  if (!article.cover_image_path) throw notFound();

  const mime = media.imageMimeForKey(article.cover_image_path);

  if (!mime) throw notFound();

  const file = await media.openFile(article.cover_image_path, mime);

  streamFile(req, res, file, article.cover_image_path, 'inline');
});

export const serveAdminAttachment = handler(async (req, res) => {
  const { id, attachmentId } = req.params as { id: string; attachmentId: string };
  const attachment = await repo.findAttachment(prisma, BigInt(id), BigInt(attachmentId));

  if (!attachment) throw notFound();

  const file = await media.openFile(
    attachment.file_path,
    attachment.mime_type,
    attachment.original_name,
  );

  streamFile(req, res, file, attachment.file_path, 'attachment');
});

/* ------------------------------------------------------------ admin: CRUD -- */

/** `GET /admin/news` */
export const listArticles = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listArticlesForAdmin>[0];
  const { rows, total } = await service.listArticlesForAdmin(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: { articles: rows.map(present.toAdminRow) },
    pagination: { page: query.page, limit: query.limit, total },
  });
});

/** `GET /admin/news/:id` */
export const getArticle = handler(async (req, res) => {
  const { id } = req.params as { id: string };
  const { article, images } = await service.getArticleForAdmin(BigInt(id));

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: { article: present.toAdminDetail(article, images) },
  });
});

/** `POST /admin/news` */
export const createArticle = handler(async (req, res) => {
  const input = req.body as Parameters<typeof service.createArticle>[0];
  const article = await service.createArticle(input, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'news.created',
    data: { article: article ? present.toAdminRow(article) : null },
  });
});

/** `PATCH /admin/news/:id` */
export const updateArticle = handler(async (req, res) => {
  const { id } = req.params as { id: string };
  const input = req.body as Parameters<typeof service.updateArticle>[1];
  const article = await service.updateArticle(BigInt(id), input, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'news.updated',
    data: { article: article ? present.toAdminRow(article) : null },
  });
});

const transition = (
  run: (id: bigint, who: service.NewsActor) => Promise<unknown>,
  messageKey: string,
): RequestHandler =>
  handler(async (req, res) => {
    const { id } = req.params as { id: string };
    const article = (await run(BigInt(id), actor(req))) as
      Parameters<typeof present.toAdminRow>[0] | null;

    handleApiResponse(res, {
      responseType: RES_STATUS.ACTION,
      messageKey,
      data: { article: article ? present.toAdminRow(article) : null },
    });
  });

/** `POST /admin/news/:id/publish` */
export const publishArticle = transition(service.publishArticle, 'news.published');

/** `POST /admin/news/:id/unpublish` */
export const unpublishArticle = transition(service.unpublishArticle, 'news.unpublished');

/** `POST /admin/news/:id/archive` */
export const archiveArticle = transition(service.archiveArticle, 'news.archived');

/** `DELETE /admin/news/:id` */
export const deleteArticle = handler(async (req, res) => {
  const { id } = req.params as { id: string };

  await service.deleteArticle(BigInt(id), actor(req));

  handleApiResponse(res, { responseType: RES_STATUS.DELETE, messageKey: 'news.deleted' });
});

/* ----------------------------------------------------------- admin: media -- */

/** `POST /admin/news/:id/cover` */
export const uploadCover = handler(async (req, res) => {
  const { id } = req.params as { id: string };
  const article = await service.setCover(BigInt(id), uploadedFile(req), actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'news.coverUpdated',
    data: { article: article ? present.toAdminRow(article) : null },
  });
});

/** `POST /admin/news/:id/attachments` — add one more file. */
export const uploadAttachment = handler(async (req, res) => {
  const { id } = req.params as { id: string };
  const { article, attachment } = await service.addAttachment(
    BigInt(id),
    uploadedFile(req),
    actor(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'news.attachmentAdded',
    data: {
      article: article ? present.toAdminRow(article) : null,
      attachment: {
        id: attachment.id.toString(),
        name: attachment.original_name,
        size_bytes: Number(attachment.size_bytes),
      },
    },
  });
});

/** `DELETE /admin/news/:id/attachments/:attachmentId` */
export const removeAttachment = handler(async (req, res) => {
  const { id, attachmentId } = req.params as { id: string; attachmentId: string };

  await service.removeAttachment(BigInt(id), BigInt(attachmentId), actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'news.attachmentRemoved',
  });
});

/**
 * `POST /admin/news/:id/images` — one picture for the body.
 *
 * The response is the URL to write into the article. It is the SAME URL the
 * public will read it at, so what the writer sees in the editor is what a
 * visitor sees on the page.
 */
export const uploadInlineImage = handler(async (req, res) => {
  const { id } = req.params as { id: string };
  const image = await service.addInlineImage(BigInt(id), uploadedFile(req), actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'news.imageUploaded',
    data: {
      image: {
        id: image.id.toString(),
        url: present.mediaUrl(image.public_id),
        original_name: image.original_name,
        size_bytes: Number(image.size_bytes),
      },
    },
  });
});

/** `DELETE /admin/news/:id/images/:imageId` */
export const deleteInlineImage = handler(async (req, res) => {
  const { id, imageId } = req.params as { id: string; imageId: string };

  await service.removeInlineImage(BigInt(id), BigInt(imageId));

  handleApiResponse(res, { responseType: RES_STATUS.DELETE, messageKey: 'news.imageDeleted' });
});

/* ------------------------------------------------------ admin: categories -- */

/** `GET /admin/news-categories` */
export const listCategories = handler(async (req, res) => {
  const query = req.query as unknown as { include_inactive: boolean };
  const rows = await service.listCategories(query.include_inactive);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: { categories: rows.map(present.toCategory) },
  });
});

/** `POST /admin/news-categories` */
export const createCategory = handler(async (req, res) => {
  const input = req.body as Parameters<typeof service.createCategory>[0];
  const category = await service.createCategory(input, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'news.categoryCreated',
    data: { category: present.toCategory(category) },
  });
});

/** `PATCH /admin/news-categories/:id` */
export const updateCategory = handler(async (req, res) => {
  const { id } = req.params as { id: string };
  const input = req.body as Parameters<typeof service.updateCategory>[1];
  const category = await service.updateCategory(BigInt(id), input, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'news.categoryUpdated',
    data: { category: present.toCategory(category) },
  });
});

/** `DELETE /admin/news-categories/:id` */
export const deleteCategory = handler(async (req, res) => {
  const { id } = req.params as { id: string };

  await service.deleteCategory(BigInt(id), actor(req));

  handleApiResponse(res, { responseType: RES_STATUS.DELETE, messageKey: 'news.categoryDeleted' });
});

export { NEWS_STATUS, NEWS_VISIBILITY };
