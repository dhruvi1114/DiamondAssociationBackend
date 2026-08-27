import { Router } from 'express';
import multer from 'multer';
import { END_POINTS } from '@constant';
import { authenticate, authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/news/news.controller';
import {
  COVER_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  INLINE_IMAGE_MAX_BYTES,
} from '@modules/news/news.constants';
import {
  createArticleSchema,
  createCategorySchema,
  attachmentParamSchema,
  imageParamSchema,
  listArticlesSchema,
  listCategoriesSchema,
  listPublicNewsSchema,
  slugAttachmentParamSchema,
  slugParamSchema,
  updateArticleSchema,
  updateCategorySchema,
} from '@modules/news/news.types';
import { idParamSchema } from '@modules/member/member.types';

const { NEWS, NEWS_CATEGORIES } = END_POINTS;

/**
 * In memory, like every other upload here: the bytes are sniffed before anything
 * touches the filesystem. These limits stop a large body being buffered at all;
 * the media service applies the same ceiling again against the real size.
 */
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(COVER_MAX_BYTES, INLINE_IMAGE_MAX_BYTES), files: 1 },
});

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 },
});

/* ------------------------------------------------------------------ admin -- */

/** `/api/v1/admin/news` — staff-facing news management (A-37…A-39). */
export const newsAdminRouter = Router();

newsAdminRouter.use(authenticateAdmin);

newsAdminRouter.get(
  NEWS,
  authorize('news.view'),
  validateRequest({ query: listArticlesSchema }),
  controller.listArticles,
);

newsAdminRouter.post(
  NEWS,
  authorize('news.manage'),
  validateRequest({ body: createArticleSchema }),
  controller.createArticle,
);

newsAdminRouter.get(
  `${NEWS}/:id`,
  authorize('news.view'),
  validateRequest({ params: idParamSchema }),
  controller.getArticle,
);

newsAdminRouter.patch(
  `${NEWS}/:id`,
  authorize('news.manage'),
  validateRequest({ params: idParamSchema, body: updateArticleSchema }),
  controller.updateArticle,
);

newsAdminRouter.delete(
  `${NEWS}/:id`,
  authorize('news.manage'),
  validateRequest({ params: idParamSchema }),
  controller.deleteArticle,
);

/*
  Three separate transitions rather than one PATCH of `status`. Publishing runs
  checks that editing does not, unpublishing is a correction and archiving is a
  retirement — collapsing them into a status field would put all three behind one
  audit action and lose which of them actually happened.
*/
newsAdminRouter.post(
  `${NEWS}/:id/publish`,
  authorize('news.manage'),
  validateRequest({ params: idParamSchema }),
  controller.publishArticle,
);

newsAdminRouter.post(
  `${NEWS}/:id/unpublish`,
  authorize('news.manage'),
  validateRequest({ params: idParamSchema }),
  controller.unpublishArticle,
);

newsAdminRouter.post(
  `${NEWS}/:id/archive`,
  authorize('news.manage'),
  validateRequest({ params: idParamSchema }),
  controller.archiveArticle,
);

newsAdminRouter.post(
  `${NEWS}/:id/cover`,
  authorize('news.manage'),
  validateRequest({ params: idParamSchema }),
  uploadImage.single('file'),
  controller.uploadCover,
);

/*
  Staff copies of the two files. Their own routes rather than a relaxed public
  one: the public endpoints must keep answering 404 for a draft, and the person
  writing that draft still has to see what they uploaded.
*/
newsAdminRouter.get(
  `${NEWS}/:id/cover`,
  authorize('news.view'),
  validateRequest({ params: idParamSchema }),
  controller.serveAdminCover,
);

newsAdminRouter.get(
  `${NEWS}/:id/attachments/:attachmentId`,
  authorize('news.view'),
  validateRequest({ params: attachmentParamSchema }),
  controller.serveAdminAttachment,
);

newsAdminRouter.post(
  `${NEWS}/:id/attachments`,
  authorize('news.manage'),
  validateRequest({ params: idParamSchema }),
  uploadPdf.single('file'),
  controller.uploadAttachment,
);

newsAdminRouter.delete(
  `${NEWS}/:id/attachments/:attachmentId`,
  authorize('news.manage'),
  validateRequest({ params: attachmentParamSchema }),
  controller.removeAttachment,
);

newsAdminRouter.post(
  `${NEWS}/:id/images`,
  authorize('news.manage'),
  validateRequest({ params: idParamSchema }),
  uploadImage.single('file'),
  controller.uploadInlineImage,
);

newsAdminRouter.delete(
  `${NEWS}/:id/images/:imageId`,
  authorize('news.manage'),
  validateRequest({ params: imageParamSchema }),
  controller.deleteInlineImage,
);

newsAdminRouter.get(
  NEWS_CATEGORIES,
  authorize('news.view'),
  validateRequest({ query: listCategoriesSchema }),
  controller.listCategories,
);

newsAdminRouter.post(
  NEWS_CATEGORIES,
  authorize('news.manage'),
  validateRequest({ body: createCategorySchema }),
  controller.createCategory,
);

newsAdminRouter.patch(
  `${NEWS_CATEGORIES}/:id`,
  authorize('news.manage'),
  validateRequest({ params: idParamSchema, body: updateCategorySchema }),
  controller.updateCategory,
);

newsAdminRouter.delete(
  `${NEWS_CATEGORIES}/:id`,
  authorize('news.manage'),
  validateRequest({ params: idParamSchema }),
  controller.deleteCategory,
);

/* ----------------------------------------------------------------- public -- */

/**
 * `/api/v1/public/news` — the website, unauthenticated.
 *
 * Published and PUBLIC only, and that is decided in the repository rather than
 * here: `isMember()` reads `req.actor`, which this router never sets. A
 * member-only article is not selected at all, so the answer to a request for one
 * is 404 and not a 403 that would confirm it exists.
 *
 * Route order matters. `/news/categories`, `/news/home` and `/news/media/:id`
 * are declared before `/news/:slug`, or the slug pattern would swallow all three.
 */
export const newsPublicRouter = Router();

newsPublicRouter.get(`${NEWS}/home`, controller.homepageNews);

newsPublicRouter.get(`${NEWS}/categories`, controller.listNewsCategories);

newsPublicRouter.get(`${NEWS}/media/:publicId`, controller.serveMedia);

newsPublicRouter.get(NEWS, validateRequest({ query: listPublicNewsSchema }), controller.listNews);

newsPublicRouter.get(
  `${NEWS}/:slug`,
  validateRequest({ params: slugParamSchema }),
  controller.getNewsArticle,
);

newsPublicRouter.get(
  `${NEWS}/:slug/cover`,
  validateRequest({ params: slugParamSchema }),
  controller.serveCover,
);

newsPublicRouter.get(
  `${NEWS}/:slug/attachments/:publicId`,
  validateRequest({ params: slugAttachmentParamSchema }),
  controller.serveAttachment,
);

/* ----------------------------------------------------------------- member -- */

/**
 * `/api/v1/news` — the same website content for a signed-in member, plus the
 * member-only articles.
 *
 * Deliberately the same controllers. A member sees everything a visitor sees and
 * more; two implementations of one listing is how the two lists start disagreeing
 * about what "newest" means.
 */
export const newsMemberRouter = Router();

newsMemberRouter.use(authenticate);

newsMemberRouter.get('/home', controller.homepageNews);

newsMemberRouter.get('/categories', controller.listNewsCategories);

newsMemberRouter.get('/', validateRequest({ query: listPublicNewsSchema }), controller.listNews);

newsMemberRouter.get(
  '/:slug',
  validateRequest({ params: slugParamSchema }),
  controller.getNewsArticle,
);

newsMemberRouter.get(
  '/:slug/cover',
  validateRequest({ params: slugParamSchema }),
  controller.serveCover,
);

newsMemberRouter.get(
  '/:slug/attachments/:publicId',
  validateRequest({ params: slugAttachmentParamSchema }),
  controller.serveAttachment,
);
