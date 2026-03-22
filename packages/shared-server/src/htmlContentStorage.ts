import { db } from "@karakeep/db";
import { ASSET_TYPES, newAssetId, saveAsset } from "@karakeep/shared/assetdb";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import { QuotaService, StorageQuotaError } from "./services/quotaService";

export type StoreHtmlResult =
  | { result: "stored"; assetId: string; size: number }
  | { result: "store_inline" }
  | { result: "not_stored" };

/**
 * Determines how to store HTML content based on size threshold and quota.
 * - Content below threshold: returns "store_inline" (caller stores in DB column)
 * - Content at/above threshold: saves to asset store and returns assetId
 * - Quota exceeded or no content: returns "not_stored"
 */
export async function storeHtmlContent(
  htmlContent: string | undefined,
  userId: string,
): Promise<StoreHtmlResult> {
  if (htmlContent == null) {
    return { result: "not_stored" };
  }

  const contentSize = Buffer.byteLength(htmlContent, "utf8");

  if (contentSize < serverConfig.crawler.htmlContentSizeThreshold) {
    return { result: "store_inline" };
  }

  let quotaApproved;
  try {
    quotaApproved = await QuotaService.checkStorageQuota(
      db,
      userId,
      contentSize,
    );
  } catch (e) {
    if (e instanceof StorageQuotaError) {
      logger.warn(
        `Skipping HTML content storage due to quota exceeded: ${e.message}`,
      );
      return { result: "not_stored" };
    }
    throw e;
  }

  const assetId = newAssetId();

  try {
    await saveAsset({
      userId,
      assetId,
      asset: Buffer.from(htmlContent, "utf8"),
      metadata: {
        contentType: ASSET_TYPES.TEXT_HTML,
        fileName: null,
      },
      quotaApproved,
    });
  } catch (e) {
    logger.error(
      `Failed to store HTML content as asset: ${(e as Error).message}`,
    );
    throw e;
  }

  return {
    result: "stored",
    assetId,
    size: contentSize,
  };
}
