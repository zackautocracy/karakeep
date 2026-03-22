import fs from "fs";
import { readdir, readFile } from "fs/promises";
import * as os from "os";
import path from "path";
import { execa } from "execa";
import { workerStatsCounter } from "metrics";
import { getProxyAgent, validateUrl } from "network";
import { withWorkerTracing } from "workerTracing";

import { db } from "@karakeep/db";
import { assets, AssetTypes, bookmarkLinks } from "@karakeep/db/schema";
import {
  OpenAIQueue,
  QueuePriority,
  QuotaService,
  StorageQuotaError,
  storeHtmlContent,
  triggerSearchReindex,
  triggerWebhook,
  VideoWorkerQueue,
  ZVideoRequest,
  zvideoRequestSchema,
} from "@karakeep/shared-server";
import { eq } from "drizzle-orm";
import {
  ASSET_TYPES,
  newAssetId,
  saveAssetFromFile,
  silentDeleteAsset,
} from "@karakeep/shared/assetdb";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import { DequeuedJob, getQueueClient } from "@karakeep/shared/queueing";

import { getBookmarkDetails, updateAsset } from "../workerUtils";
import { parseVttToHtml } from "./vttParser";

const TMP_FOLDER = path.join(os.tmpdir(), "video_downloads");

export class VideoWorker {
  static async build() {
    logger.info("Starting video worker ...");

    return (await getQueueClient())!.createRunner<ZVideoRequest>(
      VideoWorkerQueue,
      {
        run: withWorkerTracing("videoWorker.run", runWorker),
        onComplete: async (job) => {
          workerStatsCounter.labels("video", "completed").inc();
          const jobId = job.id;
          logger.info(
            `[VideoCrawler][${jobId}] Video Download Completed successfully`,
          );
          return Promise.resolve();
        },
        onError: async (job) => {
          workerStatsCounter.labels("video", "failed").inc();
          if (job.numRetriesLeft == 0) {
            workerStatsCounter.labels("video", "failed_permanent").inc();
          }
          const jobId = job.id;
          logger.error(
            `[VideoCrawler][${jobId}] Video Download job failed: ${job.error}`,
          );
          return Promise.resolve();
        },
      },
      {
        pollIntervalMs: 1000,
        timeoutSecs: serverConfig.crawler.downloadVideoTimeout,
        concurrency: 1,
        validator: zvideoRequestSchema,
      },
    );
  }
}

function prepareYtDlpArguments(
  url: string,
  proxy: string | undefined,
  assetPath: string,
) {
  const ytDlpArguments = [url];
  if (serverConfig.crawler.maxVideoDownloadSize > 0) {
    ytDlpArguments.push(
      "-f",
      `best[filesize<${serverConfig.crawler.maxVideoDownloadSize}M]`,
    );
  }

  ytDlpArguments.push(...serverConfig.crawler.ytDlpArguments);
  ytDlpArguments.push("-o", assetPath);
  ytDlpArguments.push("--no-playlist");
  if (proxy) {
    ytDlpArguments.push("--proxy", proxy);
  }
  return ytDlpArguments;
}

async function extractTranscript(
  url: string,
  tmpDir: string,
  jobId: string,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (!serverConfig.crawler.extractTranscript) {
    return null;
  }

  const transcriptLangs = serverConfig.crawler.transcriptLangs;

  try {
    const proxy = getProxyAgent(url);
    const args = [
      "--write-subs",
      "--write-auto-subs",
      "--sub-lang",
      transcriptLangs,
      "--sub-format",
      "vtt",
      "--skip-download",
      "--no-playlist",
      "--output",
      `${tmpDir}/%(id)s`,
      url,
    ];
    if (proxy) {
      args.push("--proxy", proxy.proxy.toString());
    }

    await execa("yt-dlp", args, {
      cancelSignal: abortSignal,
    });

    const files = await readdir(tmpDir);
    const vttFiles = files.filter((f) => f.endsWith(".vtt"));
    if (vttFiles.length === 0) return null;

    // Prefer VTT file matching configured language order
    const langOrder = transcriptLangs.split(",").map((l) => l.trim());
    let selectedVtt = vttFiles[0];
    for (const lang of langOrder) {
      const match = vttFiles.find((f) => f.includes(`.${lang}.`));
      if (match) {
        selectedVtt = match;
        break;
      }
    }

    const vttPath = path.join(tmpDir, selectedVtt);
    const resolvedPath = await fs.promises.realpath(vttPath);
    const resolvedDir = await fs.promises.realpath(tmpDir);
    if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
      logger.warn(
        `[VideoCrawler][${jobId}] VTT path traversal attempt detected: "${selectedVtt}"`,
      );
      return null;
    }

    const vttContent = await readFile(resolvedPath, "utf-8");
    return parseVttToHtml(vttContent);
  } catch {
    abortSignal?.throwIfAborted();
    logger.info(`[VideoCrawler][${jobId}] No subtitles available for "${url}"`);
    return null;
  }
}

async function runWorker(job: DequeuedJob<ZVideoRequest>) {
  const jobId = job.id;
  const { bookmarkId } = job.data;

  const {
    url,
    userId,
    videoAssetId: oldVideoAssetId,
  } = await getBookmarkDetails(bookmarkId);

  try {
    // URL validation — needed for BOTH video download AND transcript extraction (SSRF protection)
    const proxy = getProxyAgent(url);
    const validation = await validateUrl(url, !!proxy);
    if (!validation.ok) {
      logger.warn(
        `[VideoCrawler][${jobId}] Skipping video worker for disallowed URL "${url}": ${validation.reason}`,
      );
      return;
    }
    const normalizedUrl = validation.url.toString();

    // Video download (conditional on config)
    if (serverConfig.crawler.downloadVideo) {
      const videoAssetId = newAssetId();
      let assetPath = `${TMP_FOLDER}/${videoAssetId}`;
      await fs.promises.mkdir(TMP_FOLDER, { recursive: true });

      const ytDlpArguments = prepareYtDlpArguments(
        normalizedUrl,
        proxy?.proxy.toString(),
        assetPath,
      );

      try {
        logger.info(
          `[VideoCrawler][${jobId}] Attempting to download a file from "${normalizedUrl}" to "${assetPath}" using the following arguments: "${ytDlpArguments}"`,
        );

        await execa("yt-dlp", ytDlpArguments, {
          cancelSignal: job.abortSignal,
        });
        const downloadPath = await findAssetFile(videoAssetId);
        if (!downloadPath) {
          logger.info(
            `[VideoCrawler][${jobId}] yt-dlp didn't download anything. Skipping ...`,
          );
          // Don't return — continue to transcript extraction
        } else {
          assetPath = downloadPath;

          logger.info(
            `[VideoCrawler][${jobId}] Finished downloading a file from "${normalizedUrl}" to "${assetPath}"`,
          );

          // Get file size and check quota before saving
          const stats = await fs.promises.stat(assetPath);
          const fileSize = stats.size;

          try {
            const quotaApproved = await QuotaService.checkStorageQuota(
              db,
              userId,
              fileSize,
            );

            await saveAssetFromFile({
              userId,
              assetId: videoAssetId,
              assetPath,
              metadata: { contentType: ASSET_TYPES.VIDEO_MP4 },
              quotaApproved,
            });

            await db.transaction(async (txn) => {
              await updateAsset(
                oldVideoAssetId,
                {
                  id: videoAssetId,
                  bookmarkId,
                  userId,
                  assetType: AssetTypes.LINK_VIDEO,
                  contentType: ASSET_TYPES.VIDEO_MP4,
                  size: fileSize,
                },
                txn,
              );
            });
            await silentDeleteAsset(userId, oldVideoAssetId);

            logger.info(
              `[VideoCrawler][${jobId}] Finished downloading video from "${normalizedUrl}" and adding it to the database`,
            );
          } catch (error) {
            if (error instanceof StorageQuotaError) {
              logger.warn(
                `[VideoCrawler][${jobId}] Skipping video storage due to quota exceeded: ${error.message}`,
              );
              await deleteLeftOverAssetFile(jobId, videoAssetId);
              // Don't return — continue to transcript extraction
            } else {
              throw error;
            }
          }
        }
      } catch (e) {
        await deleteLeftOverAssetFile(jobId, videoAssetId);
        job.abortSignal.throwIfAborted();

        const err = e as Error;
        if (
          err.message.includes("ERROR: Unsupported URL:") ||
          err.message.includes("No media found")
        ) {
          logger.info(
            `[VideoCrawler][${jobId}] Skipping video download from "${normalizedUrl}", because it's not one of the supported yt-dlp URLs`,
          );
          return; // Truly unsupported URL — transcript won't work either
        }
        const genericError = `[VideoCrawler][${jobId}] Failed to download a file from "${normalizedUrl}" to "${assetPath}"`;
        if ("stderr" in err) {
          logger.error(`${genericError}: ${err.stderr}`);
        } else {
          logger.error(genericError);
        }
        // Don't return for generic download errors — try transcript next
      }
    } else {
      logger.info(
        `[VideoCrawler][${jobId}] Skipping video download from "${normalizedUrl}", because it is disabled in the config.`,
      );
    }

    // Transcript extraction — runs REGARDLESS of video download setting
    const transcriptTmpDir = `${TMP_FOLDER}/transcript_${jobId}`;
    await fs.promises.mkdir(transcriptTmpDir, { recursive: true });

    try {
      const transcript = await extractTranscript(
        normalizedUrl,
        transcriptTmpDir,
        jobId,
        job.abortSignal,
      );

      if (transcript) {
        const existingLink = await db.query.bookmarkLinks.findFirst({
          where: eq(bookmarkLinks.id, bookmarkId),
          columns: { contentSource: true, contentAssetId: true },
        });

        // Only set transcript if content wasn't manually set by user
        if (existingLink?.contentSource !== "manual") {
          const oldContentAssetId = existingLink?.contentAssetId ?? undefined;
          const storageResult = await storeHtmlContent(transcript, userId);

          if (storageResult.result === "stored") {
            await db.transaction(async (txn) => {
              await updateAsset(
                oldContentAssetId,
                {
                  id: storageResult.assetId,
                  bookmarkId,
                  userId,
                  assetType: AssetTypes.LINK_HTML_CONTENT,
                  contentType: ASSET_TYPES.TEXT_HTML,
                  size: storageResult.size,
                  fileName: null,
                },
                txn,
              );
              await txn
                .update(bookmarkLinks)
                .set({
                  htmlContent: null,
                  contentAssetId: storageResult.assetId,
                  contentSource: "transcript",
                })
                .where(eq(bookmarkLinks.id, bookmarkId));
            });
            if (oldContentAssetId) {
              await silentDeleteAsset(userId, oldContentAssetId);
            }
          } else if (storageResult.result === "store_inline") {
            await db.transaction(async (txn) => {
              if (oldContentAssetId) {
                await txn
                  .delete(assets)
                  .where(eq(assets.id, oldContentAssetId));
              }
              await txn
                .update(bookmarkLinks)
                .set({
                  htmlContent: transcript,
                  contentAssetId: null,
                  contentSource: "transcript",
                })
                .where(eq(bookmarkLinks.id, bookmarkId));
            });
            if (oldContentAssetId) {
              await silentDeleteAsset(userId, oldContentAssetId);
            }
          }

          if (storageResult.result !== "not_stored") {
            await Promise.all([
              OpenAIQueue.enqueue(
                { bookmarkId, type: "summarize" },
                { priority: QueuePriority.Default, groupId: userId },
              ),
              OpenAIQueue.enqueue(
                { bookmarkId, type: "tag" },
                { priority: QueuePriority.Default, groupId: userId },
              ),
              triggerSearchReindex(bookmarkId, { groupId: userId }),
            ]);

            logger.info(
              `[VideoCrawler][${jobId}] Stored transcript for "${normalizedUrl}" and triggered AI inference`,
            );
          }
        } else {
          logger.info(
            `[VideoCrawler][${jobId}] Skipping transcript: contentSource is manual`,
          );
        }
      }
    } finally {
      await fs.promises
        .rm(transcriptTmpDir, { recursive: true, force: true })
        .catch(() => {
          // Ignore cleanup errors
        });
    }
  } finally {
    if (!job.abortSignal.aborted) {
      await triggerWebhook(bookmarkId, "video_processed", undefined, {
        groupId: userId,
      });
    }
  }
}

/**
 * Deletes leftover assets in case the download fails
 *
 * @param jobId the id of the job
 * @param assetId the id of the asset to delete
 */
async function deleteLeftOverAssetFile(
  jobId: string,
  assetId: string,
): Promise<void> {
  let assetFile;
  try {
    assetFile = await findAssetFile(assetId);
  } catch {
    // ignore exception, no asset file was found
    return;
  }
  if (!assetFile) {
    return;
  }
  logger.info(
    `[VideoCrawler][${jobId}] Deleting leftover video asset "${assetFile}".`,
  );
  try {
    await fs.promises.rm(assetFile);
  } catch {
    logger.error(
      `[VideoCrawler][${jobId}] Failed deleting leftover video asset "${assetFile}".`,
    );
  }
}

/**
 * yt-dlp automatically adds a file ending to the passed in filename --> we have to search it again in the folder
 *
 * @param assetId the id of the asset to search
 * @returns the path to the downloaded asset
 */
async function findAssetFile(assetId: string): Promise<string | null> {
  const files = await fs.promises.readdir(TMP_FOLDER);
  for (const file of files) {
    if (file.startsWith(assetId)) {
      return path.join(TMP_FOLDER, file);
    }
  }
  return null;
}
